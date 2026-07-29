/**
 * Mission Execution State Machine v1.
 *
 * Governs the lifecycle of one Mission Contract execution through
 * a deterministic, replayable state machine. Every transition is
 * caller-supplied (executionId, transitionId, expectedRevision) and
 * the machine derives the destination state internally.
 *
 * Trusted completion (APPROVE_COMPLETION) requires a genuine
 * contract-bound TrustedValidationContext. The generic CLI cannot
 * mint one and must reject APPROVE_COMPLETION atomically.
 *
 * Full requirement-evidence completion gate deferred to LH-5.
 */

import { computeMissionContractDigest } from "./contract-digest.js";
import { _getBoundContractDigest, type TrustedValidationContext } from "./trusted-context.js";
import type { MissionContractV1 } from "./types.js";

// =============================================================================
// Schema constants
// =============================================================================

export const MISSION_EXECUTION_RECORD_VERSION = 1 as const;

// =============================================================================
// Mission Execution State
// =============================================================================

export type MissionExecutionState =
	| "PLANNING"
	| "EXECUTION"
	| "VERIFICATION"
	| "COMPLETION_REVIEW"
	| "BLOCKED"
	| "COMPLETED"
	| "FAILED"
	| "CANCELLED";

/** States from which execution can resume after BLOCKED. */
export type ResumableMissionExecutionState = Extract<
	MissionExecutionState,
	"PLANNING" | "EXECUTION" | "VERIFICATION" | "COMPLETION_REVIEW"
>;

// =============================================================================
// Terminal states
// =============================================================================

export const TERMINAL_STATES: ReadonlySet<MissionExecutionState> = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

export const RESUABLE_STATES: ReadonlySet<MissionExecutionState> = new Set([
	"PLANNING",
	"EXECUTION",
	"VERIFICATION",
	"COMPLETION_REVIEW",
]);

// =============================================================================
// Transition Kinds
// =============================================================================

export type MissionExecutionTransitionKind =
	| "START_EXECUTION"
	| "REQUEST_VERIFICATION"
	| "RETURN_TO_EXECUTION"
	| "REQUEST_COMPLETION_REVIEW"
	| "RETURN_TO_VERIFICATION"
	| "APPROVE_COMPLETION"
	| "BLOCK"
	| "RESUME"
	| "FAIL"
	| "CANCEL";

// =============================================================================
// Transition graph — source state → (kind → destination state)
// =============================================================================

const TRANSITION_GRAPH: ReadonlyMap<
	MissionExecutionState,
	ReadonlyMap<MissionExecutionTransitionKind, MissionExecutionState>
> = new Map([
	[
		"PLANNING",
		new Map([
			["START_EXECUTION", "EXECUTION"],
			["BLOCK", "BLOCKED"],
			["FAIL", "FAILED"],
			["CANCEL", "CANCELLED"],
		]),
	],
	[
		"EXECUTION",
		new Map([
			["REQUEST_VERIFICATION", "VERIFICATION"],
			["BLOCK", "BLOCKED"],
			["FAIL", "FAILED"],
			["CANCEL", "CANCELLED"],
		]),
	],
	[
		"VERIFICATION",
		new Map([
			["RETURN_TO_EXECUTION", "EXECUTION"],
			["REQUEST_COMPLETION_REVIEW", "COMPLETION_REVIEW"],
			["BLOCK", "BLOCKED"],
			["FAIL", "FAILED"],
			["CANCEL", "CANCELLED"],
		]),
	],
	[
		"COMPLETION_REVIEW",
		new Map([
			["RETURN_TO_EXECUTION", "EXECUTION"],
			["RETURN_TO_VERIFICATION", "VERIFICATION"],
			["APPROVE_COMPLETION", "COMPLETED"],
			["BLOCK", "BLOCKED"],
			["FAIL", "FAILED"],
			["CANCEL", "CANCELLED"],
		]),
	],
	[
		"BLOCKED",
		new Map([
			["RESUME", "BLOCKED"], // RESUME uses dynamic blockedFromState — validated separately
			["FAIL", "FAILED"],
			["CANCEL", "CANCELLED"],
		]),
	],
	["COMPLETED", new Map()],
	["FAILED", new Map()],
	["CANCELLED", new Map()],
]);

