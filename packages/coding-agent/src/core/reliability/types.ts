/**
 * Reliability Kernel — runtime-facing domain types.
 *
 * These types sit above the durable Long-Horizon Mission Contract / Requirement
 * Ledger subsystem. They describe the normalized model↔runtime boundary: the
 * model *proposes* actions; Jensen *decodes*, *validates*, *executes*,
 * *records evidence*, and *decides completion*.
 *
 * Nothing in this file is provider-specific or model-specific. The kernel is
 * deterministic and provider-independent by construction.
 */

// =============================================================================
// Structured Agent Action Envelope
// =============================================================================

/**
 * Normalized, Jensen-owned action protocol. Model output (native tool calls,
 * structured JSON, plain text) is decoded into exactly one of these shapes
 * before anything is executed.
 */
export type AgentAction =
	| ToolCallAction
	| RequestContextAction
	| MissionUpdateAction
	| FinalCandidateAction
	| BlockedAction
	| NoOpAction;

export interface ToolCallAction {
	type: "tool_call";
	/** Canonical tool name. */
	tool: string;
	/** Provider tool-call id when present; otherwise deterministic. */
	toolCallId: string;
	/** Parsed, unvalidated arguments as emitted by the model. */
	arguments: Record<string, unknown>;
	/** Optional model rationale — recorded, never trusted for execution. */
	reason?: string;
}

export interface RequestContextAction {
	type: "request_context";
	query: string;
}

export interface MissionUpdateAction {
	type: "mission_update";
	/** Model-proposed current objective. Informational only. */
	objective?: string;
	/** Model-proposed completed objectives. Informational only. */
	completedObjectives?: string[];
	note?: string;
}

/**
 * A model proposal that work may be finished. This is NOT completion — it is a
 * request that Jensen run the Completion Gate. Jensen alone decides.
 */
export interface FinalCandidateAction {
	type: "final_candidate";
	summary?: string;
	/**
	 * Model-asserted criteria it believes it satisfied. These are recorded but
	 * NEVER trusted: criterion state changes require Jensen-side evidence.
	 */
	claimedCriterionIds?: string[];
}

export interface BlockedAction {
	type: "blocked";
	reason: string;
}

export interface NoOpAction {
	type: "no_op";
	reason?: string;
}

// =============================================================================
// Action Validation
// =============================================================================

export type ActionValidationFailureCategory =
	| "UNKNOWN_ACTION_TYPE"
	| "UNKNOWN_TOOL"
	| "INVALID_ARGUMENTS"
	| "MISSING_REQUIRED_ARGUMENT"
	| "ARGUMENT_TYPE_MISMATCH"
	| "BOUNDARY_VIOLATION"
	| "PERMISSION_VIOLATION"
	| "FORBIDDEN_ACTION"
	| "MISSION_CONSTRAINT_VIOLATION";

/**
 * Structured validation failure. Never executes the tool. This is the API
 * foundation for the future Recovery Engine (2.2.1).
 */
export interface ActionValidationFailure {
	category: ActionValidationFailureCategory;
	message: string;
	/** True when the failure can likely be repaired by model feedback. */
	recoverable: boolean;
	details?: unknown;
}

export type ActionValidationResult =
	| {
			ok: true;
			action: ToolCallAction;
			/** Normalized/canonical arguments validated against the tool schema. */
			normalizedArgs: Record<string, unknown>;
	  }
	| {
			ok: false;
			failure: ActionValidationFailure;
	  };

// =============================================================================
// Evidence
// =============================================================================

export type MissionEvidenceType =
	| "tool_result"
	| "test_result"
	| "build_result"
	| "file_state"
	| "search_result"
	| "verification_result"
	| "user_confirmation";

/**
 * A normalized record of something Jensen actually observed. Evidence is never
 * a model assertion; it carries machine-observable facts (exit code, path,
 * command) that a verifier can interpret deterministically.
 */
export interface MissionEvidence {
	id: string;
	type: MissionEvidenceType;
	/** Stable identifier of the observing source (e.g. "runtime", "test-runner"). */
	source: string;
	summary: string;
	success?: boolean;
	/** Acceptance criterion ids this evidence supports. */
	criterionIds?: string[];
	timestamp: string;
	/** Machine-observable payload (exit code, paths, command). Not raw logs. */
	data?: unknown;
}

