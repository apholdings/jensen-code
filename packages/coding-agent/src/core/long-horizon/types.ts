/**
 * Canonical Long-Horizon Mission Contract and Requirement Ledger domain model.
 *
 * Provider-neutral, model-independent types for mission contracts
 * and auditable requirement ledgers.
 *
 * Schema version 1 for both Contract and Ledger.
 *
 * Reuses RequirementEvaluationStatus from the neutral domain-types module
 * as the single canonical source of requirement-state semantics.
 */

import type { RequirementEvaluationStatus } from "./domain-types.js";

// Re-export the canonical requirement states.
// This ensures there is only ONE source of truth for:
//   UNASSESSED, PENDING, IN_PROGRESS, IMPLEMENTED_UNVERIFIED,
//   SATISFIED, BLOCKED, NOT_APPLICABLE, FAILED
export type { RequirementEvaluationStatus } from "./domain-types.js";

// =============================================================================
// Schema versions
// =============================================================================

export const MISSION_CONTRACT_SCHEMA_VERSION = 1 as const;

export const REQUIREMENT_LEDGER_SCHEMA_VERSION = 1 as const;

// =============================================================================
// Mission Contract v1
// =============================================================================

export interface MissionContractV1 {
	contractVersion: 1;
	missionId: string;
	revision: number;
	title: string;
	objective: string;

	workstreams: MissionWorkstream[];
	requirements: MissionRequirement[];
	constraints: MissionConstraint[];
	forbiddenActions: ForbiddenAction[];
	evidencePolicy: MissionEvidencePolicy;

	/** Non-semantic metadata. Arbitrary keys allowed. Excluded from digest. */
	metadata?: Record<string, unknown>;
}

// =============================================================================
// Known top-level keys for strict validation
// =============================================================================

export const MISSION_CONTRACT_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
	"contractVersion",
	"missionId",
	"revision",
	"title",
	"objective",
	"workstreams",
	"requirements",
	"constraints",
	"forbiddenActions",
	"evidencePolicy",
	"metadata",
]);

export const WORKSTREAM_KEYS: ReadonlySet<string> = new Set(["id", "title", "description", "parentId", "order"]);

export const REQUIREMENT_KEYS: ReadonlySet<string> = new Set([
	"id",
	"workstreamId",
	"kind",
	"statement",
	"rationale",
	"sourceRefs",
	"dependencies",
	"acceptanceCriteria",
	"initialApplicability",
]);

export const ACCEPTANCE_CRITERION_KEYS: ReadonlySet<string> = new Set(["id", "statement", "requiredEvidence"]);

export const EVIDENCE_REQUIREMENT_KEYS: ReadonlySet<string> = new Set([
	"allowedTypes",
	"minAuthority",
	"requiredCollectorClass",
	"minPassingStatus",
]);

export const CONSTRAINT_KEYS: ReadonlySet<string> = new Set(["id", "kind", "statement", "sourceRefs", "severity"]);

export const FORBIDDEN_ACTION_KEYS: ReadonlySet<string> = new Set([
	"id",
	"statement",
	"sourceRefs",
	"severity",
	"matchHint",
]);

export const EVIDENCE_POLICY_KEYS: ReadonlySet<string> = new Set(["authoritativeSources", "rules"]);

export const EVIDENCE_POLICY_RULE_KEYS: ReadonlySet<string> = new Set([
	"id",
	"description",
	"allowedTypes",
	"minAuthority",
	"requiredCollectorClass",
]);

// =============================================================================
// Workstreams
// =============================================================================

export interface MissionWorkstream {
	id: string;
	title: string;
	description?: string;
	parentId?: string;
	order?: number;
}

export const MAX_WORKSTREAM_ID_LENGTH = 128;
export const MAX_REQUIREMENT_ID_LENGTH = 128;
export const MAX_CONSTRAINT_ID_LENGTH = 128;
export const MAX_FORBIDDEN_ACTION_ID_LENGTH = 128;
export const MAX_CRITERION_ID_LENGTH = 128;
export const MAX_REQUIREMENT_STATEMENT_LENGTH = 4096;
export const MAX_RATIONALE_LENGTH = 4096;

// =============================================================================
// Requirements
// =============================================================================

export type RequirementKind = "EXPLICIT" | "INFERRED";

