/**
 * Canonical orchestration decision model for the evidence-driven adaptive
 * orchestration subsystem (Jensen 1.9.0).
 *
 * These types are the single source of truth for a routing/orchestration
 * decision. Every selected strategy carries a durable ID, an explicit policy
 * version, provenance, and replay-safe deterministic serialization.
 *
 * Safety invariants enforced by this module:
 * - Routing never overrides the safety policy.
 * - Routing never grants new tool authority.
 * - Routing never expands workspace scope.
 * - Routing never exceeds the operator budget.
 * - Routing never enables a live provider implicitly.
 * - Decisions are addressable, versioned, and include provenance.
 */

/** Confidence of an orchestration decision. */
export type OrchestrationConfidence = "high" | "medium" | "low" | "insufficient_evidence";

/** Execution topology selected by routing. */
export type ExecutionTopology = "single_agent" | "single_agent_with_reviewer" | "cavecrew" | "custom_skill";

/** Retrieval strategy selected by routing. */
export type RetrievalStrategy = "none" | "lexical" | "symbolic" | "semantic" | "hybrid" | "hybrid_reranked";

/** Budget class selected by routing. */
export type BudgetClass = "tiny" | "small" | "standard" | "large" | "high_assurance" | "release";

/** A single candidate score produced by evidence-informed scoring. */
export interface OrchestrationCandidateScore {
	candidateId: string;
	correctnessScore?: number;
	safetyScore?: number;
	reliabilityScore?: number;
	costScore?: number;
	latencyScore?: number;
	/** 0..1 — higher means more uncertain. */
	uncertainty: number;
	/** Number of evaluation samples backing this score. */
	sampleCount: number;
	aggregateScore?: number;
	reasonCodes: string[];
	evidenceIds: string[];
}

/** A candidate that the orchestration engine may select. */
export interface OrchestrationCandidate {
	candidateId: string;
	providerProfile: string;
	configuredModel: string;
	thinkingLevel?: string;
	executionTopology: ExecutionTopology;
	skillIds: string[];
	subagentDefinitions: string[];
	retrievalPolicy: string;
	budgetClass: string;
	fallbackPolicy: string;
}

/** Rejection of a candidate by a hard policy filter. */
export interface OrchestrationCandidateRejection {
	candidateId: string;
	reasonCode: string;
	policyRuleId: string;
	evidenceIds: string[];
}

/** An operator override of a routing decision. */
export interface OrchestrationOverride {
	overrideId: string;
	reason?: string;
	authorizedBy: string;
	candidateId?: string;
	forcedConfidence?: OrchestrationConfidence;
	recordedAt: string;
}

/** Deterministic task feature vector. */
export interface OrchestrationFeatureVector {
	schemaVersion: number;
	taskCategory: string;
	taskComplexity: number;
	ambiguity: number;
	mutationRisk: number;
	evidenceRequirement: number;
	estimatedAffectedFiles?: number;
	estimatedContextTokens?: number;
	requiresMutation: boolean;
	requiresExternalResearch: boolean;
	requiresCrossPlatformValidation: boolean;
	requiresRelease: boolean;
	languageIds: string[];
	relevantFailureClusters: string[];
	featureHash: string;
}

/** Full orchestration decision. */
export interface OrchestrationDecision {
	decisionId: string;
	policyId: string;
	policyVersion: number;
	runId: string;
	taskFingerprint: string;
	features: OrchestrationFeatureVector;
	candidates: OrchestrationCandidateScore[];
	rejections: OrchestrationCandidateRejection[];
	selectedCandidateId?: string;
	selectedAt: string;
	confidence: OrchestrationConfidence;
	reasonCodes: string[];
	evidenceIds: string[];
	operatorOverride?: OrchestrationOverride;
}

/** Multi-objective selection policy. */
export type SelectionPolicy =
	| "quality_first"
	| "balanced"
	| "cost_constrained"
	| "latency_constrained"
	| "local_only"
	| "high_assurance";

/** Hard policy rule. */
export interface PolicyRule {
	ruleId: string;
	description: string;
	/** Known policy families used for machine-readable filtering. */
	family:
		| "workspace"
		| "tool_effect"
		| "network"
		| "provider"
		| "model"
		| "cost"
		| "model_calls"
		| "subagents"
		| "recursion"
		| "affected_files"
		| "local_only"
		| "cross_platform"
		| "structured_output";
}

/** A deterministic baseline rule. */
export interface BaselineRule {
	ruleId: string;
	description: string;
	/** Cursor position in deterministic precedence ordering. */
	precedence: number;
	match: {
		taskCategory?: string;
		minComplexity?: number;
		requiresMutation?: boolean;
		requiresRelease?: boolean;
		requiresCrossPlatformValidation?: boolean;
		requiresExternalResearch?: boolean;
	};
	result: {
		executionTopology: ExecutionTopology;
		retrievalPolicy: string;
		budgetClass: string;
		providerProfile: string;
		configuredModel: string;
		thinkingLevel?: string;
		reasonCodes: string[];
	};
}

