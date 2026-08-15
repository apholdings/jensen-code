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
	type ContextGovernorTelemetry,
	type GovernorAction,
	type ProviderOverflowContext,
	rehydrateEvidence,
	type ToolVirtualizationRecord,
} from "./context-governor.js";
export {
	type ContextAssembly,
	type ContextRegionCosts,
	estimateAssemblyInputTokens,
	estimateContextRegionCosts,
	estimateMessageTokens,
	estimateMessageTokensFor,
	estimateStablePrefixTokens,
	estimateTextTokens,
	type TokenAccounting,
	type TokenAccountingMode,
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
	clampEvidencePageLimit,
	DEFAULT_EVIDENCE_PAGE_CHARS,
	type EvidenceIntegrity,
	type EvidenceRetrievalMetadata,
	type EvidenceRetrievalOptions,
	type EvidenceRetrievalResult,
	type EvidenceRetrievalStatus,
	MAX_EVIDENCE_PAGE_CHARS,
	retrieveEvidencePage,
} from "./evidence-retrieval.js";
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
export {
	analyzeText,
	type ContentClass,
	estimateTextTokens as estimateContentTokens,
	MAX_CALIBRATED_MULTIPLIER,
	resolveAccountingMode,
	type TextTokenAnalysis,
	type TokenAccountingOptions,
} from "./token-accounting.js";