// =============================================================================
// Mission Execution Transition Record v1
// =============================================================================

export interface MissionExecutionTransitionRecordV1 {
	/** Caller-supplied. Must be unique, non-empty, trimmed. */
	transitionId: string;
	/** The kind of transition requested. */
	kind: MissionExecutionTransitionKind;
	/** The state before this transition was applied. */
	fromState: MissionExecutionState;
	/** The state after this transition was applied (derived by the machine). */
	toState: MissionExecutionState;
	/** The revision before the transition. revisionAfter = revisionBefore + 1. */
	revisionBefore: number;
	/** The revision after the transition. */
	revisionAfter: number;
}

// =============================================================================
// Mission Execution Record v1
// =============================================================================

export interface MissionExecutionRecordV1 {
	readonly executionVersion: 1;
	/** Caller-supplied execution identifier. Must be non-empty, trimmed. */
	readonly executionId: string;
	/** The canonical SHA-256 digest of the bound Mission Contract. */
	readonly contractDigest: string;
	/** Monotonically increasing revision counter. Starts at 0. */
	readonly revision: number;
	/** Current execution state. */
	readonly state: MissionExecutionState;
	/**
	 * The exact active state when BLOCKED was entered.
	 * Present only when state === BLOCKED.
	 */
	readonly blockedFromState?: ResumableMissionExecutionState;
	/** Append-only transition history. */
	readonly transitions: readonly MissionExecutionTransitionRecordV1[];
}

// =============================================================================
// Known top-level keys for strict validation
// =============================================================================

export const MISSION_EXECUTION_RECORD_KEYS: ReadonlySet<string> = new Set([
	"executionVersion",
	"executionId",
	"contractDigest",
	"revision",
	"state",
	"blockedFromState",
	"transitions",
]);

export const MISSION_EXECUTION_TRANSITION_KEYS: ReadonlySet<string> = new Set([
	"transitionId",
	"kind",
	"fromState",
	"toState",
	"revisionBefore",
	"revisionAfter",
]);

// =============================================================================
// Valid states and kinds for fast lookup
// =============================================================================

const VALID_STATES: ReadonlySet<string> = new Set([
	"PLANNING",
	"EXECUTION",
	"VERIFICATION",
	"COMPLETION_REVIEW",
	"BLOCKED",
	"COMPLETED",
	"FAILED",
	"CANCELLED",
]);

const VALID_KINDS: ReadonlySet<string> = new Set([
	"START_EXECUTION",
	"REQUEST_VERIFICATION",
	"RETURN_TO_EXECUTION",
	"REQUEST_COMPLETION_REVIEW",
	"RETURN_TO_VERIFICATION",
	"APPROVE_COMPLETION",
	"BLOCK",
	"RESUME",
	"FAIL",
	"CANCEL",
]);

const RESUABLE_STATES_SET: ReadonlySet<string> = new Set([
	"PLANNING",
	"EXECUTION",
	"VERIFICATION",
	"COMPLETION_REVIEW",
]);

// =============================================================================
// Transition Request v1
// =============================================================================

export interface MissionExecutionTransitionRequestV1 {
	/** Caller-supplied. Must be unique, non-empty, trimmed. */
	transitionId: string;
	/** The expected current revision. Rejected if mismatch. */
	expectedRevision: number;
	/** The transition kind. */
	kind: MissionExecutionTransitionKind;
}

// =============================================================================
// Validation Result
// =============================================================================

export type MissionExecutionValidationResult =
	| { readonly valid: true }
	| { readonly valid: false; readonly error: string };

export type MissionExecutionInspectionResult =
	| {
			readonly valid: true;
			readonly executionId: string;
			readonly contractDigest: string;
			readonly state: MissionExecutionState;
			readonly revision: number;
			readonly transitionCount: number;
			readonly blockedFromState?: ResumableMissionExecutionState;
			readonly completionApproved: "unavailable";
	  }
	| {
			readonly valid: false;
			readonly error: string;
	  };

export type MissionExecutionTransitionResult =
	| { readonly ok: true; readonly record: MissionExecutionRecordV1 }
	| { readonly ok: false; readonly error: string; readonly code: MissionExecutionErrorCode };

