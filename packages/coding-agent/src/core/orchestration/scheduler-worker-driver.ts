/**
 * Bounded in-process Scheduler -> Worker application driver.
 *
 * The driver supplies the optional application seam between a parent
 * orchestration execution and the existing control-plane services. It starts
 * one WorkerControlService, serially runs scheduler ticks followed by worker
 * passes, and stops the worker when the parent operation completes. It never
 * writes mission state or launches children itself; Scheduler, Assignment,
 * Worker, and the parent DurableMissionCoordinator retain their authorities.
 */

import type { AssignmentControlService } from "../assignment/assignment-control-service.js";
import type { DurableMissionStore } from "../mission-domain/durable-store.js";
import { isTerminalMissionState } from "../mission-domain/mission-state.js";
import type { SchedulerControlService } from "../scheduler/scheduler-control-service.js";
import { SchedulingError } from "../scheduler/scheduler-types.js";
import type { WorkerControlService } from "../worker-daemon/worker-control-service.js";

export interface SchedulerWorkerTerminalCleanupOptions {
	missions: DurableMissionStore;
	scheduler: SchedulerControlService;
	assignments: AssignmentControlService;
}

export interface SchedulerWorkerTerminalCleanupReport {
	children: string[];
	releasedAssignments: string[];
	cancelledIntents: string[];
	completedExecutingAssignments: string[];
	residuals: string[];
}

/**
 * Bounded parent-terminal cleanup over the existing control-plane authorities.
 * It never writes mission state: active execution is stopped by Worker, pending
 * intent is cancelled by Scheduler, and assignment ownership is released or
 * completed by Assignment using the terminal mission result as evidence.
 */
export class SchedulerWorkerTerminalCleanup {
	private readonly _missions: DurableMissionStore;
	private readonly _scheduler: SchedulerControlService;
	private readonly _assignments: AssignmentControlService;

	constructor(options: SchedulerWorkerTerminalCleanupOptions) {
		this._missions = options.missions;
		this._scheduler = options.scheduler;
		this._assignments = options.assignments;
	}

	async cleanup(parentMissionId: string): Promise<SchedulerWorkerTerminalCleanupReport> {
		const children = await this._missions.listChildren(parentMissionId);
		const report: SchedulerWorkerTerminalCleanupReport = {
			children,
			releasedAssignments: [],
			cancelledIntents: [],
			completedExecutingAssignments: [],
			residuals: [],
		};

		for (const missionId of children) {
			const current = await this._assignments.getCurrentForMission(missionId);
			if (current?.state === "ASSIGNED" || current?.state === "ACCEPTED") {
				await this._assignments.releaseAssignment(current.assignmentId);
				report.releasedAssignments.push(current.assignmentId);
			} else if (current?.state === "EXECUTING") {
				const mission = await this._missions.load(missionId);
				if (mission.status === "ok" && mission.record.result && isTerminalMissionState(mission.record.state)) {
					const lastAttempt = mission.record.attempts[mission.record.attempts.length - 1];
					await this._assignments.completeAssignment(current.assignmentId, {
						resultState: mission.record.state,
						attemptId: lastAttempt?.attemptId,
						executionId: mission.record.resultExecutionId ?? lastAttempt?.executionId,
						reason: "parent terminal cleanup: mission already terminal",
					});
					report.completedExecutingAssignments.push(current.assignmentId);
				} else {
					report.residuals.push(
						`EXECUTING assignment ${current.assignmentId} for nonterminal child ${missionId} cannot be interrupted safely`,
					);
				}
			}

			try {
				const intent = await this._scheduler.getIntentForMission(missionId);
				if (intent.state === "PENDING" || intent.state === "UNSCHEDULABLE") {
					await this._scheduler.cancelIntent(missionId);
					report.cancelledIntents.push(intent.intentId);
				}
			} catch (error) {
				if (!(error instanceof SchedulingError) || error.code !== "INTENT_NOT_FOUND") throw error;
			}
		}

		for (const missionId of children) {
			const current = await this._assignments.getCurrentForMission(missionId);
			if (current?.state === "ASSIGNED" || current?.state === "ACCEPTED" || current?.state === "EXECUTING")
				report.residuals.push(
					`current ${current.state} assignment ${current.assignmentId} remains for child ${missionId}`,
				);
			try {
				const intent = await this._scheduler.getIntentForMission(missionId);
				if (intent.state === "PENDING")
					report.residuals.push(`executable PENDING intent ${intent.intentId} remains for child ${missionId}`);
			} catch (error) {
				if (!(error instanceof SchedulingError) || error.code !== "INTENT_NOT_FOUND") throw error;
			}
		}
		if (report.residuals.length > 0)
			throw new Error(`PARENT_TERMINAL_CLEANUP_INCOMPLETE: ${report.residuals.join("; ")}`);
		return report;
	}
}