export interface MissionRequirement {
	id: string;
	workstreamId: string;
	kind: RequirementKind;
	statement: string;
	rationale?: string;
	sourceRefs: string[];
	dependencies: string[];
	acceptanceCriteria: AcceptanceCriterion[];
	initialApplicability?: "APPLICABLE" | "NOT_APPLICABLE";
}

export interface AcceptanceCriterion {
	id: string;
	statement: string;
	requiredEvidence: EvidenceRequirement[];
}

export interface EvidenceRequirement {
	allowedTypes?: string[];
	minAuthority?: EvidenceAuthorityClassification;
	requiredCollectorClass?: string;
	minPassingStatus?: "pass";
}

// =============================================================================
// Evidence Authority Classification (extends LH-0 trust model)
// =============================================================================

/**
 * Evidence authority classification.
 *
 * Aligned with the LH-0 benchmark trust boundary:
 * - AGENT_CLAIM is always non-authoritative
 * - Other levels require trusted-context capabilities
 */
export type EvidenceAuthorityClassification =
	| "agent-claim"
	| "repository-observation"
	| "command-result"
	| "test-result"
	| "runtime-observation"
	| "operator-confirmation"
	| "trusted-collector";

// =============================================================================
// Constraints
// =============================================================================

export type ConstraintKind = "REQUIRED" | "LIMIT" | "ENVIRONMENT" | "PROCESS" | "SECURITY" | "COMPATIBILITY";

export interface MissionConstraint {
	id: string;
	kind: ConstraintKind;
	statement: string;
	sourceRefs: string[];
	severity: ConstraintSeverity;
}

export type ConstraintSeverity = "error" | "warning";

// =============================================================================
// Forbidden Actions
// =============================================================================

export interface ForbiddenAction {
	id: string;
	statement: string;
	sourceRefs: string[];
	severity: ConstraintSeverity;
	/** Optional metadata for machine-level matching in later LH phases. */
	matchHint?: string;
}

// =============================================================================
// Evidence Policy
// =============================================================================

export interface MissionEvidencePolicy {
	/**
	 * Which evidence types are considered authoritative.
	 * AGENT_CLAIM is never authoritative regardless of this list.
	 */
	authoritativeSources: EvidenceAuthorityClassification[];
	/**
	 * Policy rules for specific evidence types or contexts.
	 */
	rules?: EvidencePolicyRule[];
}

export interface EvidencePolicyRule {
	id: string;
	description: string;
	allowedTypes?: string[];
	minAuthority?: EvidenceAuthorityClassification;
	requiredCollectorClass?: string;
}

// =============================================================================
// Requirement Ledger v1
// =============================================================================

export interface RequirementLedgerV1 {
	ledgerVersion: 1;
	missionId: string;
	contractVersion: 1;
	contractRevision: number;
	contractDigest: string;

	revision: number;
	requirements: RequirementLedgerEntry[];
	evidence: LedgerEvidenceRecord[];
	transitions: RequirementTransition[];
}

// =============================================================================
// Ledger Entry (current state per requirement)
// =============================================================================

export interface RequirementLedgerEntry {
	requirementId: string;
	status: RequirementEvaluationStatus;
	/** The workstream this requirement belongs to (from contract). */
	workstreamId: string;
	/** Whether the requirement was originally declared NOT_APPLICABLE. */
	initialNotApplicable: boolean;
	notApplicableRationale?: string;
	/**
	 * The revision at which this requirement most recently exited SATISFIED.
	 * Set when SATISFIED → IMPLEMENTED_UNVERIFIED, IN_PROGRESS, or FAILED.
	 * Used to enforce evidence freshness after regression.
	 */
	latestRegressionRevision?: number;
}

// =============================================================================
// Ledger Evidence Records
// =============================================================================

export interface LedgerEvidenceRecord {
	id: string;
	type: string;
	requirementIds: string[];
	criterionIds: string[];

	// Reported/descriptive fields — NOT authorization
	/** The collector type as reported by the caller. Not used for authorization. */
	reportedCollectorType: EvidenceCollectorType;
	/** The authority as reported by the caller. Not used for authorization. */
	reportedAuthority: boolean;

	// Verified provenance — derived from trusted context
	/** Effective authority derived from the trusted mutation context. */
	effectiveAuthority: EvidenceAuthorityClassification;
	/** Verified principal ID from trusted context. */
	verifiedPrincipalId: string;
	/** Verified principal kind from trusted context. */
	verifiedPrincipalKind: string;
	/** Capability used to authorize this evidence (if any). */
	verifiedCapability?: string;