export type MissionExecutionErrorCode =
	| "INVALID_EXECUTION_RECORD"
	| "INVALID_TRANSITION"
	| "STALE_REVISION"
	| "DUPLICATE_TRANSITION_ID"
	| "TERMINAL_STATE"
	| "ILLEGAL_TRANSITION"
	| "SELF_TRANSITION"
	| "BLOCK_WHILE_BLOCKED"
	| "RESUME_WHILE_NOT_BLOCKED"
	| "RESUME_STATE_NOT_RESUMABLE"
	| "TRUSTED_VALIDATION_CONTEXT_REQUIRED"
	| "EXECUTION_COMPLETION_CAPABILITY_REQUIRED"
	| "CONTRACT_DIGEST_MISMATCH"
	| "UNKNOWN_SEMANTIC_FIELD"
	| "INTERNAL_ERROR";

// =============================================================================
// Execution completion capability
// =============================================================================

export const EXECUTION_COMPLETION_CAPABILITY = "execution:complete" as const;

// =============================================================================
// Deterministic validation of a raw execution record
// =============================================================================

/**
 * Validate a MissionExecutionRecordV1 against its bound Mission Contract.
 * Performs deep structural validation, unknown-field rejection, and
 * full transition-history replay.
 */
export function validateMissionExecutionRecord(
	contract: MissionContractV1,
	record: unknown,
): MissionExecutionValidationResult {
	if (!isRecord(record)) {
		return { valid: false, error: "Execution record must be a non-null object" };
	}

	// Phase 1: Top-level structural validation
	const structErr = validateExecutionRecordStructure(record);
	if (structErr) return { valid: false, error: structErr };

	const rec = record as Record<string, unknown>;

	// Phase 2: Contract digest binding
	const contractDigest = computeMissionContractDigest(contract);
	if (rec.contractDigest !== contractDigest) {
		return { valid: false, error: "CONTRACT_DIGEST_MISMATCH: record contractDigest does not match contract" };
	}

	// Phase 3: Transition history validation and replay
	const transitions = rec.transitions as unknown[];
	if (!Array.isArray(transitions)) {
		return { valid: false, error: "transitions must be an array" };
	}

	const typedTransitions = transitions as unknown[];

	// Validate each transition entry structurally
	const seenIds = new Set<string>();
	for (let i = 0; i < typedTransitions.length; i++) {
		const tx = typedTransitions[i];
		const txErr = validateTransitionStructure(tx, i);
		if (txErr) return { valid: false, error: txErr };

		const t = tx as Record<string, unknown>;

		const transitionId = t.transitionId as string;
		if (seenIds.has(transitionId)) {
			return { valid: false, error: `transitions[${i}]: duplicate transition ID "${transitionId}"` };
		}
		seenIds.add(transitionId);

		// Revision continuity
		const revisionBefore = t.revisionBefore as number;
		const revisionAfter = t.revisionAfter as number;
		if (revisionAfter !== revisionBefore + 1) {
			return {
				valid: false,
				error: `transitions[${i}]: revisionAfter (${revisionAfter}) must equal revisionBefore + 1 (${revisionBefore + 1})`,
			};
		}

		if (i > 0) {
			const prevTx = typedTransitions[i - 1] as Record<string, unknown>;
			if (revisionBefore !== (prevTx.revisionAfter as number)) {
				return {
					valid: false,
					error: `transitions[${i}]: revision discontinuity at transition ${i} (expected ${prevTx.revisionAfter}, got ${revisionBefore})`,
				};
			}
		} else {
			// First transition must have revisionBefore === 0
			if (revisionBefore !== 0) {
				return {
					valid: false,
					error: `transitions[0]: first transition must have revisionBefore 0, got ${revisionBefore}`,
				};
			}
		}
	}

	// Phase 4: Replay the full history to derive final state
	const replayResult = replayExecutionHistory(typedTransitions);
	if (!replayResult.ok) {
		return { valid: false, error: replayResult.error! };
	}

	// Phase 5: Verify recorded state matches replayed state
	if (rec.state !== replayResult.state) {
		return {
			valid: false,
			error: `state mismatch: record claims "${rec.state}" but replayed history produces "${replayResult.state}"`,
		};
	}

	// Phase 6: Verify blockedFromState consistency
	if (rec.state === "BLOCKED") {
		if (rec.blockedFromState === undefined) {
			return { valid: false, error: "blockedFromState is required when state is BLOCKED" };
		}
		if (rec.blockedFromState !== replayResult.blockedFromState) {
			return {
				valid: false,
				error: `blockedFromState mismatch: record claims "${rec.blockedFromState}" but replayed history produces "${replayResult.blockedFromState}"`,
			};
		}
	} else {
		if (rec.blockedFromState !== undefined) {
			return {
				valid: false,
				error: `blockedFromState must not be present when state is "${rec.state}"`,
			};
		}
	}

	// Phase 7: Verify revision equals transition history length
	if (rec.revision !== typedTransitions.length) {
		return {
			valid: false,
			error: `revision (${rec.revision}) must equal transition history length (${typedTransitions.length})`,
		};
	}

	return { valid: true };
}

