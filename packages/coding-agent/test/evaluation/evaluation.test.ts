import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateAssertion } from "../../src/core/evaluation/assertions.js";
import { createBaseline } from "../../src/core/evaluation/baselines.js";
import { compareArtifacts } from "../../src/core/evaluation/comparison.js";
import { checkReleaseGate } from "../../src/core/evaluation/gates.js";
import { hashJson, scenarioContentHash } from "../../src/core/evaluation/identity.js";
import { builtInEvaluationPacks, builtInEvaluationScenarios } from "../../src/core/evaluation/packs.js";
import { runEvaluation } from "../../src/core/evaluation/runner.js";
import { comparePairedResults } from "../../src/core/evaluation/statistics.js";
import type { EvaluationEvent, EvaluationScenario } from "../../src/core/evaluation/types.js";
import { validatePack, validateScenario } from "../../src/core/evaluation/validation.js";

describe("evaluation quality gates", () => {
	it("validates built-in versioned packs and rejects duplicate scenarios", () => {
		const scenarios = builtInEvaluationScenarios();
		const packs = builtInEvaluationPacks();
		expect(packs.every((pack) => validatePack(pack, scenarios).valid)).toBe(true);
		const duplicate = { ...scenarios[0]!, scenarioId: scenarios[1]!.scenarioId };
		expect(validateScenario(duplicate).valid).toBe(true);
		expect(
			validatePack({ ...packs[0]!, scenarios: [scenarios[0]!.scenarioId, scenarios[0]!.scenarioId] }, scenarios)
				.valid,
		).toBe(false);
	});

	it("keeps scenario identity content-addressed", () => {
		const scenario = builtInEvaluationScenarios()[0]!;
		expect(scenarioContentHash(scenario)).toBe(scenarioContentHash(structuredClone(scenario)));
		expect(hashJson({ b: 1, a: 2 })).toBe(hashJson({ a: 2, b: 1 }));
	});

	it("enforces workspace boundaries in assertions", async () => {
		const root = await mkdtemp(join(tmpdir(), "jensen-eval-test-"));
		try {
			const result = await evaluateAssertion(
				{ assertionId: "escape", kind: "file_exists", path: "../outside" },
				{ workspaceRoot: root, events: [], metrics: {}, evidenceIds: new Set(), timeoutMs: 1000 },
			);
			expect(result.status).toBe("invalid");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not let missing evidence pass", async () => {
		const result = await evaluateAssertion(
			{ assertionId: "evidence", kind: "evidence_linkage", expected: "missing" },
			{ events: [], metrics: {}, evidenceIds: new Set(), timeoutMs: 1000 },
		);
		expect(result.status).toBe("fail");
	});

	it("runs deterministic fixture evaluation without live calls", async () => {
		const scenario = builtInEvaluationScenarios()[0]!;
		const events: EvaluationEvent[] = [
			{ eventId: "failure", type: "tool.failure", timestamp: new Date().toISOString(), details: { status: "pass" } },
		];
		const artifact = await runEvaluation(scenario, {
			mode: "fixture",
			executor: { execute: async () => ({ events }) },
		});
		expect(artifact.verdict).toBe("pass");
		expect(artifact.artifactHash).toMatch(/^[a-f0-9]{64}$/);
	});

	it("rejects live mode unless explicitly opted in", async () => {
		const scenario: EvaluationScenario = {
			...builtInEvaluationScenarios()[0]!,
			candidatePolicy: {
				...builtInEvaluationScenarios()[0]!.candidatePolicy,
				allowedModes: ["live"],
				allowLiveProvider: true,
			},
		};
		await expect(
			runEvaluation(scenario, { mode: "live", live: true, budget: { maximumCostUsd: 1 } }),
		).rejects.toThrow("JENSEN_EVAL_LIVE");
	});

	it("detects paired correctness and safety regressions", async () => {
		const scenario = builtInEvaluationScenarios()[0]!;
		const passing = await runEvaluation(scenario, {
			mode: "fixture",
			executor: {
				execute: async () => ({
					events: [
						{
							eventId: "failure",
							type: "tool.failure",
							timestamp: new Date().toISOString(),
							details: { status: "pass" },
						},
					],
				}),
			},
		});
		const failing = await runEvaluation(scenario, {
			mode: "fixture",
			executor: { execute: async () => ({ events: [] }) },
		});
		const comparison = compareArtifacts(passing, failing);
		expect(comparison.deterministicComparison.baselinePassed).toBe(true);
		expect(comparison.deterministicComparison.candidatePassed).toBe(false);
	});

	it("classifies paired statistics and blocks safety failures", async () => {
		const comparison = comparePairedResults([
			{
				scenarioId: "s",
				baselineRunId: "a",
				candidateRunId: "b",
				deterministicComparison: { baselinePassed: false, candidatePassed: true },
				metricDeltas: {},
			},
		]);
		expect(comparison.winRate).toBe(1);
		const root = await mkdtemp(join(tmpdir(), "jensen-eval-baseline-"));
		try {
			const artifact = await runEvaluation(builtInEvaluationScenarios()[0]!, {
				mode: "fixture",
				executor: {
					execute: async () => ({
						events: [
							{
								eventId: "failure",
								type: "tool.failure",
								timestamp: new Date().toISOString(),
								details: { status: "pass" },
							},
						],
					}),
				},
			});
			const baseline = await createBaseline(
				root,
				{
					artifactIds: [artifact.artifactHash],
					createdAt: new Date().toISOString(),
					candidate: artifact.candidate,
					packId: "core-runtime",
					packVersion: "1.0.0",
				},
				[artifact],
			);
			expect(baseline.baselineId).toContain("baseline-");
			const gate = checkReleaseGate(
				{
					gateId: "g",
					scenarioPack: "core-runtime",
					baselineId: baseline.baselineId,
					requiredScenarioPasses: [artifact.scenario.scenarioId],
					forbiddenRegressions: [],
					maximumCriticalSafetyFailures: 0,
					maximumHighSafetyFailures: 0,
					flakinessPolicy: { rejectNewFlakiness: true, minimumRepetitions: 1 },
				},
				[artifact],
				[artifact],
			);
			expect(gate.passed).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
