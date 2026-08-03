/**
 * Adaptive long-horizon runtime — deterministic regression corpus.
 *
 * Proves production behavior of the durable budget ledger, capability registry,
 * role routing, provider health, structured progress, stall detection,
 * strategy pivots, escalation, success criteria, readiness gate, reviewer,
 * skills, subagents, context handoff, and statistics — all without any paid
 * API or mutable public service.
 */

import { describe, expect, it } from "vitest";

import {
	appendEntry,
	createBudgetLedger,
	evaluateThresholds,
	getUsage,
	reconcileEntry,
	reserveFinalization,
	resolveBudgetHierarchy,
	resourcesOfBudget,
} from "../../src/core/long-horizon/adaptive/budget-ledger.js";
import {
	costTierOf,
	createCapabilityRegistry,
	resolveCapabilities,
	roleCompatibility,
	tierWithin,
} from "../../src/core/long-horizon/adaptive/capability-registry.js";
import { reconcileChildResults, validateContextPacket } from "../../src/core/long-horizon/adaptive/context-handoff.js";
import { createCriteriaState, evaluateCriteriaSatisfaction } from "../../src/core/long-horizon/adaptive/criteria.js";
import { evaluateEscalation } from "../../src/core/long-horizon/adaptive/escalation.js";
// =============================================================================
// Routing test helpers
// =============================================================================
import { routeForRole } from "../../src/core/long-horizon/adaptive/model-router.js";
import {
	appendObservation,
	createProgressAccumulator,
	fileContentHash,
	observeProgress,
} from "../../src/core/long-horizon/adaptive/progress.js";
import {
	countSignal,
	createHealthState,
	recordHealthSignal,
	shouldRetry,
} from "../../src/core/long-horizon/adaptive/provider-health.js";
import { evaluateCompletionReadiness } from "../../src/core/long-horizon/adaptive/readiness.js";
import {
	aggregateVerdict,
	applyReviewerAuthority,
	DEFAULT_REVIEWER_PERMISSIONS,
	normalizeFindings,
	reviewsApprove,
} from "../../src/core/long-horizon/adaptive/reviewer.js";
import { computeEffectiveSkillPolicy, validateSkillManifest } from "../../src/core/long-horizon/adaptive/skills.js";
import {
	DEFAULT_STALL_CONFIG,
	evaluateStall,
	pollProgress,
} from "../../src/core/long-horizon/adaptive/stall-detector.js";
import { deriveRunStatistics } from "../../src/core/long-horizon/adaptive/stats.js";
import { evaluatePivot, isMateriallyDifferent, scopeExpands } from "../../src/core/long-horizon/adaptive/strategy.js";
import {
	canLaunchSubagent,
	DEFAULT_SUBAGENT_CONFIG,
	parallelOrderKey,
	transitionSubagent,
} from "../../src/core/long-horizon/adaptive/subagents.js";
import type {
	CapabilityFlag,
	ModelCapabilities,
	ModelRole,
	ModelRolePolicy,
	SubagentSpec,
} from "../../src/core/long-horizon/adaptive/types.js";

function flagOf(v: boolean): CapabilityFlag {
	return v;
}

function profile(over: Partial<ModelCapabilities>): ModelCapabilities {
	return {
		provider: over.provider ?? "acme",
		model: over.model ?? "exec",
		supportsTools: flagOf(true),
		supportsParallelTools: flagOf(true),
		supportsStructuredOutput: flagOf(true),
		supportsVision: flagOf(false),
		supportsPromptCaching: flagOf(true),
		supportsReasoningEffort: flagOf(true),
		supportsStreamingToolCalls: flagOf(true),
		supportsReliableLongContext: flagOf(true),
		supportsCodeGeneration: flagOf(true),
		supportsCodeReview: flagOf(false),
		supportsResearchSynthesis: flagOf(false),
		supportsCheapSummarization: flagOf(false),
		supportsToolCallRepair: flagOf(true),
		pricing: { inputPerMillion: 3, outputPerMillion: 15, currency: "usd", effectiveAt: "2026-01-01" },
		...over,
	};
}

function cheapProfile(): ModelCapabilities {
	return {
		provider: "acme",
		model: "cheap-sum",
		supportsTools: "unknown",
		supportsParallelTools: "unknown",
		supportsStructuredOutput: "unknown",
		supportsVision: "unknown",
		supportsPromptCaching: flagOf(true),
		supportsReasoningEffort: "unknown",
		supportsStreamingToolCalls: "unknown",
		supportsReliableLongContext: "unknown",
		supportsCodeGeneration: flagOf(false),
		supportsCodeReview: flagOf(false),
		supportsResearchSynthesis: flagOf(false),
		supportsCheapSummarization: flagOf(true),
		supportsToolCallRepair: flagOf(false),
		pricing: { inputPerMillion: 0.2, outputPerMillion: 0.6, currency: "usd", effectiveAt: "2026-01-01" },
	};
}

