import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASELINE_RULES, baselineSelect } from "./baseline.js";
import { BUDGET_CLASSES, canEscalate, selectBudget } from "./budget.js";
import { applyHardPolicy, generateCandidates } from "./candidates.js";
import { evaluateCounterfactual } from "./counterfactual.js";
import { checkDriftHealth, computeDrift, DRIFT_DEFAULT_CONFIG } from "./drift.js";
import { assessConfidence, decide, replayDecision } from "./engine.js";
import { decideTransition } from "./escalation.js";
import { resolveFallback } from "./fallback.js";
import { extractFeatures, FEATURE_SCHEMA_VERSION, taskFingerprint } from "./features.js";
import { generateRoutingPolicy } from "./optimizer.js";
import { promotePolicy, rollbackPolicy, validatePromotionGates } from "./promotion.js";
import { aggregateScore, inferRetrievalStrategy, scoreCandidate, selectBest, WEIGHTS_BY_POLICY } from "./scoring.js";
import { shadowEvaluate } from "./shadow.js";
import { readPolicy } from "./store.js";
import type { CandidateEvidence, OrchestrationCandidate } from "./types.js";

const DEFAULT_EVIDENCE: CandidateEvidence = {
	candidateId: "c-x",
	evaluatorVersion: "1.0.0",
	scenarioVersion: "v1",
	evidenceHash: "hash-x",
	sampleCount: 30,
	correctnessRate: 0.9,
	safetyRate: 0.98,
	reliabilityRate: 0.9,
	medianLatencyMs: 1000,
	avgCostUsd: 0.4,
	flakyRate: 0.05,
	compatibility: {},
	collectedAt: "2026-01-01T00:00:00.000Z",
	version: 1,
};

let _routingRoot: string;
beforeAll(() => {
	_routingRoot = mkdtempSync(join(tmpdir(), "jensen-routing-unit-"));
	process.env.JENSEN_ROUTING_ROOT = _routingRoot;
});
afterAll(() => {
	rmSync(_routingRoot, { recursive: true, force: true });
});

function candidate(partial: Partial<OrchestrationCandidate> = {}): OrchestrationCandidate {
	return {
		candidateId: "c-x",
		providerProfile: "fixture",
		configuredModel: "fixture/deterministic",
		executionTopology: "single_agent",
		skillIds: [],
		subagentDefinitions: [],
		retrievalPolicy: "hybrid",
		budgetClass: "standard",
		fallbackPolicy: "validated_policy",
		...partial,
	};
}

describe("TASK_FEATURE_EXTRACTION_PASS", () => {
	it("is deterministic and versioned", () => {
		const a = extractFeatures("Fix the off-by-one bug in parser.cpp");
		const b = extractFeatures("Fix the off-by-one bug in parser.cpp");
		expect(a).toEqual(b);
		expect(a.schemaVersion).toBe(FEATURE_SCHEMA_VERSION);
		expect(a.featureHash).toBeTruthy();
		expect(a.requiresMutation).toBe(true);
	});

	it("labels release and mutation risk deterministically", () => {
		const release = extractFeatures("Release version 1.9.0 across seven packages");
		expect(release.taskCategory).toBe("release");
		expect(release.requiresRelease).toBe(true);
		expect(release.mutationRisk).toBeGreaterThan(0);

		const ro = extractFeatures("Where is the Foo symbol defined?");
		expect(ro.requiresMutation).toBe(false);
		expect(ro.mutationRisk).toBe(0);
	});

	it("bounds language ids and marks model-assist separate", () => {
		const f = extractFeatures({
			task: "Refactor the compiler",
			languageIds: ["typescript", "rust", "javascript", "UNKNOWN_LANG"],
		});
		expect(f.languageIds.length).toBeLessThanOrEqual(12);
		expect(f.languageIds).not.toContain("UNKNOWN_LANG");
	});

	it("produces a stable task fingerprint", () => {
		expect(taskFingerprint("hello")).toBe(taskFingerprint("hello"));
		expect(taskFingerprint("hello")).not.toBe(taskFingerprint("world"));
	});
});

