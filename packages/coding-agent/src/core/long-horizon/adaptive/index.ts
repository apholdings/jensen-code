/**
 * Adaptive long-horizon runtime — public API.
 *
 * Provider-neutral, deterministic building blocks for durable execution
 * budgets, model capability profiles and role routing, structured progress and
 * stall detection, bounded strategy pivots and escalation, evidence-backed
 * success criteria, completion readiness, independent review, typed skills and
 * isolated bounded subagents.
 */

export type {
	AllocationResult,
	AppendResult,
	BudgetAllocationInput,
	BudgetLedger,
	ThresholdOutput,
	Usage,
} from "./budget-ledger.js";

// Durable execution-budget ledger
export {
	appendEntry,
	budgetBlock,
	createBudgetLedger,
	evaluateThresholds,
	getUsage,
	reconcileEntry,
	reserveFinalization,
	resolveBudgetHierarchy,
	resolvedSourceEvents,
	resourcesOfBudget,
	sumResource,
} from "./budget-ledger.js";
export type { BuiltinSkill } from "./builtin-skills.js";
export { BUILTIN_SKILLS } from "./builtin-skills.js";
export type { CapabilityRegistry, FindCapabilitiesInput, RoleCompatibility } from "./capability-registry.js";
// Capability registry
export {
	costTierOf,
	createCapabilityRegistry,
	hasAllCapabilities,
	resolveCapabilities,
	roleCompatibility,
	tierWithin,
} from "./capability-registry.js";
// CLI surfaces and built-in skills
export { defaultRunStateDir, ensureRunStateDir, handleAdaptiveCommand, runStatePath } from "./cli.js";
export type { ContextPacket, PacketValidation } from "./context-handoff.js";
// Context handoff
export { reconcileChildResults, validateContextPacket } from "./context-handoff.js";
export type { CriteriaState, EvidenceRecord } from "./criteria.js";
// Evidence-backed success criteria
export {
	createCriteriaState,
	criterionSummary,
	evaluateCriteriaSatisfaction,
	trySatisfyCriterion,
} from "./criteria.js";
export type { EscalationBudget, EscalationContext, EscalationDecision, EscalationReasonCode } from "./escalation.js";
// Model escalation
export { evaluateEscalation, FORBIDDEN_ESCALATION_REASONS } from "./escalation.js";
export type { RouteCandidate, RouteOptions, RouteResult, RouterConfig } from "./model-router.js";
// Role-based model routing
export { requiredCapabilitiesFor, routeForRole } from "./model-router.js";
export type { ProgressAccumulator, ProgressParams, ProgressResult } from "./progress.js";
// Structured progress
export {
	accumulatorWeight,
	appendObservation,
	createProgressAccumulator,
	fileContentHash,
	NON_PROGRESS_CATEGORIES,
	observeProgress,
	PROGRESS_CATEGORY_WEIGHTS,
} from "./progress.js";
export type { HealthLevel, HealthSample, HealthSignal, ProviderHealthState } from "./provider-health.js";
// Provider health
export {
	countSignal,
	createHealthState,
	MAX_HEALTH_SAMPLES,
	recordHealthSignal,
	shouldRetry,
} from "./provider-health.js";
export type { ReadinessInput } from "./readiness.js";
// Completion readiness
export { cannotOverrideReadiness, evaluateCompletionReadiness } from "./readiness.js";
export type { ReviewerPermissions, ReviewPacket } from "./reviewer.js";
// Independent reviewer
export {
	aggregateVerdict,
	applyReviewerAuthority,
	DEFAULT_REVIEWER_PERMISSIONS,
	normalizeFindings,
	reviewsApprove,
} from "./reviewer.js";
export type { EffectiveSkillPolicy, SkillValidation } from "./skills.js";
// Typed skills
export { computeEffectiveSkillPolicy, skillModelRole, validateSkillManifest } from "./skills.js";
export type { StallConfig, StallEvaluation, StallInput } from "./stall-detector.js";
// Stall detection
export { DEFAULT_STALL_CONFIG, evaluateStall, pollProgress, stallNextAction } from "./stall-detector.js";
export type { StatsInput } from "./stats.js";
// Statistics
export { deriveRunStatistics, resourcesUsage } from "./stats.js";
export type { PivotBudget, PivotContext, PivotEvaluator } from "./strategy.js";
// Strategy and pivots
export { equivalentStrategyCount, evaluatePivot, isMateriallyDifferent, scopeExpands } from "./strategy.js";
export type { LaunchDecision, SubagentLaunchInput, SubagentRuntimeConfig } from "./subagents.js";
// Isolated bounded subagents
export {
	canLaunchSubagent,
	DEFAULT_SUBAGENT_CONFIG,
	parallelOrderKey,
	transitionSubagent,
} from "./subagents.js";
export * from "./types.js";