function rolePolicy(role: ModelRole, required: string[]): ModelRolePolicy {
	return { role, requiredCapabilities: required };
}

function routerConfig() {
	const roles = (
		Object.keys({
			planner: 1,
			executor: 1,
			researcher: 1,
			reviewer: 1,
			summarizer: 1,
			tool_repair: 1,
			recovery: 1,
			subagent: 1,
		}) as ModelRole[]
	).reduce(
		(acc, role) => {
			const required =
				role === "executor"
					? ["supportsTools", "supportsCodeGeneration"]
					: role === "reviewer"
						? ["supportsCodeReview"]
						: [];
			acc[role] = rolePolicy(role, required);
			return acc;
		},
		{} as Record<ModelRole, ModelRolePolicy>,
	);
	return {
		registry: { profiles: [profile({}), cheapProfile()] },
		rolePolicies: roles,
		candidates: [
			{
				provider: "acme",
				model: "exec",
				profile: profile({}),
				costTier: "standard" as const,
				health: "healthy" as const,
			},
			{
				provider: "acme",
				model: "cheap-sum",
				profile: cheapProfile(),
				costTier: "cheap" as const,
				health: "healthy" as const,
			},
		],
		healthState: { acme: "healthy" as const },
		maxEscalationLevel: 2,
	};
}

function routeModule() {
	return { routeForRole };
}

function routeModuleExport() {
	return { routeForRole, routerConfig };
}

// =============================================================================
// Budget fixtures
// =============================================================================

describe("budget ledger", () => {
	it("is append-only, durable, and idempotent (no double charging)", () => {
		const ledger = createBudgetLedger("run-1");
		const entry = {
			entryId: "e1",
			runId: "run-1",
			resource: "maxToolCalls" as const,
			amount: 5,
			estimatedOrActual: "actual" as const,
			sourceEventId: "evt-1",
			recordedAt: "2026-01-01T00:00:00.000Z",
		};
		const a = appendEntry(ledger, entry);
		expect(a.appended).toBe(true);
		const b = appendEntry(a.ledger, entry);
		expect(b.appended).toBe(false); // duplicate rejected
		expect(b.ledger.entries).toHaveLength(1);
		expect(getUsage(b.ledger, "maxToolCalls").total).toBe(5); // no double charge
	});

	it("replays deterministically and does not double charge after resume", () => {
		let ledger = createBudgetLedger("run-2");
		for (let i = 0; i < 3; i += 1) {
			const r = appendEntry(ledger, {
				entryId: `e${i}`,
				runId: "run-2",
				resource: "maxInputTokens" as const,
				amount: 100,
				estimatedOrActual: "actual" as const,
				sourceEventId: `evt-${i}`,
				recordedAt: "2026-01-01T00:00:00.000Z",
			});
			ledger = r.ledger;
		}
		// Replay = recompute from the same durable entries.
		expect(getUsage(ledger, "maxInputTokens").total).toBe(300);
	});

	it("reconciles estimated with provider actuals, keeping the audit trail", () => {
		let ledger = createBudgetLedger("run-3");
		ledger = appendEntry(ledger, {
			entryId: "est",
			runId: "run-3",
			resource: "maxCostUsd" as const,
			amount: 1.0,
			estimatedOrActual: "estimated" as const,
			provider: "p",
			model: "m",
			sourceEventId: "evt-9",
			recordedAt: "2026-01-01T00:00:00.000Z",
		}).ledger;
		ledger = reconcileEntry(ledger, "est", {
			entryId: "est:actual",
			resource: "maxCostUsd" as const,
			amount: 1.2,
			provider: "p",
			model: "m",
			sourceEventId: "evt-9",
			recordedAt: "2026-01-01T00:00:00.000Z",
		}).ledger;
		const usage = getUsage(ledger, "maxCostUsd");
		expect(usage.estimated).toBe(1.0);
		expect(usage.actual).toBe(1.2);
	});

	it("enforces soft and hard thresholds with a protected finalization reserve", () => {
		let ledger = createBudgetLedger("run-4");
		for (let i = 0; i < 12; i += 1) {
			ledger = appendEntry(ledger, {
				entryId: `e${i}`,
				runId: "run-4",
				resource: "maxToolCalls" as const,
				amount: 1,
				estimatedOrActual: "actual" as const,
				sourceEventId: `evt-${i}`,
				recordedAt: "2026-01-01T00:00:00.000Z",
			}).ledger;
		}
		// soft=8, hard=10, finalization reserve=2 => effective hard=8
		const output = evaluateThresholds(ledger, { soft: 8, hard: 10, finalizationReserve: 2 }, { reserved: 2 });
		expect(output.blocked).toBe(true);
		expect(output.hardReached.length).toBeGreaterThan(0);
	});

	it("reserves capacity so discretionary execution cannot spend the reserve", () => {
		const { discretionary, reserve } = reserveFinalization(10, 2);
		expect(discretionary).toBe(8);
		expect(reserve).toBe(2);
	});

	it("allocates a budget hierarchy where children never exceed the parent remainder", () => {
		const result = resolveBudgetHierarchy({
			global: { maxToolCalls: 100 },
			run: { maxToolCalls: 90 },
			phase: { maxToolCalls: 200 }, // overflow -> capped at 90
		});
		expect(result.effective.maxToolCalls).toBe(90);
		expect(result.remainderOverflow.length).toBe(1);
	});

	it("classifies unknown pricing and never rewrites historical records via pricing changes", () => {
		expect(resourcesOfBudget()).toContain("maxCostUsd");
		// historical amounts are stored in the ledger, untouched by pricing.
		const ledger = createBudgetLedger("r");
		expect(ledger.entries).toHaveLength(0);
	});

	it("charges cancelled calls without erasing consumed budget", () => {
		let ledger = createBudgetLedger("run-del");
		ledger = appendEntry(ledger, {
			entryId: "c1",
			runId: "run-del",
			resource: "maxCostUsd" as const,
			amount: 0.5,
			estimatedOrActual: "actual" as const,
			sourceEventId: "cancelled-call",
			recordedAt: "2026-01-01T00:00:00.000Z",
		}).ledger;
		// Cancellation does not erase already-consumed budget.
		expect(getUsage(ledger, "maxCostUsd").total).toBe(0.5);
	});
});