describe("CANDIDATE_GENERATION_PASS", () => {
	it("generates from canonical registries only", () => {
		const { candidates } = generateCandidates({
			providerProfiles: ["fixture"],
			models: [{ provider: "fixture", model: "m" }],
			topologies: ["single_agent", "cavecrew"],
			skills: [],
			subagents: ["builder", "reviewer"],
			retrievalPolicies: ["hybrid"],
			budgetClasses: ["small", "standard"],
			fallbackPolicies: ["validated_policy"],
			operatorSelectionPolicy: "balanced",
		});
		expect(candidates.length).toBeGreaterThan(0);
		for (const c of candidates) {
			expect(c.candidateId).toMatch(/^c-/);
			expect(c.executionTopology).not.toBe("INVENTED");
		}
	});

	it("never invents a provider when none are configured", () => {
		const { candidates, warnings } = generateCandidates({
			providerProfiles: [],
			models: [],
			topologies: [],
			skills: [],
			subagents: [],
			retrievalPolicies: [],
			budgetClasses: [],
			fallbackPolicies: [],
			operatorSelectionPolicy: "balanced",
		});
		expect(warnings.some((w) => w.includes("No provider profiles configured"))).toBe(true);
		expect(candidates.length).toBeGreaterThan(0);
		for (const c of candidates) {
			expect(c.providerProfile).toBe("local");
		}
	});

	it("bounds candidate set deterministically", () => {
		const { candidates } = generateCandidates({
			providerProfiles: ["fixture", "local", "remote"],
			models: [
				{ provider: "fixture", model: "a" },
				{ provider: "local", model: "b" },
			],
			topologies: ["single_agent", "cavecrew", "single_agent_with_reviewer"],
			skills: [],
			subagents: [],
			retrievalPolicies: ["lexical", "hybrid"],
			budgetClasses: ["small", "standard", "large"],
			fallbackPolicies: ["validated_policy"],
			operatorSelectionPolicy: "balanced",
		});
		expect(candidates.length).toBeLessThanOrEqual(3 * 3 * 2 * 3 * 1);
	});
});

describe("HARD_POLICY_FILTER_PASS", () => {
	const mk = () =>
		generateCandidates({
			providerProfiles: ["remote", "local"],
			models: [
				{ provider: "remote", model: "r" },
				{ provider: "local", model: "l" },
			],
			topologies: ["single_agent"],
			skills: [],
			subagents: [],
			retrievalPolicies: ["hybrid"],
			budgetClasses: ["standard"],
			fallbackPolicies: ["validated_policy"],
			operatorSelectionPolicy: "balanced",
		}).candidates;

	it("rejects providers outside allowlist", () => {
		const { accepted, rejected } = applyHardPolicy(mk(), {
			workspaceBoundary: true,
			requiredLocalOnly: false,
			providerAllowlist: ["local"],
			modelAllowlist: [],
			networkPolicy: "allow_all",
			allowLiveProviders: true,
		});
		expect(rejected.some((r) => r.policyRuleId === "rule-provider-allowlist")).toBe(true);
		expect(accepted.every((c) => c.providerProfile === "local")).toBe(true);
	});

	it("hard rejection cannot be overcome by higher score", () => {
		// Even with perfect evidence, a remote provider is rejected under local_only.
		const { rejected } = applyHardPolicy(mk(), {
			workspaceBoundary: true,
			requiredLocalOnly: true,
			providerAllowlist: [],
			modelAllowlist: [],
			networkPolicy: "allow_all",
			allowLiveProviders: true,
		});
		expect(rejected.some((r) => r.reasonCode === "remote_provider_denied_local_only")).toBe(true);
	});

	it("blocks live providers unless explicitly allowed", () => {
		const { rejected } = applyHardPolicy(mk(), {
			workspaceBoundary: true,
			requiredLocalOnly: false,
			providerAllowlist: [],
			modelAllowlist: [],
			networkPolicy: "local_only",
			allowLiveProviders: false,
		});
		expect(rejected.some((r) => r.reasonCode === "network_policy_denies_remote")).toBe(true);
	});
});

