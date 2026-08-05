/**
 * Durable Mission Graph — canonical domain model (2.0.0).
 *
 * A Mission is a durable, versioned, scope-explicit execution graph spanning
 * one or more declared repositories. It adds an orchestrating execution layer
 * on top of the long-horizon Mission Contract / Requirement Ledger subsystem.
 *
 * Invariants enforced by the pure modules in this directory:
 *  - a mission's scope is explicit and cannot expand itself
 *  - objectives cannot grant authority to one another
 *  - dependencies are explicit
 *  - acceptance criteria are explicit
 *  - repository/worktree identity is authoritative
 *  - cross-repository mutations require explicit authority
 *  - parallelism never violates dependencies
 *  - leases are repository-scoped
 *  - checkpoints precede mutation
 *  - integration is transactional
 *  - independent completed work is preserved
 *  - human approval nodes cannot be auto-approved
 *  - external blockers cannot be fabricated
 *  - routing cannot override mission policy
 *  - evaluation cannot grant authority
 *  - replay has zero effects
 */

// =============================================================================
// Schema identity
// =============================================================================

export const MISSION_SCHEMA_VERSION = 1 as const;

/** Canonical graph digest algorithm used for durable identity. */
export const MISSION_DIGEST_ALGORITHM = "sha256" as const;

// =============================================================================
// Statuses
// =============================================================================

export type MissionStatus = "DRAFT" | "ACTIVE" | "COMPLETED" | "FAILED" | "ABORTED";

export type ObjectiveStatus =
	| "PENDING"
	| "BLOCKED"
	| "READY"
	| "IN_PROGRESS"
	| "COMPLETED"
	| "FAILED"
	| "SKIPPED"
	| "WAITING_APPROVAL"
	| "WAITING_EXTERNAL";

export type DependencyKind = "REQUIRED" | "OPTIONAL";

export type RepositoryIdentityScheme = "git-url" | "vcs-remote" | "sha" | "canonical";

// =============================================================================
// Scope
// =============================================================================

/**
 * Explicit mission scope. A mission may only operate within these declared
 * repository identities. It cannot expand its own scope.
 */
export interface MissionScope {
	/** Declared repository identities the mission is allowed to touch. */
	repositories: string[];
	/**
	 * When true, every repository referenced by an objective must be declared
	 * in `repositories`. Always true for DRAFT→ACTIVE promotion.
	 */
	requireDeclaredRepositories: true;
}

// =============================================================================
// Acceptance criteria
// =============================================================================

export interface AcceptanceCriterion {
	id: string;
	statement: string;
	/** Evidence authority classifier required for satisfaction (see long-horizon). */
	requiredAuthority?: string;
}

// =============================================================================
// Contracts
// =============================================================================

export type ContractRole = "PRODUCER" | "CONSUMER";

/** Typed cross-objective contract binding. */
export interface MissionContract {
	id: string;
	schema: string;
	revision: number;
	/** producer objective id (may be absent for external contract). */
	producerObjective?: string;
	/** consumer objective id. */
	consumerObjective: string;
	/** Compatibility predicate the consumer requires of the producer output. */
	compatibility: string;
	/** Optional SHA-256 of the contract schema definition. */
	schemaDigest?: string;
}

export function isContractRole(value: string): value is ContractRole {
	return value === "PRODUCER" || value === "CONSUMER";
}

// =============================================================================
// Approval gates
// =============================================================================

export interface ApprovalGateSpec {
	id: string;
	/** The approval must be granted by exactly one of these principals. */
	requiredPrincipals: string[];
	/** Scope of the approval decision. */
	scope: "objective" | "mission";
	/** Optional expiry window (ms) after which an approval lapses. */
	ttlMs?: number;
}

export interface ApprovalDecision {
	gateId: string;
	approved: boolean;
	/** Verified principal that granted (or rejected) the approval. */
	principal: string;
	/** Optional expiry deadline as epoch ms when the decision was captured. */
	expiresAtMs?: number;
	reason?: string;
	recordedAtMs: number;
}

// =============================================================================
// External blockers
// =============================================================================

export interface ExternalBlockerSpec {
	id: string;
	statement: string;
	/** When true, satisfaction requires concrete evidence (cannot be fabricated). */
	evidenceRequired: true;
	/** Acceptable evidence references that mark the blocker satisfied. */
	satisfiedOn: string[];
}

