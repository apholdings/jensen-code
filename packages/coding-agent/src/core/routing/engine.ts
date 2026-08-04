/**
 * Evidence-driven orchestration decision engine.
 *
 * Encapsulates the full decision flow:
 *   task & runtime context → feature extraction → candidate generation →
 *   hard policy filtering → evidence lookup → candidate scoring →
 *   uncertainty assessment → orchestration decision → outcome capture.
 */

import { randomUUID } from "node:crypto";
import { applyHardPolicy, generateCandidates, type HardPolicyInput } from "./candidates.js";
import { extractFeatures, type TaskContext, taskFingerprint } from "./features.js";
import { type SelectionOptions, scoreCandidate, selectBest } from "./scoring.js";
import { appendEvent, readDecision, writeDecision } from "./store.js";
import type {
	CandidateEvidence,
	ExecutionTopology,
	OrchestrationCandidate,
	OrchestrationCandidateScore,
	OrchestrationConfidence,
	OrchestrationDecision,
} from "./types.js";

export interface RoutingPolicyContext {
	policyId: string;
	policyVersion: number;
	/** Deterministic baseline candidate preferences. */
	preferences?: { candidateId: string; quality: number }[];
	/** Dominated candidate IDs the policy will not select. */
	dominatedCandidateIds?: string[];
}

/** Outcome capture for evaluation linkage. */
export interface DecisionOutcome {
	decisionId: string;
	success: boolean;
	correctnessRate?: number;
	safetyRate?: number;
	medianLatencyMs?: number;
	avgCostUsd?: number;
	toolFailureRate?: number;
	flakyRate?: number;
}

export interface EngineOptions {
	runId?: string;
	policyOverride?: RoutingPolicyContext;
	hardPolicy?: Partial<HardPolicyInput>;
	selection?: Partial<SelectionOptions>;
	operatorOverride?: OrchestrationOperatorOverride;
}

export interface OrchestrationOperatorOverride {
	authorizedBy: string;
	candidateId?: string;
	reason?: string;
}

/** Context describing all configured candidate sources (canonical registries). */
export interface CandidateRegistryContext {
	providerProfiles: string[];
	models: { provider: string; model: string }[];
	topologies: ExecutionTopology[];
	skills: string[];
	subagents: string[];
	retrievalPolicies: string[];
	budgetClasses: string[];
	fallbackPolicies: string[];
}

const DEFAULT_HARD_POLICY: HardPolicyInput = {
	workspaceBoundary: true,
	requiredLocalOnly: false,
	providerAllowlist: [],
	modelAllowlist: [],
	maxSubagents: 4,
	networkPolicy: "allow_all",
	allowLiveProviders: false,
};

const DEFAULT_REGISTRY: CandidateRegistryContext = {
	providerProfiles: ["fixture", "local"],
	models: [
		{ provider: "fixture", model: "fixture/deterministic" },
		{ provider: "local", model: "local/readonly" },
	],
	topologies: ["single_agent", "single_agent_with_reviewer", "cavecrew", "custom_skill"],
	skills: [],
	subagents: ["reviewer", "investigator", "planner", "builder"],
	retrievalPolicies: ["none", "lexical", "symbolic", "semantic", "hybrid", "hybrid_reranked"],
	budgetClasses: ["tiny", "small", "standard", "large", "high_assurance", "release"],
	fallbackPolicies: ["rigid", "validated_policy", "deterministic_baseline", "degraded", "blocked"],
};

export interface DecideInput {
	task: string | TaskContext;
	registry?: Partial<CandidateRegistryContext>;
	hardPolicy?: Partial<HardPolicyInput>;
	selectionPolicy?: SelectionOptions["policy"];
	operatorOverride?: OrchestrationOperatorOverride;
	evidence?: Record<string, CandidateEvidence>;
	policyContext?: RoutingPolicyContext;
	runId?: string;
}

export interface DecideResult {
	decision: OrchestrationDecision;
	selectedCandidate?: OrchestrationCandidate;
	evidenceById: Record<string, CandidateEvidence>;
}

/**
 * Execute the full decision flow for a task.
 * Returns the decision (durable) and the selected candidate (if any).
 */
