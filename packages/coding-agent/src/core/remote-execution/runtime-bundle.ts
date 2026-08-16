/**
 * Remote runtime bundle (3.0.0 cross-host bridge).
 *
 * Builds a reproducible, content-addressed, self-contained runtime bundle from
 * the CURRENT checkout. The bundle is a directory tree (compiled workspace dist
 * + hoisted third-party node_modules) tarballed into one payload. Identity is
 * the tarball SHA-256: `runtimeId = <commitShort>-<hashPrefix>`.
 *
 * The bundle is code/runtime only. It never contains Qwen weights, llama.cpp,
 * API keys, or Evidence content.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

export const RUNTIME_BUNDLE_SCHEMA_VERSION = 1 as const;
/** Remote-runtime handshake protocol version. */
export const RUNTIME_PROTOCOL_VERSION = 1 as const;

export interface RuntimeBundleFile {
	path: string;
	sha256: string;
	bytes: number;
}

export interface RuntimeBundleManifest {
	schemaVersion: typeof RUNTIME_BUNDLE_SCHEMA_VERSION;
	runtimeId: string;
	jensenCommit: string;
	runtimeProtocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
	/** Shared-inference admission protocol version this runtime speaks. */
	sharedInferenceProtocolVersion: number;
	packageVersions: Record<string, string>;
	/** Content-address of the transfer payload (tarball SHA-256). */
	tarballHash: string;
	/** Audit list of the workspace dist files (not the third-party closure). */
	workspaceFiles: RuntimeBundleFile[];
}

/**
 * Non-circular identity written INSIDE the tarball so a remote runtime can be
 * verified after extraction without a separate sidecar write (which races with
 * Windows file-handle release + Defender scanning).
 */
export interface RuntimeBundleIdentity {
	schemaVersion: typeof RUNTIME_BUNDLE_SCHEMA_VERSION;
	jensenCommit: string;
	runtimeProtocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
	sharedInferenceProtocolVersion: number;
	packageVersions: Record<string, string>;
}

export interface RuntimeBundlePackage {
	/** Directory name under packages/, e.g. "ai". */
	dir: string;
	/** npm name, e.g. "@apholdings/jensen-ai". */
	npmName: string;
	/** package.json version, read during build. */
	version?: string;
}

export interface BuiltRuntimeBundle {
	tarballPath: string;
	manifestPath: string;
	runtimeId: string;
	tarballHash: string;
	jensenCommit: string;
	commitShort: string;
	manifest: RuntimeBundleManifest;
	identity: RuntimeBundleIdentity;
}

export interface BuildRuntimeBundleOptions {
	checkoutRoot: string;
	outDir: string;
	packages?: RuntimeBundlePackage[];
	jensenCommit?: string;
	sharedInferenceProtocolVersion?: number;
}

function sha256OfBuffer(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex");
}

async function copyTree(src: string, dst: string): Promise<void> {
	await fsp.cp(src, dst, { recursive: true, force: true, verbatimSymlinks: false });
}

async function fileSha256(p: string): Promise<{ sha256: string; bytes: number }> {
	const buffer = await fsp.readFile(p);
	return { sha256: createHash("sha256").update(buffer).digest("hex"), bytes: buffer.length };
}

async function listFilesRecursive(root: string): Promise<string[]> {
	const out: string[] = [];
	async function walk(dir: string): Promise<void> {
		const entries = await fsp.readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) await walk(full);
			else if (entry.isFile()) out.push(full);
		}
	}
	await walk(root);
	return out;
}

/**
 * Build the runtime bundle + sidecar manifest. The third-party `node_modules`
 * closure is copied whole (self-contained; no reliance on the target's global
 * install). The workspace `@apholdings` packages are the freshly-built dist.
 */
