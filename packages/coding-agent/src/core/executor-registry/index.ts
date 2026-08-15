/**
 * Executor Registry — public API (2.10.0).
 */

export {
	DEFAULT_EXECUTOR_HEARTBEAT_EXPIRY_MS,
	ExecutorControlService,
	type ExecutorControlServiceOptions,
} from "./executor-control-service.js";
export {
	type CreateExecutorRecordInput,
	createExecutorRecord,
	EXECUTOR_REGISTRY_SCHEMA_VERSION,
	type ExecutorLoadResult,
	type ExecutorMutateResult,
	type ExecutorMutation,
	type ExecutorRecordParseResult,
	type ExecutorRegisterResult,
	type ExecutorRegistryStore,
	executorDefinitionsEqual,
	parseExecutorRecord,
} from "./executor-registry-store.js";
export {
	type ActivateExecutorInput,
	type ExecutorActivationOutcome,
	type ExecutorCapabilities,
	type ExecutorDeactivateOutcome,
	type ExecutorDefinition,
	type ExecutorDetail,
	type ExecutorHeartbeatOutcome,
	type ExecutorListDirection,
	type ExecutorListFilter,
	type ExecutorListOptions,
	type ExecutorListResult,
	type ExecutorListSort,
	type ExecutorLiveness,
	type ExecutorLivenessStatus,
	type ExecutorRecord,
	ExecutorRegistryError,
	type ExecutorRegistryErrorCode,
	type ExecutorResourceSnapshot,
	type ExecutorRetireOutcome,
	type ExecutorRetireStatus,
	type ExecutorRuntime,
	type ExecutorRuntimeMutationInput,
	type ExecutorRuntimeProof,
	type ExecutorSummary,
	type GpuDevice,
	isSafeExecutorId,
	newRuntimeOwnerId,
	type RegisterExecutorInput,
} from "./executor-registry-types.js";
export {
	createFileExecutorRegistry,
	defaultExecutorRegistryRoot,
	FileExecutorRegistry,
	type FileExecutorRegistryOptions,
} from "./file-executor-registry.js";
export {
	collectLocalRuntimeMetadata,
	collectResourceSnapshot,
	ExecutorRuntimeRegistration,
	type ExecutorRuntimeRegistrationOptions,
	type LocalRuntimeMetadata,
} from "./runtime-harness.js";
