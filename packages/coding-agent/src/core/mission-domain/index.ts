/**
 * First-Class Mission domain primitives (2.3.0).
 *
 * Canonical, executor-independent and provider-independent primitives for
 * delegated work: MissionRequest, MissionHandle, MissionResult, and the
 * MissionState lifecycle machine. The process-spawn path is one executor
 * (`ProcessMissionExecutor`) behind the `MissionExecutor` seam.
 */

export {
	type AcquiredExecutionOwnership,
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
	type DurableMissionMutateResult,
	type DurableMissionMutation,
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
// Execution heartbeat (2.8.0)
export {
	classifyHeartbeatRenewalError,
	defaultHeartbeatScheduler,
	ExecutionAuthorityLostError,
	ExecutionHeartbeat,
	type ExecutionHeartbeatDeps,
	type HeartbeatAuthorityLossInfo,
	type HeartbeatAuthorityLossReason,
	type HeartbeatRenewalFailureKind,
	type HeartbeatScheduler,
	type HeartbeatTelemetry,
	type HeartbeatTimer,
	type HeartbeatTimingInput,
	type ResolvedHeartbeatTiming,
	resolveHeartbeatTiming,
} from "./execution-heartbeat.js";
// Execution lease + fencing (2.7.0)
export {
	DEFAULT_EXECUTION_LEASE_DURATION_MS,
	type ExecutionLease,
	type ExecutionLeaseProof,
	ExecutionOwnershipError,
	type ExecutionOwnershipErrorCode,
	isExecutionLeaseActive,
	newExecutorOwnerId,
} from "./execution-lease.js";
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
	isSafeChildSessionId,
	type MissionAcceptanceCriterion,
	type MissionBudget,
	type MissionExecutionMode,
	type MissionModelPolicy,
	type MissionRequest,
	type MissionRequestValidationError,
	type MissionRequestValidationResult,
	type MissionWorkspaceScope,
	newChildSessionId,
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