	status: "pass" | "fail" | "unknown";
	source: string;
	summary: string;
	digest?: string;
	claimText?: string;
	/** The revision at which this evidence was accepted (before-revision + 1). */
	addedAtRevision: number;
	metadata?: Record<string, unknown>;
}

export type EvidenceCollectorType =
	| "agent"
	| "trusted-collector"
	| "operator"
	| "test-runner"
	| "build-system"
	| "repository-scanner";

// =============================================================================
// Requirement Transitions
// =============================================================================

export interface RequirementTransition {
	id: string;
	ledgerRevisionBefore: number;
	ledgerRevisionAfter: number;
	requirementId: string;
	fromStatus: RequirementEvaluationStatus;
	toStatus: RequirementEvaluationStatus;

	// Reported/descriptive — NOT authorization
	/** The actor type as reported by the caller. Not used for authorization. */
	reportedActorType: string;
	/** The actor ID as reported by the caller. Not used for authorization. */
	reportedActorId?: string;

	// Verified provenance — from trusted context
	/** Verified principal ID from trusted context. */
	verifiedPrincipalId: string;
	/** Verified principal kind from trusted context. */
	verifiedPrincipalKind: string;
	/** Capability used to authorize this transition (if any). */
	verifiedCapability?: string;

	reason: string;
	evidenceIds: string[];
	blockerReference?: string;

	// Runtime NOT_APPLICABLE provenance
	applicabilitySource?: string;
	applicabilityDecisionId?: string;

	metadata?: Record<string, unknown>;
}

// =============================================================================
// Evidence Insertion Request — no authorization fields
// =============================================================================

export interface LedgerEvidenceRequest {
	expectedRevision: number;
	evidence: {
		id: string;
		type: string;
		requirementIds: string[];
		criterionIds: string[];
		status: "pass" | "fail" | "unknown";
		source: string;
		summary: string;
		digest?: string;
		claimText?: string;
		/** Descriptive only — the collector type as reported. Not authorization. */
		reportedCollectorType?: EvidenceCollectorType;
		/** Descriptive only — authority as reported. Not authorization. */
		reportedAuthority?: boolean;
		metadata?: Record<string, unknown>;
	};
}

// =============================================================================
// Transition Request — no authorization fields
// =============================================================================

export interface TransitionRequest {
	/** Caller-supplied deterministic transition ID. Must be non-empty, globally unique. */
	transitionId: string;
	expectedRevision: number;
	requirementId: string;
	toStatus: RequirementEvaluationStatus;
	/** Descriptive only — actor type as reported. Not authorization. */
	reportedActorType?: string;
	/** Descriptive only — actor ID as reported. Not authorization. */
	reportedActorId?: string;
	reason: string;
	evidenceIds: string[];
	blockerReference?: string;
	metadata?: Record<string, unknown>;
}

// =============================================================================
// Ledger Summary
// =============================================================================

export interface LedgerSummary {
	missionId: string;
	contractRevision: number;
	contractDigest: string;
	ledgerRevision: number;
	totalRequirements: number;
	applicableRequirements: number;
	stateCounts: Partial<Record<RequirementEvaluationStatus, number>>;
	explicitCount: number;
	inferredCount: number;
	workstreamSummaries: WorkstreamSummary[];
	blockedRequirements: string[];
	failedRequirements: string[];
	requirementsLackingAuthoritativeEvidence: string[];
	/** True when every applicable requirement is SATISFIED and all trust checks pass. */
	completionCandidate: boolean;
	/** When false, describes why completionCandidate was not met. */
	completionBlockers?: string[];
}

export interface WorkstreamSummary {
	workstreamId: string;
	title: string;
	totalRequirements: number;
	satisfiedCount: number;
}

// =============================================================================
// Validation / Error types
// =============================================================================

export interface ValidationResult {
	valid: boolean;
	errors: ValidationError[];
}

export interface ValidationError {
	path: string;
	message: string;
}

// =============================================================================
// Operation results
// =============================================================================

export interface OperationResult<T> {
	ok: boolean;
	value?: T;
	error?: string;
	code?: OperationErrorCode;
}

