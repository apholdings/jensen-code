/**
 * Long-Horizon Context Virtualization (2.5.0).
 *
 * Provider-independent orchestration that keeps MISSION HORIZON decoupled from
 * MODEL CONTEXT WINDOW. A model's physical context is a performance parameter,
 * never a limit on how long a Jensen mission can continue.
 */

export {
	type ContextCapability,
	type ContextCapabilityOverrides,
	type ContextCapabilitySource,
	computeSafeInputBudget,
	contextPressureRatio,
	exceedsSafeInputBudget,
	resolveContextCapability,
} from "./context-capability.js";
export {
	ContextGovernor,
	type ContextGovernorDiagnostics,
	type ContextGovernorOptions,
	type ContextGovernorResult,
	type GovernorAction,
	rehydrateEvidence,
} from "./context-governor.js";
export {
	type ContextAssembly,
	estimateAssemblyInputTokens,
	estimateMessageTokensFor,
	estimateStablePrefixTokens,
	estimateTextTokens,
} from "./context-token.js";
export {
	buildEvidenceRecord,
	deriveEvidenceId,
	type EvidenceArchive,
	EvidenceFileStore,
	type EvidenceKind,
	type EvidenceRecord,
	hashContent,
	InMemoryEvidenceArchive,
	redactSecrets,
} from "./evidence-archive.js";
export {
	type CheckpointPatch,
	checkpointToRehydrationPreamble,
	createMissionContextCheckpoint,
	type DecisionRecord,
	type EvidenceReference,
	type FindingRecord,
	MISSION_CONTEXT_CHECKPOINT_SCHEMA_VERSION,
	type MissionContextCheckpoint,
	parseMissionContextCheckpoint,
	type TestState,
} from "./mission-checkpoint.js";