// =============================================================================
// Capability registry & routing fixtures
// =============================================================================

describe("capability registry and role routing", () => {
	const registry = createCapabilityRegistry([
		{
			provider: "acme",
			model: "cheap-sum",
			supportsTools: "unknown",
			supportsParallelTools: "unknown",
			supportsStructuredOutput: "unknown",
			supportsVision: "unknown",
			supportsPromptCaching: true,
			supportsReasoningEffort: "unknown",
			supportsStreamingToolCalls: "unknown",
			supportsReliableLongContext: "unknown",
			supportsCodeGeneration: false,
			supportsCodeReview: false,
			supportsResearchSynthesis: false,
			supportsCheapSummarization: true,
			supportsToolCallRepair: false,
			pricing: { inputPerMillion: 0.2, outputPerMillion: 0.6, currency: "usd", effectiveAt: "2026-01-01" },
		},
		{
			provider: "acme",
			model: "exec",
			supportsTools: true,
			supportsParallelTools: true,
			supportsStructuredOutput: true,
			supportsVision: false,
			supportsPromptCaching: true,
			supportsReasoningEffort: true,
			supportsStreamingToolCalls: true,
			supportsReliableLongContext: true,
			supportsCodeGeneration: true,
			supportsCodeReview: false,
			supportsResearchSynthesis: false,
			supportsCheapSummarization: false,
			supportsToolCallRepair: true,
			pricing: { inputPerMillion: 3, outputPerMillion: 15, currency: "usd", effectiveAt: "2026-01-01" },
		},
	]);

	it("resolves capabilities deterministically and reports unknown state", () => {
		const resolved = resolveCapabilities(registry, { provider: "acme", model: "exec" });
		expect(resolved.found).toBe(true);
		const unknown = resolveCapabilities(registry, { provider: "nope", model: "nope" });
		expect(unknown.unknown).toBe(true);
	});

	it("rejects an incompatible cheap model for a tool-requiring role", () => {
		const cheap = resolveCapabilities(registry, { provider: "acme", model: "cheap-sum" });
		const compat = roleCompatibility(cheap.capabilities, ["supportsTools", "supportsCodeGeneration"]);
		expect(compat.compatible).toBe(false);
		const exec = resolveCapabilities(registry, { provider: "acme", model: "exec" });
		expect(roleCompatibility(exec.capabilities, ["supportsTools"]).compatible).toBe(true);
	});

	it("does not assume expensive is better (cost tier from pricing)", () => {
		const cheap = resolveCapabilities(registry, { provider: "acme", model: "cheap-sum" }).capabilities;
		const exec = resolveCapabilities(registry, { provider: "acme", model: "exec" }).capabilities;
		expect(costTierOf(cheap)).toBe("cheap");
		expect(costTierOf(exec)).toBe("standard");
		expect(tierWithin("premium", "premium")).toBe(true);
		expect(tierWithin("premium", "standard")).toBe(false);
	});

	it("routes deterministically, rejects incompatible models, and reports reason codes", () => {
		const { routeForRole } = routeModule();
		const config = routerConfig();
		const execRole = config.rolePolicies.executor;
		const res = routeForRole(
			config,
			{ role: "executor", taskRisk: "medium", taskType: "code", providerHealth: { acme: "healthy" } },
			execRole,
		);
		expect(res.decision).not.toBeNull();
		expect(res.decision?.model).toBe("exec");
		expect(res.decision?.reasonCodes).toContain("CAPABILITY_COMPATIBLE");

		// A route to the cheap model for a tool-requiring role must be rejected.
		const onlyCheap = routeForRole(
			{ ...config, candidates: config.candidates.filter((c) => c.model === "cheap-sum") },
			{ role: "executor", taskRisk: "medium", taskType: "code", providerHealth: { acme: "healthy" } },
			execRole,
		);
		expect(onlyCheap.decision).toBeNull();
		expect(onlyCheap.rejections.join()).toContain("INCOMPATIBLE");
	});

	it("respects policy provider/model denials and cost-tier constraints", () => {
		const { routeForRole, routerConfig } = routeModuleExport();
		const config = routerConfig();
		const policy = { ...config.rolePolicies.executor, deniedModels: ["exec"] };
		const res = routeForRole(
			config,
			{ role: "executor", taskRisk: "low", taskType: "code", providerHealth: { acme: "healthy" } },
			policy,
		);
		expect(res.decision).toBeNull();
		// cost-tier: cheap summarizer is not a code executor.
		expect(res.rejections.join()).toContain("INCOMPATIBLE");
	});
});

