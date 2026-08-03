/**
 * Adaptive long-horizon runtime — domain types.
 *
 * Provider-neutral, model-independent types for durable execution budgets,
 * model capability profiles and role routing, structured progress and stall
 * detection, bounded strategy pivots and escalation, evidence-backed success
 * criteria, completion readiness, typed skills and isolated bounded subagents.
 *
 * These types are pure data: none of them carry authority. Authority remains
 * with the deterministic policy evaluation that consumes them (see the
 * individual pure function modules in this directory).
 */

// =============================================================================
// Execution budget
// =============================================================================

/**
 * Durable execution budget dimensions. All are optional; an absent dimension
 * is unbounded (subject only to global runtime limits).
 */
export interface ExecutionBudget {
	maxCostUsd?: number;
	maxInputTokens?: number;
	maxOutputTokens?: number;
	maxCachedInputTokens?: number;
	maxModelTurns?: number;
	maxToolCalls?: number;
	maxMutatingToolCalls?: number;
	maxWallTimeMs?: number;
	maxProviderRetries?: number;
	maxStrategyPivots?: number;
	maxModelEscalations?: number;
	maxSubagentRuns?: number;
	maxConcurrentSubagents?: number;
	maxWebSearches?: number;
	maxWebFetches?: number;
	maxBrowserRenders?: number;
	maxLspRequests?: number;
	maxBackgroundJobs?: number;
}

export type BudgetResource = keyof ExecutionBudget & string;

/**
 * A single durable, append-only budget ledger entry.
 */
export interface BudgetLedgerEntry {
	entryId: string;
	runId: string;
	phaseId?: string;
	role?: string;
	resource: BudgetResource;
	amount: number;
	estimatedOrActual: "estimated" | "actual";
	provider?: string;
	model?: string;
	sourceEventId: string;
	recordedAt: string;
}

/**
 * Thresholds applied to a budget dimension at a given hierarchy node.
 */
export interface BudgetThresholds {
	soft?: number;
	hard?: number;
	/** Protected capacity reserved for authoritative validation/finalization. */
	finalizationReserve?: number;
	/** Protected capacity reserved for emergency recovery. */
	recoveryReserve?: number;
}

/**
 * Typed result of enforcing soft/hard thresholds for one resource.
 */
export type ThresholdVerdict =
	| { kind: "ok" }
	| { kind: "soft"; resource: BudgetResource; used: number; threshold: number }
	| { kind: "hard"; resource: BudgetResource; used: number; threshold: number }
	| { kind: "finalization_reserve"; resource: BudgetResource; remaining: number };

/**
 * Typed budget block returned when a hard limit is reached.
 */
export interface BudgetBlock {
	blocked: true;
	runId: string;
	resource: BudgetResource;
	used: number;
	threshold: number;
	reasonCode: "HARD_LIMIT_REACHED";
	finalizationReserveAvailable: boolean;
}

// =============================================================================
// Model capability profile
// =============================================================================

export interface ModelPricing {
	inputPerMillion?: number;
	cachedInputPerMillion?: number;
	outputPerMillion?: number;
	currency: string;
	effectiveAt?: string;
}

export type CapabilityFlag = boolean | "unknown";

export interface ModelCapabilities {
	provider: string;
	model: string;
	contextWindow?: number;
	maxOutputTokens?: number;
	supportsTools: CapabilityFlag;
	supportsParallelTools: CapabilityFlag;
	supportsStructuredOutput: CapabilityFlag;
	supportsVision: CapabilityFlag;
	supportsPromptCaching: CapabilityFlag;
	supportsReasoningEffort: CapabilityFlag;
	supportsStreamingToolCalls: CapabilityFlag;
	supportsReliableLongContext: CapabilityFlag;
	supportsCodeGeneration: CapabilityFlag;
	supportsCodeReview: CapabilityFlag;
	supportsResearchSynthesis: CapabilityFlag;
	supportsCheapSummarization: CapabilityFlag;
	supportsToolCallRepair: CapabilityFlag;
	pricing?: ModelPricing;
}

// =============================================================================
// Model role routing
// =============================================================================

export type ModelRole =
	| "planner"
	| "executor"
	| "researcher"
	| "reviewer"
	| "summarizer"
	| "tool_repair"
	| "recovery"
	| "subagent";

export interface ModelRolePolicy {
	role: ModelRole;
	requiredCapabilities: string[];
	preferredCapabilities?: string[];
	allowedProviders?: string[];
	deniedModels?: string[];
	maximumCostTier?: string;
	escalationTargets?: string[];
	fallbackTargets?: string[];
}

export type CostTier = "cheap" | "standard" | "premium";

export interface ModelRouteDecision {
	role: ModelRole;
	provider: string;
	model: string;
	reasonCodes: string[];
	estimatedBudgetImpact?: number;
	fallbackChain: string[];
	escalationLevel: number;
}

export interface RoutingInput {
	role: ModelRole;
	taskRisk: "low" | "medium" | "high";
	taskType: "code" | "research" | "review" | "synthesis" | "repair" | "recovery";
	phase?: string;
	remainingBudget?: number;
	contextSize?: number;
	requiredTools?: string[];
	providerHealth: Record<string, "healthy" | "degraded" | "unhealthy" | "unknown">;
	recentFailures?: string[];
	stallState?: StallState;
	requireIndependentReview?: boolean;
	userConfiguration?: Record<string, unknown>;
}

