/**
 * Worker Control Service (2.13.0).
 *
 * The durable daemon boundary that composes the existing primitives into a
 * long-lived worker loop. It NEVER re-implements executor identity, assignment
 * claim, execution fencing, mission lifecycle, evidence, or verification — it
 * consumes them:
 *
 *   - ExecutorControlService      → worker identity + incarnation + heartbeat.
 *   - AssignmentControlService    → discovery + claim + execution + completion.
 *   - DurableMissionCoordinator   → crash reconciliation + stale-owner interrupt.
 *   - ProcessMissionExecutor      → the existing local child-resume execution path.
 *   - buildAcceptanceCriteriaVerifier → deterministic completion promotion.
 *
 * Critical invariant (Jensen 3.0): logical agent concurrency != inference
 * concurrency. This worker owns an Assignment for its full logical lifetime, but
 * never reserves a Qwen inference slot for that lifetime. Inference is acquired
 * only while the child execution actually performs an inference request; the
 * future Shared Inference Scheduler will park/rehydrate the logical execution
 * (RUNNING → WAITING(INFERENCE) → RUNNING) without touching worker identity.
 */

import type {
	AssignmentControlService,
	BuildAssignedExecutor,
	BuildAssignedResumeLaunch,
} from "../assignment/assignment-control-service.js";
import type { AssignmentRecord } from "../assignment/assignment-types.js";
import { AssignmentError } from "../assignment/assignment-types.js";
import { ExecutorRegistryError } from "../executor-registry/executor-registry-types.js";
import type { ExecutorControlService, ExecutorDetail, ExecutorRuntimeProof } from "../executor-registry/index.js";
import { DurableMissionCoordinator } from "../mission-domain/durable-coordinator.js";
import type { DurableMissionRecord, DurableMissionStore } from "../mission-domain/durable-store.js";
import type { MissionExecutor } from "../mission-domain/mission-executor.js";
import { isTerminalMissionState, type MissionState } from "../mission-domain/mission-state.js";
import type { ProcessMissionVerifier } from "../mission-domain/process-mission-executor.js";
import {
	type WorkerActivity,
	type WorkerCurrentAssignment,
	type WorkerCurrentExecution,
	type WorkerDaemonState,
	type WorkerErrorCode,
	type WorkerIdentity,
	type WorkerRecoveryReport,
	type WorkerRunOutcome,
	type WorkerStartOutcome,
	type WorkerStatus,
	type WorkerSummary,
	type WorkerWaitReason,
	workerIdForExecutor,
} from "./worker-types.js";
import { buildAcceptanceCriteriaVerifier } from "./worker-verification.js";

// =============================================================================
// Errors + helpers
// =============================================================================

function workerError(code: WorkerErrorCode, message: string, details: Record<string, unknown> = {}): never {
	const error = new Error(message) as Error & { code: WorkerErrorCode; details: Readonly<Record<string, unknown>> };
	error.name = "WorkerError";
	error.code = code;
	error.details = Object.freeze({ ...details });
	throw error;
}

/** Executor used only for read/recovery passes that never launch work. */
const NOOP_EXECUTOR: MissionExecutor = {
	executorId: "worker-noop",
	async launch(): Promise<never> {
		throw new Error("noop executor cannot launch");
	},
	async awaitResult(): Promise<never> {
		throw new Error("noop executor cannot await");
	},
	async cancel(): Promise<void> {},
};

function waitReasonFor(record: DurableMissionRecord): WorkerWaitReason | undefined {
	if (record.state !== "WAITING" && record.state !== "BLOCKED") return undefined;
	const last = record.transitions[record.transitions.length - 1];
	const reason = last?.reason ?? "";
	if (/inference/i.test(reason)) return "INFERENCE";
	if (/tool/i.test(reason)) return "TOOL";
	if (/external|process/i.test(reason)) return "EXTERNAL_PROCESS";
	if (/dependenc/i.test(reason)) return "DEPENDENCY";
	if (/operator/i.test(reason)) return "OPERATOR";
	if (/resource/i.test(reason)) return "RESOURCE";
	return "UNKNOWN";
}

// =============================================================================
// Options
// =============================================================================