export interface SchedulerWorkerDriverOptions {
	scheduler: SchedulerControlService;
	worker: WorkerControlService;
	/** Mandatory parent-terminal cleanup over the existing Scheduler/Assignment authorities. */
	terminalCleanup: SchedulerWorkerTerminalCleanup;
	/** Maximum number of scheduler/worker passes for one parent operation. */
	maxTicks?: number;
	/** Delay between passes. Defaults to 0 for application/test composition. */
	tickIntervalMs?: number;
}

export interface SchedulerWorkerDriverRunOptions {
	signal?: AbortSignal;
	parentMissionId?: string;
}

/** Structured scheduler/worker driver failure, distinct from caller cancellation. */
export class SchedulerWorkerDriverFailure extends Error {
	readonly cause: unknown;

	constructor(message: string, cause?: unknown) {
		super(message);
		this.name = "SchedulerWorkerDriverFailure";
		this.cause = cause;
	}
}

function isParentFailedOutcome(result: unknown): boolean {
	return (
		typeof result === "object" &&
		result !== null &&
		"state" in result &&
		(result as { state?: unknown }).state === "FAILED"
	);
}

function isParentTerminalCleanupRequired(result: unknown): boolean {
	if (typeof result !== "object" || result === null || !("state" in result)) return true;
	const state = (result as { state?: unknown }).state;
	return state === "CANCELLED" || state === "FAILED" || state === "TIMED_OUT" || state === "CRASHED";
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

/**
 * Drives a parent operation while an optional local worker consumes its child
 * assignments. One driver instance owns one serialized worker run at a time.
 */
export class SchedulerWorkerDriver {
	private readonly _scheduler: SchedulerControlService;
	private readonly _worker: WorkerControlService;
	private readonly _terminalCleanup: SchedulerWorkerTerminalCleanup;
	private readonly _maxTicks: number;
	private readonly _tickIntervalMs: number;
	private _active = false;

	constructor(options: SchedulerWorkerDriverOptions) {
		this._scheduler = options.scheduler;
		this._worker = options.worker;
		this._terminalCleanup = options.terminalCleanup;
		this._maxTicks = options.maxTicks ?? 10_000;
		this._tickIntervalMs = options.tickIntervalMs ?? 0;
		if (!Number.isSafeInteger(this._maxTicks) || this._maxTicks < 1)
			throw new Error("SCHEDULER_WORKER_DRIVER_INVALID: maxTicks must be a positive safe integer");
		if (!Number.isFinite(this._tickIntervalMs) || this._tickIntervalMs < 0)
			throw new Error("SCHEDULER_WORKER_DRIVER_INVALID: tickIntervalMs must be non-negative");
	}

	/** Execute an operation with the bounded Scheduler -> Worker pump active. */
	async execute<T>(
		operation: (signal: AbortSignal) => Promise<T>,
		options: SchedulerWorkerDriverRunOptions = {},
	): Promise<T> {
		if (this._active) throw new Error("SCHEDULER_WORKER_DRIVER_ACTIVE: driver is already running");
		this._active = true;
		const controller = new AbortController();
		const callerSignal = options.signal;
		const abortFromCaller = () => controller.abort(callerSignal?.reason);
		if (callerSignal) {
			if (callerSignal.aborted) controller.abort(callerSignal.reason);
			else callerSignal.addEventListener("abort", abortFromCaller, { once: true });
		}

		let pumpFailure: SchedulerWorkerDriverFailure | undefined;
		let pump: Promise<void> | undefined;
		let result: T | undefined;
		let operationCompleted = false;
		let cleanupRequired = false;
		let primaryError: unknown;
		const finalizationErrors: unknown[] = [];
		try {
			try {
				await this._worker.start({ reconcile: false, polling: false });
				pump = this._pump(controller.signal).catch((error: unknown) => {
					const failure = new SchedulerWorkerDriverFailure("scheduler/worker driver failed", error);
					pumpFailure = failure;
					controller.abort(failure);
				});
				result = await operation(controller.signal);
				operationCompleted = true;
				cleanupRequired = isParentTerminalCleanupRequired(result);
			} catch (error) {
				primaryError = error;
				controller.abort(error);
			}

			if (pumpFailure !== undefined || primaryError !== undefined) cleanupRequired = true;
		} finally {
			controller.abort("scheduler/worker driver cleanup");
			// stop() aborts the worker's in-flight child before awaiting it. This
			// ordering prevents cleanup from waiting on a runOnce that cleanup
			// itself must cancel. Finalization errors are collected so they cannot
			// replace the operation or pump failure that caused the shutdown.
			try {
				await this._worker.stop("scheduler/worker driver cleanup");
			} catch (error) {
				finalizationErrors.push(error);
			}
			if (pump) {
				try {
					await pump;
				} catch (error) {
					finalizationErrors.push(error);
				}
			}
			if (pumpFailure !== undefined) cleanupRequired = true;
			if ((cleanupRequired || pumpFailure !== undefined) && options.parentMissionId) {
				try {
					await this._terminalCleanup.cleanup(options.parentMissionId);
				} catch (error) {
					finalizationErrors.push(error);
				}
			}
			if (callerSignal) callerSignal.removeEventListener("abort", abortFromCaller);
			this._active = false;
		}

		// A coordinator result with FAILED state is the durable authority for a
		// pump failure. Do not replace it with a caller-only exception. For
		// non-durable callers, retain the pump failure as the primary error.
		if (pumpFailure !== undefined && !isParentFailedOutcome(result) && !callerSignal?.aborted)
			primaryError = pumpFailure;
		if (operationCompleted && result !== undefined && isParentTerminalCleanupRequired(result)) cleanupRequired = true;

		if (primaryError !== undefined && finalizationErrors.length > 0)
			throw new AggregateError([primaryError, ...finalizationErrors], "scheduler/worker driver finalization failed");
		if (primaryError !== undefined) throw primaryError;
		if (finalizationErrors.length === 1) throw finalizationErrors[0];
		if (finalizationErrors.length > 1)
			throw new AggregateError(finalizationErrors, "scheduler/worker driver finalization failed");
		return result as T;
	}

	private async _pump(signal: AbortSignal): Promise<void> {
		for (let tick = 0; tick < this._maxTicks && !signal.aborted; tick++) {
			await this._scheduler.runTick();
			if (signal.aborted) break;
			await this._worker.runOnce();
			await sleep(this._tickIntervalMs, signal);
		}
		if (!signal.aborted) throw new Error("SCHEDULER_WORKER_DRIVER_LIMIT: bounded tick limit exhausted");
	}
}

export function createSchedulerWorkerDriver(options: SchedulerWorkerDriverOptions): SchedulerWorkerDriver {
	return new SchedulerWorkerDriver(options);
}