// =============================================================================
// Initialize a new MissionExecutionRecordV1 in PLANNING state
// =============================================================================

/**
 * Create a new MissionExecutionRecordV1 with revision 0 and state PLANNING.
 * The executionId and contractDigest are caller-supplied and deterministic.
 */
export function initializeMissionExecution(contract: MissionContractV1, executionId: string): MissionExecutionRecordV1 {
	if (!executionId || executionId.trim().length === 0) {
		throw new Error("executionId must be non-empty and trimmed");
	}
	if (executionId !== executionId.trim()) {
		throw new Error("executionId must be trimmed (no leading/trailing whitespace)");
	}

	const contractDigest = computeMissionContractDigest(contract);

	return freezeRecord({
		executionVersion: 1 as const,
		executionId: executionId.trim(),
		contractDigest,
		revision: 0,
		state: "PLANNING" as const,
		transitions: Object.freeze([] as MissionExecutionTransitionRecordV1[]),
	}) as unknown as MissionExecutionRecordV1;
}

// =============================================================================
// Structural inspection (untrusted)
// =============================================================================

/**
 * Inspect a MissionExecutionRecordV1 structurally without requiring
 * trusted provenance. Never claims completion approval.
 */
export function inspectMissionExecution(
	_contract: MissionContractV1,
	record: unknown,
): MissionExecutionInspectionResult {
	if (!isRecord(record)) {
		return { valid: false, error: "Execution record must be a non-null object" };
	}

	const rec = record as Record<string, unknown>;

	// Basic structural checks
	if (typeof rec.executionId !== "string" || rec.executionId.trim().length === 0) {
		return { valid: false, error: "executionId must be a non-empty trimmed string" };
	}
	if (typeof rec.contractDigest !== "string") {
		return { valid: false, error: "contractDigest must be a string" };
	}
	if (typeof rec.revision !== "number" || !Number.isSafeInteger(rec.revision) || rec.revision < 0) {
		return { valid: false, error: "revision must be a safe non-negative integer" };
	}
	if (typeof rec.state !== "string" || !VALID_STATES.has(rec.state)) {
		return { valid: false, error: `state must be a valid MissionExecutionState, got "${rec.state}"` };
	}
	if (!Array.isArray(rec.transitions)) {
		return { valid: false, error: "transitions must be an array" };
	}

	const state = rec.state as MissionExecutionState;
	const revision = rec.revision as number;

	// blockedFromState check
	let blockedFromState: ResumableMissionExecutionState | undefined;
	if (state === "BLOCKED") {
		if (typeof rec.blockedFromState !== "string" || !RESUABLE_STATES_SET.has(rec.blockedFromState)) {
			return {
				valid: false,
				error: `blockedFromState must be a resumable state when state is BLOCKED`,
			};
		}
		blockedFromState = rec.blockedFromState as ResumableMissionExecutionState;
	} else if (rec.blockedFromState !== undefined) {
		return { valid: false, error: `blockedFromState must not be present when state is "${state}"` };
	}

	return {
		valid: true,
		executionId: rec.executionId as string,
		contractDigest: rec.contractDigest as string,
		state,
		revision,
		transitionCount: rec.transitions.length,
		blockedFromState,
		completionApproved: "unavailable",
	};
}

// =============================================================================
// Apply a transition
// =============================================================================

