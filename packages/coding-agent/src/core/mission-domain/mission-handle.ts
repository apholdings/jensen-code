/**
 * First-Class Mission Handle (2.3.0).
 *
 * A handle references a launched mission independently of its executor. It is a
 * read-only domain snapshot: no ChildProcess, no socket, no concrete transport
 * appears here. The executor owns cancellation behind its own boundary and
 * attaches a typed `cancel` control to the handle.
 */

import type { MissionState } from "./mission-state.js";

export interface MissionHandle {
	/** Stable canonical mission identity. */
	readonly missionId: string;
	/** Explicit structured parent identity; absent for a root mission. */
	readonly parentMissionId?: string;
	/** Structural recursion depth. */
	readonly depth: number;
	/**
	 * Executor-scoped execution identity (opaque string). It is NOT a process id
	 * and must remain meaningful for a remote or restarted executor.
	 */
	readonly executionId: string;
	/** Current lifecycle state (snapshot at handle creation). */
	readonly state: MissionState;
	readonly createdAtMs: number;
	readonly startedAtMs?: number;
	readonly finishedAtMs?: number;
	/**
	 * Cancellation control owned by the executor. Safe to call after launch;
	 * idempotent.
	 */
	readonly cancel: (reason?: string) => Promise<void>;
}

export interface CreateMissionHandleInput {
	missionId: string;
	parentMissionId?: string;
	depth: number;
	executionId: string;
	state: MissionState;
	createdAtMs: number;
	startedAtMs?: number;
	finishedAtMs?: number;
	cancel: (reason?: string) => Promise<void>;
}

/**
 * Construct an immutable handle snapshot. `cancel` is supplied by the executor;
 * the domain never knows what it closes over.
 */
export function createMissionHandle(input: CreateMissionHandleInput): MissionHandle {
	return Object.freeze({
		missionId: input.missionId,
		parentMissionId: input.parentMissionId,
		depth: input.depth,
		executionId: input.executionId,
		state: input.state,
		createdAtMs: input.createdAtMs,
		startedAtMs: input.startedAtMs,
		finishedAtMs: input.finishedAtMs,
		cancel: input.cancel,
	});
}
