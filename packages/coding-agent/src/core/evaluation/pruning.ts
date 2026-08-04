import { mkdir, readdir, rm, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createPruneManifest, DEFAULT_EVALUATION_RETENTION_POLICY } from "./retention.js";
import type { EvaluationPruneManifest, EvaluationRetentionPolicy } from "./types.js";

export interface PruneReport {
	mode: "preview" | "execute";
	root: string;
	deleted: string[];
	retained: string[];
	mutationCount: number;
	manifest: EvaluationPruneManifest;
}

async function acquireWriterLease(root: string): Promise<() => Promise<void>> {
	const lease = join(root, ".prune-writer.lock");
	await mkdir(lease, { recursive: false }).catch((error: unknown) => {
		throw new Error(
			`artifact store writer lease unavailable: ${error instanceof Error ? error.message : String(error)}`,
		);
	});
	return async () => {
		await rmdir(lease).catch(() => undefined);
	};
}

function assertManifestMatches(expected: EvaluationPruneManifest, actual: EvaluationPruneManifest): void {
	const expectedEntries = JSON.stringify({
		entries: expected.entries,
		protectedEntries: expected.protectedEntries,
		policyVersion: expected.policyVersion,
	});
	const actualEntries = JSON.stringify({
		entries: actual.entries,
		protectedEntries: actual.protectedEntries,
		policyVersion: actual.policyVersion,
	});
	if (expectedEntries !== actualEntries) throw new Error("prune precondition failed: store changed after preview");
}

export async function pruneEvaluationStore(
	root: string,
	execute: boolean,
	policy: EvaluationRetentionPolicy = DEFAULT_EVALUATION_RETENTION_POLICY,
	manifest?: EvaluationPruneManifest,
): Promise<PruneReport> {
	const storeRoot = resolve(root);
	await mkdir(storeRoot, { recursive: true });
	const current = await createPruneManifest(storeRoot, policy);
	if (!execute) {
		return {
			mode: "preview",
			root: storeRoot,
			deleted: current.entries.map((entry) => join(storeRoot, entry.artifactId)).sort(),
			retained: current.protectedEntries.map((entry) => entry.artifactId).sort(),
			mutationCount: 0,
			manifest: current,
		};
	}
	if (!manifest) throw new Error("prune execute requires a preview manifest");
	assertManifestMatches(manifest, current);
	const release = await acquireWriterLease(storeRoot);
	try {
		const deleted: string[] = [];
		for (const entry of current.entries) {
			if (!entry.artifactId.startsWith("temporary/")) continue;
			const path = join(storeRoot, entry.artifactId);
			await rm(path, { recursive: true, force: true });
			deleted.push(path);
		}
		const remaining = await readdir(join(storeRoot, "temporary"), { withFileTypes: true }).catch(() => []);
		return {
			mode: "execute",
			root: storeRoot,
			deleted: deleted.sort(),
			retained: [
				...current.protectedEntries.map((entry) => entry.artifactId),
				...remaining.map((entry) => `temporary/${entry.name}`),
			].sort(),
			mutationCount: deleted.length,
			manifest: current,
		};
	} finally {
		await release();
	}
}