/**
 * Apply a deterministic transition to a MissionExecutionRecordV1.
 *
 * Every mutation requires expectedRevision, caller-supplied transitionId,
 * and a transition kind. The destination state is derived by the state
 * machine from the current state and the transition kind.
 *
 * APPROVE_COMPLETION requires a genuine contract-bound
 * TrustedValidationContext. Without one, the transition is rejected.
 */
export function applyMissionExecutionTransition(
	contract: MissionContractV1,
	record: MissionExecutionRecordV1,
	request: MissionExecutionTransitionRequestV1,
	options?: {
		trustedValidationContext?: TrustedValidationContext;
	},
): MissionExecutionTransitionResult {
	// Phase 0: Validate contract digest
	const contractDigest = computeMissionContractDigest(contract);
	if (record.contractDigest !== contractDigest) {
		return {
			ok: false,
			error: "CONTRACT_DIGEST_MISMATCH",
			code: "CONTRACT_DIGEST_MISMATCH",
		};
	}

	// Phase 1: Validate request
	if (!request.transitionId || request.transitionId.trim().length === 0) {
		return {
			ok: false,
			error: "transitionId must be non-empty and trimmed",
			code: "INVALID_TRANSITION",
		};
	}
	if (request.transitionId !== request.transitionId.trim()) {
		return {
			ok: false,
			error: "transitionId must be trimmed (no leading/trailing whitespace)",
			code: "INVALID_TRANSITION",
		};
	}

	// Phase 2: expectedRevision check
	if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) {
		return {
			ok: false,
			error: "expectedRevision must be a safe non-negative integer",
			code: "STALE_REVISION",
		};
	}
	if (request.expectedRevision !== record.revision) {
		return {
			ok: false,
			error: `STALE_REVISION: expected revision ${request.expectedRevision} but record is at revision ${record.revision}`,
			code: "STALE_REVISION",
		};
	}

	// Phase 3: Validate transition kind
	if (!VALID_KINDS.has(request.kind)) {
		return {
			ok: false,
			error: `Unknown transition kind: "${request.kind}"`,
			code: "INVALID_TRANSITION",
		};
	}

	// Phase 4: Terminal state rejection
	if (TERMINAL_STATES.has(record.state)) {
		return {
			ok: false,
			error: `TERMINAL_STATE: cannot transition from terminal state "${record.state}"`,
			code: "TERMINAL_STATE",
		};
	}

	// Phase 5: RESUME requires BLOCKED
	if (request.kind === "RESUME" && record.state !== "BLOCKED") {
		return {
			ok: false,
			error: "RESUME: can only resume from BLOCKED state",
			code: "RESUME_WHILE_NOT_BLOCKED",
		};
	}

	// Phase 6: BLOCK while already BLOCKED
	if (request.kind === "BLOCK" && record.state === "BLOCKED") {
		return {
			ok: false,
			error: "BLOCK_WHILE_BLOCKED: already in BLOCKED state",
			code: "BLOCK_WHILE_BLOCKED",
		};
	}

	if (
		record.state === "BLOCKED" &&
		request.kind !== "RESUME" &&
		request.kind !== "FAIL" &&
		request.kind !== "CANCEL"
	) {
		return {
			ok: false,
			error: `BLOCKED: only RESUME, FAIL, or CANCEL allowed from BLOCKED, got "${request.kind}"`,
			code: "ILLEGAL_TRANSITION",
		};
	}

	// Phase 7: Derive destination state
	const stateTransitions = TRANSITION_GRAPH.get(record.state);
	if (!stateTransitions) {
		return {
			ok: false,
			error: `INTERNAL_ERROR: no transition graph entry for state "${record.state}"`,
			code: "INTERNAL_ERROR",
		};
	}

	let toState: MissionExecutionState;

	if (request.kind === "RESUME" && record.state === "BLOCKED") {
		// RESUME returns to the exact blockedFromState
		if (!record.blockedFromState) {
			return {
				ok: false,
				error: "INTERNAL_ERROR: BLOCKED state missing blockedFromState",
				code: "INTERNAL_ERROR",
			};
		}
		if (!RESUABLE_STATES_SET.has(record.blockedFromState)) {
			return {
				ok: false,
				error: `RESUME_STATE_NOT_RESUMABLE: "${record.blockedFromState}" is not a resumable state`,
				code: "RESUME_STATE_NOT_RESUMABLE",
			};
		}
		toState = record.blockedFromState;
	} else {
		const dest = stateTransitions.get(request.kind);
		if (dest === undefined) {
			return {
				ok: false,
				error: `ILLEGAL_TRANSITION: cannot apply "${request.kind}" from "${record.state}"`,
				code: "ILLEGAL_TRANSITION",
			};
		}
		toState = dest;
	}

	// Phase 8: Self-transition check
	if (record.state === toState) {
		return {
			ok: false,
			error: `SELF_TRANSITION: transition from "${record.state}" to "${toState}" is a no-op`,
			code: "SELF_TRANSITION",
		};
	}

	// Phase 9: Trusted completion boundary
	if (toState === "COMPLETED") {
		const completionError = checkCompletionAuthorization(contractDigest, options?.trustedValidationContext);
		if (completionError) return completionError;
	}

	// Phase 10: Duplicate transition ID check
	for (const tx of record.transitions) {
		if (tx.transitionId === request.transitionId) {
			return {
				ok: false,
				error: `DUPLICATE_TRANSITION_ID: transition "${request.transitionId}" already exists`,
				code: "DUPLICATE_TRANSITION_ID",
			};
		}
	}

	// Phase 11: Determine blockedFromState for BLOCK transitions
	let blockedFromState: ResumableMissionExecutionState | undefined;
	if (request.kind === "BLOCK" && record.state !== "BLOCKED") {
		if (RESUABLE_STATES_SET.has(record.state)) {
			blockedFromState = record.state as ResumableMissionExecutionState;
		}
	} else if (request.kind === "RESUME") {
		// Clear blockedFromState on RESUME
		blockedFromState = undefined;
	}

	// Phase 12: Build transition record from validated primitives (no caller reference retained)
	const transition: MissionExecutionTransitionRecordV1 = Object.freeze({
		transitionId: String(request.transitionId),
		kind: request.kind,
		fromState: record.state,
		toState,
		revisionBefore: record.revision | 0,
		revisionAfter: (record.revision + 1) | 0,
	});

	// Phase 13: Build new record (immutable — new object, fully defensive snapshot)
	// Every historical transition is reconstructed from validated primitive values
	// to prevent caller-owned mutable references from aliasing into the output.
	const snapshotTransitions: readonly MissionExecutionTransitionRecordV1[] = Object.freeze([
		...record.transitions.map((tx) =>
			Object.freeze({
				transitionId: String(tx.transitionId),
				kind: tx.kind,
				fromState: tx.fromState,
				toState: tx.toState,
				revisionBefore: tx.revisionBefore | 0,
				revisionAfter: tx.revisionAfter | 0,
			}),
		),
		transition,
	]);
	const newRecord: MissionExecutionRecordV1 = freezeRecord({
		executionVersion: 1 as const,
		executionId: String(record.executionId),
		contractDigest: String(record.contractDigest),
		revision: record.revision + 1,
		state: toState,
		blockedFromState,
		transitions: snapshotTransitions,
	}) as unknown as MissionExecutionRecordV1;

	return { ok: true, record: newRecord };
}

