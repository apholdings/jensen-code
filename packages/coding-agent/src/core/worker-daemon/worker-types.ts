/**
 * Worker Daemon Foundation — domain types, DTOs and structured errors (2.13.0).
 *
 * The durable runtime boundary between "work Jensen has decided should happen"
 * (a durable Assignment) and "work Jensen can prove actually happened" (a
 * durable Mission terminal result with Evidence + Verification).
 *
 * This module does NOT invent a parallel execution universe. Identity, liveness,
 * ownership, execution, and evidence authority remain with the existing domains:
 *
 *   - Executor Registry  → logical executor + runtime incarnation + heartbeat.
 *   - Assignment         → mission ↔ executor designation + claim/execution.
 *   - Durable Mission    → execution lease/fencing + attempts + terminal result.
 *   - Evidence / Verifier→ evidence correlation + completion authority.
 *
 * A Worker is a concrete daemon runtime bound to one logical executor. Its
 * stable identity (`workerId`) is derived deterministically from the executor it
 * serves; its ephemeral incarnation (`workerInstanceId`) is the Executor
 * Registry runtime incarnation. No new persistence authority is introduced:
 * worker state is a durable read model over the existing stores plus in-process
 * daemon lifecycle.
 */

import { randomUUID } from "node:crypto";
import type { AssignmentState } from "../assignment/assignment-types.js";
import type { ExecutorLivenessStatus } from "../executor-registry/executor-registry-types.js";
import type { MissionState } from "../mission-domain/mission-state.js";

// =============================================================================
// Structured errors
// =============================================================================

export type WorkerErrorCode =
	| "EXECUTOR_NOT_FOUND"
	| "EXECUTOR_ALREADY_ACTIVE"
	| "EXECUTOR_NOT_ACTIVE"
	| "WORKER_NOT_STARTED"
	| "WORKER_ALREADY_STARTED"
	| "WORKER_ALREADY_STOPPED"
	| "WORKER_RECONCILIATION_CORRUPT"
	| "INVALID_EXECUTOR_ID"
	| "NO_RESUME_LAUNCH_BUILDER";

export class WorkerError extends Error {
	readonly code: WorkerErrorCode;
	readonly details: Readonly<Record<string, unknown>>;

	constructor(code: WorkerErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
		super(message);
		this.name = "WorkerError";
		this.code = code;
		this.details = Object.freeze({ ...details });
	}
}

// =============================================================================
// Identity
// =============================================================================

/**
 * Stable worker identity derived from the logical executor it serves. A worker
 * is bound 1:1 to an executor; the executor remains the capability/placement
 * authority while `workerId` provides a distinct worker-domain namespace.
 */
export function workerIdForExecutor(executorId: string): string {
	return `worker_${executorId}`;
}

export function isSafeWorkerId(value: string): boolean {
	return /^[A-Za-z0-9._-]+$/u.test(value) && value !== "." && value !== "..";
}

/** Stable non-PID worker incarnation owner identity (host + UUID). */
export function newWorkerOwnerId(): string {
	return `worker_owner_${randomUUID()}`;
}

/**
 * Worker identity view. `workerInstanceId`/`workerEpoch`/`ownerId` are the
 * concrete daemon incarnation (Executor Registry runtime), never PID-derived.
 */
export interface WorkerIdentity {
	executorId: string;
	workerId: string;
	/** Concrete daemon incarnation = Executor Registry runtimeInstanceId. */
	workerInstanceId: string;
	/** Activation generation = Executor Registry runtimeEpoch. */
	workerEpoch: number;
	/** Process-lifetime owner identity (never a PID). */
	ownerId: string;
	hostname?: string;
	pid?: number;
	startedAtMs: number;
	processStartedAtMs?: number;
	jensenVersion?: string;
}

// =============================================================================
// Daemon lifecycle + activity
// =============================================================================

/** In-process daemon lifecycle. Durable liveness is Executor Registry heartbeat. */
export type WorkerDaemonState = "STARTING" | "RUNNING" | "SHUTTING_DOWN" | "STOPPED";