export interface WorkerControlServiceOptions {
	/** The logical executor this worker serves (workerId is derived). */
	executorId: string;
	executors: ExecutorControlService;
	assignments: AssignmentControlService;
	missions: DurableMissionStore;
	/** Maps a durable child mission to the concrete local child CLI launch. */
	buildResumeLaunch: BuildAssignedResumeLaunch;
	/**
	 * Optional executor builder for a REMOTE executor. When set, the worker uses
	 * it instead of the local `ProcessMissionExecutor` path. Built per-worker by
	 * the CLI when the executor is bound to a remote target.
	 */
	buildExecutor?: BuildAssignedExecutor;
	/**
	 * Optional verifier that promotes a clean exit-0 execution to SUCCEEDED.
	 * When omitted, the worker builds one from the mission's declared acceptance
	 * criteria (`buildAcceptanceCriteriaVerifier`). A mission with no verifiable
	 * criteria therefore stays PARTIAL (unverified), never fabricated SUCCEEDED.
	 */
	verifier?: ProcessMissionVerifier;
	/** Poll cadence for assignment discovery (default 1000ms). */
	pollMs?: number;
	/** Heartbeat cadence for worker liveness (default 3000ms). */
	heartbeatMs?: number;
	/** Heartbeat expiry window (default from ExecutorControlService). */
	expiryMs?: number;
	/** Lease duration used for child execution (default 30 min). */
	leaseDurationMs?: number;
	now?: () => number;
	/** Worker instance id factory (default host+UUID; never a PID). */
	workerInstanceIdFactory?: () => string;
}

// =============================================================================
// Service
// =============================================================================

export class WorkerControlService {
	private readonly _executorId: string;
	private readonly _workerId: string;
	private readonly _executors: ExecutorControlService;
	private readonly _assignments: AssignmentControlService;
	private readonly _missions: DurableMissionStore;
	private readonly _buildResumeLaunch: BuildAssignedResumeLaunch;
	private readonly _buildExecutor?: BuildAssignedExecutor;
	private readonly _verifier?: ProcessMissionVerifier;
	private readonly _pollMs: number;
	private readonly _heartbeatMs: number;
	private readonly _expiryMs?: number;
	private readonly _leaseDurationMs?: number;
	private readonly _now: () => number;
	private readonly _workerInstanceIdFactory: () => string;

	private _proof?: ExecutorRuntimeProof;
	private _identity?: WorkerIdentity;
	private _daemonState: WorkerDaemonState = "STOPPED";
	private _heartbeatTimer?: NodeJS.Timeout;
	private _pollTimer?: NodeJS.Timeout;
	private _running = false;
	private _currentAbort?: AbortController;
	private _inFlight?: Promise<WorkerRunOutcome>;
	private _lastError?: string;

