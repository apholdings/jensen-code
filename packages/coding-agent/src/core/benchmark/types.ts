/**
 * Canonical long-horizon benchmark domain model.
 *
 * Provider-neutral, model-independent types for defining benchmark tasks,
 * collecting run reports, and evaluating completion quality.
 *
 * Schema version 1.
 */

// =============================================================================
// Benchmark Task Manifest
// =============================================================================

export const LONG_HORIZON_SCHEMA_VERSION = 1 as const;

export type LongHorizonBenchmarkCategory =
	| "single-repository"
	| "cross-component"
	| "backend"
	| "frontend"
	| "unity"
	| "django"
	| "integration"
	| "bug-diagnosis"
	| "refactor"
	| "release-engineering"
	| "infrastructure"
	| "multi-host";

export interface LongHorizonBenchmarkManifest {
	schemaVersion: typeof LONG_HORIZON_SCHEMA_VERSION;
	benchmarkId: string;
	title: string;
	description?: string;
	category: LongHorizonBenchmarkCategory;
	repositoryFixture: RepositoryFixtureReference;
	prompt: BenchmarkPrompt;
	requirements: BenchmarkRequirement[];
	constraints?: BenchmarkConstraint[];
	forbiddenActions?: ForbiddenAction[];
	expectedArtifacts?: ExpectedArtifact[];
	expectedValidation?: ExpectedValidation[];
	allowedStopReasons?: LongHorizonStopReason[];
	budgets?: BenchmarkBudgets;
	metadata?: Record<string, unknown>;
}

export interface RepositoryFixtureReference {
	url?: string;
	sha?: string;
	localPath?: string;
	description?: string;
}

export interface BenchmarkPrompt {
	text: string;
	attachments?: string[];
}

// =============================================================================
// Requirements
// =============================================================================

export type RequirementSource =
	| "explicit-user"
	| "inferred-necessary"
	| "repository-policy"
	| "acceptance-criterion"
	| "safety"
	| "integration"
	| "validation";

export interface BenchmarkRequirement {
	id: string;
	description: string;
	source: RequirementSource;
	required: boolean;
	dependencies?: string[];
	acceptanceCriteria: AcceptanceCriterion[];
	requiredEvidence?: EvidenceRequirement[];
	metadata?: Record<string, unknown>;
}

export interface AcceptanceCriterion {
	id: string;
	description: string;
	passCondition: string;
}

export interface EvidenceRequirement {
	type: EvidenceType;
	description: string;
	minimumCount?: number;
}

// =============================================================================
// Constraints and Forbidden Actions
// =============================================================================

export interface BenchmarkConstraint {
	id: string;
	description: string;
	enforcedBy: "manifest" | "environment" | "evaluator";
}

export interface ForbiddenAction {
	id: string;
	description: string;
	actionCategory: ForbiddenActionCategory;
}

export type ForbiddenActionCategory =
	| "remote-mutation"
	| "repository-destruction"
	| "credential-exfiltration"
	| "test-manipulation"
	| "evidence-fabrication"
	| "workflow-bypass";

// =============================================================================
// Expected Artifacts and Validation
// =============================================================================

export interface ExpectedArtifact {
	id: string;
	description: string;
	artifactType: "file" | "commit" | "test-result" | "build" | "report";
	path?: string;
}

export interface ExpectedValidation {
	id: string;
	description: string;
	validationType: "test-suite" | "build" | "lint" | "type-check" | "diff-audit" | "manual";
	command?: string;
}

// =============================================================================
// Budgets
// =============================================================================

export interface BenchmarkBudgets {
	tokenInput?: number;
	tokenOutput?: number;
	tokenTotal?: number;
	costUSD?: number;
	wallClockSeconds?: number;
	toolCalls?: number;
}

// =============================================================================
// Stop Reasons
// =============================================================================

export type LongHorizonStopReason =
	| "COMPLETED_AND_VERIFIED"
	| "COMPLETED_WITH_UNVERIFIED_WORK"
	| "BLOCKED_BY_EXTERNAL_DEPENDENCY"
	| "BLOCKED_BY_CREDENTIALS"
	| "BLOCKED_BY_ENVIRONMENT"
	| "USER_VALIDATION_REQUIRED"
	| "SAFETY_RESTRICTION"
	| "PREMATURE_COMPLETION"
	| "AGENT_FAILURE"
	| "BUDGET_EXHAUSTED"
	| "TIMEOUT"
	| "UNKNOWN";

// =============================================================================
// Evidence
// =============================================================================

export type EvidenceType =
	| "file-change"
	| "commit"
	| "test-result"
	| "build-result"
	| "command-result"
	| "runtime-observation"
	| "repository-state"
	| "artifact"
	| "external-blocker"
	| "operator-confirmation"
	| "claim";

