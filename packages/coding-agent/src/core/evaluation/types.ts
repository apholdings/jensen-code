import type { LongHorizonRunReport } from "../benchmark/types.js";

export const EVALUATION_SCHEMA_VERSION = 1 as const;
export const EVALUATOR_VERSION = "1.0.0" as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type EvaluationCategory =
	| "repository_navigation"
	| "bug_fix"
	| "feature_implementation"
	| "refactor"
	| "test_repair"
	| "long_horizon"
	| "tool_reliability"
	| "safety"
	| "retrieval"
	| "subagent"
	| "mcp"
	| "todo_recovery"
	| "release"
	| "cross_platform";

export type EvaluationMode = "offline" | "fixture" | "sandbox" | "live";
export type EvaluationStatus =
	| "preparing"
	| "running"
	| "evaluating"
	| "completed"
	| "failed"
	| "cancelled"
	| "invalid";
export type EvaluationVerdict = "pass" | "fail" | "invalid" | "cancelled";
export type AssertionStatus = "pass" | "fail" | "invalid" | "not_evaluated";
export type SafetySeverity = "critical" | "high" | "medium" | "low";

export interface EvaluationProvenance {
	classification: "public" | "private-local" | "synthetic" | "generated" | "historical-regression";
	license?: string;
	source?: string;
	defectOrigin?: string;
	notes?: string;
}

export interface EvaluationFixtureSpec {
	kind: "inline" | "local" | "generated" | "provider_trace";
	root?: string;
	files?: Record<string, string>;
	fileHashes?: Record<string, string>;
	git?: { initialize: boolean; branch?: string };
	providerTrace?: string;
	allowExternalSymlinks?: false;
}

export interface EvaluationTaskSpec {
	prompt: string;
	attachments?: string[];
	visibleFiles?: string[];
}

export interface EvaluationCandidatePolicy {
	allowedModes: EvaluationMode[];
	allowNetwork: boolean;
	allowLiveProvider: boolean;
	allowMutation: boolean;
	allowedTools?: string[];
	deniedEffects?: string[];
	workspaceBoundary?: string;
	networkPolicy?: "none" | "loopback_only" | "provider_only" | "explicit_allowlist";
	maximumProcesses?: number;
	maximumToolCalls?: number;
	maximumWallTimeMs?: number;
	maximumOutputBytes?: number;
	maximumDiskBytes?: number;
	maximumCostUsd?: number;
	budget?: EvaluationBudget;
}

export interface EvaluationAssertionSpec {
	assertionId: string;
	kind:
		| "file_exists"
		| "file_absent"
		| "file_content"
		| "git_diff"
		| "command"
		| "event_present"
		| "event_absent"
		| "event_order"
		| "tool_effect"
		| "policy_decision"
		| "transaction_state"
		| "rollback_state"
		| "process_cleanup"
		| "workspace_clean"
		| "budget_bound"
		| "evidence_linkage"
		| "retrieval_relevance"
		| "custom";
	path?: string;
	pattern?: string;
	command?: string;
	expected?: JsonValue;
	dependsOn?: string[];
	severity?: SafetySeverity;
	customKey?: string;
}

export interface EvaluationMetricSpec {
	metricId: string;
	kind: "task" | "reliability" | "efficiency" | "safety" | "quality" | "retrieval";
	direction: "higher_is_better" | "lower_is_better" | "target";
	threshold?: number;
	unit?: string;
}

export interface EvaluationScenario {
	scenarioId: string;
	scenarioVersion: number;
	title: string;
	description: string;
	category: EvaluationCategory;
	fixture: EvaluationFixtureSpec;
	task: EvaluationTaskSpec;
	candidatePolicy: EvaluationCandidatePolicy;
	assertions: EvaluationAssertionSpec[];
	metrics: EvaluationMetricSpec[];
	repetitions: number;
	timeoutMs: number;
	tags: string[];
	provenance: EvaluationProvenance;
	semanticRubricId?: string;
}

export interface EvaluationScenarioPack {
	packId: string;
	packVersion: string;
	schemaVersion: number;
	description: string;
	scenarios: string[];
	compatibility: { minimumJensenVersion?: string; maximumJensenVersion?: string };
	provenance: EvaluationProvenance;
}

export interface EvaluationScenarioIdentity {
	scenarioId: string;
	scenarioVersion: number;
	scenarioContentHash: string;
	packId?: string;
	packVersion?: string;
}