// =============================================================================
// Completion approval gate — trusted boundary
// =============================================================================

function checkCompletionAuthorization(
	contractDigest: string,
	trustedValidationContext: TrustedValidationContext | undefined,
): MissionExecutionTransitionResult | null {
	if (!trustedValidationContext) {
		return {
			ok: false,
			error: "TRUSTED_VALIDATION_CONTEXT_REQUIRED: APPROVE_COMPLETION requires a genuine contract-bound TrustedValidationContext",
			code: "TRUSTED_VALIDATION_CONTEXT_REQUIRED",
		};
	}

	// Verify the trusted context is genuinely branded
	const boundDigest = _getBoundContractDigest(trustedValidationContext);
	if (boundDigest !== contractDigest) {
		return {
			ok: false,
			error: "TRUSTED_VALIDATION_CONTEXT_REQUIRED: trusted context is not bound to this contract digest",
			code: "TRUSTED_VALIDATION_CONTEXT_REQUIRED",
		};
	}

	// Verify the trusted context authorizes the execution:complete capability
	if (!trustedValidationContext.verifyCapability("completion-operator", "operator", EXECUTION_COMPLETION_CAPABILITY)) {
		return {
			ok: false,
			error: "EXECUTION_COMPLETION_CAPABILITY_REQUIRED: trusted context does not authorize execution:complete",
			code: "EXECUTION_COMPLETION_CAPABILITY_REQUIRED",
		};
	}

	// LH-5 will implement the full requirement-evidence completion gate here.
	return null;
}