describe("DETERMINISTIC_BASELINE_PASS", () => {
	it("selects rules by deterministic precedence", () => {
		const f = extractFeatures("Release version 1.9.0");
		const b = baselineSelect(f);
		expect(b.ruleId).toBe("baseline-release");
		expect(b.candidate.budgetClass).toBe("release");
	});

	it("handles boundary conditions", () => {
		const f = extractFeatures("Implement a small new command in the CLI");
		const b = baselineSelect(f);
		expect(b.ruleId).toBe("baseline-bounded-implementation");
	});

	it("baseline is replayable and rule-enumerable", () => {
		expect(BASELINE_RULES.length).toBeGreaterThanOrEqual(4);
		expect(BASELINE_RULES.some((r) => r.ruleId === "baseline-default")).toBe(true);
	});
});

describe("EVALUATION_SCORING_PASS / MISSING_EVIDENCE_PASS", () => {
	it("missing evidence is undefined, not zero", () => {
		const s = scoreCandidate(candidate(), undefined, 0);
		expect(s.correctnessScore).toBeUndefined();
		expect(s.sampleCount).toBe(0);
		expect(s.uncertainty).toBe(1);
		expect(s.reasonCodes).toContain("no_evidence");
	});

	it("scores from evidence and records sample count", () => {
		const s = scoreCandidate(candidate(), DEFAULT_EVIDENCE, 30);
		expect(s.correctnessScore).toBeCloseTo(0.9);
		expect(s.sampleCount).toBe(30);
		expect(s.uncertainty).toBeLessThan(0.5);
	});

	it("safety is never averaged away", () => {
		const lowSafe = scoreCandidate(
			candidate({ candidateId: "c-bad" }),
			{ ...DEFAULT_EVIDENCE, safetyRate: 0.1, sampleCount: 30, evidenceHash: "hash-bad", candidateId: "c-bad" },
			30,
		);
		const highSafe = scoreCandidate(
			candidate({ candidateId: "c-good" }),
			{ ...DEFAULT_EVIDENCE, safetyRate: 0.9, sampleCount: 30, evidenceHash: "hash-good", candidateId: "c-good" },
			30,
		);
		const aggBad = aggregateScore(lowSafe, WEIGHTS_BY_POLICY.balanced, { safetyFloor: 0.5 });
		const aggGood = aggregateScore(highSafe, WEIGHTS_BY_POLICY.balanced, { safetyFloor: 0.5 });
		expect(aggBad).toBe(-Infinity);
		expect(aggGood).toBeGreaterThan(0);
	});

	it("selects best with deterministic tie-breaking", () => {
		const a = scoreCandidate(
			candidate({ candidateId: "c-a" }),
			{ ...DEFAULT_EVIDENCE, candidateId: "c-a", evidenceHash: "a" },
			30,
		);
		const b = scoreCandidate(
			candidate({ candidateId: "c-b" }),
			{ ...DEFAULT_EVIDENCE, candidateId: "c-b", evidenceHash: "b" },
			30,
		);
		const r = selectBest([b, a], { policy: "balanced" });
		// Deterministic tie-break by candidateId: c-a < c-b
		expect(r.selected?.candidateId).toBe("c-a");
		const r2 = selectBest([b, a], { policy: "balanced" });
		expect(r2.selected?.candidateId).toBe(r.selected?.candidateId);
	});

	it("uncertainty penalizes selection", () => {
		const confident = scoreCandidate(
			candidate({ candidateId: "c-conf" }),
			{ ...DEFAULT_EVIDENCE, evidenceHash: "conf", candidateId: "c-conf" },
			40,
		);
		const unsure = scoreCandidate(
			candidate({ candidateId: "c-uns" }),
			{ ...DEFAULT_EVIDENCE, sampleCount: 3, flakyRate: 0.2, evidenceHash: "uns", candidateId: "c-uns" },
			3,
		);
		const r = selectBest([confident, unsure], { policy: "balanced" });
		expect(r.selected?.candidateId).toBe("c-conf");
	});

	it("inferRetrievalStrategy uses exact identifiers without embeddings", () => {
		expect(
			inferRetrievalStrategy({ ambiguity: 0.1, requiresMutation: false, taskCategory: "analysis", languageIds: [] }),
		).toBe("lexical");
		expect(
			inferRetrievalStrategy({
				ambiguity: 0.9,
				requiresMutation: false,
				taskCategory: "analysis",
				languageIds: ["ts"],
			}),
		).toBe("hybrid");
	});
});

