/**
 * Assignment Foundation — domain types, DTOs and structured errors (2.11.0).
 *
 * The durable bridge between a logical mission and a logical executor, without
 * any scheduling. An assignment records *designation* ("mission M is currently
 * designated for executor E"), not execution ownership and not runtime
 * incarnation. Those remain separate authority domains:
 *
 *   - Assignment            → logical mission ↔ logical executor designation.
 *   - ExecutorRuntime       → concrete worker process/incarnation liveness.
 *   - ExecutionLease/fence  → concrete execution ownership for a mission.
 *
 * A runtime restart does not destroy the logical designation; the concrete
 * runtime is resolved only when work is accepted or started.
 */

import { randomUUID } from "node:crypto";
import type { MissionState } from "../mission-domain/mission-state.js";

// =============================================================================
// Structured errors
// =============================================================================

export type AssignmentErrorCode =
	| "ASSIGNMENT_NOT_FOUND"
	| "ASSIGNMENT_ALREADY_EXISTS"
	| "INVALID_ASSIGNMENT_ID"
	| "MISSION_NOT_FOUND"
	| "EXECUTOR_NOT_FOUND"
	| "MISSION_ALREADY_ASSIGNED"
	| "MISSION_NOT_ASSIGNABLE"
	| "MISSION_ACTIVE"
	| "EXECUTOR_NOT_ASSIGNABLE"
	| "EXECUTOR_OFFLINE"
	| "EXECUTOR_RETIRED"
	| "EXECUTOR_INCOMPATIBLE"
	| "ASSIGNMENT_NOT_CURRENT"
	| "ASSIGNMENT_SUPERSEDED"
	| "ASSIGNMENT_RELEASED"
	| "STALE_EXECUTOR_INSTANCE"
	| "ASSIGNMENT_RUNTIME_MISMATCH"
	| "ASSIGNMENT_CORRUPT"
	| "ASSIGNMENT_LOCK_TIMEOUT";

export class AssignmentError extends Error {
	readonly code: AssignmentErrorCode;
	readonly details: Readonly<Record<string, unknown>>;

	constructor(code: AssignmentErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
		super(message);
		this.name = "AssignmentError";
		this.code = code;
		this.details = Object.freeze({ ...details });
	}
}

// =============================================================================
// Identity
// =============================================================================

/**
 * A safe `assignmentId` is used as a file path component by the concrete
 * store. Reject anything that could escape the store root or inject a path
 * separator. It is independent of `missionId` and `executorId`.
 */
export function isSafeAssignmentId(value: string): boolean {
	return /^[A-Za-z0-9._-]+$/u.test(value) && value !== "." && value !== "..";
}

/** Stable, durable assignment id. UUID-based, never PID-derived. */
export function newAssignmentId(): string {
	return `assign_${randomUUID()}`;
}

// =============================================================================
// Mission requirements (structured, deterministic, no scoring)
// =============================================================================

/**
 * Where tool/process work physically runs. A route is `remote` when the executor
 * is bound to a `RemoteExecutionTarget`; otherwise it is `local`. This is an
 * execution-location constraint, deliberately distinct from the model/inference
 * location (inference is never implied by the execution route).
 */
export type ExecutionRouteMode = "local" | "remote";

/**
 * Preference hints for placement ranking. Preferences never affect eligibility:
 * a preferred-but-incompatible route remains ineligible, and a non-preferred
 * compatible route remains eligible.
 */
export interface MissionRequirementPreferences {
	/** Prefer a local or remote route. */
	executionMode?: ExecutionRouteMode;
	/** Prefer a specific executor. */
	executorId?: string;
	/** Prefer a specific remote target. */
	remoteTargetId?: string;
}

export interface MissionRequirements {
	/** Required platform. Both fields are optional; when present they must match exactly. */
	platform?: {
		os?: string;
		arch?: string;
	};
	/** Required execution location. Absent means either local or remote satisfies. */
	executionMode?: ExecutionRouteMode;
	/** Each listed execution capability must be advertised. */
	execution?: string[];
	/** Any-of provider requirement: at least one must be advertised. */
	providers?: string[];
	/** Any-of model requirement: at least one must be advertised. */
	models?: string[];
	/** Each listed tool capability must be advertised. */
	tools?: string[];
	/** Each listed specialized capability must be advertised. */
	specialized?: string[];
	/** Label constraints. `required` all present; `excluded` none present. */
	labels?: {
		required?: string[];
		excluded?: string[];
	};
	/** Extensible exact-match constraint strings (future scheduler policies). */
	extra?: string[];
	/** Ranking hints only; never eligibility. */
	preferences?: MissionRequirementPreferences;
}

// =============================================================================
// Compatibility + assignability
// =============================================================================

export type CompatibilityRequirementKind =
	| "platform.os"
	| "platform.arch"
	| "execution"
	| "provider"
	| "model"
	| "tool"
	| "specialized"
	| "label.required"
	| "label.excluded"
	| "extra";

export interface CompatibilityRequirementItem {
	kind: CompatibilityRequirementKind;
	requirement: string;
	observed: string | readonly string[] | undefined;
}

