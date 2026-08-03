export type { BoundaryCheckOptions } from "./boundary.js";
export {
	canonicalKey,
	displayPath,
	isWindows,
	pathExists,
	validatePathInput,
	WorkspaceBoundary,
	WorkspaceBoundaryError,
} from "./boundary.js";
export type { CheckpointEntry, CheckpointStatus, WorkspaceCheckpoint } from "./checkpoint.js";
export {
	CheckpointError,
	CheckpointStore,
	sha256,
} from "./checkpoint.js";
export {
	PRODUCTION_TOOL_EFFECTS,
	UndeclaredEffectsError,
	validateToolEffects,
} from "./effects.js";
export type { LeaseRecord, LeaseResult, LeaseStatus, LeaseStoreOptions } from "./lease.js";
export {
	WorkspaceLeaseError,
	WorkspaceLeaseStore,
} from "./lease.js";
export type { MutationLifecycleEvent, MutationOutcome, WorkspaceSafetyOptions } from "./manager.js";
export {
	PolicyApprovalRequiredError,
	PolicyDeniedError,
	WorkspaceSafety,
} from "./manager.js";
export type { PolicyEngineOptions, PolicyRule } from "./policy.js";
export {
	BASELINE_RULES,
	isSecretPath,
	PolicyEngine,
	workspaceIdFromRoot,
} from "./policy.js";
export type {
	ApplyResult,
	RollbackConflict,
	RollbackResult,
	TransactionRecord,
	TransactionStage,
	ValidationGate,
	WorkspaceEdit,
} from "./transaction.js";
export {
	TransactionError,
	WorkspaceTransactionManager,
} from "./transaction.js";
export type {
	CheckpointId,
	ExecutionMode,
	LeaseId,
	PolicyDecision,
	PolicyEvaluation,
	PolicyInput,
	RecoveryClass,
	RollbackCapability,
	TransactionId,
} from "./types.js";
