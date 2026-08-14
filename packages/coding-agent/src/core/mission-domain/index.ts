/**
 * First-Class Mission domain primitives (2.3.0).
 *
 * Canonical, executor-independent and provider-independent primitives for
 * delegated work: MissionRequest, MissionHandle, MissionResult, and the
 * MissionState lifecycle machine. The process-spawn path is one executor
 * (`ProcessMissionExecutor`) behind the `MissionExecutor` seam.
 */

export {
	DurableMissionCoordinator,
	type DurableMissionCoordinatorOptions,
	type DurableRecoveryReport,
} from "./durable-coordinator.js";
// Durable Missions (2.4.0)
export {
	type CreateDurableMissionRecordInput,
	createDurableMissionRecord,
	DURABLE_MISSION_SCHEMA_VERSION,
	type DurableExecutionAttempt,
	type DurableExecutionAttemptEndReason,
	type DurableMissionCreateResult,
	type DurableMissionLoadResult,
	type DurableMissionParseResult,
	type DurableMissionRecord,
	type DurableMissionSaveOptions,
	type DurableMissionSaveResult,
	type DurableMissionStore,
	type DurableMissionTransition,
	isSafeMissionId,
	missionRequestsEqual,
	parseDurableMissionRecord,
	stableStringify,
} from "./durable-store.js";
export {
	MissionExecutionService,
	type MissionExecutor,
	type MissionLaunchOptions,
} from "./mission-executor.js";
export {
	type CreateMissionHandleInput,
	createMissionHandle,
	type MissionHandle,
} from "./mission-handle.js";
export {
	type CreateMissionRequestInput,
	createMissionRequest,
	type MissionAcceptanceCriterion,
	type MissionBudget,
	type MissionExecutionMode,
	type MissionModelPolicy,
	type MissionRequest,
	type MissionRequestValidationError,
	type MissionRequestValidationResult,
	type MissionWorkspaceScope,
	newMissionId,
	validateMissionRequest,
} from "./mission-request.js";
export {
	aggregateMissionResults,
	type CreateMissionResultInput,
	classifyExecutorOutcome,
	createMissionResult,
	type ExecutorDiagnostics,
	type ExecutorOutcome,
	type ExecutorOutcomeClassification,
	isMissionExecutionOutcome,
	MISSION_CHAIN_CONTINUE_STATES,
	MISSION_EXECUTION_OUTCOMES,
	type MissionExecutionOutcome,
	type MissionResult,
	type MissionSetResult,
	type MissionUsage,
	type MissionVerification,
	type StructuredFailure,
	type StructuredFailureCategory,
	shouldContinueMissionChain,
} from "./mission-result.js";
export {
	assertMissionTransition,
	canTransitionMissionState,
	isMissionState,
	isMissionSuccessState,
	isResumableMissionState,
	isTerminalMissionState,
	MISSION_RESUMABLE_STATES,
	MISSION_STATES,
	MISSION_SUCCESS_STATES,
	MISSION_TERMINAL_STATES,
	type MissionState,
	MissionStateTracker,
	type MissionTransitionResult,
} from "./mission-state.js";
export {
	ProcessMissionExecutor,
	type ProcessMissionExecutorOptions,
	type ProcessMissionHarness,
	type ProcessMissionLaunch,
	type ProcessMissionOutcome,
	type ProcessMissionVerification,
	type ProcessMissionVerifier,
	type ProcessMissionVerifierInput,
} from "./process-mission-executor.js";
export {
	createMissionRuntimeFromRequest,
	toMissionRuntimeDefinition,
} from "./reliability-mapping.js";
