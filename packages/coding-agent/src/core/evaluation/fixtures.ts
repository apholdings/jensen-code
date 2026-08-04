import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { hashJson, sha256 } from "./identity.js";
import type { EvaluationFixtureSpec } from "./types.js";

const execFileAsync = promisify(execFile);

export interface MaterializedFixture {
	root: string;
	fixtureHash: string;
	retained: boolean;
}

function assertRelativePath(root: string, candidate: string): string {
	if (isAbsolute(candidate)) throw new Error(`fixture path must be relative: ${candidate}`);
	const target = resolve(root, candidate);
	const rootWithSeparator = `${resolve(root)}${sep}`;
	if (target !== resolve(root) && !target.startsWith(rootWithSeparator))
		throw new Error(`fixture path escapes root: ${candidate}`);
	return target;
}

async function copyTree(source: string, destination: string, sourceRoot: string): Promise<Record<string, string>> {
	const hashes: Record<string, string> = {};
	const entries = await readdir(source, { withFileTypes: true });
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		const sourcePath = join(source, entry.name);
		const relativePath = relative(sourceRoot, sourcePath);
		const destinationPath = assertRelativePath(destination, relativePath);
		if (entry.isSymbolicLink()) throw new Error(`fixture symlinks are not permitted: ${relativePath}`);
		if (entry.isDirectory()) {
			await mkdir(destinationPath, { recursive: true });
			Object.assign(hashes, await copyTree(sourcePath, destination, sourceRoot));
			continue;
		}
		if (!entry.isFile()) throw new Error(`unsupported fixture entry: ${relativePath}`);
		const content = await readFile(sourcePath);
		await mkdir(dirname(destinationPath), { recursive: true });
		await writeFile(destinationPath, content, { flag: "wx" });
		hashes[relativePath] = sha256(content);
	}
	return hashes;
}

export async function materializeFixture(
	spec: EvaluationFixtureSpec,
	options: { retainOnFailure?: boolean } = {},
): Promise<MaterializedFixture> {
	const root = await mkdtemp(join(tmpdir(), "jensen-eval-"));
	try {
		let hashes: Record<string, string> = {};
		if (spec.kind === "inline" || spec.kind === "generated" || spec.kind === "provider_trace") {
			for (const [filePath, contents] of Object.entries(spec.files ?? {}).sort(([left], [right]) =>
				left.localeCompare(right),
			)) {
				const destination = assertRelativePath(root, filePath);
				await mkdir(dirname(destination), { recursive: true });
				await writeFile(destination, contents, { flag: "wx" });
				hashes[filePath] = sha256(contents);
			}
		} else {
			if (!spec.root) throw new Error("local fixture root is required");
			const source = resolve(spec.root);
			const sourceStat = await stat(source);
			if (!sourceStat.isDirectory()) throw new Error("local fixture root must be a directory");
			hashes = await copyTree(source, root, source);
		}
		for (const [filePath, expectedHash] of Object.entries(spec.fileHashes ?? {})) {
			if (hashes[filePath] !== expectedHash) throw new Error(`fixture hash mismatch for ${filePath}`);
		}
		if (spec.git?.initialize) {
			await execFileAsync("git", ["init", "--quiet", "--initial-branch", spec.git.branch ?? "main"], { cwd: root });
			await execFileAsync("git", ["config", "user.email", "evaluation@localhost"], { cwd: root });
			await execFileAsync("git", ["config", "user.name", "Jensen Evaluation"], { cwd: root });
			await execFileAsync("git", ["add", "--all"], { cwd: root });
			await execFileAsync("git", ["commit", "--quiet", "--no-gpg-sign", "-m", "fixture"], { cwd: root });
		}
		return {
			root,
			fixtureHash: hashJson({ files: hashes, git: spec.git }),
			retained: options.retainOnFailure === true,
		};
	} catch (error) {
		if (!options.retainOnFailure) await rm(root, { recursive: true, force: true });
		throw error;
	}
}

export async function cleanupFixture(fixture: MaterializedFixture): Promise<void> {
	if (!fixture.retained) await rm(fixture.root, { recursive: true, force: true });
}
