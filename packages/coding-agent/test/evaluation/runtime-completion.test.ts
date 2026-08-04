import { describe, expect, it } from "vitest";
import {
	clusterFailure,
	compareCavecrewCandidates,
	replayArtifact,
	rescoreArtifact,
} from "../../src/core/evaluation/index.js";
import { builtInEvaluationScenarios } from "../../src/core/evaluation/packs.js";
import { calculateRetrievalMetrics } from "../../src/core/evaluation/retrieval.js";
import { runEvaluation } from "../../src/core/evaluation/runner.js";
import { aggregateStability } from "../../src/core/evaluation/stability.js";
import type { EvaluationArtifact, EvaluationEvent } from "../../src/core/evaluation/types.js";

async function artifactWithStatus(status: "pass" | "fail"): Promise<EvaluationArtifact> {
	const scenario = builtInEvaluationScenarios()[0]!;
	const events: EvaluationEvent[] =
		status === "pass"
			? [
					{
						eventId: "failure",
						type: "tool.failure",
						timestamp: "2026-01-01T00:00:00.000Z",
						details: { status: "pass" },
					},
				]
			: [];
	return runEvaluation(scenario, { mode: "fixture", executor: { execute: async () => ({ events }) } });
}

describe("evaluation runtime completion", () => {
	it("keeps every repetition and makes flakiness explicit", async () => {
		const passing = await artifactWithStatus("pass");
		const failing = await artifactWithStatus("fail");
		const result = aggregateStability([passing, failing]);
		expect(result.repetitions).toBe(2);
		expect(result.classification).toBe("flaky");
		expect(result.outcomeVariance).toBe(1);
	});

	it("creates immutable replay and rescore identities", async () => {
		const original = await artifactWithStatus("pass");
		const replay = replayArtifact(original);
		const rescore = rescoreArtifact(original, "2.0.0");
		expect(replay.artifactHash).not.toBe(original.artifactHash);
		expect(rescore.artifactHash).not.toBe(original.artifactHash);
		expect(replay.provenance.sourceRunIds).toEqual([original.run.evaluationRunId]);
		expect(rescore.provenance.evaluatorVersion).toBe("2.0.0");
	});

	it("calculates retrieval metrics with stale and duplicate penalties", () => {
		const result = calculateRetrievalMetrics({
			results: [
				{ resultId: "a", relevance: 3, current: true },
				{ resultId: "a", relevance: 3, current: true },
				{ resultId: "b", relevance: 0, current: false },
			],
			relevantResultIds: ["a", "c"],
			k: 3,
		});
		expect(result.recallAtK).toBe(0.5);
		expect(result.duplicateResultRate).toBeCloseTo(1 / 3);
		expect(result.staleResultRate).toBeCloseTo(1 / 3);
	});

	it("clusters failures from authoritative assertion fields", async () => {
		const artifact = await artifactWithStatus("fail");
		const cluster = clusterFailure(artifact);
		expect(cluster?.clusterId).toMatch(/^failure-[a-f0-9]{16}$/);
		expect(cluster?.key.assertionIds).toContain("failure-recorded");
	});

	it("does not infer a Cavecrew win from delegation alone", () => {
		const comparison = compareCavecrewCandidates({
			scenarioId: "s",
			fixtureHash: "f",
			candidates: [
				{
					candidateId: "single-agent",
					correctness: 1,
					safety: 1,
					wallTimeMs: 10,
					modelCalls: 1,
					tokens: 10,
					costUsd: 1,
					toolCalls: 1,
					retrievalUsage: 0,
					contextCompactions: 0,
					rollbackCount: 0,
					reviewerFindings: 0,
				},
				{
					candidateId: "cavecrew",
					correctness: 1,
					safety: 1,
					wallTimeMs: 20,
					modelCalls: 4,
					tokens: 40,
					costUsd: 2,
					toolCalls: 3,
					retrievalUsage: 1,
					contextCompactions: 0,
					rollbackCount: 0,
					reviewerFindings: 0,
				},
			],
		});
		expect(comparison.winner).toBe("tie");
	});
});