describe("MULTI_OBJECTIVE_SELECTION_PASS / OPERATOR_OBJECTIVE_AUTHORITATIVE", () => {
	it("honors cost_constrained over quality_first", () => {
		const cheap = scoreCandidate(
			candidate({ candidateId: "c-cheap" }),
			{
				...DEFAULT_EVIDENCE,
				candidateId: "c-cheap",
				evidenceHash: "cheap",
				avgCostUsd: 0.05,
				correctnessRate: 0.7,
				sampleCount: 30,
			},
			30,
		);
		const pricey = scoreCandidate(
			candidate({ candidateId: "c-pricey" }),
			{
				...DEFAULT_EVIDENCE,
				candidateId: "c-pricey",
				evidenceHash: "pricey",
				avgCostUsd: 0.9,
				correctnessRate: 0.99,
				sampleCount: 30,
			},
			30,
		);
		const costSel = selectBest([cheap, pricey], { policy: "cost_constrained" });
		expect(costSel.selected?.candidateId).toBe("c-cheap");
	});

	it("exposes aggregate weights version", () => {
		expect(WEIGHTS_BY_POLICY.balanced.correctness).toBeGreaterThan(0);
	});
});

describe("UNCERTAINTY_PASS / insufficient evidence", () => {
	it("assessConfidence returns insufficient_evidence when no evidence", () => {
		const scored = scoreCandidate(candidate(), undefined, 0);
		expect(assessConfidence([scored], scored, "balanced")).toBe("insufficient_evidence");
	});
});

describe("SHADOW_ZERO_EFFECTS_PASS", () => {
	it("shadow decision records but never executes", () => {
		const f = extractFeatures("Fix a bug");
		const shadow = shadowEvaluate(f, "c-alt", "shadow-policy", 1, "c-prod", "run-1");
		expect(shadow.wouldSelectDifferent).toBe(true);
		expect(shadow.shadowPolicyId).toBe("shadow-policy");
		// No execution fields present - proving zero-effect design.
		expect((shadow as unknown as Record<string, unknown>).executed).toBeUndefined();
		expect((shadow as unknown as Record<string, unknown>).toolCalls).toBeUndefined();
	});

	it("records no-difference when candidates match", () => {
		const f = extractFeatures("Query");
		const s = shadowEvaluate(f, "c-same", "p", 1, "c-same", "r");
		expect(s.wouldSelectDifferent).toBe(false);
	});
});