// =============================================================================
// Replay execution history to derive final state
// =============================================================================

interface ReplayResult {
	ok: boolean;
	state?: MissionExecutionState;
	blockedFromState?: ResumableMissionExecutionState;
	error?: string;
}

function replayExecutionHistory(transitions: readonly unknown[]): ReplayResult {
	if (transitions.length === 0) {
		return { ok: true, state: "PLANNING" };
	}

	let currentState: MissionExecutionState = "PLANNING";
	let blockedFromState: ResumableMissionExecutionState | undefined;

	for (let i = 0; i < transitions.length; i++) {
		const tx = transitions[i] as Record<string, unknown>;
		const kind = tx.kind as MissionExecutionTransitionKind;
		const fromState = tx.fromState as MissionExecutionState;
		const toState = tx.toState as MissionExecutionState;

		// Verify fromState matches current
		if (fromState !== currentState) {
			return {
				ok: false,
				error: `transitions[${i}]: fromState "${fromState}" does not match current state "${currentState}"`,
			};
		}

		// Verify transition kind is valid for current state
		if (kind === "RESUME") {
			if (currentState !== "BLOCKED") {
				return {
					ok: false,
					error: `transitions[${i}]: RESUME only valid from BLOCKED, not "${currentState}"`,
				};
			}
			if (!blockedFromState) {
				return {
					ok: false,
					error: `transitions[${i}]: RESUME but no blockedFromState recorded`,
				};
			}
			if (toState !== blockedFromState) {
				return {
					ok: false,
					error: `transitions[${i}]: RESUME to "${toState}" does not match blockedFromState "${blockedFromState}"`,
				};
			}
			blockedFromState = undefined;
		} else if (kind === "BLOCK") {
			if (!RESUABLE_STATES_SET.has(currentState)) {
				return {
					ok: false,
					error: `transitions[${i}]: BLOCK only valid from resumable state, not "${currentState}"`,
				};
			}
			blockedFromState = currentState as ResumableMissionExecutionState;
		} else {
			const stateTransitions = TRANSITION_GRAPH.get(currentState);
			if (!stateTransitions) {
				return {
					ok: false,
					error: `transitions[${i}]: no transition graph entry for state "${currentState}"`,
				};
			}
			const expectedDest = stateTransitions.get(kind);
			if (expectedDest === undefined) {
				return {
					ok: false,
					error: `transitions[${i}]: illegal transition "${kind}" from "${currentState}"`,
				};
			}
			if (toState !== expectedDest) {
				return {
					ok: false,
					error: `transitions[${i}]: toState "${toState}" does not match expected destination "${expectedDest}" for kind "${kind}" from "${currentState}"`,
				};
			}
		}

		// Self-transition rejection
		if (fromState === toState) {
			return {
				ok: false,
				error: `transitions[${i}]: self-transition from "${fromState}" to "${toState}"`,
			};
		}

		// Terminal state must not have outgoing transitions
		if (TERMINAL_STATES.has(currentState) && i > 0) {
			return {
				ok: false,
				error: `transitions[${i}]: transition after terminal state "${prevTerminal(transitions, i)}"`,
			};
		}

		currentState = toState;
	}

	return { ok: true, state: currentState, blockedFromState };
}

function prevTerminal(transitions: readonly unknown[], currentIndex: number): string {
	for (let i = currentIndex - 1; i >= 0; i--) {
		const tx = transitions[i] as Record<string, unknown>;
		if (TERMINAL_STATES.has(tx.toState as MissionExecutionState)) {
			return tx.toState as string;
		}
	}
	return "unknown";
}

// =============================================================================
// Transition structure validation
// =============================================================================