export function decide(input: DecideInput): DecideResult {
	const runId = input.runId ?? randomUUID();
	const ctx: TaskContext = typeof input.task === "string" ? { task: input.task } : input.task;
	const taskText = ctx.task ?? "";

	// 1. Feature extraction (deterministic).
	const features = extractFeatures(ctx);

	// 2. Candidate generation from canonical registries.
	const registry: CandidateRegistryContext = { ...DEFAULT_REGISTRY, ...input.registry };
	const { candidates, warnings } = generateCandidates({
		providerProfiles: registry.providerProfiles,
		models: registry.models,
		topologies: registry.topologies,
		skills: registry.skills,
		subagents: registry.subagents,
		retrievalPolicies: registry.retrievalPolicies,
		budgetClasses: registry.budgetClasses,
		fallbackPolicies: registry.fallbackPolicies,
		operatorSelectionPolicy: input.selectionPolicy ?? "balanced",
	});
	void warnings;

	// 3. Hard policy filtering.
	const hardPolicy: HardPolicyInput = { ...DEFAULT_HARD_POLICY, ...input.hardPolicy };
	const { accepted, rejected } = applyHardPolicy(candidates, hardPolicy);

	// 4. Evidence lookup + scoring.
	const evidenceStore = input.evidence ?? {};
	const scored: OrchestrationCandidateScore[] = accepted.map((candidate) => {
		const ev = evidenceStore[candidate.candidateId];
		return scoreCandidate(candidate, ev, ev ? ev.sampleCount : 0);
	});

	// 5. Uncertainty assessment + multi-objective selection.
	const selectionOptions: SelectionOptions = {
		policy: input.selectionPolicy ?? "balanced",
	};
	const selection = selectBest(scored, selectionOptions);
	const policyContext: RoutingPolicyContext = input.policyContext ?? {
		policyId: "deterministic-baseline",
		policyVersion: 1,
	};

	// 6. Apply policy preferences (only among accepted candidates).
	let selected = selection.selected;
	if (policyContext.preferences && policyContext.preferences.length > 0 && selected) {
		const prefId = policyContext.preferences[0]?.candidateId;
		const prefCandidate = scored.find((s) => s.candidateId === prefId && !isDominated(policyContext, prefId));
		if (prefCandidate && selected.candidateId !== prefCandidate.candidateId) {
			selected = prefCandidate;
		}
	}

	// 7. Operator override (highest authority below safety policy).
	if (input.operatorOverride?.candidateId) {
		const overrideCandidate = scored.find((s) => s.candidateId === input.operatorOverride?.candidateId);
		if (overrideCandidate) {
			selected = overrideCandidate;
		}
	}

	const confidence = assessConfidence(scored, selected, input.selectionPolicy ?? "balanced");

	const reasonCodes: string[] = [
		...selection.reasonCodes,
		...(selected ? [`selected:${selected.candidateId}`] : []),
		...(input.operatorOverride ? ["operator_override"] : []),
		...(hardPolicy.requiredLocalOnly ? ["local_only_enforced"] : []),
	];

	const evidenceIds = (selected?.evidenceIds ?? []).concat(rejected.length > 0 ? [] : []);

	const decision: OrchestrationDecision = {
		decisionId: randomUUID(),
		policyId: policyContext.policyId,
		policyVersion: policyContext.policyVersion,
		runId,
		taskFingerprint: taskFingerprint(taskText),
		features,
		candidates: scored,
		rejections: rejected,
		selectedCandidateId: selected?.candidateId,
		selectedAt: new Date().toISOString(),
		confidence,
		reasonCodes,
		evidenceIds: [...new Set(evidenceIds)],
		operatorOverride: input.operatorOverride
			? {
					overrideId: randomUUID(),
					authorizedBy: input.operatorOverride.authorizedBy,
					reason: input.operatorOverride.reason,
					candidateId: input.operatorOverride.candidateId,
					recordedAt: new Date().toISOString(),
				}
			: undefined,
	};

	writeDecision(decision);
	appendEvent({
		type: "ORCHESTRATION_DECISION_SELECTED",
		runId,
		decisionId: decision.decisionId,
		policyId: decision.policyId,
		policyVersion: decision.policyVersion,
		evidenceIds: decision.evidenceIds,
	});

	const selectedFull = selected ? candidates.find((c) => c.candidateId === selected.candidateId) : undefined;

	return { decision, selectedCandidate: selectedFull, evidenceById: evidenceStore };
}

function isDominated(policy: RoutingPolicyContext, candidateId: string): boolean {
	return Boolean(policy.dominatedCandidateIds?.includes(candidateId));
}

/** Assess decision confidence deterministically. */
export function assessConfidence(
	_scored: OrchestrationCandidateScore[],
	selected: OrchestrationCandidateScore | undefined,
	policy: SelectionOptions["policy"],
): OrchestrationConfidence {
	if (!selected) return "insufficient_evidence";
	if (selected.sampleCount === 0 && selected.reasonCodes.includes("no_evidence")) {
		return "insufficient_evidence";
	}
	const hasEvidence =
		(selected.correctnessScore ??
			selected.safetyScore ??
			selected.reliabilityScore ??
			selected.costScore ??
			selected.latencyScore) !== undefined;
	if (!hasEvidence) return "insufficient_evidence";
	// For local_only or high_assurance, require stronger evidence.
	if (policy === "local_only" || policy === "high_assurance") {
		if (selected.sampleCount < 10) return "low";
	}
	if (selected.sampleCount < 5) return "low";
	if (selected.uncertainty > 0.5) return "low";
	return "medium";
}

export { buildCandidateId } from "./baseline.js";
export function replayDecision(decisionId: string): OrchestrationDecision | undefined {
	return readDecision(decisionId);
}