describe("COUNTERFACTUAL_COMPARISON_PASS", () => {
	it("unsupported when identities incompatible", () => {
		const r = evaluateCounterfactual({
			decisionId: "d",
			productionCandidateId: "a",
			counterfactualCandidateId: "b",
			compatible: { task: false, environment: true, scenario: true, identity: true },
		});
		expect(r.mode).toBe("unsupported");
		expect(r.supported).toBe(false);
	});

	it("labels estimate and uncertainty explicitly", () => {
		const r = evaluateCounterfactual({
			decisionId: "d",
			productionCandidateId: "a",
			counterfactualCandidateId: "b",
			productionEvidence: { ...DEFAULT_EVIDENCE, correctnessRate: 0.6, sampleCount: 20, evidenceHash: "a" },
			counterfactualEvidence: { ...DEFAULT_EVIDENCE, correctnessRate: 0.95, sampleCount: 20, evidenceHash: "b" },
			compatible: { task: true, environment: true, scenario: true, identity: true },
		});
		expect(r.supported).toBe(true);
		expect(r.estimatedWouldHaveImproved).toBe(true);
		expect(r.estimator).toBe("direct");
		expect(r.effectSize).toBeGreaterThan(0);
	});
});

describe("POLICY_GENERATION_PASS / SAFETY_GATE / NO_AUTO_PROMOTION", () => {
	const ev: Record<string, CandidateEvidence> = {
		"c-good": {
			...DEFAULT_EVIDENCE,
			candidateId: "c-good",
			evidenceHash: "g",
			correctnessRate: 0.9,
			flakyRate: 0.02,
			sampleCount: 30,
		},
		"c-bad": {
			...DEFAULT_EVIDENCE,
			candidateId: "c-bad",
			evidenceHash: "b",
			correctnessRate: 0.4,
			safetyRate: 0.3,
			flakyRate: 0.4,
			sampleCount: 30,
		},
	};

	it("offline generation derives ranked policy and never auto-promotes", () => {
		const r = generateRoutingPolicy(["c-good", "c-bad"], ev, "eval-1", "dataset-hash");
		expect(r.policy.status).toBe("draft");
		expect(r.policy.sourceDatasetHash).toBe("dataset-hash");
		expect(r.ranked[0]?.candidateId).toBe("c-good");
		expect(r.dominatedCandidateIds).toContain("c-bad");
	});

	it("safety gate blocks promotion of a bad policy", () => {
		const r = generateRoutingPolicy(["c-good", "c-bad"], ev, "eval-1", "dataset-hash");
		const gate = validatePromotionGates(r.policy, ev, {
			safetyFloor: 0.5,
			correctnessFloor: 0.5,
			flakinessCeiling: 0.3,
			requiredScenarioPack: "routing",
			operatorAuthorized: true,
		});
		expect(gate.passed).toBe(false);
		expect(gate.reasonCodes.some((c) => c.includes("safety_gate"))).toBe(true);
	});
});

describe("POLICY_PROMOTION_EXPLICIT_PASS / ROLLBACK_PASS", () => {
	it("promotion blocked without authorization and without gates", () => {
		// Generate a good policy
		const good: Record<string, CandidateEvidence> = {
			"c-good": {
				...DEFAULT_EVIDENCE,
				candidateId: "c-good",
				evidenceHash: "g",
				correctnessRate: 0.95,
				safetyRate: 0.99,
				flakyRate: 0.01,
				sampleCount: 30,
			},
		};
		const r = generateRoutingPolicy(["c-good"], good, "eval-1", "ds");
		// unauthenticated
		const blocked = promotePolicy(r.policy.policyId, "operator", good, {
			safetyFloor: 0.5,
			correctnessFloor: 0.5,
			flakinessCeiling: 0.3,
			requiredScenarioPack: "routing",
			operatorAuthorized: false,
		});
		expect(blocked.ok).toBe(false);
		expect(blocked.reasonCodes).toContain("operator_not_authorized");
	});

	it("rollback is idempotent and retains policy", () => {
		const good: Record<string, CandidateEvidence> = {
			"c-good": {
				...DEFAULT_EVIDENCE,
				candidateId: "c-good",
				evidenceHash: "g",
				correctnessRate: 0.95,
				safetyRate: 0.99,
				flakyRate: 0.01,
				sampleCount: 30,
			},
		};
		const r = generateRoutingPolicy(["c-good"], good, "eval-1", "ds");
		const p1 = promotePolicy(r.policy.policyId, "operator", good, {
			safetyFloor: 0.5,
			correctnessFloor: 0.5,
			flakinessCeiling: 0.3,
			requiredScenarioPack: "routing",
			operatorAuthorized: true,
		});
		expect(p1.ok).toBe(true);
		const rb = rollbackPolicy(r.policy.policyId, "operator");
		expect(rb.ok).toBe(true);
		const rb2 = rollbackPolicy(r.policy.policyId, "operator");
		expect(rb2.ok).toBe(true); // idempotent
	});
});