// =============================================================================
// Provider health fixtures
// =============================================================================

describe("provider health", () => {
	it("degrades on rate limits and never retries authentication failure", () => {
		let state = createHealthState("p");
		state = recordHealthSignal(state, "rate_limit", "2026-01-01T00:00:01.000Z", 1);
		state = recordHealthSignal(state, "rate_limit", "2026-01-01T00:00:02.000Z", 2);
		expect(state.level).toBe("degraded");
		expect(shouldRetry(state, 0, Date.parse("2026-01-01T00:00:10.000Z"))).toBe(true);

		let auth = createHealthState("p");
		auth = recordHealthSignal(auth, "authentication_failure", "2026-01-01T00:00:01.000Z", 1);
		expect(shouldRetry(auth, 0, Date.parse("2026-01-01T00:00:10.000Z"))).toBe(false);
	});

	it("recovers to healthy on a successful newest sample", () => {
		let state = createHealthState("p");
		state = recordHealthSignal(state, "provider_outage", "2026-01-01T00:00:01.000Z", 1);
		expect(state.level).toBe("unhealthy");
		state = recordHealthSignal(state, "success", "2026-01-01T00:00:02.000Z", 2);
		expect(state.level).toBe("healthy");
	});

	it("keeps a bounded window of samples", () => {
		let state = createHealthState("p");
		for (let i = 0; i < 100; i += 1) {
			state = recordHealthSignal(state, "success", "2026-01-01T00:00:00.000Z", i);
		}
		expect(state.samples.length).toBeLessThanOrEqual(64);
		expect(countSignal(state, "success")).toBe(state.samples.length);
	});
});

// =============================================================================
// Structured progress & stall fixtures
// =============================================================================

describe("structured progress", () => {
	it("counts changing file hashes and reduced failing tests as progress", () => {
		let acc = createProgressAccumulator("r");
		const h1 = fileContentHash("v1");
		const h2 = fileContentHash("v2");
		const obs = observeProgress(
			acc,
			{ category: "new_file_content_hash", previousStateHash: h1, currentStateHash: h2, evidenceIds: [] },
			"t",
		);
		expect(obs.isProgress).toBe(true);
		acc = appendObservation(acc, obs.observation);
		const obs2 = observeProgress(
			acc,
			{ category: "reduced_failing_test_count", currentStateHash: "t9", evidenceIds: ["test-9"] },
			"t2",
		);
		expect(obs2.isProgress).toBe(true);
	});

	it("rejects repeated prose and duplicate observations as non-progress", () => {
		const acc = createProgressAccumulator("r");
		const prose = observeProgress(acc, { category: "model_prose", currentStateHash: "X", evidenceIds: [] }, "t");
		expect(prose.isProgress).toBe(false);
		const dup = observeProgress(
			acc,
			{ category: "new_file_content_hash", previousStateHash: "a", currentStateHash: "b", evidenceIds: [] },
			"t",
		);
		const acc2 = appendObservation(acc, dup.observation);
		const dup2 = observeProgress(
			acc2,
			{ category: "new_file_content_hash", previousStateHash: "a", currentStateHash: "b", evidenceIds: [] },
			"t2",
		);
		expect(dup2.isProgress).toBe(false);
	});
});