function validateTransitionStructure(tx: unknown, index: number): string | null {
	if (!isRecord(tx)) {
		return `transitions[${index}]: must be a non-null object`;
	}

	const t = tx as Record<string, unknown>;

	// Unknown field check
	for (const key of Object.keys(t)) {
		if (!MISSION_EXECUTION_TRANSITION_KEYS.has(key)) {
			return `transitions[${index}]: unknown field "${key}"`;
		}
	}

	if (typeof t.transitionId !== "string" || t.transitionId.trim().length === 0) {
		return `transitions[${index}]: transitionId must be a non-empty trimmed string`;
	}
	if (t.transitionId !== (t.transitionId as string).trim()) {
		return `transitions[${index}]: transitionId must be trimmed (no leading/trailing whitespace)`;
	}
	if (typeof t.kind !== "string" || !VALID_KINDS.has(t.kind)) {
		return `transitions[${index}]: kind must be a valid transition kind, got "${t.kind}"`;
	}
	if (typeof t.fromState !== "string" || !VALID_STATES.has(t.fromState)) {
		return `transitions[${index}]: fromState must be a valid state, got "${t.fromState}"`;
	}
	if (typeof t.toState !== "string" || !VALID_STATES.has(t.toState)) {
		return `transitions[${index}]: toState must be a valid state, got "${t.toState}"`;
	}
	if (typeof t.revisionBefore !== "number" || !Number.isSafeInteger(t.revisionBefore) || t.revisionBefore < 0) {
		return `transitions[${index}]: revisionBefore must be a safe non-negative integer`;
	}
	if (typeof t.revisionAfter !== "number" || !Number.isSafeInteger(t.revisionAfter) || t.revisionAfter < 0) {
		return `transitions[${index}]: revisionAfter must be a safe non-negative integer`;
	}

	// NaN, Infinity checks (covered by !Number.isSafeInteger but let's be explicit)
	if (!Number.isFinite(t.revisionBefore as number) || !Number.isFinite(t.revisionAfter as number)) {
		return `transitions[${index}]: revision values must be finite`;
	}

	return null;
}

// =============================================================================
// Execution record structure validation
// =============================================================================

function validateExecutionRecordStructure(record: Record<string, unknown>): string | null {
	// Unknown field check
	for (const key of Object.keys(record)) {
		if (!MISSION_EXECUTION_RECORD_KEYS.has(key)) {
			return `Unknown field in execution record: "${key}"`;
		}
	}

	if (record.executionVersion !== 1) {
		return `executionVersion must be 1, got ${record.executionVersion}`;
	}

	if (typeof record.executionId !== "string" || record.executionId.trim().length === 0) {
		return "executionId must be a non-empty trimmed string";
	}
	if (record.executionId !== (record.executionId as string).trim()) {
		return "executionId must be trimmed (no leading/trailing whitespace)";
	}

	if (typeof record.contractDigest !== "string" || record.contractDigest.length === 0) {
		return "contractDigest must be a non-empty string";
	}

	if (
		typeof record.revision !== "number" ||
		!Number.isFinite(record.revision) ||
		!Number.isSafeInteger(record.revision) ||
		record.revision < 0
	) {
		return "revision must be a safe non-negative integer";
	}

	if (typeof record.state !== "string" || !VALID_STATES.has(record.state)) {
		return `state must be a valid MissionExecutionState, got "${record.state}"`;
	}

	if (!Array.isArray(record.transitions)) {
		return "transitions must be an array";
	}

	// blockedFromState validation
	if (record.state === "BLOCKED") {
		if (record.blockedFromState === undefined) {
			return "blockedFromState is required when state is BLOCKED";
		}
		if (typeof record.blockedFromState !== "string" || !RESUABLE_STATES_SET.has(record.blockedFromState)) {
			return `blockedFromState must be a resumable state when state is BLOCKED, got "${record.blockedFromState}"`;
		}
	} else {
		if (record.blockedFromState !== undefined) {
			return `blockedFromState must not be present when state is "${record.state}"`;
		}
	}

	return null;
}

// =============================================================================
// Utilities
// =============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function freezeRecord<T extends Record<string, unknown>>(obj: T): T {
	return Object.freeze(obj) as T;
}