/**
 * Deterministic, explainable capability match. No scores, no ranking, no fuzzy
 * model matching. `compatible` is true only when `unsatisfied` is empty.
 */
export interface CompatibilityResult {
	compatible: boolean;
	satisfied: CompatibilityRequirementItem[];
	unsatisfied: CompatibilityRequirementItem[];
	warnings: string[];
}

export type ExecutorAssignabilityStatus = "REGISTERED" | "ONLINE" | "STALE" | "OFFLINE" | "RETIRED" | "UNKNOWN";

/**
 * `compatible` (capability match) is deliberately distinct from `assignable`
 * (capability match + executor state policy). A registered-but-offline executor
 * can be compatible while not presently assignable.
 */
export interface AssignabilityResult {
	compatible: boolean;
	assignable: boolean;
	status: ExecutorAssignabilityStatus;
	reason?: string;
	compatibility: CompatibilityResult;
}

// =============================================================================
// Runtime / ownership observation
// =============================================================================

/**
 * Structured correlation between a mission execution owner and the executor
 * runtime that consumed the assignment. Mission lease `fencingToken` stays a
 * separate authority domain; this is audit metadata, not a fencing credential.
 */
export interface ExecutionOwnerIdentity {
	executorId: string;
	runtimeInstanceId: string;
	runtimeEpoch: number;
	/** The mission execution-lease owner identity used for the assigned start. */
	ownerId: string;
}

/** Observational snapshot of the executor runtime at assignment time. */
export interface ExecutorRuntimeObservation {
	runtimeInstanceId?: string;
	runtimeEpoch: number;
	status: ExecutorAssignabilityStatus;
	observedAtMs: number;
}

// =============================================================================
// Assignment state machine
// =============================================================================

export type AssignmentState =
	| "ASSIGNED"
	| "ACCEPTED"
	| "EXECUTING"
	| "COMPLETED"
	| "FAILED"
	| "RELEASED"
	| "SUPERSEDED";

export const ASSIGNMENT_STATES: ReadonlySet<AssignmentState> = new Set<AssignmentState>([
	"ASSIGNED",
	"ACCEPTED",
	"EXECUTING",
	"COMPLETED",
	"FAILED",
	"RELEASED",
	"SUPERSEDED",
]);

export function isAssignmentState(value: unknown): value is AssignmentState {
	return typeof value === "string" && (ASSIGNMENT_STATES as ReadonlySet<string>).has(value);
}

/** Non-terminal states: the assignment is still the current designation. */
export const ASSIGNMENT_ACTIVE_STATES: ReadonlySet<AssignmentState> = new Set<AssignmentState>([
	"ASSIGNED",
	"ACCEPTED",
	"EXECUTING",
]);

export function isActiveAssignmentState(state: AssignmentState): boolean {
	return ASSIGNMENT_ACTIVE_STATES.has(state);
}

const ASSIGNMENT_TRANSITIONS: ReadonlyMap<AssignmentState, ReadonlySet<AssignmentState>> = new Map<
	AssignmentState,
	ReadonlySet<AssignmentState>
>([
	["ASSIGNED", new Set<AssignmentState>(["ACCEPTED", "EXECUTING", "RELEASED", "SUPERSEDED"])],
	["ACCEPTED", new Set<AssignmentState>(["EXECUTING", "RELEASED", "SUPERSEDED"])],
	["EXECUTING", new Set<AssignmentState>(["COMPLETED", "FAILED"])],
	["COMPLETED", new Set<AssignmentState>()],
	["FAILED", new Set<AssignmentState>()],
	["RELEASED", new Set<AssignmentState>()],
	["SUPERSEDED", new Set<AssignmentState>()],
]);

export function canTransitionAssignmentState(from: AssignmentState, to: AssignmentState): boolean {
	const destinations = ASSIGNMENT_TRANSITIONS.get(from);
	return destinations?.has(to) ?? false;
}

export function assertAssignmentTransition(
	from: AssignmentState,
	to: AssignmentState,
): { ok: true } | { ok: false; error: string } {
	if (from === to) {
		return { ok: false, error: `SELF_TRANSITION: cannot transition "${from}" to itself` };
	}
	if (!canTransitionAssignmentState(from, to)) {
		return { ok: false, error: `ILLEGAL_TRANSITION: cannot transition "${from}" to "${to}"` };
	}
	return { ok: true };
}

// =============================================================================
// Durable record
// =============================================================================

export interface AssignmentRecord {
	schemaVersion: 1;
	assignmentId: string;
	missionId: string;
	executorId: string;
	createdAtMs: number;
	updatedAtMs: number;
	state: AssignmentState;
	/** True while this record is the current designation for its mission. */
	current: boolean;
	assignedBy?: string;
	requirementsSnapshot?: MissionRequirements;
	compatibilitySnapshot?: CompatibilityResult;
	/** Execution-route provenance (local/remote + target) at designation time. */
	executionMode?: ExecutionRouteMode;
	remoteTargetId?: string;
	executorRuntimeAtAssignment?: ExecutorRuntimeObservation;
	acceptedAtMs?: number;
	executionStartedAtMs?: number;
	completedAtMs?: number;
	releasedAtMs?: number;
	consumedByAttemptId?: string;
	consumedByExecutionId?: string;
	supersededByAssignmentId?: string;
	supersedesAssignmentId?: string;
	executionOwnerIdentity?: ExecutionOwnerIdentity;
	/** Observed canonical mission terminal state, never assignment authority. */
	terminalMissionState?: MissionState;
	reason?: string;
	revision: number;
}

