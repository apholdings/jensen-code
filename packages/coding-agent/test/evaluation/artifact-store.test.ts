import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	discoverEvaluationPacks,
	inspectArtifactStore,
	readArtifact,
	writeArtifact,
} from "../../src/core/evaluation/index.js";
import { builtInEvaluationScenarios } from "../../src/core/evaluation/packs.js";
import { runEvaluation } from "../../src/core/evaluation/runner.js";
import type { EvaluationEvent } from "../../src/core/evaluation/types.js";

async function passingArtifact() {
	const scenario = builtInEvaluationScenarios()[0]!;
	const events: EvaluationEvent[] = [
		{ eventId: "failure", type: "tool.failure", timestamp: "2026-01-01T00:00:00.000Z", details: { status: "pass" } },
	];
	return runEvaluation(scenario, {
		mode: "fixture",
		executor: { execute: async () => ({ events }) },
	});
}

describe("evaluation artifact store", () => {
	it("does not create a store while doctor inspects an absent root", async () => {
		const root = join(tmpdir(), `jensen-store-absent-${Date.now()}`);
		try {
			const result = await inspectArtifactStore(root);
			expect(result.status).toBe("pass");
			expect(result.state).toBe("absent");
			await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("promotes complete artifacts and records a store index", async () => {
		const root = await mkdtemp(join(tmpdir(), "jensen-store-"));
		try {
			const artifact = await passingArtifact();
			await writeArtifact(root, artifact);
			const store = await inspectArtifactStore(root);
			expect(store.status).toBe("pass");
			expect(store.state).toBe("initialized");
			expect(store.artifactCount).toBe(1);
			expect(store.indexedArtifactIds).toEqual([artifact.artifactHash]);
			expect(await readArtifact(root, artifact.artifactHash)).toEqual(artifact);
			expect(JSON.parse(await readFile(join(root, "store.json"), "utf8")).schemaVersion).toBe(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("ignores reserved store directories during pack discovery", async () => {
		const root = await mkdtemp(join(tmpdir(), "jensen-packs-"));
		try {
			await mkdir(join(root, "artifacts"), { recursive: true });
			await mkdir(join(root, "baselines"), { recursive: true });
			await mkdir(join(root, "temporary"), { recursive: true });
			const discovered = await discoverEvaluationPacks(root);
			expect(discovered.errors).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("fails closed for an incomplete ready artifact", async () => {
		const root = await mkdtemp(join(tmpdir(), "jensen-corrupt-"));
		try {
			await mkdir(join(root, "artifacts", "a".repeat(64)), { recursive: true });
			const store = await inspectArtifactStore(root);
			expect(store.status).toBe("fail");
			expect(store.state).toBe("artifact_incomplete");
			expect(store.mutationCount).toBe(0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