export async function buildRuntimeBundle(options: BuildRuntimeBundleOptions): Promise<BuiltRuntimeBundle> {
	const checkoutRoot = path.resolve(options.checkoutRoot);
	const packages: RuntimeBundlePackage[] = options.packages ?? [
		{ dir: "ai", npmName: "@apholdings/jensen-ai" },
		{ dir: "agent", npmName: "@apholdings/jensen-agent-core" },
		{ dir: "coding-agent", npmName: "@apholdings/jensen-code" },
		{ dir: "tui", npmName: "@apholdings/jensen-tui" },
	];

	let jensenCommit = options.jensenCommit;
	if (!jensenCommit) {
		jensenCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkoutRoot, encoding: "utf8" }).trim();
	}
	const commitShort = jensenCommit.slice(0, 12);

	const staging = path.join(options.outDir, `bundle-staging-${process.pid}-${Date.now().toString(36)}`);
	const stagingNodeModules = path.join(staging, "node_modules");
	await fsp.mkdir(stagingNodeModules, { recursive: true });

	const packageVersions: Record<string, string> = {};
	for (const pkg of packages) {
		const pkgJsonPath = path.join(checkoutRoot, "packages", pkg.dir, "package.json");
		const pkgJson = JSON.parse(await fsp.readFile(pkgJsonPath, "utf8"));
		packageVersions[pkg.npmName] = pkgJson.version ?? "unknown";
		const dst = path.join(stagingNodeModules, ...pkg.npmName.split("/"));

		// Copy the package's publish surface (its `files` entries) + package.json.
		// This includes root shim files (e.g. ai's `bedrock-provider.js`) that the
		// `exports` map references outside `dist`, which a dist-only copy would miss.
		const files: string[] = Array.isArray(pkgJson.files) && pkgJson.files.length > 0 ? pkgJson.files : ["dist"];
		for (const entry of files) {
			// Normalise npm glob entries (e.g. `dist/**/*`) to their base directory.
			const base = entry.split("*")[0]!.replace(/\/+$/, "");
			const src = path.join(checkoutRoot, "packages", pkg.dir, base);
			const target = path.join(dst, base);
			const stat = await fsp.lstat(src).catch(() => undefined);
			if (!stat) continue;
			if (stat.isDirectory()) await copyTree(src, target);
			else {
				await fsp.mkdir(path.dirname(target), { recursive: true });
				await fsp.copyFile(src, target);
			}
		}
		await fsp.copyFile(pkgJsonPath, path.join(dst, "package.json"));

		// Nested (non-hoisted) dependencies live under the workspace package's own
		// `node_modules`. Copy them so resolution matches the checkout exactly.
		const nested = path.join(checkoutRoot, "packages", pkg.dir, "node_modules");
		const nestedStat = await fsp.lstat(nested).catch(() => undefined);
		if (nestedStat?.isDirectory()) await copyTree(nested, path.join(dst, "node_modules"));
	}

	// Third-party closure (exclude workspace @apholdings symlinks; they are the
	// real dist we just materialised above).
	const thirdParty = path.join(checkoutRoot, "node_modules");
	const entries = await fsp.readdir(thirdParty, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.name === "@apholdings") continue;
		await copyTree(path.join(thirdParty, entry.name), path.join(stagingNodeModules, entry.name));
	}

	// Non-circular identity written INSIDE the tarball (remote verification
	// without a sidecar write).
	const identity: RuntimeBundleIdentity = {
		schemaVersion: RUNTIME_BUNDLE_SCHEMA_VERSION,
		jensenCommit,
		runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
		sharedInferenceProtocolVersion: options.sharedInferenceProtocolVersion ?? 1,
		packageVersions,
	};
	await fsp.writeFile(path.join(staging, "identity.json"), JSON.stringify(identity, null, 2));

	// Tarball the staging directory, then content-address it.
	const tmpTarball = path.join(options.outDir, `bundle-${process.pid}-${Date.now().toString(36)}.tgz`);
	execFileSync("tar", ["-czf", tmpTarball, "-C", staging, "."], { stdio: "inherit" });
	const tarballBuffer = await fsp.readFile(tmpTarball);
	const tarballHash = sha256OfBuffer(tarballBuffer);
	const runtimeId = `${commitShort}-${tarballHash.slice(0, 12)}`;

	const tarballPath = path.join(options.outDir, `${runtimeId}.tgz`);
	if (path.resolve(tarballPath) !== path.resolve(tmpTarball)) {
		await fsp.rename(tmpTarball, tarballPath);
	}

	// Audit the workspace dist files (identity audit, not the identity itself).
	const workspaceFiles: RuntimeBundleFile[] = [];
	for (const pkg of packages) {
		const distRoot = path.join(stagingNodeModules, ...pkg.npmName.split("/"), "dist");
		const files = await listFilesRecursive(distRoot);
		for (const file of files) {
			const rel = path.relative(staging, file).replace(/\\/g, "/");
			const { sha256, bytes } = await fileSha256(file);
			workspaceFiles.push({ path: rel, sha256, bytes });
		}
	}
	workspaceFiles.sort((a, b) => a.path.localeCompare(b.path));

	const manifest: RuntimeBundleManifest = {
		schemaVersion: RUNTIME_BUNDLE_SCHEMA_VERSION,
		runtimeId,
		jensenCommit,
		runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
		sharedInferenceProtocolVersion: options.sharedInferenceProtocolVersion ?? 1,
		packageVersions,
		tarballHash,
		workspaceFiles,
	};
	const manifestPath = path.join(options.outDir, `${runtimeId}.manifest.json`);
	await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

	// Clean up the staging directory (the tarball + manifest are authoritative).
	await fsp.rm(staging, { recursive: true, force: true });

	return { tarballPath, manifestPath, runtimeId, tarballHash, jensenCommit, commitShort, manifest, identity };
}