// =============================================================================
// Deterministic Verification
// =============================================================================

export type VerificationKind =
	| "command"
	| "test"
	| "build"
	| "lint"
	| "typecheck"
	| "file_exists"
	| "file_absent"
	| "file_contains"
	| "search_no_matches"
	| "git_diff_scope";

export interface VerificationSpec {
	kind: VerificationKind;
	/** For command/test/build/lint/typecheck. */
	command?: string;
	/** For file_* / search_* checks. */
	path?: string;
	pattern?: string;
	/** For search_no_matches / git_diff_scope. */
	cwd?: string;
	/** For git_diff_scope: paths that are allowed to change. */
	allowedPaths?: string[];
}

/**
 * Result of a deterministic verification operation. `passed` is computed by
 * Jensen from the observation, never from model output.
 */
export interface VerificationResult {
	passed: boolean;
	criterionId?: string;
	kind: VerificationKind;
	evidence: MissionEvidence;
	detail?: string;
}

// =============================================================================
// Acceptance Criteria (runtime view)
// =============================================================================

export type CriterionSource = "user" | "system" | "derived";
export type CriterionStatus = "pending" | "passed" | "failed" | "blocked";

export interface RuntimeAcceptanceCriterion {
	id: string;
	description: string;
	/**
	 * `user` — supplied explicitly by the user (preserved faithfully).
	 * `system` — required by Jensen runtime policy (e.g. "build passes").
	 * `derived` — inferred by Jensen from the goal (distinguished from user).
	 */
	source: CriterionSource;
	status: CriterionStatus;
	verification?: VerificationSpec;
	evidenceIds: string[];
}

// =============================================================================
// Completion Gate
// =============================================================================

export type CompletionDecision = "accept" | "reject";

export interface CompletionGateResult {
	decision: CompletionDecision;
	/** Human/machine-readable reasons for the decision. */
	reasons: string[];
	/** Criteria that remain unverified (pending or failed). */
	missingCriterionIds: string[];
	/** Active fatal blockers preventing completion. */
	blockedBy: string[];
	completedCriterionIds: string[];
}

// =============================================================================
// Runtime phases
// =============================================================================

/**
 * Observable agent lifecycle. The durable authority for state transitions is
 * the Long-Horizon Mission Execution State Machine; this is the presentation
 * view for the model and telemetry.
 */
export type ReliabilityPhase =
	| "INITIALIZING"
	| "PLANNING"
	| "ACTING"
	| "OBSERVING"
	| "VERIFYING"
	| "FINALIZING"
	| "COMPLETED"
	| "FAILED"
	| "BLOCKED";

// =============================================================================
// Failure events (normalized taxonomy)
// =============================================================================

export type FailureCategory =
	| "ACTION_DECODE_FAILURE"
	| "ACTION_VALIDATION_FAILURE"
	| "TOOL_EXECUTION_FAILURE"
	| "VERIFICATION_FAILURE"
	| "CONTEXT_REQUIRED"
	| "BOUNDARY_VIOLATION"
	| "PERMISSION_FAILURE"
	| "FINALIZATION_REJECTED"
	| "INTERNAL_RUNTIME_FAILURE";

export interface FailureEvent {
	category: FailureCategory;
	message: string;
	recoverable: boolean;
	timestamp: string;
	details?: unknown;
}

// =============================================================================
// Telemetry
// =============================================================================

export type ReliabilityEventName =
	| "mission_started"
	| "action_proposed"
	| "action_decode_failure"
	| "action_validation_failure"
	| "tool_executed"
	| "tool_failed"
	| "evidence_recorded"
	| "verification_executed"
	| "criterion_passed"
	| "criterion_failed"
	| "finalization_proposed"
	| "finalization_rejected"
	| "mission_completed"
	| "mission_blocked";

export interface ReliabilityEvent {
	name: ReliabilityEventName;
	missionId?: string;
	timestamp: string;
	/** Structured, non-sensitive payload. */
	data?: Record<string, unknown>;
}

export interface ReliabilityMetrics {
	taskSuccess: boolean;
	falseSuccessAttempts: number;
	invalidActionCount: number;
	toolFailureCount: number;
	verificationFailureCount: number;
	finalizationRejectionCount: number;
	actionsExecuted: number;
	modelTurns: number;
	elapsedMs: number;
	missionResumed: boolean;
}