/**
 * Derived worker activity from the durable assignment + mission stores. It is a
 * read model, never a separate persisted worker state.
 */
export type WorkerActivity = "IDLE" | "CLAIMING" | "EXECUTING" | "INTERRUPTED" | "TERMINAL";

/**
 * Waiting/parking reason vocabulary. Not a resource scheduler; the purpose is
 * to keep the execution lifecycle capable of distinguishing an agent that is
 * waiting for inference (future Shared Inference Scheduler) from one that is
 * waiting on a tool/external process, without a breaking redesign later.
 */
export type WorkerWaitReason =
	| "TOOL"
	| "EXTERNAL_PROCESS"
	| "DEPENDENCY"
	| "INFERENCE"
	| "OPERATOR"
	| "RESOURCE"
	| "UNKNOWN";

// =============================================================================
// Status DTOs
// =============================================================================

/** Current assignment designation observed by this worker (bounded view). */
export interface WorkerCurrentAssignment {
	assignmentId: string;
	missionId: string;
	state: AssignmentState;
	acceptedAtMs?: number;
	executionStartedAtMs?: number;
	attemptId?: string;
	executionId?: string;
}

/** Current execution (mission lifecycle) observed by this worker. */
export interface WorkerCurrentExecution {
	missionId: string;
	missionState: MissionState;
	currentAttemptId?: string;
	currentExecutionId?: string;
	/** Present when the mission is in a waiting/blocked state. */
	waitReason?: WorkerWaitReason;
}

/** Full operator-facing worker status (identity + liveness + work view). */
export interface WorkerStatus {
	identity: WorkerIdentity;
	liveness: ExecutorLivenessStatus;
	daemonState: WorkerDaemonState;
	activity: WorkerActivity;
	currentAssignment?: WorkerCurrentAssignment;
	currentExecution?: WorkerCurrentExecution;
	lastError?: string;
	observedAtMs: number;
}

/** Bounded list entry. */
export interface WorkerSummary {
	executorId: string;
	workerId: string;
	workerInstanceId?: string;
	workerEpoch: number;
	hostname?: string;
	pid?: number;
	status: ExecutorLivenessStatus;
	lastHeartbeatAtMs?: number;
	expiresAtMs?: number;
	currentAssignmentId?: string;
	currentAssignmentState?: AssignmentState;
	currentMissionState?: MissionState;
}

export interface WorkerListResult {
	entries: WorkerSummary[];
	/** Corrupt executor records surfaced structurally, never folded into health. */
	corrupt: { executorId: string; diagnostic: string }[];
}

// =============================================================================
// Run outcomes
// =============================================================================

/** One worker claim/execute cycle outcome (used by `--once` and polling). */
export type WorkerRunOutcome =
	| { kind: "idle"; observedAtMs: number }
	| { kind: "skipped"; assignmentId: string; reason: string; observedAtMs: number }
	| {
			kind: "executed";
			assignmentId: string;
			missionId: string;
			missionState: MissionState;
			attemptId?: string;
			executionId?: string;
			success: boolean;
			observedAtMs: number;
	  };

/** Worker startup outcome: identity + proof for a newly-activated incarnation. */
export interface WorkerStartOutcome {
	identity: WorkerIdentity;
	runtimeInstanceId: string;
	runtimeEpoch: number;
	expiresAtMs: number;
}

/** Restart reconciliation report (worker-scoped, composes durable recovery). */
export interface WorkerRecoveryReport {
	executorId: string;
	/** Missions transitioned to INTERRUPTED (stale-worker live lease revoked). */
	staleInterrupted: { missionId: string; previousState: MissionState }[];
	/** Stale EXECUTING assignments transitioned to FAILED. */
	staleAssignmentsFailed: { assignmentId: string; missionId: string }[];
	/** Underlying durable-store recovery (expired leases). */
	durableRecovery: {
		scanned: number;
		reconciled: string[];
		alreadyRecovered: string[];
		unchanged: string[];
		corrupt: { missionId: string; diagnostic: string }[];
		actions: string[];
	};
}