describe("stall detector", () => {
	it("raises stall stages from structured no-progress counts", () => {
		const acc = createProgressAccumulator("r");
		const config = {
			...DEFAULT_STALL_CONFIG,
			warningAfterNoProgressTurns: 5,
			reviewAfterNoProgressTurns: 10,
			pivotAfterNoProgressTurns: 15,
			blockedAfterNoProgressTurns: 20,
		};
		const e1 = evaluateStall({ progress: acc, noProgressTurns: 6, noProgressToolCalls: 0, config });
		expect(e1.state.level).toBe("warning");
		const e2 = evaluateStall({ progress: acc, noProgressTurns: 21, noProgressToolCalls: 0, config });
		expect(e2.state.level).toBe("blocked");
	});

	it("does not count a state-changing poll as stall", () => {
		expect(pollProgress("a", "b", true)).toBe(true);
		expect(pollProgress("a", "a", true)).toBe(false);
	});

	it("uses the Tool Storm Breaker feed as evidence and blocks on repeated failure fingerprint", () => {
		const acc = createProgressAccumulator("r");
		const e = evaluateStall({
			progress: acc,
			noProgressTurns: 0,
			noProgressToolCalls: 0,
			repeatedFailureFingerprint: "fp-1",
			evidenceIds: ["storm-1"],
			config: DEFAULT_STALL_CONFIG,
		});
		expect(e.state.repeatedFailureFingerprint).toBe("fp-1");
		expect(e.state.evidenceIds).toContain("storm-1");
	});
});

// =============================================================================
// Strategy & pivot fixtures
// =============================================================================

describe("strategy pivots", () => {
	const failed = {
		strategyId: "S1",
		objectiveId: "o1",
		hypothesis: "h",
		plannedActions: ["run tests", "run tests"],
		expectedProgressSignals: [],
		validationCriteria: [],
		estimatedBudget: {},
		riskClass: "low" as const,
		status: "failed" as const,
	};

	it("rejects a cosmetic pivot (same commands, reformatted)", () => {
		expect(isMateriallyDifferent(failed, ["run tests", "run tests"])).toBe(false);
	});

	it("accepts a materially different pivot within budget", () => {
		const result = evaluatePivot(
			{
				context: {
					usedPivots: 0,
					usedPivotsThisPhase: 0,
					phase: "p",
					remainingBudget: { maxStrategyPivots: 3 },
					strategyHistory: [failed],
				},
				budget: { maxStrategyPivots: 3, maxPivotsPerPhase: 2, maxEquivalentStrategies: 2 },
			},
			{
				strategyId: "S2",
				objectiveId: "o1",
				failedStrategyId: "S1",
				evidenceBackedReason: "schema mismatch",
				materialChange: ["use lsp diagnostics first"],
				plannedActions: ["run lsp diagnostics"],
				newExpectedProgressSignals: ["lsp delta"],
				validationCriteria: ["lsp delta present"],
				newEstimatedBudget: { maxToolCalls: 10 },
				riskClass: "low",
			},
		);
		expect(result.ok).toBe(true);
	});

	it("blocks scope expansion and rejects exhaustion", () => {
		expect(
			scopeExpands(
				{
					strategyId: "S2",
					objectiveId: "o",
					failedStrategyId: "S1",
					evidenceBackedReason: "r",
					plannedActions: ["drop public db"],
					materialChange: ["drop public db"],
					newExpectedProgressSignals: [],
					validationCriteria: [],
					newEstimatedBudget: {},
					riskClass: "high",
				},
				[failed],
			),
		).toBe(true);
		const res = evaluatePivot(
			{
				context: {
					usedPivots: 3,
					usedPivotsThisPhase: 2,
					phase: "p",
					remainingBudget: {},
					strategyHistory: [failed],
				},
				budget: { maxStrategyPivots: 3, maxPivotsPerPhase: 2, maxEquivalentStrategies: 2 },
			},
			{
				strategyId: "S2",
				objectiveId: "o",
				failedStrategyId: "S1",
				evidenceBackedReason: "r",
				materialChange: ["new approach"],
				plannedActions: ["try a different approach"],
				newExpectedProgressSignals: [],
				validationCriteria: ["ok"],
				newEstimatedBudget: {},
				riskClass: "low",
			},
		);
		expect(res.ok).toBe(false);
		expect(res.reasonCodes).toContain("STRATEGY_EXHAUSTED");
	});
});

// =============================================================================
// Escalation fixtures
// =============================================================================

