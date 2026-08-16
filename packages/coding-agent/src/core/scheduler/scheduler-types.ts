/**
 * Scheduler Foundation — domain types, DTOs and structured errors (2.12.0).
 *
 * The first durable deterministic scheduler boundary. It decides WHICH logical
 * executor should receive a schedulable mission and produces a durable
 * Assignment via the existing Assignment Foundation. It never executes a
 * mission, runs a worker daemon, accepts an assignment on behalf of a worker,
 * begins mission execution, migrates live work, reserves GPU/RAM, or performs
 * remote RPC.
 *
 * Authority model:
 *   - Missions (DurableMissionStore) remain authoritative for mission lifecycle.
 *   - Executors (ExecutorControlService) remain authoritative for runtime liveness.
 *   - Assignments (AssignmentControlService) remain authoritative for designation.
 *   - This domain records *pending scheduling intent* and the *deterministic
 *     decision* that turns intent into an assignment. It fabricates none of the
 *     other three.
 */

import { randomUUID } from "node:crypto";
import type { ExecutionRouteMode, MissionRequirements } from "../assignment/assignment-types.js";
import type { RoutabilityStatus } from "../capability-routing/route-types.js";
import type { ExecutorLivenessStatus } from "../executor-registry/executor-registry-types.js";
import type { RemoteTargetHealth } from "../remote-execution/remote-target-types.js";

// =============================================================================
// Structured errors
// =============================================================================

export type SchedulingErrorCode =
	| "INTENT_NOT_FOUND"
	| "INTENT_ALREADY_EXISTS"
	| "INTENT_ALREADY_ASSIGNED"
	| "INTENT_CANCELLED"
	| "INTENT_CORRUPT"
	| "INTENT_LOCK_TIMEOUT"
	| "INVALID_INTENT_ID"
	| "INVALID_MISSION_ID"
	| "MISSION_NOT_FOUND"
	| "MISSION_CORRUPT"
	| "MISSION_TERMINAL"
	| "MISSION_ACTIVE"
	| "MISSION_ALREADY_ASSIGNED"
	| "NO_ASSIGNABLE_EXECUTOR";

export class SchedulingError extends Error {
	readonly code: SchedulingErrorCode;
	readonly details: Readonly<Record<string, unknown>>;

	constructor(code: SchedulingErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
		super(message);
		this.name = "SchedulingError";
		this.code = code;
		this.details = Object.freeze({ ...details });
	}
}

// =============================================================================
// Identity
// =============================================================================

/**
 * A safe `intentId` is used as a file path component by the concrete store.
 * Intent ids are deterministic per mission (`intent_${missionId}`) so a
 * scheduler tick is idempotent across restarts and processes: there is at most
 * one durable queue entry per mission.
 */
export function isSafeIntentId(value: string): boolean {
	return /^[A-Za-z0-9._-]+$/u.test(value) && value !== "." && value !== "..";
}

/** Deterministic queue-entry identity for a mission. */
export function intentIdForMission(missionId: string): string {
	return `intent_${missionId}`;
}

/** Stable tick identity for observability; UUID-based, never PID-derived. */
export function newSchedulingTickId(): string {
	return `tick_${randomUUID()}`;
}

// =============================================================================
// Policy
// =============================================================================

export type SchedulingPolicyMode = "first-fit" | "least-assigned";

/**
 * Deterministic executor selection policy. Both modes total-order candidates by
 * executorId before choosing, so identical scheduler state yields an identical
 * decision.
 */
export interface SchedulingPolicy {
	mode: SchedulingPolicyMode;
}

export const DEFAULT_SCHEDULING_POLICY: SchedulingPolicy = Object.freeze({ mode: "first-fit" });

// =============================================================================
// Intent state machine
// =============================================================================

export type SchedulingIntentState = "PENDING" | "ASSIGNED" | "UNSCHEDULABLE" | "CANCELLED";

export const SCHEDULING_INTENT_STATES: ReadonlySet<SchedulingIntentState> = new Set<SchedulingIntentState>([
	"PENDING",
	"ASSIGNED",
	"UNSCHEDULABLE",
	"CANCELLED",
]);

export function isSchedulingIntentState(value: unknown): value is SchedulingIntentState {
	return typeof value === "string" && (SCHEDULING_INTENT_STATES as ReadonlySet<string>).has(value);
}

/** Terminal intent states: the scheduling decision has been finalized. */
export const SCHEDULING_INTENT_TERMINAL_STATES: ReadonlySet<SchedulingIntentState> = new Set<SchedulingIntentState>([
	"ASSIGNED",
	"CANCELLED",
]);