export interface EvaluationCandidateIdentity {
	jensenVersion: string;
	gitCommit?: string;
	packageIntegrity?: string;
	providerProfile: string;
	provider: string;
	configuredModel: string;
	resolvedModel?: string;
	thinkingLevel?: string;
	temperature?: number;
	seed?: number;
	systemPromptHash: string;
	toolSchemaHash: string;
	policyHash: string;
	skillSetHash: string;
	subagentRegistryHash: string;
	retrievalConfigurationHash: string;
	runtimeFeatureFlags: Record<string, boolean>;
}

export interface EvaluationEnvironmentIdentity {
	os: string;
	architecture: string;
	nodeVersion: string;
	packageManager: string;
	jensenPackageIntegrity?: string;
	gitCommit?: string;
	fixtureHash: string;
	timezone: string;
	locale: string;
	availableTools: string[];
	providerFixtureVersion?: string;
	sandboxPolicyVersion: string;
}

export interface EvaluationBudget {
	maximumCostUsd?: number;
	maximumInputTokens?: number;
	maximumOutputTokens?: number;
	maximumModelCalls?: number;
	maximumToolCalls?: number;
	maximumWallTimeMs?: number;
	maximumOutputBytes?: number;
	maximumDiskBytes?: number;
}

export interface EvaluationSandboxIdentity {
	sandboxId: string;
	evaluationRunId: string;
	canonicalRoot: string;
	fixtureHash: string;
	platform: string;
	createdAt: string;
	retained: boolean;
}

export type EvaluationSandboxEventType =
	| "EVAL_SANDBOX_ALLOCATED"
	| "EVAL_SANDBOX_MATERIALIZED"
	| "EVAL_SANDBOX_VERIFIED"
	| "EVAL_CANDIDATE_STARTED"
	| "EVAL_CANDIDATE_COMPLETED"
	| "EVAL_CANDIDATE_FAILED"
	| "EVAL_SANDBOX_CLEANUP_STARTED"
	| "EVAL_SANDBOX_CLEANUP_COMPLETED"
	| "EVAL_SANDBOX_RETAINED";

export interface EvaluationReviewerAssignment {
	reviewerRunId: string;
	candidateEvaluationRunId: string;
	reviewerDefinition: string;
	rubricId: string;
	rubricVersion: number;
	evidencePacketId: string;
}

export interface CavecrewComparisonResult {
	comparisonId: string;
	scenarioId: string;
	singleAgentRunId: string;
	cavecrewRunId: string;
	correctnessDelta: number;
	safetyDelta: number;
	wallTimeDeltaMs: number;
	modelCallDelta: number;
	tokenDelta: number;
	costDeltaUsd?: number;
	toolCallDelta: number;
	retrievalDelta: number;
	rollbackDelta: number;
	deterministicWinner: "single_agent" | "cavecrew" | "tie" | "invalid";
	semanticPreference?: "single_agent" | "cavecrew" | "tie" | "invalid";
}

export interface EvaluationRetentionPolicy {
	policyVersion: number;
	rules: Array<{
		class: string;
		minimumRetentionDays?: number;
		maximumRetentionDays?: number;
		preserveWhenReferenced: boolean;
		preserveForRelease: boolean;
	}>;
}

export interface EvaluationPruneManifest {
	manifestId: string;
	policyVersion: number;
	createdAt: string;
	entries: Array<{
		artifactId: string;
		retentionClass: string;
		reasonCode: string;
		estimatedBytes: number;
	}>;
	protectedEntries: Array<{
		artifactId: string;
		reasonCode: string;
	}>;
}

export interface ReleaseConvergenceState {
	releaseId: string;
	version: string;
	releaseCommit: string;
	functionalEvaluation: "pending" | "passed" | "failed";
	packageBuild: "pending" | "passed" | "failed";
	npmPublication: "pending" | "partial" | "complete" | "failed";
	sourceTag: "pending" | "created" | "failed";
	binaryBuild: "pending" | "passed" | "failed";
	binarySmoke: "pending" | "passed" | "failed";
	assetUpload: "pending" | "partial" | "complete" | "failed";
	assetVerification: "pending" | "passed" | "failed";
	githubRelease: "pending" | "published" | "failed";
	finalVerdict: "incomplete" | "blocked" | "pass";
}

export interface EvaluationRun {
	evaluationRunId: string;
	scenarioId: string;
	scenarioVersion: number;
	scenarioContentHash: string;
	mode: EvaluationMode;
	candidate: EvaluationCandidateIdentity;
	baseline?: EvaluationCandidateIdentity;
	environmentIdentity: EvaluationEnvironmentIdentity;
	startedAt: string;
	completedAt?: string;
	status: EvaluationStatus;
	resultArtifactId?: string;
	sandboxIdentity?: EvaluationSandboxIdentity;
	eventCount?: number;
}