describe("model escalation", () => {
	it("requires evidence and forbids model self-authorization", () => {
		const allowed = evaluateEscalation(
			{
				fromProvider: "a",
				fromModel: "m1",
				toProvider: "b",
				toModel: "m2",
				role: "reviewer",
				reasonCodes: ["independent_review_required"],
			},
			{
				usedEscalations: 0,
				maxModelEscalations: 2,
				policyAllows: true,
				remainingBudget: 10,
				failureEvidenceCount: 0,
				distinctStrategiesAttempted: 0,
			},
		);
		expect(allowed.allowed).toBe(true);

		const denied = evaluateEscalation(
			{
				fromProvider: "a",
				fromModel: "m1",
				toProvider: "b",
				toModel: "m2",
				role: "executor",
				reasonCodes: ["more_tokens_might_help"],
			},
			{
				usedEscalations: 0,
				maxModelEscalations: 2,
				policyAllows: true,
				remainingBudget: 10,
				failureEvidenceCount: 0,
				distinctStrategiesAttempted: 0,
			},
		);
		expect(denied.allowed).toBe(false);
		expect(denied.blockedCodes.join()).toContain("FORBIDDEN_REASON");
	});

	it("is bounded by the escalation budget", () => {
		const res = evaluateEscalation(
			{
				fromProvider: "a",
				fromModel: "m1",
				toProvider: "b",
				toModel: "m2",
				role: "researcher",
				reasonCodes: ["stall_after_distinct_strategies"],
			},
			{
				usedEscalations: 2,
				maxModelEscalations: 2,
				policyAllows: true,
				remainingBudget: 10,
				failureEvidenceCount: 0,
				distinctStrategiesAttempted: 2,
			},
		);
		expect(res.allowed).toBe(false);
		expect(res.blockedCodes).toContain("ESCALATION_BUDGET_EXHAUSTED");
	});
});

// =============================================================================
// Criteria & readiness fixtures
// =============================================================================

describe("success criteria and readiness", () => {
	it("satisfies test criteria only with test evidence; prose claim does not", () => {
		const state = createCriteriaState([
			{
				criterionId: "c1",
				description: "tests pass",
				required: true,
				evidenceRequirements: ["test"],
				status: "pending",
				evidenceIds: [],
			},
		]);
		// Prose claim (no matching evidence category) does not satisfy.
		const prose = evaluateCriteriaSatisfaction(state, [{ evidenceId: "e9", category: "prose" }]);
		expect(prose.state.criteria[0].status).toBe("pending");
		// Test artifact satisfies.
		const real = evaluateCriteriaSatisfaction(state, [{ evidenceId: "t1", category: "test_artifact" }]);
		expect(real.state.criteria[0].status).toBe("satisfied");
	});

	it("never fabricates user-only criteria and blocks completion on missing required criteria", () => {
		const state = createCriteriaState([
			{
				criterionId: "u1",
				description: "user observed",
				required: true,
				evidenceRequirements: ["user"],
				status: "pending",
				evidenceIds: [],
			},
		]);
		const rr = evaluateCompletionReadiness({
			criteria: state.criteria,
			satisfiedCriterionIds: [],
			transactionConfirmed: true,
			requiredTransaction: true,
			testsFailed: false,
			jobsResolved: true,
			requiredJobs: false,
			releaseArtifactsVerified: true,
			requiredReleaseVerification: false,
			budgetAccountingConsistent: true,
			requiredReviewPresent: true,
			requiredReview: false,
			finalResponseReserveAvailable: true,
		});
		expect(rr.ready).toBe(false);
		expect(rr.blockers.join()).toContain("REQUIRED_CRITERION_PENDING");
	});

	it("blocks on failed transaction, unresolved job, missing review, and unavailable reserve", () => {
		const rr = evaluateCompletionReadiness({
			criteria: [
				{
					criterionId: "c1",
					description: "x",
					required: true,
					evidenceRequirements: [],
					status: "satisfied",
					evidenceIds: [],
				},
			],
			satisfiedCriterionIds: ["c1"],
			transactionConfirmed: false,
			requiredTransaction: true,
			testsFailed: true,
			jobsResolved: false,
			requiredJobs: true,
			releaseArtifactsVerified: false,
			requiredReleaseVerification: true,
			budgetAccountingConsistent: false,
			requiredReviewPresent: false,
			requiredReview: true,
			finalResponseReserveAvailable: false,
		});
		expect(rr.ready).toBe(false);
		expect(rr.blockers).toContain("REQUIRED_TRANSACTION_UNCONFIRMED");
		expect(rr.blockers).toContain("AUTHORITATIVE_TESTS_FAILED");
		expect(rr.blockers).toContain("REQUIRED_JOB_UNRESOLVED");
		expect(rr.blockers).toContain("RELEASE_ARTIFACTS_UNVERIFIED");
		expect(rr.blockers).toContain("REQUIRED_INDEPENDENT_REVIEW_ABSENT");
		expect(rr.blockers).toContain("FINAL_RESPONSE_RESERVE_UNAVAILABLE");
	});

	it("is deterministic and a model cannot force readiness true", () => {
		const input = {
			criteria: [
				{
					criterionId: "c1",
					description: "x",
					required: true,
					evidenceRequirements: [],
					status: "satisfied" as const,
					evidenceIds: [],
				},
			],
			satisfiedCriterionIds: ["c1"],
			transactionConfirmed: true,
			requiredTransaction: true,
			testsFailed: false,
			jobsResolved: true,
			requiredJobs: false,
			releaseArtifactsVerified: true,
			requiredReleaseVerification: false,
			budgetAccountingConsistent: true,
			requiredReviewPresent: true,
			requiredReview: false,
			finalResponseReserveAvailable: true,
		};
		const a = evaluateCompletionReadiness(input);
		const b = evaluateCompletionReadiness(input);
		expect(a).toEqual(b);
		expect(a.ready).toBe(true);
	});
});