export function isTerminalSchedulingIntentState(state: SchedulingIntentState): boolean {
	return SCHEDULING_INTENT_TERMINAL_STATES.has(state);
}

// =============================================================================
// Durable record
// =============================================================================

export interface SchedulingIntentRecord {
	schemaVersion: 1;
	intentId: string;
	missionId: string;
	/** Executor requirements to satisfy when scheduling. Absent means "any ONLINE executor". */
	requirements?: MissionRequirements;
	/** Higher schedules first (deterministic tie-break is enqueuedAtMs, then intentId). */
	priority: number;
	createdAtMs: number;
	updatedAtMs: number;
	/** Last time this intent entered PENDING (used for FIFO ordering). */
	enqueuedAtMs: number;
	state: SchedulingIntentState;
	/** Present when the intent resolved to a durable assignment. */
	assignmentId?: string;
	/** Present when the last scheduler tick could not schedule the mission. */
	unschedulableReason?: string;
	revision: number;
}

// =============================================================================
// Decision DTOs
// =============================================================================

/** One executor's deterministic eligibility for a single intent decision. */
export interface ExecutorEligibility {
	executorId: string;
	status: ExecutorLivenessStatus;
	compatible: boolean;
	assignable: boolean;
	/** True when the policy selected this executor. */
	chosen: boolean;
	reason?: string;
	/** Routing provenance (present when a Capability Router is wired). */
	executionMode?: ExecutionRouteMode;
	remoteTargetId?: string;
	targetHealth?: RemoteTargetHealth;
	routabilityStatus?: RoutabilityStatus;
	preferenceScore?: number;
	preferenceReasons?: string[];
}

export type SchedulingDecisionKind = "ASSIGN" | "RECONCILE" | "UNSCHEDULABLE";

/**
 * One deterministic scheduling decision. `RECONCILE` means the mission already
 * has a current assignment, so the intent is idempotently bound to it rather
 * than creating a second designation.
 */
export interface SchedulingDecision {
	intentId: string;
	missionId: string;
	decision: SchedulingDecisionKind;
	executorId?: string;
	assignmentId?: string;
	reason?: string;
	/** Execution-route provenance of the chosen executor (routed scheduling). */
	executionMode?: ExecutionRouteMode;
	remoteTargetId?: string;
	/** Full executor eligibility (empty when the mission itself is unschedulable). */
	eligibility: ExecutorEligibility[];
}

export interface SchedulingTickResult {
	runId: string;
	dryRun: boolean;
	policy: SchedulingPolicy;
	startedAtMs: number;
	finishedAtMs: number;
	decisions: SchedulingDecision[];
	assignmentsCreated: number;
	intentsAssigned: number;
	intentsUnschedulable: number;
	/** Corrupt intent records surfaced structurally, never folded into healthy state. */
	corrupt: { intentId: string; diagnostic: string }[];
}

// =============================================================================
// Views (stable operator DTOs, never secrets)
// =============================================================================

export interface SchedulingIntentSummary {
	intentId: string;
	missionId: string;
	state: SchedulingIntentState;
	priority: number;
	enqueuedAtMs: number;
	createdAtMs: number;
	updatedAtMs: number;
	assignmentId?: string;
	unschedulableReason?: string;
}

export interface SchedulingIntentDetail extends SchedulingIntentSummary {
	requirements?: MissionRequirements;
}

export type SchedulingIntentListSort = "enqueuedAtMs" | "priority" | "intentId" | "updatedAtMs";
export type SchedulingIntentListDirection = "asc" | "desc";

export interface SchedulingIntentListFilter {
	missionId?: string;
	state?: SchedulingIntentState;
}

export interface SchedulingIntentListOptions {
	filter?: SchedulingIntentListFilter;
	sort?: SchedulingIntentListSort;
	direction?: SchedulingIntentListDirection;
	limit?: number;
	offset?: number;
}

export interface SchedulingIntentListResult {
	entries: SchedulingIntentSummary[];
	corrupt: { intentId: string; diagnostic: string }[];
}

// =============================================================================
// Mutation inputs / outcomes
// =============================================================================

export interface EnqueueSchedulingIntentInput {
	/** Executor requirements. Absent means the mission accepts any ONLINE executor. */
	requirements?: MissionRequirements;
	/** Deterministic ordering hint. Higher schedules first. Default 0. */
	priority?: number;
	/** Now override for deterministic construction/tests. */
	now?: number;
}

export type EnqueueSchedulingIntentStatus = "created" | "idempotent" | "reopened";

export interface EnqueueSchedulingIntentOutcome {
	intentId: string;
	missionId: string;
	state: SchedulingIntentState;
	status: EnqueueSchedulingIntentStatus;
	record: SchedulingIntentRecord;
}