	constructor(options: WorkerControlServiceOptions) {
		this._executorId = options.executorId;
		this._workerId = workerIdForExecutor(options.executorId);
		this._executors = options.executors;
		this._assignments = options.assignments;
		this._missions = options.missions;
		this._buildResumeLaunch = options.buildResumeLaunch;
		this._buildExecutor = options.buildExecutor;
		this._verifier = options.verifier;
		this._pollMs = options.pollMs ?? 1000;
		this._heartbeatMs = options.heartbeatMs ?? 3000;
		this._expiryMs = options.expiryMs;
		this._leaseDurationMs = options.leaseDurationMs;
		this._now = options.now ?? (() => Date.now());
		this._workerInstanceIdFactory =
			options.workerInstanceIdFactory ??
			(() => `worker_${this._executorId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
	}

	get executorId(): string {
		return this._executorId;
	}

	get workerId(): string {
		return this._workerId;
	}

	get daemonState(): WorkerDaemonState {
		return this._daemonState;
	}

	get proof(): ExecutorRuntimeProof | undefined {
		return this._proof;
	}

	// =========================================================================
	// Lifecycle
	// =========================================================================

	/**
	 * Register (idempotent) + activate a runtime incarnation + begin heartbeat
	 * and polling. Exactly one worker runtime can be live per executor at a time;
	 * a second concurrent `start()` for the same executor fails closed with
	 * EXECUTOR_ALREADY_ACTIVE (the duplicate-daemon single-owner fence).
	 */
	async start(options: { reconcile?: boolean } = {}): Promise<WorkerStartOutcome> {
		if (this._daemonState !== "STOPPED") {
			workerError("WORKER_ALREADY_STARTED", `Worker ${this._workerId} is already ${this._daemonState}`);
		}
		this._daemonState = "STARTING";

		let activation: Awaited<ReturnType<ExecutorControlService["activateExecutor"]>> | undefined;
		try {
			activation = await this._activate();
		} catch (error) {
			this._daemonState = "STOPPED";
			if (error instanceof ExecutorRegistryError && error.code === "EXECUTOR_ALREADY_ACTIVE") {
				workerError("EXECUTOR_ALREADY_ACTIVE", `Executor ${this._executorId} already has a live worker runtime`, {
					executorId: this._executorId,
				});
			}
			throw error;
		}

		if (!activation) {
			this._daemonState = "STOPPED";
			workerError("EXECUTOR_NOT_ACTIVE", `Executor ${this._executorId} did not activate a runtime`);
		}

		if (options.reconcile !== false) {
			try {
				await this.reconcile();
			} catch (error) {
				this._lastError = error instanceof Error ? error.message : String(error);
			}
		}

		this._daemonState = "RUNNING";
		this._heartbeatTimer = setInterval(() => void this._heartbeat(), this._heartbeatMs);
		this._pollTimer = setInterval(() => void this._poll(), this._pollMs);
		return {
			identity: this._identity!,
			runtimeInstanceId: activation.runtimeInstanceId,
			runtimeEpoch: activation.runtimeEpoch,
			expiresAtMs: activation.expiresAtMs,
		};
	}

	/**
	 * Graceful shutdown: stop accepting work, stop heartbeats, abort any
	 * in-flight execution honestly (the fenced child path persists CANCELLED,
	 * never a fabricated success), and deactivate the runtime incarnation.
	 */
	async stop(reason?: string): Promise<void> {
		if (this._daemonState === "STOPPED") return;
		this._daemonState = "SHUTTING_DOWN";

		if (this._pollTimer) clearInterval(this._pollTimer);
		if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
		this._pollTimer = undefined;
		this._heartbeatTimer = undefined;

		if (this._currentAbort) {
			this._currentAbort.abort(reason ?? "worker shutdown");
			this._currentAbort = undefined;
		}

		// Await the in-flight execution so its fenced terminal write (CANCELLED,
		// never a fabricated success) lands before the runtime is deactivated.
		if (this._inFlight) {
			try {
				await this._inFlight;
			} catch {
				// The terminal write is the authority; never mask shutdown.
			}
		}

		if (this._proof) {
			try {
				await this._executors.deactivateExecutor(this._proof);
			} catch (error) {
				// Deactivation is best-effort; liveness still expires via heartbeat.
				this._lastError = error instanceof Error ? error.message : String(error);
			}
		}

		this._proof = undefined;
		this._identity = undefined;
		this._daemonState = "STOPPED";
	}

	// =========================================================================
	// Work loop
	// =========================================================================

	/**
	 * One discovery → claim → execute cycle. Deterministic ordering by
	 * `createdAtMs` (then assignmentId). `--once` callers use this directly;
	 * the daemon poll loop invokes it while idle. Never runs two executions
	 * concurrently (initial concurrency policy = serial).
	 */
	async runOnce(): Promise<WorkerRunOutcome> {
		if (this._running) return { kind: "idle", observedAtMs: this._now() };
		if (!this._proof) {
			workerError("WORKER_NOT_STARTED", `Worker ${this._workerId} has not been started`);
		}

		this._running = true;
		const task = this._runOnceImpl();
		this._inFlight = task;
		try {
			return await task;
		} finally {
			this._running = false;
			this._inFlight = undefined;
		}
	}

	private async _runOnceImpl(): Promise<WorkerRunOutcome> {
		const eligible = await this._eligibleAssignments();
		if (eligible.length === 0) return { kind: "idle", observedAtMs: this._now() };

		const assignment = eligible[0];
		try {
			// Explicit claim step (ASSIGNED → ACCEPTED). An ACCEPTED assignment
			// (prior crash between accept and begin) is executed directly.
			if (assignment.state === "ASSIGNED") {
				await this._assignments.acceptAssignment(assignment.assignmentId, this._proof!);
			}

			this._currentAbort = new AbortController();
			const verifier = this._verifier ?? (await this._verifierFor(assignment.missionId));
			const started = await this._assignments.startAssignedMission(assignment.assignmentId, this._proof!, {
				buildResumeLaunch: this._buildResumeLaunch,
				signal: this._currentAbort.signal,
				verifier,
				...(this._buildExecutor ? { buildExecutor: this._buildExecutor } : {}),
			});
			this._currentAbort = undefined;
			this._lastError = undefined;

			return {
				kind: "executed",
				assignmentId: assignment.assignmentId,
				missionId: started.missionId,
				missionState: started.missionState,
				attemptId: started.attemptId,
				executionId: started.executionId,
				success: started.success,
				observedAtMs: this._now(),
			};
		} catch (error) {
			this._currentAbort = undefined;
			// A claim race (another worker accepted first) is not a failure; it
			// is observed ownership, recorded and skipped safely.
			if (error instanceof AssignmentError && error.code === "ASSIGNMENT_NOT_CURRENT") {
				return {
					kind: "skipped",
					assignmentId: assignment.assignmentId,
					reason: error.message,
					observedAtMs: this._now(),
				};
			}
			this._lastError = error instanceof Error ? error.message : String(error);
			throw error;
		}
	}

	// =========================================================================
	// Read model
	// =========================================================================

	/** Durable read model of this worker's identity, liveness, and current work. */
	async status(): Promise<WorkerStatus> {
		let detail: ExecutorDetail | undefined;
		try {
			detail = await this._executors.getExecutor(this._executorId);
		} catch {
			detail = undefined;
		}

		const identity: WorkerIdentity =
			this._identity ??
			({
				executorId: this._executorId,
				workerId: this._workerId,
				workerInstanceId: detail?.runtime?.runtimeInstanceId ?? "",
				workerEpoch: detail?.runtimeEpoch ?? 0,
				ownerId: detail?.runtime?.ownerId ?? "",
				hostname: detail?.runtime?.hostname,
				pid: detail?.runtime?.pid,
				startedAtMs: detail?.runtime?.startedAtMs ?? 0,
				processStartedAtMs: detail?.runtime?.processStartedAtMs,
				jensenVersion: detail?.runtime?.jensenVersion,
			} as WorkerIdentity);

		const liveness = detail?.status ?? "OFFLINE";
		const currentAssignment = await this._currentAssignment();
		const currentExecution = currentAssignment
			? await this._currentExecution(currentAssignment.missionId)
			: undefined;
		const activity = this._activityFor(currentAssignment, currentExecution);

		return {
			identity,
			liveness,
			daemonState: this._daemonState,
			activity,
			currentAssignment,
			currentExecution,
			lastError: this._lastError,
			observedAtMs: this._now(),
		};
	}

	// =========================================================================
	// Crash / restart reconciliation
	// =========================================================================

	/**
	 * Conservative restart reconciliation. Runs the durable-store recovery
	 * (expired leases → INTERRUPTED) and additionally revokes still-live leases
	 * left behind by a prior worker incarnation of THIS executor (identified via
	 * stale assignment `executionOwnerIdentity`). Never auto-runs side-effectful
	 * work and never fabricates success.
	 */
	async reconcile(): Promise<WorkerRecoveryReport> {
		if (!this._proof) {
			workerError("WORKER_NOT_STARTED", `Worker ${this._workerId} has not been started`);
		}
		const coordinator = new DurableMissionCoordinator(this._missions, NOOP_EXECUTOR, {
			now: this._now,
			leaseDurationMs: this._leaseDurationMs,
		});
		const durableRecovery = await coordinator.recover();

		const staleInterrupted: WorkerRecoveryReport["staleInterrupted"] = [];
		const staleAssignmentsFailed: WorkerRecoveryReport["staleAssignmentsFailed"] = [];

		const { records } = await this._assignments.store.listRecords();
		const staleExecuting = records
			.filter(
				(record) =>
					record.executorId === this._executorId &&
					record.state === "EXECUTING" &&
					record.current &&
					record.executionOwnerIdentity &&
					record.executionOwnerIdentity.runtimeInstanceId !== this._proof!.runtimeInstanceId,
			)
			.sort((a, b) => a.createdAtMs - b.createdAtMs || (a.assignmentId < b.assignmentId ? -1 : 1));

		for (const assignment of staleExecuting) {
			const missionId = assignment.missionId;
			const staleOwnerId = assignment.executionOwnerIdentity!.ownerId;
			const missionLoaded = await this._missions.load(missionId);

			if (missionLoaded.status === "ok" && isTerminalMissionState(missionLoaded.record.state)) {
				// The child already reached a terminal result but the prior worker
				// died before completing the assignment: complete it honestly.
				const record = missionLoaded.record;
				const lastAttempt = record.attempts[record.attempts.length - 1];
				await this._assignments.completeAssignment(assignment.assignmentId, {
					resultState: record.state,
					attemptId: record.resultExecutionId ? lastAttempt?.attemptId : assignment.consumedByAttemptId,
					executionId: record.resultExecutionId ?? assignment.consumedByExecutionId,
					reason: "worker restart reconciliation: mission already terminal",
				});
				continue;
			}

			const interrupted = await coordinator.interruptStaleExecution(missionId, {
				staleOwnerId,
				reason: "worker restart: prior execution owner is stale",
			});
			if (interrupted.status === "reconciled") {
				staleInterrupted.push({ missionId, previousState: interrupted.previousState ?? "RUNNING" });
			}
			const failed = await this._assignments.interruptExecution(
				assignment.assignmentId,
				"worker restart: prior execution interrupted",
			);
			staleAssignmentsFailed.push({ assignmentId: failed.assignmentId, missionId });
		}

		return {
			executorId: this._executorId,
			staleInterrupted,
			staleAssignmentsFailed,
			durableRecovery,
		};
	}

	// =========================================================================
	// Internals
	// =========================================================================

	private async _activate(): Promise<Awaited<ReturnType<ExecutorControlService["activateExecutor"]>>> {
		try {
			return await this._activateRuntime();
		} catch (error) {
			if (error instanceof ExecutorRegistryError && error.code === "EXECUTOR_NOT_FOUND") {
				// The executor is not registered yet: register a bare definition and
				// activate. If it already exists (e.g. operator-registered with
				// capabilities) it is never re-registered, so its definition is
				// preserved and the worker simply activates a runtime incarnation.
				await this._executors.registerExecutor({
					executorId: this._executorId,
					displayName: this._workerId,
				});
				return this._activateRuntime();
			}
			throw error;
		}
	}

	private async _activateRuntime(): Promise<Awaited<ReturnType<ExecutorControlService["activateExecutor"]>>> {
		const activation = await this._executors.activateExecutor(this._executorId, {
			runtimeInstanceId: this._workerInstanceIdFactory(),
			expiryMs: this._expiryMs,
		});
		this._proof = activation.proof;
		const runtime = activation.record.runtime;
		this._identity = {
			executorId: this._executorId,
			workerId: this._workerId,
			workerInstanceId: activation.runtimeInstanceId,
			workerEpoch: activation.runtimeEpoch,
			ownerId: runtime?.ownerId ?? "",
			hostname: runtime?.hostname,
			pid: runtime?.pid,
			startedAtMs: runtime?.startedAtMs ?? this._now(),
			processStartedAtMs: runtime?.processStartedAtMs,
			jensenVersion: runtime?.jensenVersion,
		};
		return activation;
	}

	private async _heartbeat(): Promise<void> {
		if (!this._proof || this._daemonState !== "RUNNING") return;
		try {
			await this._executors.heartbeatExecutor(this._proof, { expiryMs: this._expiryMs });
		} catch (error) {
			this._lastError = error instanceof Error ? error.message : String(error);
		}
	}

	private async _poll(): Promise<void> {
		if (this._daemonState !== "RUNNING" || this._running) return;
		try {
			await this.runOnce();
		} catch (error) {
			this._lastError = error instanceof Error ? error.message : String(error);
		}
	}

	private async _eligibleAssignments(): Promise<AssignmentRecord[]> {
		const { records } = await this._assignments.store.listRecords();
		return records
			.filter(
				(record) =>
					record.executorId === this._executorId &&
					record.current &&
					(record.state === "ASSIGNED" || record.state === "ACCEPTED"),
			)
			.sort((a, b) => a.createdAtMs - b.createdAtMs || (a.assignmentId < b.assignmentId ? -1 : 1));
	}

	private async _verifierFor(missionId: string): Promise<ProcessMissionVerifier | undefined> {
		const loaded = await this._missions.load(missionId);
		if (loaded.status !== "ok") return undefined;
		return buildAcceptanceCriteriaVerifier(loaded.record.request);
	}

	private async _currentAssignment(): Promise<WorkerCurrentAssignment | undefined> {
		const { records } = await this._assignments.store.listRecords();
		const current = records
			.filter((record) => record.executorId === this._executorId && record.current)
			.sort((a, b) => a.createdAtMs - b.createdAtMs || (a.assignmentId < b.assignmentId ? -1 : 1));
		if (current.length === 0) return undefined;
		const record = current[0];
		return {
			assignmentId: record.assignmentId,
			missionId: record.missionId,
			state: record.state,
			acceptedAtMs: record.acceptedAtMs,
			executionStartedAtMs: record.executionStartedAtMs,
			attemptId: record.consumedByAttemptId,
			executionId: record.consumedByExecutionId,
		};
	}

	private async _currentExecution(missionId: string): Promise<WorkerCurrentExecution | undefined> {
		const loaded = await this._missions.load(missionId);
		if (loaded.status !== "ok") return undefined;
		const record = loaded.record;
		return {
			missionId,
			missionState: record.state,
			currentAttemptId: record.currentAttemptId,
			currentExecutionId: record.currentExecutionId,
			waitReason: waitReasonFor(record),
		};
	}

	private _activityFor(
		assignment: WorkerCurrentAssignment | undefined,
		execution: WorkerCurrentExecution | undefined,
	): WorkerActivity {
		if (!assignment) return "IDLE";
		if (assignment.state === "ACCEPTED") return "CLAIMING";
		if (assignment.state === "EXECUTING") {
			if (execution && execution.missionState === "INTERRUPTED") return "INTERRUPTED";
			return "EXECUTING";
		}
		if (assignment.state === "COMPLETED" || assignment.state === "FAILED") return "TERMINAL";
		return "IDLE";
	}
}

// =============================================================================
// Worker list read model (cross-worker, durable-only)
// =============================================================================

export async function listWorkers(options: {
	executors: ExecutorControlService;
	assignments: AssignmentControlService;
	missions: DurableMissionStore;
}): Promise<{ entries: WorkerSummary[]; corrupt: { executorId: string; diagnostic: string }[] }> {
	const result = await options.executors.listExecutors();

	const { records: assignmentRecords } = await options.assignments.store.listRecords();
	const currentByExecutor = new Map<string, AssignmentRecord>();
	for (const record of assignmentRecords) {
		if (record.current) currentByExecutor.set(record.executorId, record);
	}

	const entries: WorkerSummary[] = [];
	for (const summary of result.entries) {
		const current = currentByExecutor.get(summary.executorId);
		let missionState: MissionState | undefined;
		if (current) {
			const loaded = await options.missions.load(current.missionId);
			if (loaded.status === "ok") missionState = loaded.record.state;
		}
		entries.push({
			executorId: summary.executorId,
			workerId: workerIdForExecutor(summary.executorId),
			workerInstanceId: summary.runtimeInstanceId,
			workerEpoch: summary.runtimeEpoch,
			hostname: summary.hostname,
			status: summary.status,
			lastHeartbeatAtMs: summary.lastHeartbeatAtMs,
			expiresAtMs: summary.expiresAtMs,
			currentAssignmentId: current?.assignmentId,
			currentAssignmentState: current?.state,
			currentMissionState: missionState,
		});
	}
	entries.sort((a, b) => (a.executorId < b.executorId ? -1 : a.executorId > b.executorId ? 1 : 0));

	return { entries, corrupt: result.corrupt };
}