/** An evaluation evidence record keyed by candidate identity. */
export interface CandidateEvidence {
	candidateId: string;
	evaluatorVersion: string;
	scenarioVersion: string;
	/** Content-addressable hash of the evidence payload. */
	evidenceHash: string;
	sampleCount: number;
	correctnessRate?: number;
	safetyRate?: number;
	reliabilityRate?: number;
	medianLatencyMs?: number;
	avgCostUsd?: number;
	toolFailureRate?: number;
	flakyRate?: number;
	retrievalQuality?: number;
	reviewerQuality?: number;
	rollbackRate?: number;
	stallRate?: number;
	/** Prompt/tool/skill/model identity that produced this evidence. */
	compatibility: {
		promptTemplateId?: string;
		toolSchemaVersion?: string;
		modelVersion?: string;
		skillVersions?: string[];
	};
	collectedAt: string;
	version: number;
}

/** An off-policy evaluation estimator label. */
export type OffPolicyEstimator = "direct" | "doubly_robust" | "importance_sampling" | "none";

/** Status of a routing policy candidate generated offline. */
export type RoutingPolicyStatus = "draft" | "validated" | "rejected" | "promoted";

/** A routing policy candidate produced by the offline optimizer. */
export interface RoutingPolicyCandidate {
	policyId: string;
	policyVersion: number;
	sourceDatasetHash: string;
	evaluatorVersion: string;
	generatedAt: string;
	status: RoutingPolicyStatus;
	/** Ranked candidate preference produced by the optimizer. */
	preferences:
		| {
				candidateId: string;
				quality: number;
		  }[]
		| null;
	/** Suggested thresholds. */
	suggestedThresholds?: Record<string, number>;
	/** Suggested new routing rules. */
	suggestedRules: string[];
	/** Dominated candidates. */
	dominatedCandidateIds: string[];
	/** Evidence gaps. */
	evidenceGaps: string[];
	rollbackPolicyId?: string;
	hash: string;
	content: string;
}

/** A shadow routing decision — computed but never executed. */
export interface ShadowDecision {
	shadowId: string;
	productionDecisionId: string;
	runId: string;
	taskFingerprint: string;
	features: OrchestrationFeatureVector;
	shadowPolicyId: string;
	shadowPolicyVersion: number;
	productionCandidateId?: string;
	shadowCandidateId?: string;
	wouldSelectDifferent: boolean;
	reasonCodes: string[];
	recordedAt: string;
}

/** A drift detection result. */
export interface DriftResult {
	detectorId: string;
	method: string;
	dimension:
		| "quality"
		| "cost"
		| "latency"
		| "failure_cluster"
		| "retrieval"
		| "task_distribution"
		| "flakiness"
		| "policy_selection";
	sampleWindow: number;
	minSampleCount: number;
	sampleCount: number;
	driftDetected: boolean;
	measure: number;
	threshold: number;
	severity: "low" | "medium" | "high" | "safety";
	observedAt: string;
	recommendation: string[];
}

/** Durable orchestration event type. */
export type OrchestrationEventType =
	| "ORCHESTRATION_FEATURES_EXTRACTED"
	| "ORCHESTRATION_CANDIDATES_GENERATED"
	| "ORCHESTRATION_CANDIDATE_REJECTED"
	| "ORCHESTRATION_CANDIDATE_SCORED"
	| "ORCHESTRATION_DECISION_SELECTED"
	| "ORCHESTRATION_OPERATOR_OVERRIDE"
	| "ORCHESTRATION_FALLBACK_APPLIED"
	| "ORCHESTRATION_ESCALATION_APPLIED"
	| "ORCHESTRATION_DEESCALATION_APPLIED"
	| "ORCHESTRATION_SHADOW_DECISION"
	| "ORCHESTRATION_OUTCOME_LINKED"
	| "ROUTING_POLICY_VALIDATED"
	| "ROUTING_POLICY_PROMOTED"
	| "ROUTING_POLICY_ROLLED_BACK"
	| "ROUTING_DRIFT_DETECTED";

/** A durable orchestration event. */
export interface OrchestrationEvent {
	eventId: string;
	type: OrchestrationEventType;
	runId?: string;
	phase?: string;
	decisionId?: string;
	policyId?: string;
	policyVersion?: number;
	candidateId?: string;
	evidenceIds?: string[];
	payload?: Record<string, unknown>;
	occurredAt: string;
	sequence: number;
}

/** Drift configuration with explicit detector methods. */
export interface DriftConfig {
	method: "fixed_threshold" | "adwin" | "page_hinkley";
	windowSize: number;
	minSampleCount: number;
	threshold: number;
	enabled: boolean;
}