export interface ExternalBlockerState {
	specId: string;
	satisfied: boolean;
	/** Concrete evidence reference that satisfied the blocker. */
	evidenceReference?: string;
	satisfiedAtMs?: number;
}

// =============================================================================
// Budgets
// =============================================================================

export interface ObjectiveBudget {
	/** Maximum execution cost (abstract units) for this objective. */
	maxCost: number;
	spentCost: number;
	route: string;
}

export interface MissionBudget {
	/** Maximum total cost across the mission. */
	maxCost: number;
	spentCost: number;
}

// =============================================================================
// Repository & worktree identity
// =============================================================================

export interface RepositoryIdentity {
	/** Stable canonical identity, e.g. normalized git remote or vcs key. */
	id: string;
	scheme: RepositoryIdentityScheme;
	/** Human-readable remote label (informational only; identity is `id`). */
	label?: string;
}

export interface WorktreeAllocation {
	/**
	 * Absolute path of the allocated worktree. Empty until allocated.
	 * The operator's own worktree is never allocated to a mission.
	 */
	path: string;
	/** The canonical repository identity this worktree belongs to. */
	repositoryId: string;
	isolated: boolean;
}

// =============================================================================
// Objectives
// =============================================================================

export interface MissionObjective {
	id: string;
	title: string;
	/** Explicit dependency objective ids (or external node ids prefixed `ext:`). */
	dependencies: string[];
	/** Declared repository identities this objective may mutate. */
	declaredRepositories: string[];
	/** Weight used for critical-path analysis and scheduling. */
	estimate: number;
	/** Acceptance criteria — explicit, required before completion. */
	acceptanceCriteria: AcceptanceCriterion[];
	requiresApproval: boolean;
	approvalGate?: ApprovalGateSpec;
	externalBlocker?: ExternalBlockerSpec;
	/** Optional per-objective budget. */
	budget?: ObjectiveBudget;
	/** Adaptive routing policy per objective (never overrides mission policy). */
	routingPolicy?: string;
	/** Immutable after first promotion: dependencies, scope, criteria. */
	status: ObjectiveStatus;
}

// =============================================================================
// Durable Mission Graph
// =============================================================================

/**
 * Versioned, hashed, durable mission graph.
 *
 * `digest` is the canonical sha-256 of the semantic payload (scope, objectives,
 * contracts) at this revision. Any semantic change bumps `revision` and
 * recomputes `digest`. Completed objective history is preserved across
 * revision bumps; completed independent work is never discarded.
 */
export interface MissionGraphDocumentV1 {
	schemaVersion: 1;
	missionId: string;
	revision: number;
	/** Canonical identity hash of the semantic payload at this revision. */
	digest: string;
	scope: MissionScope;
	objectives: MissionObjective[];
	contracts: MissionContract[];
	status: MissionStatus;
	/**
	 * Repository identities observed in the environment, reconciled by the
	 * recovery/reconciliation path. Informational; `scope.repositories` stays
	 * the authoritative declaration.
	 */
	observedRepositories?: string[];
	createdAtMs: number;
	updatedAtMs: number;
}

export interface DependencyEdge {
	from: string;
	to: string;
	kind: DependencyKind;
}

// =============================================================================
// Storage / event log / lease / checkpoint primitives
// =============================================================================

export interface StoredMission {
	/** On-disk document (graph + status). */
	document: MissionGraphDocumentV1;
	/** Monotonic mutation sequence for optimistic concurrency. */
	revision: number;
}

export interface MissionEventRecord {
	/** Globally unique, caller-supplied deterministic event id. */
	id: string;
	missionId: string;
	revision: number;
	kind: MissionEventKind;
	payload: Record<string, unknown>;
	recordedAtMs: number;
}

export type MissionEventKind =
	| "MISSION_CREATED"
	| "MISSION_PROMOTED"
	| "OBJECTIVE_STARTED"
	| "OBJECTIVE_COMPLETED"
	| "OBJECTIVE_FAILED"
	| "CHECKPOINT"
	| "INTEGRATION_BEGIN"
	| "INTEGRATION_CONFIRMED"
	| "INTEGRATION_ROLLED_BACK"
	| "APPROVAL_GRANTED"
	| "APPROVAL_REJECTED"
	| "BLOCKER_SATISFIED"
	| "MISSION_COMPLETED"
	| "RECONCILED"
	| "REBOOT_RECOVERED";

