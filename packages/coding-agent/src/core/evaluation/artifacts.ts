import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sha256, stableStringify } from "./identity.js";
import { EVALUATION_SCHEMA_VERSION, EVALUATOR_VERSION, type EvaluationArtifact } from "./types.js";

export const ARTIFACT_STORE_SCHEMA_VERSION = 1 as const;
export const RESERVED_EVALUATION_DIRECTORIES = new Set(["artifacts", "baselines", "temporary"]);
const ARTIFACT_ID_PATTERN = /^[a-f0-9]{64}$/;

export interface EvaluationStoreManifest {
	schemaVersion: typeof ARTIFACT_STORE_SCHEMA_VERSION;
	createdAt: string;
	updatedAt: string;
	artifacts: string[];
}

export type ArtifactStoreState =
	| "absent"
	| "empty"
	| "initialized"
	| "degraded"
	| "artifact_incomplete"
	| "artifact_corrupt"
	| "artifact_missing"
	| "schema_unsupported"
	| "permission_denied";

export interface ArtifactStoreDiagnostic {
	name: "evaluation-artifact-store";
	status: "pass" | "warn" | "fail";
	state: ArtifactStoreState;
	storeRoot: string;
	artifactCount: number;
	temporaryCount: number;
	indexedArtifactIds: string[];
	discoveredArtifactIds: string[];
	errors: string[];
	warnings: string[];
	mutationCount: 0;
}

function artifactPayload(artifact: Omit<EvaluationArtifact, "artifactHash">): string {
	return stableStringify(artifact);
}

export function createArtifact(
	input: Omit<EvaluationArtifact, "schemaVersion" | "evaluatorVersion" | "artifactHash">,
): EvaluationArtifact {
	const unsigned = { ...input, schemaVersion: EVALUATION_SCHEMA_VERSION, evaluatorVersion: EVALUATOR_VERSION };
	return { ...unsigned, artifactHash: sha256(artifactPayload(unsigned)) };
}

export function verifyArtifact(artifact: EvaluationArtifact): boolean {
	const { artifactHash, ...unsigned } = artifact;
	return artifact.schemaVersion === EVALUATION_SCHEMA_VERSION && artifactHash === sha256(artifactPayload(unsigned));
}

function assertArtifactId(artifactId: string): void {
	if (!ARTIFACT_ID_PATTERN.test(artifactId)) throw new Error(`invalid evaluation artifact id: ${artifactId}`);
}

function storeManifestPath(root: string): string {
	return join(root, "store.json");
}

