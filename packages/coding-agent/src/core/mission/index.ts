/**
 * Durable Mission Graph — public API (2.0.0).
 */

// Approval & blockers
export {
	evaluateApproval,
	isApprovalValid,
	satisfyExternalBlocker,
} from "./approval.js";
// CLI
export { handleMissionCommand } from "./cli.js";
// Contracts & integration
export {
	isContractStale,
	linkProducerConsumer,
	verifyContractCompatibility,
} from "./contract.js";
// Engine
export {
	canExpandScope,
	completeObjective,
	deriveReadiness,
	failObjective,
	initializeRuntime,
	isLegalTransition,
	missionStatus,
	promoteMission,
	reconcileAfterReboot,
	recordApproval,
	recordBlocker,
	replayRuntime,
	startObjective,
} from "./engine.js";
// Graph
export {
	buildDependencyIndex,
	buildMissionDocument,
	computeCriticalPath,
	computeMissionGraphDigest,
	detectCycles,
	objectiveIds,
	topologicallyOrdered,
	validateMissionGraph,
} from "./graph.js";
export {
	addIntegrationCheckpoint,
	beginIntegrationTransaction,
	canTransitionIntegration,
	confirmIntegrationTransaction,
	markIntegrationValidating,
	rollbackIntegrationTransaction,
} from "./integration.js";
// Repository & worktree
export {
	allocateWorktree,
	assertIsolationBoundary,
	blocksEscalatingSegments,
	canonicalRepositoryId,
	detectRepositoryDrift,
	isRepositoryDeclared,
	parseRepositoryIdentity,
	sameRepositoryIdentity,
} from "./repository.js";
// Scheduler
export {
	budgetViolations,
	buildSchedulePlan,
	isObjectiveReady,
	TERMINAL_STATUSES,
	UNSCHEDULABLE_STATUSES,
} from "./scheduler.js";

// Store
export { MissionStore, reconcileProcessAfterReboot } from "./store.js";
// Domain types
export type {
	AcceptanceCriterion,
	ApprovalDecision,
	ApprovalGateSpec,
	ContractRole,
	DependencyEdge,
	DependencyKind,
	ExternalBlockerSpec,
	ExternalBlockerState,
	GraphValidationResult,
	IntegrationTransactionState,
	MissionBudget,
	MissionContract,
	MissionErrorCode,
	MissionEventKind,
	MissionEventRecord,
	MissionGraphDocumentV1,
	MissionObjective,
	MissionOperationResult,
	MissionScope,
	MissionStatus,
	ObjectiveBudget,
	ObjectiveCheckpoint,
	ObjectiveStatus,
	ProcessRecord,
	ReconciliationStatus,
	RecoveryRecord,
	RepositoryIdentity,
	RepositoryIdentityScheme,
	RepositoryLease,
	SchedulePlan,
	StoredMission,
	ValidationIssue,
	WorktreeAllocation,
} from "./types.js";
export {
	isContractRole,
	MISSION_DIGEST_ALGORITHM,
	MISSION_SCHEMA_VERSION,
} from "./types.js";