// =============================================================================
// Leases
// =============================================================================

/**
 * A repository-scoped lease. A mutation on a repository requires holding the
 * lease for that repository. Leases are never global; they bind to one repo.
 */
export interface RepositoryLease {
	leaseId: string;
	repositoryId: string;
	holder: string;
	acquiredAtMs: number;
	expiresAtMs: number;
}

// =============================================================================
// Checkpoints & integration transactions
// =============================================================================

export interface ObjectiveCheckpoint {
	objectiveId: string;
	/** Sequence number; checkpoints precede mutation. */
	sequence: number;
	state: Record<string, unknown>;
	createdAtMs: number;
}

export interface IntegrationTransactionState {
	transactionId: string;
	objectiveIds: string[];
	repositoryIds: string[];
	stage: "PREPARED" | "CHECKPOINTED" | "VALIDATING" | "CONFIRMED" | "VOLATILE" | "ROLLED_BACK";
	checkpoints: ObjectiveCheckpoint[];
	createdAtMs: number;
	updatedAtMs: number;
}

// =============================================================================
// Process / recovery records
// =============================================================================

export interface ProcessRecord {
	processId: string;
	owner: string;
	repositoryIds: string[];
	status: "running" | "interrupted" | "completed" | "missing";
	startedAtMs: number;
	interruptedAtMs?: number;
}

export interface RecoveryRecord {
	recoveryId: string;
	missionId: string;
	reason: string;
	actions: string[];
	createdAtMs: number;
}

export type ReconciliationStatus = "CLEAN" | "REQUIRED" | "RECONCILED";

// =============================================================================
// Scheduler output
// =============================================================================

export interface SchedulePlan {
	missionId: string;
	revision: number;
	/** Ready objectives in dependency order, grouped into parallel waves. */
	waves: string[][];
	/** Objectives never scheduled (blocked/failed/waiting). */
	unready: string[];
	/** Repository write-conflict cycles serialized. */
	serializedGroups: string[][];
	/** Ordered critical path (longest dependency chain). */
	criticalPath: string[];
	/**
	 * Budget accounting: waves would exceed mission/or objective budgets.
	 * When non-empty and enforce strict scheduling, no wave proceeds.
	 */
	budgetExceeded: boolean;
}

export interface CriticalPathResult {
	/** Objectives on the longest dependency chain (source order). */
	path: string[];
	/** Total weight (sum of estimates) of the critical path. */
	weight: number;
}

export interface GraphValidationResult {
	valid: boolean;
	digest: string;
	revision: number;
	errors: ValidationIssue[];
	cycles: string[][];
	missingDependencies: string[];
	undeclaredRepositories: string[];
	noSelfApproval: boolean;
}

export interface ValidationIssue {
	path: string;
	message: string;
	severity: "error" | "warning";
}

// =============================================================================
// Operation envelope
// =============================================================================

export interface MissionOperationResult<T> {
	ok: boolean;
	value?: T;
	error?: string;
	code?: MissionErrorCode;
}

export type MissionErrorCode =
	| "SCOPE_EXPANSION"
	| "UNDECLARED_REPOSITORY"
	| "CYCLE_DETECTED"
	| "MISSING_DEPENDENCY"
	| "MISSING_ACCEPTANCE_CRITERIA"
	| "SELF_APPROVAL"
	| "APPROVAL_REQUIRED"
	| "APPROVAL_NOT_GRANTED"
	| "APPROVAL_EXPIRED"
	| "BLOCKER_UNSATISFIED"
	| "BLOCKER_WITHOUT_EVIDENCE"
	| "BUDGET_EXCEEDED"
	| "NOT_READY"
	| "DEPENDENCY_UNSATISFIED"
	| "WRITE_CONFLICT"
	| "LEASE_NOT_HELD"
	| "STALE_REVISION"
	| "DUPLICATE_ID"
	| "FORBIDDEN_MUTATION"
	| "NOT_FOUND"
	| "INVALID_GRAPH"
	| "INTEGRATION_IN_PROGRESS"
	| "CONTRACT_MISMATCH"
	| "STALE_CONTRACT"
	| "INTERNAL_ERROR";