// =============================================================================
// Views (stable operator DTOs, never secrets)
// =============================================================================

export interface AssignmentSummary {
	assignmentId: string;
	missionId: string;
	executorId: string;
	state: AssignmentState;
	current: boolean;
	createdAtMs: number;
	updatedAtMs: number;
	assignedBy?: string;
	acceptedAtMs?: number;
	executionStartedAtMs?: number;
	completedAtMs?: number;
	releasedAtMs?: number;
	supersededByAssignmentId?: string;
	consumedByAttemptId?: string;
	consumedByExecutionId?: string;
	terminalMissionState?: MissionState;
	reason?: string;
	executionMode?: ExecutionRouteMode;
	remoteTargetId?: string;
}

export interface AssignmentDetail extends AssignmentSummary {
	requirementsSnapshot?: MissionRequirements;
	compatibilitySnapshot?: CompatibilityResult;
	executorRuntimeAtAssignment?: ExecutorRuntimeObservation;
	executionOwnerIdentity?: ExecutionOwnerIdentity;
}

/** Pure bounded projection from a durable record to an operator summary. */
export function toAssignmentSummary(record: AssignmentRecord): AssignmentSummary {
	return {
		assignmentId: record.assignmentId,
		missionId: record.missionId,
		executorId: record.executorId,
		state: record.state,
		current: record.current,
		createdAtMs: record.createdAtMs,
		updatedAtMs: record.updatedAtMs,
		assignedBy: record.assignedBy,
		acceptedAtMs: record.acceptedAtMs,
		executionStartedAtMs: record.executionStartedAtMs,
		completedAtMs: record.completedAtMs,
		releasedAtMs: record.releasedAtMs,
		supersededByAssignmentId: record.supersededByAssignmentId,
		consumedByAttemptId: record.consumedByAttemptId,
		consumedByExecutionId: record.consumedByExecutionId,
		terminalMissionState: record.terminalMissionState,
		reason: record.reason,
		executionMode: record.executionMode,
		remoteTargetId: record.remoteTargetId,
	};
}

export type AssignmentListSort = "createdAtMs" | "updatedAtMs" | "assignmentId";
export type AssignmentListDirection = "asc" | "desc";

export interface AssignmentListFilter {
	missionId?: string;
	executorId?: string;
	state?: AssignmentState;
	current?: boolean;
}

export interface AssignmentListOptions {
	filter?: AssignmentListFilter;
	sort?: AssignmentListSort;
	direction?: AssignmentListDirection;
	limit?: number;
	offset?: number;
}

export interface AssignmentListResult {
	entries: AssignmentSummary[];
	/** Corrupt records surfaced structurally, never folded into healthy state. */
	corrupt: { assignmentId: string; diagnostic: string }[];
}

// =============================================================================
// Mutation inputs / outcomes
// =============================================================================

export interface AssignMissionInput {
	missionId: string;
	executorId: string;
	requirements?: MissionRequirements;
	assignedBy?: string;
	/** Execution-route provenance recorded on the assignment. */
	executionMode?: ExecutionRouteMode;
	remoteTargetId?: string;
	/** Caller-allocated identity for deterministic tests; generated when omitted. */
	assignmentId?: string;
}

export interface AssignMissionOutcome {
	assignmentId: string;
	missionId: string;
	executorId: string;
	state: AssignmentState;
	record: AssignmentRecord;
}

export interface ReassignMissionInput {
	missionId: string;
	executorId: string;
	requirements?: MissionRequirements;
	assignedBy?: string;
	executionMode?: ExecutionRouteMode;
	remoteTargetId?: string;
	assignmentId?: string;
}

export interface AcceptAssignmentOutcome {
	assignmentId: string;
	state: AssignmentState;
	record: AssignmentRecord;
}

export interface BeginAssignedExecutionOutcome {
	assignmentId: string;
	missionId: string;
	executorId: string;
	state: AssignmentState;
	executionOwnerIdentity: ExecutionOwnerIdentity;
	record: AssignmentRecord;
}

export interface StartAssignedMissionOutcome {
	assignmentId: string;
	missionId: string;
	assignmentState: AssignmentState;
	missionState: MissionState;
	attemptId?: string;
	executionId?: string;
	success: boolean;
	assignment: AssignmentRecord;
}

export interface CompleteAssignmentInput {
	resultState: MissionState;
	attemptId?: string;
	executionId?: string;
	reason?: string;
}

export interface CompleteAssignmentOutcome {
	assignmentId: string;
	state: AssignmentState;
	terminalMissionState: MissionState;
	record: AssignmentRecord;
}
