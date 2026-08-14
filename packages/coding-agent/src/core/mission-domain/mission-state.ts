/**
 * First-Class Mission state machine (2.3.0).
 *
 * This is the canonical lifecycle vocabulary for a single *delegated unit of
 * work* — a mission — independent of any executor. It is intentionally separate
 * from:
 *
 *   - `MissionExecutionState` (long-horizon): the inner execution/verification
 *     lifecycle of one reliability-governed MissionRuntime contract.
 *   - `MissionStatus` (durable mission graph): the durable multi-repo graph
 *     status, a different orchestration layer.
 *   - `DelegatedStatus` (delegated-work): an ephemeral UI/display state.
 *
 * Those layers remain authoritative for their own concerns; this machine owns
 * the *mission* lifecycle (created → queued → running → terminal). No state in
 * this file may be reached from a raw process exit code alone: SUCCEEDED is a
 * mission-level claim that must be supported by verified completion (see the
 * Reliability Kernel's Completion Gate).
 *
 * `INTERRUPTED` (added in 2.4.0) is a NON-terminal, recoverable state meaning:
 * "the mission is not terminal, but Jensen lost authoritative ownership of the
 * previous execution attempt and recovery is required." It is reached only from
 * an active non-terminal state (QUEUED/RUNNING/WAITING/BLOCKED/RETRYING) during
 * restart reconciliation, never from a raw process exit code, and it is never a
 * success or a failure signal.
 *
 * `LAUNCHING` (added in 2.4.0) is a NON-terminal state meaning "execution
 * initiation has begun (a durable attempt identity exists) but authoritative
 * runtime ownership (the executor's execution id) has not yet been confirmed."
 * It is the durable bridge between QUEUED and RUNNING that closes the
 * launch-persistence crash window: an attempt intent is persisted BEFORE the
 * executor is invoked, so a crash immediately after launch can never erase the
 * fact that an attempt may have started. It is entered only from QUEUED and
 * exits to RUNNING (ownership confirmed), FAILED (executor rejected launch), or
 * INTERRUPTED (restart reconciliation). It is never a success or failure.
 */

// =============================================================================
// State vocabulary
// =============================================================================

/**
 * Canonical mission lifecycle states.
 *
 * Closed union. Adding a state is a breaking change for exhaustive consumers.
 */
export type MissionState =
	| "CREATED"
	| "QUEUED"
	| "LAUNCHING"
	| "RUNNING"
	| "WAITING"
	| "BLOCKED"
	| "RETRYING"
	| "INTERRUPTED"
	| "SUCCEEDED"
	| "PARTIAL"
	| "FAILED"
	| "CANCELLED"
	| "TIMED_OUT"
	| "CRASHED";

/**
 * All canonical mission states. Used for runtime validation of untrusted
 * (durable) state values so a persisted record can never smuggle in a made-up
 * state string.
 */
export const MISSION_STATES: ReadonlySet<MissionState> = new Set<MissionState>([
	"CREATED",
	"QUEUED",
	"LAUNCHING",
	"RUNNING",
	"WAITING",
	"BLOCKED",
	"RETRYING",
	"INTERRUPTED",
	"SUCCEEDED",
	"PARTIAL",
	"FAILED",
	"CANCELLED",
	"TIMED_OUT",
	"CRASHED",
]);

/** Runtime type guard for a canonical MissionState. */
export function isMissionState(value: unknown): value is MissionState {
	return typeof value === "string" && (MISSION_STATES as ReadonlySet<string>).has(value);
}

/**
 * States from which a mission can continue (i.e. not terminal).
 */
export const MISSION_RESUMABLE_STATES: ReadonlySet<MissionState> = new Set<MissionState>([
	"CREATED",
	"QUEUED",
	"LAUNCHING",
	"RUNNING",
	"WAITING",
	"BLOCKED",
	"RETRYING",
	"INTERRUPTED",
]);

/**
 * Terminal states: no outgoing transitions are legal.
 */
export const MISSION_TERMINAL_STATES: ReadonlySet<MissionState> = new Set<MissionState>([
	"SUCCEEDED",
	"PARTIAL",
	"FAILED",
	"CANCELLED",
	"TIMED_OUT",
	"CRASHED",
]);

