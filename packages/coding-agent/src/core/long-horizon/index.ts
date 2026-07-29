/**
 * Long-Horizon public API.
 *
 * Exports all pure functions, types, and CLI handler for
 * the Mission Contract and Requirement Ledger system.
 */

// Pure APIs
export { toCanonicalJson } from "./canonical-json.js";
// CLI
export { handleLongHorizonCommand } from "./cli.js";
export { computeMissionContractDigest } from "./contract-digest.js";
// Execution State Machine types
export type {
	MissionExecutionErrorCode,
	MissionExecutionInspectionResult,
	MissionExecutionRecordV1,
	MissionExecutionState,
	MissionExecutionTransitionKind,
	MissionExecutionTransitionRecordV1,
	MissionExecutionTransitionRequestV1,
	MissionExecutionTransitionResult,
	MissionExecutionValidationResult,
	ResumableMissionExecutionState,
} from "./execution-state-machine.js";
// Execution State Machine
export {
	applyMissionExecutionTransition,
	EXECUTION_COMPLETION_CAPABILITY,
	initializeMissionExecution,
	inspectMissionExecution,
	MISSION_EXECUTION_RECORD_VERSION,
	validateMissionExecutionRecord,
} from "./execution-state-machine.js";
export {
	deriveCurrentStates,
	getRequirementStatus,
	isTerminalState,
	verifyLedgerConsistency,
} from "./ledger-reducer.js";
export { deriveRequirementLedgerSummary, inspectLedgerStructure } from "./ledger-summary.js";
export {
	validateCriterionReferences,
	validateMissionContract,
	validateSourceGrantCriterionIds,
} from "./mission-contract-schema.js";
export {
	addLedgerEvidence,
	applyRequirementTransition,
	evaluateSatisfiedTransition,
	initializeRequirementLedger,
	inspectRequirementLedgerStructure,
	validateRequirementLedger,
	validateRequirementLedgerStrict,
} from "./requirement-ledger.js";
export {
	authorizeTransition,
	checkEvidenceFreshnessAfterRegression,
	getPermittedTransitions,
	isForbiddenDirectSatisfied,
	isSatisfactionAuthorized,
	validateTransition,
} from "./transition-policy.js";
// Public types
export type {
	EvidenceLedgerCapability,
	EvidenceSourceVerificationRequest,
	LedgerCapability,
	TrustedEvidenceSourceGrant,
	TrustedLedgerMutationContext,
	TrustedPrincipalKind,
	TrustedValidationContext,
} from "./trusted-context.js";
// Trusted context: public safe APIs only
// INTERNAL FACTORIES (_internalCreateTrustedContext, _internalCreateTrustedValidationContext)
// are NOT exported from this public index. Tests must import from trusted-context.ts directly.
// getUntrustedValidationContext is DEPRECATED — use inspectRequirementLedgerStructure instead.
export {
	capabilityToAuthority,
	contextHasAnyCapability,
	contextHasCapability,
	deriveEffectiveAuthority,
	getUntrustedContext,
	isEvidenceCapability,
	isTrustedMutationContext,
	isTrustedValidationContext,
} from "./trusted-context.js";
// Types
export type {
	AcceptanceCriterion,
	AuthoritativeLedgerValidationResult,
	EvidenceAuthorityClassification,
	EvidenceCollectorType,
	EvidencePolicyRule,
	EvidenceRequirement,
	ForbiddenAction,
	LedgerEvidenceRecord,
	LedgerEvidenceRequest,
	LedgerSummary,
	MissionConstraint,
	MissionContractV1,
	MissionEvidencePolicy,
	MissionRequirement,
	MissionWorkstream,
	OperationErrorCode,
	OperationResult,
	RequirementEvaluationStatus,
	RequirementLedgerEntry,
	RequirementLedgerV1,
	RequirementTransition,
	StructuralLedgerInspection,
	TransitionRequest,
	ValidationError,
	ValidationResult,
	WorkstreamSummary,
} from "./types.js";
// Re-exports
export {
	MAX_CRITERION_ID_LENGTH,
	MAX_REQUIREMENT_ID_LENGTH,
	MAX_WORKSTREAM_ID_LENGTH,
	MISSION_CONTRACT_SCHEMA_VERSION,
	REQUIREMENT_LEDGER_SCHEMA_VERSION,
} from "./types.js";