export type OperationErrorCode =
	| "INVALID_CONTRACT"
	| "INVALID_LEDGER"
	| "STALE_REVISION"
	| "INVALID_TRANSITION"
	| "INVALID_EVIDENCE"
	| "DUPLICATE_EVIDENCE_ID"
	| "DUPLICATE_TRANSITION_ID"
	| "CONTRACT_DIGEST_MISMATCH"
	| "EVIDENCE_NOT_AUTHORITATIVE"
	| "MISSING_ACCEPTANCE_CRITERIA"
	| "UNKNOWN_REQUIREMENT"
	| "UNKNOWN_CRITERION"
	| "UNKNOWN_EVIDENCE"
	| "WALKED_STATE"
	| "SELF_AUTH_SATISFIED"
	| "NOT_APPLICABLE_AUTHORITY"
	| "TRUSTED_CONTEXT_REQUIRED"
	| "TRUSTED_VALIDATION_CONTEXT_REQUIRED"
	| "AUTHORIZATION_FAILED"
	| "UNKNOWN_SEMANTIC_FIELD"
	| "STALE_EVIDENCE_AFTER_REGRESSION"
	| "UNKNOWN_AUTHORITATIVE_SOURCE"
	| "AUTHORITATIVE_SOURCE_REQUIRED"
	| "SOURCE_EVIDENCE_CAPABILITY_MISMATCH"
	| "SOURCE_PRINCIPAL_MISMATCH"
	| "SOURCE_COLLECTOR_MISMATCH"
	| "SOURCE_EVIDENCE_TYPE_MISMATCH"
	| "SOURCE_REQUIREMENT_MISMATCH"
	| "SOURCE_CRITERION_MISMATCH"
	| "DUPLICATE_TRUSTED_PRINCIPAL"
	| "INVALID_TRUSTED_PRINCIPAL"
	| "INVALID_TRUSTED_CAPABILITY"
	| "DUPLICATE_SOURCE_GRANT"
	| "INVALID_SOURCE_GRANT"
	| "CONTRACT_EVIDENCE_POLICY_VIOLATION"
	| "CRITERION_EVIDENCE_POLICY_VIOLATION"
	| "INTERNAL_REPLAY_INVARIANT_VIOLATION"
	| "TRUSTED_VALIDATION_CONTEXT_CONTRACT_MISMATCH"
	| "INTERNAL_ERROR";

// =============================================================================
// Structural inspection result (untrusted, no completionCandidate)
// =============================================================================

/**
 * Result of untrusted structural ledger inspection.
 *
 * Contains structural state counts and basic validity. Does NOT
 * contain completionCandidate or any trusted completion assessment.
 */
export interface StructuralLedgerInspection {
	missionId: string;
	contractDigest: string;
	ledgerRevision: number;
	totalRequirements: number;
	applicableRequirements: number;
	/**
	 * Structural validity only (contract binding, mutation sequence,
	 * state reconstruction). Does NOT imply trusted provenance.
	 */
	structurallyValid: boolean;
	stateCounts: Partial<Record<RequirementEvaluationStatus, number>>;
	blockedRequirements: string[];
	failedRequirements: string[];
	/**
	 * Always unavailable from untrusted inspection.
	 * Use a trusted validation context for authoritative completion.
	 */
	completionCandidate: "unavailable";
	/**
	 * Always false for structural inspection.
	 * Trusted provenance was NOT verified.
	 */
	trustVerified: false;
}

// =============================================================================
// Authoritative validation result
// =============================================================================

/**
 * Result of authoritative ledger validation with full trust verification.
 *
 * Only produced when a genuine TrustedValidationContext was provided.
 * The trustVerified field is always true for this type.
 */
export interface AuthoritativeLedgerValidationResult {
	/**
	 * Full validation result: structural integrity AND trusted provenance.
	 */
	valid: boolean;
	/**
	 * Always true — this result type is only reachable through a genuine
	 * trusted validation registry.
	 */
	readonly trustVerified: true;
	/**
	 * Structural validation result.
	 * "passed" when contract binding, mutation sequence, and state reconstruction are valid.
	 * "failed" with code and message otherwise.
	 */
	readonly structuralValidation: { status: "passed" } | { status: "failed"; code: string; message: string };
	/**
	 * Provenance validation result.
	 * "passed" when all principal, capability, source, and policy checks passed.
	 * "failed" when any provenance check failed.
	 * "not-reached" when structural validation failed before provenance checks.
	 */
	readonly provenanceValidation:
		| { status: "passed" }
		| { status: "failed"; code: string; message: string }
		| { status: "not-reached" };
}