/**
 * States that represent mission-level success. Only SUCCEEDED is clean success;
 * PARTIAL is terminal but is *not* a clean success.
 */
export const MISSION_SUCCESS_STATES: ReadonlySet<MissionState> = new Set<MissionState>(["SUCCEEDED"]);

// =============================================================================
// Transition graph
// =============================================================================

const MISSION_TRANSITIONS: ReadonlyMap<MissionState, ReadonlySet<MissionState>> = new Map<
	MissionState,
	ReadonlySet<MissionState>
>([
	["CREATED", new Set<MissionState>(["QUEUED", "CANCELLED"])],
	["QUEUED", new Set<MissionState>(["LAUNCHING", "RUNNING", "CANCELLED", "FAILED", "INTERRUPTED"])],
	["LAUNCHING", new Set<MissionState>(["RUNNING", "FAILED", "INTERRUPTED"])],
	[
		"RUNNING",
		new Set<MissionState>([
			"WAITING",
			"BLOCKED",
			"RETRYING",
			"INTERRUPTED",
			"SUCCEEDED",
			"PARTIAL",
			"FAILED",
			"CANCELLED",
			"TIMED_OUT",
			"CRASHED",
		]),
	],
	["WAITING", new Set<MissionState>(["RUNNING", "BLOCKED", "CANCELLED", "FAILED", "TIMED_OUT", "INTERRUPTED"])],
	["BLOCKED", new Set<MissionState>(["RUNNING", "WAITING", "RETRYING", "FAILED", "CANCELLED", "INTERRUPTED"])],
	["RETRYING", new Set<MissionState>(["RUNNING", "BLOCKED", "FAILED", "CANCELLED", "TIMED_OUT", "INTERRUPTED"])],
	["INTERRUPTED", new Set<MissionState>(["QUEUED", "FAILED", "CANCELLED"])],
	["SUCCEEDED", new Set<MissionState>()],
	["PARTIAL", new Set<MissionState>()],
	["FAILED", new Set<MissionState>()],
	["CANCELLED", new Set<MissionState>()],
	["TIMED_OUT", new Set<MissionState>()],
	["CRASHED", new Set<MissionState>()],
]);

// =============================================================================
// Predicates
// =============================================================================

export function isTerminalMissionState(state: MissionState): boolean {
	return MISSION_TERMINAL_STATES.has(state);
}

export function isResumableMissionState(state: MissionState): boolean {
	return MISSION_RESUMABLE_STATES.has(state);
}

export function isMissionSuccessState(state: MissionState): boolean {
	return MISSION_SUCCESS_STATES.has(state);
}

/**
 * Whether a transition is legal. Terminal states admit no outgoing transition.
 */
export function canTransitionMissionState(from: MissionState, to: MissionState): boolean {
	if (isTerminalMissionState(from)) return false;
	const destinations = MISSION_TRANSITIONS.get(from);
	return destinations?.has(to) ?? false;
}

// =============================================================================
// Transition API
// =============================================================================

export interface MissionTransitionResult {
	ok: boolean;
	error?: string;
}

/**
 * Assert that `from -> to` is a legal transition. Terminal states admit no
 * outgoing transition; self-transitions are rejected.
 */
export function assertMissionTransition(from: MissionState, to: MissionState): MissionTransitionResult {
	if (from === to) {
		return { ok: false, error: `SELF_TRANSITION: cannot transition from "${from}" to itself` };
	}
	if (!canTransitionMissionState(from, to)) {
		return {
			ok: false,
			error: `ILLEGAL_TRANSITION: cannot transition from "${from}" to "${to}"`,
		};
	}
	return { ok: true };
}

/**
 * Mutable tracker that enforces legal transitions through the canonical API.
 * Executors own a tracker internally; the public MissionHandle exposes a
 * read-only snapshot of its state.
 */
export class MissionStateTracker {
	private _state: MissionState;

	constructor(initial: MissionState = "CREATED") {
		this._state = initial;
	}

	get state(): MissionState {
		return this._state;
	}

	transition(to: MissionState): MissionTransitionResult {
		const result = assertMissionTransition(this._state, to);
		if (!result.ok) return result;
		this._state = to;
		return { ok: true };
	}
}