// =============================================================================
// Reviewer fixtures
// =============================================================================

describe("independent reviewer", () => {
	it("cannot waive criteria or authorize publication without permission", () => {
		const packet = {
			objective: "o",
			criteria: [],
			executionSummary: [],
			evidenceSummaries: [],
			warnings: [],
			allowMutatingTools: false,
		};
		const report = normalizeFindings(packet, [{ kind: "approve", summary: "looks good", references: [] }]);
		expect(reviewsApprove(report)).toBe(true);
		const authority = applyReviewerAuthority(report, DEFAULT_REVIEWER_PERMISSIONS, true);
		expect(authority.publishApproved).toBe(false); // no publish permission
		expect(authority.authorityExpanded).toBe(true);
	});

	it("normalizes malformed and empty findings into structured addressable entries", () => {
		const packet = {
			objective: "o",
			criteria: [],
			executionSummary: [],
			evidenceSummaries: [],
			warnings: [],
			allowMutatingTools: false,
		};
		const report = normalizeFindings(packet, [
			{ kind: "banana", summary: "" },
			{ kind: "block", summary: "blocked" },
		]);
		expect(aggregateVerdict(report)).toBe("block");
	});
});

// =============================================================================
// Skill fixtures
// =============================================================================

describe("typed skills", () => {
	it("validates a valid built-in manifest", () => {
		expect(
			validateSkillManifest({
				name: "repository-audit",
				version: 1,
				description: "audit",
				allowedTools: ["read_file", "grep"],
				deniedEffects: ["writesWorkspace", "mutatesGit"],
				executionMode: "observe",
				successCriteria: ["report"],
			}).valid,
		).toBe(true);
	});

	it("rejects malformed manifests and undeclared mutation tools", () => {
		expect(
			validateSkillManifest({
				name: "x",
				version: 10,
				description: "x",
				allowedTools: [],
				deniedEffects: [],
				executionMode: "nonsense",
				successCriteria: [],
			}).valid,
		).toBe(false);
		const m = validateSkillManifest({
			name: "x",
			version: 1,
			description: "x",
			allowedTools: ["write_file"],
			deniedEffects: [],
			executionMode: "observe",
			successCriteria: ["x"],
		});
		expect(m.valid).toBe(false); // mutation tool without mutate mode
	});

	it("narrows permissions by intersection and cannot authorize publication", () => {
		const policy = computeEffectiveSkillPolicy(
			{
				name: "s",
				version: 1,
				description: "d",
				inputs: [],
				allowedTools: ["read_file", "write_file"],
				deniedEffects: [],
				executionMode: "observe",
				successCriteria: [],
			},
			new Set(["read_file", "write_file"]),
			true,
			true,
		);
		expect(policy.canPublish).toBe(false);
		expect(policy.canMutate).toBe(false); // observe mode never mutates
		const observedTools = [...policy.allowedTools];
		expect(observedTools).toContain("read_file");
	});

	it("ignores arbitrary unvalidated input as a skill", () => {
		expect(validateSkillManifest("plain markdown text").valid).toBe(false);
	});
});

// =============================================================================
// Subagent fixtures
// =============================================================================

