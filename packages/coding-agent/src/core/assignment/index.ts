/**
 * Assignment Foundation — public API (2.11.0).
 */

export {
	AssignmentControlService,
	type AssignmentControlServiceOptions,
	type BuildAssignedResumeLaunch,
} from "./assignment-control-service.js";
export {
	ASSIGNMENT_SCHEMA_VERSION,
	type AssignmentListRecordsResult,
	type AssignmentLoadResult,
	type AssignmentMutateResult,
	type AssignmentMutation,
	type AssignmentParseResult,
	type AssignmentStore,
	type CreateAssignmentRecordInput,
	createAssignmentRecord,
	isTerminalAssignmentRecord,
	type MissionAssignmentIndex,
	parseAssignmentRecord,
} from "./assignment-store.js";
export {
	type AcceptAssignmentOutcome,
	ASSIGNMENT_STATES,
	type AssignMissionInput,
	type AssignMissionOutcome,
	type AssignmentDetail,
	AssignmentError,
	type AssignmentErrorCode,
	type AssignmentListDirection,
	type AssignmentListFilter,
	type AssignmentListOptions,
	type AssignmentListResult,
	type AssignmentListSort,
	type AssignmentRecord,
	type AssignmentState,
	type AssignmentSummary,
	assertAssignmentTransition,
	type BeginAssignedExecutionOutcome,
	type CompatibilityRequirementItem,
	type CompatibilityRequirementKind,
	type CompatibilityResult,
	type CompleteAssignmentInput,
	type CompleteAssignmentOutcome,
	canTransitionAssignmentState,
	type ExecutionOwnerIdentity,
	type ExecutorAssignabilityStatus,
	type ExecutorRuntimeObservation,
	isActiveAssignmentState,
	isAssignmentState,
	isSafeAssignmentId,
	type MissionRequirements,
	newAssignmentId,
	type ReassignMissionInput,
	type StartAssignedMissionOutcome,
	toAssignmentSummary,
} from "./assignment-types.js";
export {
	type AssignabilityInput,
	evaluateAssignability,
	evaluateCompatibility,
	mergeExecutorCapabilities,
	toAssignabilityStatus,
} from "./compatibility.js";
export {
	createFileAssignmentStore,
	defaultAssignmentRoot,
	FileAssignmentStore,
	type FileAssignmentStoreOptions,
} from "./file-assignment-store.js";