export interface EscalationRequest {
	fromProvider: string;
	fromModel: string;
	toProvider: string;
	toModel: string;
	role: ModelRole;
	reasonCodes: string[];
	budgetEffect?: number;
}

// =============================================================================
// Structured progress
// =============================================================================

export interface ProgressObservation {
	observationId: string;
	runId: string;
	phaseId?: string;
	category: string;
	previousStateHash?: string;
	currentStateHash?: string;
	evidenceIds: readonly string[];
	progressWeight: number;
	recordedAt: string;
}

// =============================================================================
// Stall detection
// =============================================================================

export type StallLevel = "none" | "warning" | "strategy_review" | "pivot_required" | "blocked";

export interface StallState {
	level: StallLevel;
	reasonCodes: readonly string[];
	noProgressTurns: number;
	noProgressToolCalls: number;
	repeatedFailureFingerprint?: string;
	evidenceIds: readonly string[];
}

// =============================================================================
// Strategy
// =============================================================================

export type StrategyStatus = "proposed" | "active" | "succeeded" | "failed" | "superseded" | "blocked";

export interface ExecutionStrategy {
	strategyId: string;
	objectiveId: string;
	hypothesis: string;
	plannedActions: readonly string[];
	expectedProgressSignals: readonly string[];
	validationCriteria: readonly string[];
	estimatedBudget: Partial<ExecutionBudget>;
	riskClass: "low" | "medium" | "high";
	status: StrategyStatus;
}

export interface PivotRequest {
	strategyId: string;
	objectiveId: string;
	failedStrategyId: string;
	evidenceBackedReason: string;
	plannedActions: readonly string[];
	materialChange: readonly string[];
	newExpectedProgressSignals: readonly string[];
	validationCriteria: readonly string[];
	newEstimatedBudget: Partial<ExecutionBudget>;
	riskClass: "low" | "medium" | "high";
}

export type PivotResult =
	| { ok: true; strategy: ExecutionStrategy; budgetRemaining: number; reasonCodes: string[] }
	| { ok: false; reasonCodes: string[]; blocked?: true; error?: string };

// =============================================================================
// Success criteria
// =============================================================================

export type CriterionStatus = "pending" | "satisfied" | "failed" | "blocked" | "waived";

export interface AcceptanceCriterion {
	criterionId: string;
	description: string;
	required: boolean;
	evidenceRequirements: readonly string[];
	status: CriterionStatus;
	evidenceIds: readonly string[];
	waiverAuthority?: string;
}

// =============================================================================
// Completion readiness
// =============================================================================

export interface CompletionReadiness {
	ready: boolean;
	blockers: readonly string[];
	warnings: readonly string[];
	satisfiedCriteria: readonly string[];
	pendingCriteria: readonly string[];
	evidenceIds: readonly string[];
}

// =============================================================================
// Independent reviewer
// =============================================================================

export type ReviewFindingKind =
	| "approve"
	| "request_specific_correction"
	| "identify_missing_evidence"
	| "identify_contradiction"
	| "block";

export interface ReviewFinding {
	findingId: string;
	kind: ReviewFindingKind;
	summary: string;
	references: readonly string[];
}

export interface ReviewReport {
	reviewId: string;
	findings: readonly ReviewFinding[];
}

// =============================================================================
// Typed skill manifest
// =============================================================================

export type SkillExecutionMode = "observe" | "static" | "mutate";

export interface SkillManifest {
	name: string;
	version: number;
	description: string;
	inputs: Array<{ name: string; type: string }>;
	allowedTools: string[];
	deniedEffects: string[];
	executionMode: SkillExecutionMode;
	budget?: Partial<ExecutionBudget>;
	timeoutMs?: number;
	successCriteria: string[];
	outputSchema?: string;
	modelRole?: ModelRole;
	provenance?: string;
	requiredCapabilities?: string[];
}

// =============================================================================
// Subagents
// =============================================================================

export type SubagentRole =
	| "repository_explorer"
	| "test_failure_analyst"
	| "research_source_verifier"
	| "documentation_reviewer"
	| "release_readiness_reviewer";

export interface SubagentSpec {
	subagentId: string;
	parentRunId: string;
	objective: string;
	role: SubagentRole;
	isolatedContext: true;
	allowedTools: string[];
	executionMode: SkillExecutionMode;
	budget: Partial<ExecutionBudget>;
	deadlineMs?: number;
	outputSchema?: string;
	successCriteria: string[];
	allowMutation: boolean;
	allowSpawnSubagents: boolean;
	maxDepth: number;
}

export type SubagentStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";

export interface SubagentRunRecord {
	subagentId: string;
	parentRunId: string;
	role: SubagentRole;
	status: SubagentStatus;
	startedAt?: string;
	finishedAt?: string;
	resultPayload?: unknown;
	cancelRequested?: boolean;
}

// =============================================================================
// Run statistics
// =============================================================================

export interface RunStatistics {
	runId: string;
	costByRole: Record<string, number>;
	tokensByRole: Record<string, { input: number; output: number; cachedInput: number }>;
	toolCallsByTool: Record<string, number>;
	mutatingToolCalls: number;
	webSearches: number;
	webFetches: number;
	lspRequests: number;
	jobStarts: number;
	subagentRuns: number;
	retryCount: number;
	pivotCount: number;
	escalationCount: number;
	stallPeriods: number;
	criteriaComplete: number;
	finalizationReserveUsed: number;
}