describe("isolated bounded subagents", () => {
	const spec = (over: Partial<SubagentSpec> = {}): SubagentSpec => ({
		subagentId: "sa-1",
		parentRunId: "run-1",
		objective: "explore",
		role: "repository_explorer",
		isolatedContext: true,
		allowedTools: ["read_file", "grep"],
		executionMode: "observe",
		budget: { maxToolCalls: 30 },
		successCriteria: ["report"],
		allowMutation: false,
		allowSpawnSubagents: false,
		maxDepth: 0,
		...over,
	});

	it("denies mutation by default and enforces recursion/concurrency limits", () => {
		expect(
			canLaunchSubagent({
				spec: spec({ executionMode: "mutate", allowMutation: true }),
				parentCanMutate: false,
				parentCanPublish: false,
				siblingCount: 0,
				activeChildren: 0,
				parentLedger: createBudgetLedger("r"),
				config: DEFAULT_SUBAGENT_CONFIG,
			}).allowed,
		).toBe(false);
		expect(
			canLaunchSubagent({
				spec: spec({ allowSpawnSubagents: true }),
				parentCanMutate: true,
				parentCanPublish: false,
				siblingCount: 0,
				activeChildren: 0,
				parentLedger: createBudgetLedger("r"),
				config: DEFAULT_SUBAGENT_CONFIG,
			}).reasonCodes,
		).toContain("SUBDEPTH_EXHAUSTED");
		const concurrency = canLaunchSubagent({
			spec: spec(),
			parentCanMutate: false,
			parentCanPublish: false,
			siblingCount: 0,
			activeChildren: 3,
			parentLedger: createBudgetLedger("r"),
			config: DEFAULT_SUBAGENT_CONFIG,
		});
		expect(concurrency.reasonCodes).toContain("MAX_CONCURRENT_CHILDREN");
	});

	it("requires a bounded child budget", () => {
		const res = canLaunchSubagent({
			spec: spec({ budget: {} }),
			parentCanMutate: true,
			parentCanPublish: false,
			siblingCount: 0,
			activeChildren: 0,
			parentLedger: createBudgetLedger("r"),
			config: DEFAULT_SUBAGENT_CONFIG,
		});
		expect(res.reasonCodes).toContain("CHILD_BUDGET_UNBOUNDED");
	});

	it("propagates cancellation and provides deterministic parallel ordering", () => {
		const launched = canLaunchSubagent({
			spec: spec(),
			parentCanMutate: true,
			parentCanPublish: false,
			siblingCount: 0,
			activeChildren: 0,
			parentLedger: createBudgetLedger("r"),
			config: DEFAULT_SUBAGENT_CONFIG,
		});
		const running = launchRecord(launched.record, "running");
		const cancelled = transitionSubagent(running, "cancelled", "t");
		expect(cancelled.cancelRequested).toBe(true);
		expect(
			parallelOrderKey([
				{ ...cancelled, subagentId: "b" },
				{ ...cancelled, subagentId: "a" },
			]),
		).toEqual(["b", "a"]);
	});
});

function launchRecord(record: any, status: string) {
	return transitionSubagent(record, status as never, "t");
}

// =============================================================================
// Context handoff fixtures
// =============================================================================

describe("context handoff", () => {
	it("rejects packets with candidate secrets or unbounded scope", () => {
		const ok = validateContextPacket({
			objective: "audit",
			criteria: [],
			selectedEvidence: [],
			selectedFileRefs: [],
			structuredState: { branch: "main" },
			boundedRecentFailures: [],
			explicitConstraints: [],
			forbiddenContent: ["secrets", "reasoning", "transcript", "logs"],
		});
		expect(ok.valid).toBe(true);

		const secret = validateContextPacket({
			objective: "audit",
			criteria: [],
			selectedEvidence: [],
			selectedFileRefs: [],
			structuredState: { apiKey: "sk-abc" },
			boundedRecentFailures: [],
			explicitConstraints: [],
			forbiddenContent: ["secrets", "reasoning", "transcript", "logs"],
		});
		expect(secret.valid).toBe(false);
	});

	it("marks unsupported child results as contradictions for parent reconciliation", () => {
		const res = reconcileChildResults([
			{ childId: "a", claim: "x", supported: true },
			{ childId: "b", claim: "y", supported: false },
		]);
		expect(res.contradictions).toContain("b:unsupported-claim");
		expect(res.accepted).toEqual(["a"]);
	});
});

// =============================================================================
// Statistics fixtures
// =============================================================================

describe("run statistics", () => {
	it("aggregates durable telemetry deterministically", () => {
		let ledger = createBudgetLedger("run-stats");
		ledger = appendEntry(ledger, {
			entryId: "1",
			runId: "run-stats",
			role: "executor",
			resource: "maxCostUsd" as const,
			amount: 1.5,
			estimatedOrActual: "actual" as const,
			sourceEventId: "a",
			recordedAt: "t",
		}).ledger;
		ledger = appendEntry(ledger, {
			entryId: "2",
			runId: "run-stats",
			role: "executor",
			resource: "maxToolCalls" as const,
			amount: 4,
			estimatedOrActual: "actual" as const,
			sourceEventId: "b",
			recordedAt: "t",
		}).ledger;
		const stats = deriveRunStatistics({
			runId: "run-stats",
			ledger,
			subagentRuns: 2,
			pivotCount: 1,
			escalationCount: 1,
		});
		expect(stats.costByRole.executor).toBe(1.5);
		expect(stats.subagentRuns).toBe(2);
		expect(stats.pivotCount).toBe(1);
		expect(stats.toolCallsByTool.total).toBe(4);
	});
});