export interface EvaluationEvent {
	eventId: string;
	type: string;
	timestamp: string;
	severity?: SafetySeverity;
	tool?: string;
	phase?: string;
	details?: Record<string, JsonValue>;
}

export interface EvaluationEvidence {
	evidenceId: string;
	type: string;
	summary: string;
	source: "durable_event" | "fixture" | "workspace" | "assertion" | "reviewer";
	contentHash?: string;
	redacted: boolean;
}

export interface EvaluationAssertionResult {
	assertionId: string;
	status: AssertionStatus;
	expected: JsonValue | undefined;
	observed: JsonValue | undefined;
	evidenceIds: string[];
	reasonCode: string;
	severity?: SafetySeverity;
}

export interface EvaluationMetricResult {
	metricId: string;
	value: number | undefined;
	unit?: string;
	source: "durable_event" | "provider_reported" | "calculated" | "semantic";
	version: number;
}

export interface SemanticEvaluationRubric {
	rubricId: string;
	version: number;
	dimensions: Array<{
		name: string;
		description: string;
		minimum: number;
		maximum: number;
		anchors: Record<string, string>;
		weight: number;
	}>;
}

export interface SemanticEvaluationResult {
	rubricId: string;
	rubricVersion: number;
	judgeId: string;
	status: "pass" | "fail" | "uncertain" | "invalid" | "unavailable";
	dimensions: Record<string, number | undefined>;
	rationale: string;
	candidateIdentityHidden: boolean;
	toolExecutionAllowed: false;
}

export interface EvaluationStabilityResult {
	repetitions: number;
	passCount: number;
	failCount: number;
	invalidCount: number;
	outcomeVariance: number;
	metricVariance: Record<string, number>;
	classification: "stable_pass" | "stable_fail" | "flaky" | "insufficient_samples";
	seeds: number[];
}

export interface EvaluationArtifact {
	schemaVersion: number;
	evaluatorVersion: string;
	run: EvaluationRun;
	scenario: EvaluationScenarioIdentity;
	candidate: EvaluationCandidateIdentity;
	baseline?: EvaluationCandidateIdentity;
	assertions: EvaluationAssertionResult[];
	metrics: EvaluationMetricResult[];
	semanticResults: SemanticEvaluationResult[];
	events?: EvaluationEvent[];
	usage?: EvaluationBudget & { estimatedCostUsd?: number; providerReportedCostUsd?: number };
	stability?: EvaluationStabilityResult;
	verdict: EvaluationVerdict;
	evidenceIds: string[];
	artifactHash: string;
	provenance: { createdAt: string; sourceRunIds: string[]; evaluatorVersion: string };
}

export interface PairwiseEvaluationResult {
	scenarioId: string;
	baselineRunId: string;
	candidateRunId: string;
	deterministicComparison: { baselinePassed: boolean; candidatePassed: boolean };
	metricDeltas: Record<string, number | undefined>;
	semanticPreference?: "baseline" | "candidate" | "tie" | "invalid";
	confidence?: number;
	method?: string;
}

export interface StatisticalComparison {
	sampleSize: number;
	confidenceLevel: number;
	method: "paired_win_tie_loss" | "bootstrap_percentile";
	winRate: number | undefined;
	tieRate: number | undefined;
	lossRate: number | undefined;
	confidenceInterval?: { lower: number; upper: number };
	adequateSample: boolean;
}

export interface EvaluationRegressionRule {
	metricId: string;
	maximumRelativeIncrease?: number;
	minimumAbsoluteDecrease?: number;
	severity: SafetySeverity;
}

export interface EvaluationReleaseGate {
	gateId: string;
	scenarioPack: string;
	baselineId: string;
	requiredScenarioPasses: string[];
	forbiddenRegressions: EvaluationRegressionRule[];
	maximumCriticalSafetyFailures: 0;
	maximumHighSafetyFailures: 0;
	flakinessPolicy: { rejectNewFlakiness: boolean; minimumRepetitions: number };
}

export interface EvaluationGateResult {
	gateId: string;
	passed: boolean;
	checks: Array<{ checkId: string; passed: boolean; reason: string }>;
	artifactIds: string[];
	verdict: EvaluationVerdict;
}

export interface EvaluationInput {
	scenario: EvaluationScenario;
	run: EvaluationRun;
	events: EvaluationEvent[];
	workspaceRoot?: string;
	benchmarkReport?: LongHorizonRunReport;
	assertions?: EvaluationAssertionSpec[];
	metrics?: EvaluationMetricSpec[];
}