async function writeDurably(path: string, contents: string): Promise<void> {
	const handle = await open(path, "wx");
	try {
		await handle.writeFile(contents, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function readStoreManifest(root: string): Promise<EvaluationStoreManifest | undefined> {
	try {
		return JSON.parse(await readFile(storeManifestPath(root), "utf8")) as EvaluationStoreManifest;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function updateStoreManifest(root: string, artifactId: string): Promise<void> {
	const path = storeManifestPath(root);
	const current = (await readStoreManifest(root)) ?? {
		schemaVersion: ARTIFACT_STORE_SCHEMA_VERSION,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		artifacts: [],
	};
	if (current.schemaVersion !== ARTIFACT_STORE_SCHEMA_VERSION) throw new Error("unsupported evaluation store schema");
	const manifest: EvaluationStoreManifest = {
		...current,
		updatedAt: new Date().toISOString(),
		artifacts: [...new Set([...current.artifacts, artifactId])].sort(),
	};
	const temporaryPath = `${path}.${randomUUID()}.tmp`;
	await writeDurably(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`);
	await rename(temporaryPath, path);
}

export async function writeArtifact(root: string, artifact: EvaluationArtifact): Promise<string> {
	if (!verifyArtifact(artifact)) throw new Error("cannot write invalid evaluation artifact");
	assertArtifactId(artifact.artifactHash);
	const storeRoot = resolve(root);
	const artifactDirectory = join(storeRoot, "artifacts", artifact.artifactHash);
	const temporaryDirectory = join(storeRoot, "temporary", `${artifact.artifactHash}-${randomUUID()}`);
	await mkdir(join(storeRoot, "artifacts"), { recursive: true });
	await mkdir(join(storeRoot, "baselines"), { recursive: true });
	await mkdir(join(storeRoot, "temporary"), { recursive: true });
	try {
		const resultPath = join(temporaryDirectory, "result.json");
		const manifestPath = join(temporaryDirectory, "manifest.json");
		await mkdir(temporaryDirectory, { recursive: true });
		const result = `${JSON.stringify(artifact, null, 2)}\n`;
		await writeDurably(resultPath, result);
		await writeDurably(
			manifestPath,
			`${JSON.stringify(
				{
					schemaVersion: ARTIFACT_STORE_SCHEMA_VERSION,
					artifactId: artifact.artifactHash,
					resultHash: sha256(result),
					createdAt: artifact.provenance.createdAt,
				},
				null,
			)}\n`,
		);
		await rename(temporaryDirectory, artifactDirectory);
		await updateStoreManifest(storeRoot, artifact.artifactHash);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			await rm(temporaryDirectory, { recursive: true, force: true });
			const existing = await readArtifact(storeRoot, artifact.artifactHash);
			if (!verifyArtifact(existing)) throw new Error("existing artifact is corrupt");
			return artifact.artifactHash;
		}
		await rm(temporaryDirectory, { recursive: true, force: true });
		throw error;
	}
	return artifact.artifactHash;
}

export async function readArtifact(root: string, artifactId: string): Promise<EvaluationArtifact> {
	assertArtifactId(artifactId);
	const artifact = JSON.parse(
		await readFile(join(resolve(root), "artifacts", artifactId, "result.json"), "utf8"),
	) as EvaluationArtifact;
	if (!verifyArtifact(artifact)) throw new Error(`invalid evaluation artifact: ${artifactId}`);
	return artifact;
}

export async function listArtifacts(root: string): Promise<EvaluationArtifact[]> {
	const diagnostic = await inspectArtifactStore(root);
	const artifacts: EvaluationArtifact[] = [];
	for (const artifactId of diagnostic.discoveredArtifactIds.sort()) {
		artifacts.push(await readArtifact(root, artifactId));
	}
	return artifacts;
}

export async function inspectArtifactStore(root: string): Promise<ArtifactStoreDiagnostic> {
	const storeRoot = resolve(root);
	const diagnostic: ArtifactStoreDiagnostic = {
		name: "evaluation-artifact-store",
		status: "pass",
		state: "absent",
		storeRoot,
		artifactCount: 0,
		temporaryCount: 0,
		indexedArtifactIds: [],
		discoveredArtifactIds: [],
		errors: [],
		warnings: [],
		mutationCount: 0,
	};
	let rootStat: Awaited<ReturnType<typeof stat>>;
	try {
		rootStat = await stat(storeRoot);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return diagnostic;
		if ((error as NodeJS.ErrnoException).code === "EACCES") {
			diagnostic.status = "fail";
			diagnostic.state = "permission_denied";
			diagnostic.errors.push("permission denied reading evaluation store");
			return diagnostic;
		}
		throw error;
	}
	if (!rootStat.isDirectory()) {
		diagnostic.status = "fail";
		diagnostic.state = "artifact_corrupt";
		diagnostic.errors.push("evaluation store root is not a directory");
		return diagnostic;
	}
	let store: EvaluationStoreManifest | undefined;
	try {
		store = await readStoreManifest(storeRoot);
	} catch (error) {
		diagnostic.status = "fail";
		diagnostic.state = "artifact_corrupt";
		diagnostic.errors.push(`store manifest: ${error instanceof Error ? error.message : String(error)}`);
		return diagnostic;
	}
	if (store && store.schemaVersion !== ARTIFACT_STORE_SCHEMA_VERSION) {
		diagnostic.status = "fail";
		diagnostic.state = "schema_unsupported";
		diagnostic.errors.push(`unsupported evaluation store schema: ${store.schemaVersion}`);
		return diagnostic;
	}
	diagnostic.indexedArtifactIds = store?.artifacts ?? [];
	const artifactRoot = join(storeRoot, "artifacts");
	const temporaryRoot = join(storeRoot, "temporary");
	const artifactEntries = await readdir(artifactRoot, { withFileTypes: true }).catch((error: unknown) => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	});
	const temporaryEntries = await readdir(temporaryRoot, { withFileTypes: true }).catch((error: unknown) => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	});
	diagnostic.temporaryCount = temporaryEntries.length;
	if (diagnostic.temporaryCount > 0) {
		diagnostic.status = "warn";
		diagnostic.state = "degraded";
		diagnostic.warnings.push(`${diagnostic.temporaryCount} temporary artifact(s) require recovery or pruning`);
	}
	for (const entry of artifactEntries.sort((left, right) => left.name.localeCompare(right.name))) {
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			diagnostic.status = "fail";
			diagnostic.state = "artifact_corrupt";
			diagnostic.errors.push(`ready artifact entry is not a directory: ${entry.name}`);
			continue;
		}
		const artifactId = entry.name;
		diagnostic.discoveredArtifactIds.push(artifactId);
		diagnostic.artifactCount += 1;
		if (!ARTIFACT_ID_PATTERN.test(artifactId)) {
			diagnostic.status = "fail";
			diagnostic.state = "artifact_corrupt";
			diagnostic.errors.push(`invalid artifact id: ${artifactId}`);
			continue;
		}
		try {
			const manifest = JSON.parse(await readFile(join(artifactRoot, artifactId, "manifest.json"), "utf8")) as {
				schemaVersion: number;
				artifactId: string;
				resultHash: string;
			};
			const result = await readFile(join(artifactRoot, artifactId, "result.json"));
			const artifact = JSON.parse(result.toString("utf8")) as EvaluationArtifact;
			if (
				manifest.schemaVersion !== ARTIFACT_STORE_SCHEMA_VERSION ||
				manifest.artifactId !== artifactId ||
				manifest.resultHash !== sha256(result) ||
				!verifyArtifact(artifact)
			)
				throw new Error("manifest or result hash mismatch");
		} catch (error) {
			diagnostic.status = "fail";
			diagnostic.state = "artifact_incomplete";
			diagnostic.errors.push(`${artifactId}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	for (const artifactId of diagnostic.indexedArtifactIds) {
		if (!diagnostic.discoveredArtifactIds.includes(artifactId)) {
			diagnostic.status = "fail";
			diagnostic.state = "artifact_missing";
			diagnostic.errors.push(`store index references missing artifact: ${artifactId}`);
		}
	}
	if (!store && diagnostic.artifactCount === 0 && diagnostic.temporaryCount === 0) {
		diagnostic.state = "empty";
	} else if (diagnostic.status === "pass") {
		diagnostic.state = diagnostic.artifactCount === 0 ? "empty" : "initialized";
	}
	return diagnostic;
}