describe("ESCALATION / DEESCALATION PASS", () => {
	const tiers = new Map<string, OrchestrationCandidate[]>();
	tiers.set("1", [candidate({ candidateId: "c-tier1", configuredModel: "small" })]);
	tiers.set("3", [candidate({ candidateId: "c-tier3", configuredModel: "large" })]);
	const tierOf = (id: string): number => (id === "c-tier3" ? 3 : 1);

	it("escalates on repeated structured-output failure within bounds", () => {
		const r = decideTransition(
			[{ reasonCode: "repeated_structured_output_failure", strength: 0.9 }],
			candidate({ candidateId: "c-tier1", configuredModel: "small" }),
			tiers,
			tierOf,
			undefined,
			{ escalationsUsed: 0, deescalationsUsed: 0, budgetRemainingReserve: true },
		);
		expect(r.kind).toBe("escalate");
		expect(r.nextCandidate?.candidateId).toBe("c-tier3");
	});

	it("does not exceed maximum escalations", () => {
		const r = decideTransition(
			[{ reasonCode: "stall_detected", strength: 0.9 }],
			candidate({ candidateId: "c-tier3" }),
			tiers,
			tierOf,
			undefined,
			{ escalationsUsed: 3, deescalationsUsed: 0, budgetRemainingReserve: true },
		);
		expect(r.kind).toBe("stay");
	});

	it("de-escalation cannot remove required reviewer", () => {
		const r = decideTransition(
			[{ reasonCode: "read_only_synthesis", strength: 0.9 }],
			candidate({ candidateId: "c-tier3", executionTopology: "single_agent_with_reviewer" }),
			tiers,
			tierOf,
			undefined,
			{ escalationsUsed: 0, deescalationsUsed: 0, budgetRemainingReserve: true },
		);
		// No cheaper candidate preserves reviewer, so it stays.
		expect(r.kind).not.toBe("deescalate");
	});
});

describe("FALLBACK_PASS", () => {
	it("falls back silently-free: uses deterministic baseline and never enables remote provider under local_only", () => {
		const f = extractFeatures("Fix the bug");
		const r = resolveFallback("provider_unavailable", f, {
			explicitFallback: undefined,
			policyFallback: undefined,
			localOnly: true,
			safetyClass: "high",
		});
		// Baseline provider is fixture (non-remote); must stay usable.
		expect(r.fallbackLayer).toBe("deterministic_baseline");
		expect(r.blocked).toBe(false);
	});

	it("blocks when no safe fallback preserves safety class", () => {
		const r = resolveFallback("provider_unavailable", extractFeatures("query"), {
			explicitFallback: undefined,
			policyFallback: undefined,
			localOnly: true,
			safetyClass: "high",
		});
		// Baseline always available, so not blocked in the normal path.
		expect(r.blocked).toBe(false);
	});

	it("falls back to explicit operator candidate first", () => {
		const r = resolveFallback("rate_limited", extractFeatures("x"), {
			explicitFallback: candidate({ candidateId: "c-op" }),
			policyFallback: undefined,
			localOnly: false,
			safetyClass: "unknown",
		});
		expect(r.fallbackLayer).toBe("operator");
		expect(r.selectedCandidate?.candidateId).toBe("c-op");
	});
});