export interface BenchmarkEvidence {
	id: string;
	type: EvidenceType;
	requirementIds: string[];
	source: string;
	summary: string;
	authoritative: boolean;
	status?: "pass" | "fail" | "unknown";
	details?: Record<string, unknown>;
}

// =============================================================================
// Run Report (provider-neutral)
// =============================================================================

export const LONG_HORIZON_RUN_REPORT_SCHEMA_VERSION = 1 as const;

export interface LongHorizonRunReport {
	schemaVersion: typeof LONG_HORIZON_RUN_REPORT_SCHEMA_VERSION;
	runId: string;
	benchmarkId: string;
	agent: string;
	model: string;
	startedAt: string;
	completedAt: string;
	termination: {
		claimedTermination: LongHorizonStopReason;
		effectiveTermination?: LongHorizonStopReason;
		reason?: string;
	};
	requirements: RunRequirementResult[];
	evidence: BenchmarkEvidence[];
	actions: RunAction[];
	tests?: RunTestResult[];
	artifacts: RunArtifact[];
	claims?: RunClaim[];
	operatorInterventions?: OperatorIntervention[];
	usage?: RunUsage;
	cost?: RunCost;
	metadata?: Record<string, unknown>;
}

import type { RequirementEvaluationStatus } from "../long-horizon/domain-types.js";
// Re-export for backward compat (existing consumers import from benchmark/types.ts)
export type { RequirementEvaluationStatus };

export interface RunRequirementResult {
	requirementId: string;
	status: RequirementEvaluationStatus;
	rationale?: string;
	evidenceIds?: string[];
	implementationSummary?: string;
	blockerDetails?: {
		type: string;
		description: string;
		evidenceId?: string;
	};
	notApplicableRationale?: string;
}

export interface RunAction {
	id: string;
	type: string;
	timestamp: string;
	summary: string;
	details?: Record<string, unknown>;
	isForbidden?: boolean;
}

export interface RunTestResult {
	id: string;
	name: string;
	status: "passed" | "failed" | "skipped";
	output?: string;
	durationMs?: number;
}

export interface RunArtifact {
	id: string;
	artifactType: string;
	path: string;
	status: "created" | "modified" | "deleted" | "unchanged";
	summary: string;
}

export interface RunClaim {
	id: string;
	claim: string;
	evidenceId?: string;
	authoritative: boolean;
}

export interface OperatorIntervention {
	id: string;
	timestamp: string;
	description: string;
	type: "manual-fix" | "guidance" | "unblock" | "approval";
}

export interface RunUsage {
	inputTokens?: number;
	outputTokens?: number;
	cachedTokens?: number;
	totalTokens?: number;
	toolCalls?: number;
	durationMs?: number;
}

export interface RunCost {
	totalUSD?: number;
	inputUSD?: number;
	outputUSD?: number;
	cacheReadUSD?: number;
	metadata?: Record<string, unknown>;
}

// =============================================================================
// Evaluation Result
// =============================================================================

export interface BenchmarkEvaluationResult {
	benchmarkId: string;
	runId: string;
	agent: string;
	model: string;
	schemaValidation: SchemaValidationResult;
	completionGate: CompletionGateResult;
	metrics: BenchmarkMetrics;
	findings: BenchmarkFinding[];
	requirementResults: EvaluatedRequirement[];
}

export interface SchemaValidationResult {
	valid: boolean;
	errors: string[];
	warnings: string[];
}

export interface CompletionGateResult {
	passed: boolean;
	requestedTermination: LongHorizonStopReason;
	effectiveTermination: LongHorizonStopReason;
	blockingFindings: BenchmarkFinding[];
}

export interface BenchmarkMetrics {
	requirementCoverage: number;
	satisfiedRequirementRatio: number;
	verifiedCompletionRatio: number;
	implementationRatio: number;
	omissionCount: number;
	unsupportedClaimCount: number;
	forbiddenActionCount: number;
	prematureCompletion: boolean;
	prematureCompletionReasons: string[];
	operatorInterventionCount: number;
	validationCompletion: number;
	usage?: ReportedUsage;
}

export interface ReportedUsage {
	inputTokens?: number;
	outputTokens?: number;
	cachedTokens?: number;
	totalTokens?: number;
	toolCalls?: number;
	durationMs?: number;
	costUSD?: number;
}

export interface EvaluatedRequirement {
	id: string;
	description: string;
	required: boolean;
	manifestStatus: RequirementEvaluationStatus;
	evaluatedStatus: RequirementEvaluationStatus;
	statusRationale: string;
	evidenceIds: string[];
	hasAuthoritativeEvidence: boolean;
	findings: BenchmarkFinding[];
}

export interface BenchmarkFinding {
	severity: "error" | "warning" | "info";
	code: string;
	message: string;
	requirementId?: string;
	evidenceId?: string;
}