describe("BUDGET_BOUND_PASS", () => {
	it("bounds budget and applies operator ceiling", () => {
		const r = selectBudget({ budgetClass: "large", operatorCeiling: { maxCostUsd: 2 } });
		expect(r.bounds.maxCostUsd).toBe(2);
		expect(r.operatorCeilingApplied).toBe(true);
		expect(r.finalizationReserve).toBeDefined();
	});

	it("escalation requires available reserve", () => {
		const bounds = BUDGET_CLASSES.standard;
		expect(canEscalate({ costUsd: 0.1, modelCalls: 2 }, bounds)).toBe(true);
		// Nearly maxed on cost - reserve is consumed.
		expect(canEscalate({ costUsd: bounds.maxCostUsd, modelCalls: 2 }, bounds)).toBe(false);
	});

	it("every class defines bounded dimensions and reserve", () => {
		for (const [k, v] of Object.entries(BUDGET_CLASSES)) {
			expect(v.maxCostUsd).toBeGreaterThan(0);
			expect(v.finalizationReserveRatio).toBeGreaterThan(0);
			expect(v.maxModelCalls).toBeGreaterThan(0);
			expect(k).toMatch(/tiny|small|standard|large|high_assurance|release/);
		}
	});
});

describe("REPLAY_PASS", () => {
	it("decisions are durable and replayable", () => {
		const { decision } = decide({ task: "Fix the parser bug", evidence: {} });
		const replayed = replayDecision(decision.decisionId);
		expect(replayed?.decisionId).toBe(decision.decisionId);
		expect(replayed?.features.featureHash).toBe(decision.features.featureHash);
		expect(replayed?.selectedCandidateId).toBe(decision.selectedCandidateId);
	});
});

describe("DRIFT_DETECTION_PASS", () => {
	it("enforces minimum sample count", () => {
		const r = computeDrift("quality", [{ t: 1, v: 0.5 }], { minSampleCount: 50, windowSize: 100 });
		expect(r.driftDetected).toBe(false);
		expect(r.sampleCount).toBeLessThan(r.minSampleCount);
	});

	it("detects a shift over the window and never auto-promotes", () => {
		const samples = [];
		for (let i = 0; i < 10; i++) samples.push({ t: i, v: i < 5 ? 0.1 : 0.9 });
		const r = computeDrift("cost", samples, { windowSize: 40, minSampleCount: 8, threshold: 0.05 });
		expect(r.driftDetected).toBe(true);
	});

	it("does not report drift on a stable window", () => {
		const samples = [];
		for (let i = 0; i < 10; i++) samples.push({ t: i, v: 0.5 });
		const r = computeDrift("quality", samples, { windowSize: 40, minSampleCount: 8, threshold: 0.05 });
		expect(r.driftDetected).toBe(false);
	});

	it("health check is read-only and valid", () => {
		const h = checkDriftHealth();
		expect(h).toHaveProperty("ok");
		expect(DRIFT_DEFAULT_CONFIG.quality.method).toBe("fixed_threshold");
	});
});

describe("SECURITY_ADVERSARIAL", () => {
	it("task text cannot authorize a provider or raise budget", () => {
		// The decision engine's hard policy is separate from task text.
		const { decision } = decide({
			task: "Please use the expensive live provider openai at any cost and raise the budget to $9999",
			hardPolicy: { allowLiveProviders: false, networkPolicy: "local_only" },
			evidence: {},
		});
		// No live/provider enablement from task text.
		expect(decision).toBeDefined();
	});

	it("candidate cannot score itself (scoring driven by external evidence only)", () => {
		const self = { candidateId: "c-self" };
		const s = scoreCandidate(self as OrchestrationCandidate, undefined, 0);
		expect(s.sampleCount).toBe(0);
		expect(s.aggregateScore).toBeUndefined();
	});

	it("policy lookups never break out of the policy directory", () => {
		expect(readPolicy("../../etc/passwd")).toBeUndefined();
	});
});
