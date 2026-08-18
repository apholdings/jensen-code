/**
 * Durable Mission Coordinator (2.4.0, ownership 2.7.0).
 *
 * Composes the canonical mission lifecycle with a DurableMissionStore at the
 * mission execution boundary. The parent/domain layer never remembers to write
 * files; it talks to this coordinator, and the coordinator persists every
 * authoritative lifecycle transition before and after the executor runs.
 *
 * Execution ownership:
 *   - Resume is explicit and always allocates a NEW execution attempt.
 *   - Before any executor work begins, the coordinator atomically acquires a
 *     first-class execution lease with a monotonically increasing fencing
 *     token. Two processes racing to resume the same mission therefore have
 *     exactly one winner; the loser receives a structured MISSION_OWNED error.
 *   - Every execution-authoritative mutation carries lease proof
 *     (`leaseId` + `fencingToken`); the store rejects a fenced owner.
 *   - Terminal transition clears the lease atomically in the same write, so a
 *     completed mission can never be modified by its former owner.
 *
 * Design constraints:
 *   - The coordinator depends only on the injected `DurableMissionStore` port
 *     and a `MissionExecutor` seam — never on process/provider/CLI/UI code.
 *   - Opening/recovering the store NEVER auto-runs mission work.
 *   - Recovery revokes only expired (dead) leases; it never steals a live lease.
 */

import { randomUUID } from "node:crypto";
import {
	createDurableMissionRecord,
	type DurableExecutionAttempt,
	type DurableExecutionAttemptEndReason,
	type DurableMissionMutateResult,
	type DurableMissionRecord,
	type DurableMissionStore,
} from "./durable-store.js";
import {
	defaultHeartbeatScheduler,
	ExecutionAuthorityLostError,
	ExecutionHeartbeat,
	type HeartbeatAuthorityLossInfo,
	type HeartbeatScheduler,
	type HeartbeatTelemetry,
	type ResolvedHeartbeatTiming,
	resolveHeartbeatTiming,
} from "./execution-heartbeat.js";
import {
	DEFAULT_EXECUTION_LEASE_DURATION_MS,
	type ExecutionLease,
	type ExecutionLeaseProof,
	ExecutionOwnershipError,
	isExecutionLeaseActive,
	newExecutorOwnerId,
} from "./execution-lease.js";
import type {
	MissionExecutionEvent,
	MissionExecutionObserver,
	MissionExecutor,
	MissionLaunchOptions,
} from "./mission-executor.js";
import type { MissionHandle } from "./mission-handle.js";
import type { MissionRequest } from "./mission-request.js";
import { validateMissionRequest } from "./mission-request.js";
import { createMissionResult, type MissionResult } from "./mission-result.js";
import { assertMissionTransition, isTerminalMissionState, type MissionState } from "./mission-state.js";

export interface DurableMissionCoordinatorOptions {
	now?: () => number;
	/**
	 * Durable attempt identity factory. Defaults to a UUID-based id. It is
	 * coordinator-scoped and distinct from the executor's `executionId`.
	 */
	attemptIdFactory?: () => string;
	/**
	 * Executor owner identity. Defaults to a fresh host+UUID identity per
	 * coordinator instance (never PID-derived). Pass one stable value per
	 * executor/process lifetime for diagnostics.
	 */
	ownerId?: string;
	/** Execution lease lifetime. Defaults to a conservative 30 minutes. */
	leaseDurationMs?: number;
	/** Lease identity factory (tests). */
	leaseIdFactory?: () => string;
	/** Heartbeat renewal cadence override (defaults to leaseDurationMs / 3). */
	heartbeatIntervalMs?: number;
	/** Heartbeat safety margin override (defaults to leaseDurationMs / 6). */
	renewalSafetyMarginMs?: number;
	/** Injectable timer scheduler for deterministic heartbeat tests. */
	heartbeatScheduler?: HeartbeatScheduler;
	/** Assignment identity used for execution/Governance attribution. */
	assignmentId?: string;
	/** Observer for actual attempt/execution lifecycle events; recovery/polling is excluded. */
	executionObserver?: MissionExecutionObserver;
}

export interface DurableRecoveryReport {
	scanned: number;
	/** Missions transitioned to INTERRUPTED during this recovery. */
	reconciled: string[];
	/** Missions already INTERRUPTED (no additional action taken). */
	alreadyRecovered: string[];
	/** Terminal or CREATED missions left unchanged. */
	unchanged: string[];
	/** Corrupt records surfaced structurally (never silently dropped). */
	corrupt: { missionId: string; diagnostic: string }[];
	/** Human-readable recovery actions. */
	actions: string[];
}

const ACTIVE_NONTERMINAL_STATES: ReadonlySet<MissionState> = new Set<MissionState>([
	"QUEUED",
	"LAUNCHING",
	"RUNNING",
	"WAITING",
	"BLOCKED",
	"RETRYING",
]);

type AcquireOutcome =
	| { status: "not_resumable"; state: MissionState }
	| { status: "owned"; lease: ExecutionLease }
	| { status: "acquired"; lease: ExecutionLease; record: DurableMissionRecord };

type RenewOutcome =
	| { status: "lease_not_found" }
	| { status: "stale_owner"; lease: ExecutionLease }
	| { status: "lease_expired"; lease: ExecutionLease }
	| { status: "renewed"; lease: ExecutionLease; record: DurableMissionRecord };

type ReleaseOutcome =
	| { status: "lease_not_found" }
	| { status: "stale_owner"; lease: ExecutionLease }
	| { status: "released"; record: DurableMissionRecord };

type RevokeOutcome = { status: "unchanged" } | { status: "reconciled"; previousState: MissionState };

/** Local live execution retained for operator cancellation. */
interface ActiveExecution {
	cancelController: AbortController;
	handle?: MissionHandle;
}

/**
 * Map a terminal MissionResult's executor-level outcome to an attempt end
 * reason. `MissionExecutionOutcome` is a strict subset of
 * `DurableExecutionAttemptEndReason` (INTERRUPTED is never a terminal result).
 */
function attemptEndReason(result: MissionResult): DurableExecutionAttemptEndReason {
	return result.executionOutcome;
}

/** The authoritative lease acquired for one mission, plus the record after acquisition. */
export interface AcquiredExecutionOwnership {
	record: DurableMissionRecord;
	lease: ExecutionLease;
}

export class DurableMissionCoordinator {
	private readonly _store: DurableMissionStore;
	private readonly _executor: MissionExecutor;
	private readonly _now: () => number;
	private readonly _attemptIdFactory: () => string;
	private readonly _ownerId: string;
	private readonly _leaseDurationMs: number;
	private readonly _leaseIdFactory: () => string;
	private readonly _heartbeatTiming: ResolvedHeartbeatTiming;
	private readonly _heartbeatScheduler: HeartbeatScheduler;
	private readonly _executionObserver?: MissionExecutionObserver;
	private readonly _assignmentId?: string;
	private readonly _heartbeats = new Map<string, ExecutionHeartbeat>();
	private readonly _activeExecutions = new Map<string, ActiveExecution>();

	constructor(store: DurableMissionStore, executor: MissionExecutor, options: DurableMissionCoordinatorOptions = {}) {
		this._store = store;
		this._executor = executor;
		this._now = options.now ?? (() => Date.now());
		this._attemptIdFactory = options.attemptIdFactory ?? (() => `attempt_${randomUUID()}`);
		this._ownerId = options.ownerId ?? newExecutorOwnerId();
		this._leaseDurationMs = options.leaseDurationMs ?? DEFAULT_EXECUTION_LEASE_DURATION_MS;
		this._leaseIdFactory = options.leaseIdFactory ?? (() => `lease_${randomUUID()}`);
		this._heartbeatTiming = resolveHeartbeatTiming({
			leaseDurationMs: this._leaseDurationMs,
			heartbeatIntervalMs: options.heartbeatIntervalMs,
			renewalSafetyMarginMs: options.renewalSafetyMarginMs,
		});
		this._heartbeatScheduler = options.heartbeatScheduler ?? defaultHeartbeatScheduler;
		this._executionObserver = options.executionObserver;
		this._assignmentId = options.assignmentId;
	}

	/** The underlying persistence port (exposed for tests and load paths). */
	get store(): DurableMissionStore {
		return this._store;
	}

	get executor(): MissionExecutor {
		return this._executor;
	}

	/** Stable executor owner identity used for lease acquisition. */
	get ownerId(): string {
		return this._ownerId;
	}

	/**
	 * Latest heartbeat telemetry for a mission this coordinator executed. The
	 * heartbeat object (and thus its telemetry) survives stop so callers can
	 * inspect renewal/loss state after completion. Returns `undefined` before
	 * the coordinator has ever run the mission.
	 */
	heartbeatTelemetry(missionId: string): HeartbeatTelemetry | undefined {
		return this._heartbeats.get(missionId)?.telemetry();
	}

	/**
	 * Request cancellation of a locally-active execution. This aborts the same
	 * combined signal the executor received, so the normal fenced terminal path
	 * persists CANCELLED. It never signals a remote/other-process owner and
	 * never bypasses fencing.
	 */
	async requestCancellation(
		missionId: string,
		reason?: string,
	): Promise<{ status: "cancel_requested" | "not_running"; missionId: string }> {
		const active = this._activeExecutions.get(missionId);
		if (!active) return { status: "not_running", missionId };
		active.cancelController.abort(reason ?? "mission cancelled by operator");
		return { status: "cancel_requested", missionId };
	}

	// =========================================================================
	// Create (durable, does NOT execute)
	// =========================================================================

	/**
	 * Persist a mission at CREATED state. Does not launch anything.
	 *
	 * Re-creating the same missionId with an identical immutable request is
	 * idempotent; re-creating with a different request is rejected structurally
	 * (history is never silently overwritten).
	 */
	async createMission(request: MissionRequest): Promise<DurableMissionRecord> {
		const validation = validateMissionRequest(request);
		if (!validation.valid) {
			throw new Error(`Invalid MissionRequest: ${validation.errors.join(", ")}`);
		}
		const record = createDurableMissionRecord({ request, now: this._now() });
		const result = await this._store.create(record);
		if (result.status === "created") return record;
		if (result.status === "idempotent") return result.record;
		throw new Error(`Mission ${request.missionId} already exists with a conflicting request: ${result.error}`);
	}

	// =========================================================================
	// Read
	// =========================================================================

	/** Load a mission, or `undefined` when missing. Corrupt records throw. */
	async getMission(missionId: string): Promise<DurableMissionRecord | undefined> {
		const loaded = await this._store.load(missionId);
		if (loaded.status === "ok") return loaded.record;
		if (loaded.status === "missing") return undefined;
		throw new Error(`Mission ${missionId} is corrupt: ${loaded.diagnostic}`);
	}

	async listMissions(): Promise<string[]> {
		return this._store.listMissions();
	}

	async listNonterminalMissions(): Promise<string[]> {
		return this._store.listNonterminalMissions();
	}

	async listChildren(parentMissionId: string): Promise<string[]> {
		return this._store.listChildren(parentMissionId);
	}

	// =========================================================================
	// Execution ownership (acquire / renew / release)
	// =========================================================================

	/**
	 * Atomically acquire execution ownership for a CREATED or INTERRUPTED
	 * mission. Transitions the mission to QUEUED and persists a new execution
	 * lease with a strictly greater fencing token. Exactly one of any set of
	 * racing cross-process callers wins; losers get structured errors.
	 *
	 * Does NOT invoke the executor.
	 */
	async acquireOwnership(missionId: string): Promise<AcquiredExecutionOwnership> {
		const now = this._now();
		const leaseId = this._leaseIdFactory();

		const result = await this._store.mutate<AcquireOutcome>(missionId, (current) => {
			if (isTerminalMissionState(current.state)) {
				return { kind: "noop", value: { status: "not_resumable" as const, state: current.state } };
			}
			// A live owner exists regardless of which active non-terminal state it
			// has reached. This is the authoritative "owned" signal.
			if (current.lease && isExecutionLeaseActive(current.lease, now)) {
				return { kind: "noop", value: { status: "owned" as const, lease: current.lease } };
			}
			if (current.state !== "CREATED" && current.state !== "INTERRUPTED") {
				return { kind: "noop", value: { status: "not_resumable" as const, state: current.state } };
			}

			const fencingToken = current.fencingToken + 1;
			const lease: ExecutionLease = {
				ownerId: this._ownerId,
				leaseId,
				fencingToken,
				acquiredAtMs: now,
				renewedAtMs: now,
				expiresAtMs: now + this._leaseDurationMs,
			};
			const next: DurableMissionRecord = {
				...this._withTransition(current, "QUEUED", {
					reason: current.state === "INTERRUPTED" ? "explicit resume (new execution attempt)" : "initial launch",
					atMs: now,
				}),
				fencingToken,
				lease,
			};
			return { kind: "write", next, value: { status: "acquired" as const, lease, record: next } };
		});

		if (result.status === "missing") throw new Error(`Mission not found: ${missionId}`);
		if (result.status === "corrupt") throw new Error(`Mission ${missionId} is corrupt: ${result.diagnostic}`);

		const value = result.value;
		if (value.status === "acquired") return { record: value.record, lease: value.lease };
		if (value.status === "owned") {
			throw new ExecutionOwnershipError(
				"MISSION_OWNED",
				`Mission ${missionId} already has an active execution owner`,
				{
					missionId,
					ownerId: value.lease.ownerId,
					leaseId: value.lease.leaseId,
					fencingToken: value.lease.fencingToken,
				},
			);
		}
		if (isTerminalMissionState(value.state)) {
			throw new ExecutionOwnershipError(
				"MISSION_TERMINAL",
				`Cannot resume terminal mission ${missionId} (${value.state})`,
				{ missionId, state: value.state },
			);
		}
		throw new ExecutionOwnershipError(
			"MISSION_NOT_RESUMABLE",
			`Cannot resume mission ${missionId} from state ${value.state}; reconcile (recover) first`,
			{ missionId, state: value.state },
		);
	}

	/**
	 * Renew a live lease. Requires current lease proof and does NOT change the
	 * fencing token (renewal is a heartbeat, not a takeover).
	 */
	async renewOwnership(
		missionId: string,
		proof: ExecutionLeaseProof,
		options: { now?: number } = {},
	): Promise<{ lease: ExecutionLease; record: DurableMissionRecord }> {
		const now = options.now ?? this._now();

		const result = await this._store.mutate<RenewOutcome>(missionId, (current) => {
			const lease = current.lease;
			if (!lease) return { kind: "noop", value: { status: "lease_not_found" as const } };
			if (lease.leaseId !== proof.leaseId || lease.fencingToken !== proof.fencingToken) {
				return { kind: "noop", value: { status: "stale_owner" as const, lease } };
			}
			if (!isExecutionLeaseActive(lease, now)) {
				return { kind: "noop", value: { status: "lease_expired" as const, lease } };
			}
			const renewed: ExecutionLease = { ...lease, renewedAtMs: now, expiresAtMs: now + this._leaseDurationMs };
			const next: DurableMissionRecord = {
				...current,
				lease: renewed,
				updatedAtMs: now,
				revision: current.revision + 1,
			};
			return { kind: "write", next, value: { status: "renewed" as const, lease: renewed, record: next } };
		});

		return this._mapRenewResult(missionId, result);
	}

	/**
	 * Release a live lease without reaching a terminal state. This is a clean
	 * non-terminal stop: any active non-terminal state moves to INTERRUPTED
	 * (recoverable) and ownership is cleared atomically. Terminal completion
	 * should instead clear the lease as part of the terminal write.
	 */
	async releaseOwnership(
		missionId: string,
		proof: ExecutionLeaseProof,
		options: { now?: number } = {},
	): Promise<DurableMissionRecord> {
		const now = options.now ?? this._now();

		const result = await this._store.mutate<ReleaseOutcome>(missionId, (current) => {
			const lease = current.lease;
			if (!lease) return { kind: "noop", value: { status: "lease_not_found" as const } };
			if (lease.leaseId !== proof.leaseId || lease.fencingToken !== proof.fencingToken) {
				return { kind: "noop", value: { status: "stale_owner" as const, lease } };
			}

			let next: DurableMissionRecord;
			if (isTerminalMissionState(current.state) || current.state === "CREATED" || current.state === "INTERRUPTED") {
				next = { ...current, lease: undefined, updatedAtMs: now, revision: current.revision + 1 };
			} else {
				next = this._withTransition(current, "INTERRUPTED", {
					reason: "owner released without terminal result",
					atMs: now,
				});
				next = { ...next, lease: undefined, currentAttemptId: undefined, currentExecutionId: undefined };
			}
			return { kind: "write", next, value: { status: "released" as const, record: next } };
		});

		if (result.status === "missing")
			throw new ExecutionOwnershipError("LEASE_NOT_FOUND", `Mission ${missionId} not found`);
		if (result.status === "corrupt") throw new Error(`Mission ${missionId} is corrupt: ${result.diagnostic}`);
		const value = result.value;
		if (value.status === "released") return value.record;
		if (value.status === "lease_not_found") {
			throw new ExecutionOwnershipError("LEASE_NOT_FOUND", `Mission ${missionId} has no execution lease`);
		}
		throw new ExecutionOwnershipError(
			"STALE_EXECUTION_OWNER",
			`Mission ${missionId} lease no longer belongs to this owner`,
			{ missionId, leaseId: value.lease.leaseId, fencingToken: value.lease.fencingToken },
		);
	}

	// =========================================================================
	// Restart reconciliation (no auto re-execution)
	// =========================================================================

	/**
	 * Inspect every persisted non-terminal mission and reconcile lost executor
	 * ownership. Persisted active states (QUEUED/RUNNING/WAITING/BLOCKED/
	 * RETRYING) are never blindly trusted across a restart: when they have no
	 * live lease they transition to INTERRUPTED with a recovery reason. A live
	 * (non-expired) lease is never stolen. Terminal missions stay terminal;
	 * CREATED missions stay CREATED; already-interrupted missions are left
	 * alone. Nothing is executed.
	 */
	async recover(options: { now?: number } = {}): Promise<DurableRecoveryReport> {
		const now = options.now ?? this._now();
		const ids = await this._store.listMissions();
		const report: DurableRecoveryReport = {
			scanned: ids.length,
			reconciled: [],
			alreadyRecovered: [],
			unchanged: [],
			corrupt: [],
			actions: [],
		};

		for (const id of ids) {
			const loaded = await this._store.load(id);
			if (loaded.status === "corrupt") {
				report.corrupt.push({ missionId: id, diagnostic: loaded.diagnostic });
				report.actions.push(`mission '${id}' is corrupt; surfaced, not recovered`);
				continue;
			}
			if (loaded.status === "missing") continue;

			const record = loaded.record;
			if (isTerminalMissionState(record.state) || record.state === "CREATED") {
				report.unchanged.push(id);
				report.actions.push(`mission '${id}' left at ${record.state}`);
				continue;
			}
			if (record.state === "INTERRUPTED") {
				report.alreadyRecovered.push(id);
				report.actions.push(`mission '${id}' already INTERRUPTED`);
				continue;
			}

			// Guard: only active nonterminal states may be reconciled here.
			if (!ACTIVE_NONTERMINAL_STATES.has(record.state)) {
				report.unchanged.push(id);
				report.actions.push(`mission '${id}' left at ${record.state}`);
				continue;
			}

			// A live owner must not be stolen by ordinary recovery.
			if (record.lease && isExecutionLeaseActive(record.lease, now)) {
				report.unchanged.push(id);
				report.actions.push(`mission '${id}' has a live lease (owner ${record.lease.ownerId}); left unchanged`);
				continue;
			}

			// Honest per-state recovery reason. QUEUED has no attempt and no
			// ownership (launch was never initiated); LAUNCHING has a durable
			// attempt but ownership was never confirmed; RUNNING/WAITING/BLOCKED/
			// RETRYING lost confirmed ownership.
			const reason =
				record.state === "LAUNCHING"
					? "control_plane_restart: launch initiated but runtime ownership never confirmed"
					: record.state === "QUEUED"
						? "control_plane_restart: queued but never launched"
						: "control_plane_restart: executor ownership lost";

			const revoked = await this._revokeInterrupted(id, now, reason);
			if (revoked.status === "reconciled") {
				report.reconciled.push(id);
				report.actions.push(`mission '${id}' reconciled ${revoked.previousState} → INTERRUPTED`);
			} else if (revoked.status === "corrupt") {
				report.corrupt.push({ missionId: id, diagnostic: revoked.diagnostic });
				report.actions.push(`mission '${id}' became corrupt during recovery; surfaced, not recovered`);
			} else {
				report.unchanged.push(id);
				report.actions.push(`mission '${id}' left unchanged after atomic re-check`);
			}
		}

		return report;
	}

	/**
	 * Interrupt a stale worker's still-live execution ownership. Unlike
	 * `recover()` (which only revokes EXPIRED leases), this closes the crash
	 * window where a prior worker process died but its execution lease has not
	 * yet expired. The caller must prove the stale owner identity (for example,
	 * via a persisted assignment's `executionOwnerIdentity.ownerId`).
	 *
	 * Exactly like recovery, this NEVER auto-runs work and NEVER fabricates a
	 * terminal result: it moves an active non-terminal mission to INTERRUPTED
	 * (recoverable) and clears the lease for a future explicit resume.
	 */
	async interruptStaleExecution(
		missionId: string,
		options: { staleOwnerId: string; reason?: string; now?: number },
	): Promise<{ status: "reconciled" | "unchanged" | "missing"; previousState?: MissionState }> {
		const now = options.now ?? this._now();
		const reason = options.reason ?? "worker restart: prior execution owner is stale";

		const result = await this._store.mutate<{
			status: "reconciled" | "unchanged";
			previousState: MissionState;
		}>(missionId, (current) => {
			if (isTerminalMissionState(current.state) || current.state === "CREATED" || current.state === "INTERRUPTED") {
				return { kind: "noop", value: { status: "unchanged" as const, previousState: current.state } };
			}
			if (!ACTIVE_NONTERMINAL_STATES.has(current.state)) {
				return { kind: "noop", value: { status: "unchanged" as const, previousState: current.state } };
			}
			// Only revoke when the current lease belongs to the proven-stale owner.
			if (!current.lease || current.lease.ownerId !== options.staleOwnerId) {
				return { kind: "noop", value: { status: "unchanged" as const, previousState: current.state } };
			}

			const previousState = current.state;
			const fencingToken = current.fencingToken + 1;
			let next = this._withTransition(current, "INTERRUPTED", { reason, atMs: now });

			const attempts = [...current.attempts];
			if (current.currentAttemptId) {
				const index = attempts.findIndex((a) => a.attemptId === current.currentAttemptId);
				if (index >= 0) {
					attempts[index] = {
						...attempts[index],
						endReason: "INTERRUPTED",
						recovery: { reason, recoveredAtMs: now },
					};
				}
			}
			next = {
				...next,
				fencingToken,
				lease: undefined,
				currentAttemptId: undefined,
				currentExecutionId: undefined,
				attempts,
			};
			return { kind: "write", next, value: { status: "reconciled" as const, previousState } };
		});

		if (result.status === "missing") return { status: "missing" };
		if (result.status === "corrupt") throw new Error(`Mission ${missionId} is corrupt: ${result.diagnostic}`);
		return result.value;
	}

	// =========================================================================
	// Explicit resume (new execution attempt)
	// =========================================================================

	/**
	 * Explicitly start a mission (or restart a recovered one) to terminal state.
	 *
	 * The logical mission identity (`missionId`, `parentMissionId`, `depth`,
	 * immutable `request`, and lifecycle history) is preserved, but the executor
	 * allocates a NEW `executionId` for the attempt. The previous attempt remains
	 * in `attempts` for auditability and is never overwritten.
	 */
	async resume(missionId: string, options: MissionLaunchOptions = {}): Promise<DurableMissionRecord> {
		const { record: queued, lease } = await this.acquireOwnership(missionId);
		const proof: ExecutionLeaseProof = { leaseId: lease.leaseId, fencingToken: lease.fencingToken };
		const attemptNumber = queued.attempts.length + 1;
		let record = queued;

		// Combine the caller's cancellation signal with the authority-loss signal
		// produced by the heartbeat and the operator-cancellation signal produced
		// by `requestCancellation`. All three abort the executor through the same
		// AbortSignal path, but authority loss keeps a distinct diagnostic reason.
		const authorityLost = new AbortController();
		const cancelController = new AbortController();
		const combinedSignals = [cancelController.signal, authorityLost.signal];
		if (options.signal) combinedSignals.push(options.signal);
		const signal = AbortSignal.any(combinedSignals);
		let authorityLostInfo: HeartbeatAuthorityLossInfo | undefined;

		const heartbeat = this._buildHeartbeat(missionId, proof, (info) => {
			authorityLostInfo = info;
			authorityLost.abort(info);
		});
		this._heartbeats.set(missionId, heartbeat);

		const activeExecution: ActiveExecution = { cancelController };
		this._activeExecutions.set(missionId, activeExecution);

		let handle: MissionHandle | undefined;
		let completed = false;

		try {
			// Allocate the durable attempt identity and persist LAUNCHING BEFORE
			// invoking the executor. If Jensen crashes immediately after the executor
			// actually launches but before RUNNING is persisted, the attempt intent
			// survives durably and restart reconciliation marks it interrupted.
			const attemptId = this._attemptIdFactory();
			const launchAtMs = this._now();
			const correlation = {
				missionId: record.missionId,
				assignmentId: this._assignmentId ?? record.missionId,
				attemptId,
				sessionId: record.request.childSessionId,
			};
			this._emitExecutionEvent({
				type: "attempt_started",
				eventId: `${record.missionId}:${attemptId}:attempt_started`,
				atMs: launchAtMs,
				correlation,
			});
			if (attemptNumber > 1) {
				this._emitExecutionEvent({
					type: "execution_retry",
					eventId: `${record.missionId}:${attemptId}:execution_retry:${attemptNumber - 1}`,
					atMs: launchAtMs,
					retryClass: "execution",
					retryIndex: attemptNumber - 1,
					reason: "explicit resume after prior execution attempt",
					correlation,
				});
			}
			this._emitExecutionEvent({
				type: "execution_launch_started",
				eventId: `${record.missionId}:${attemptId}:execution_launch_started`,
				atMs: launchAtMs,
				correlation,
			});
			let next = this._withTransition(record, "LAUNCHING", {
				reason: "launch initiated",
				attemptId,
				atMs: launchAtMs,
			});
			next = {
				...next,
				currentAttemptId: attemptId,
				startedAtMs: record.startedAtMs ?? launchAtMs,
				attempts: [...record.attempts, { attemptId, startedAtMs: launchAtMs }],
			};
			record = await this._commitFenced(record, next, lease);

			const executor = this._executor;
			try {
				handle = await executor.launch(record.request, {
					signal,
					attemptId,
					attemptNumber,
					assignmentId: this._assignmentId ?? record.missionId,
					sessionId: record.request.childSessionId,
					fencing: { leaseId: lease.leaseId, fencingToken: lease.fencingToken },
				});
				activeExecution.handle = handle;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this._emitExecutionEvent({
					type: "execution_failed",
					eventId: `${record.missionId}:${attemptId}:execution_failed`,
					atMs: this._now(),
					correlation,
					state: "FAILED",
					executionOutcome: "CRASHED",
				});
				const failed = await this._commitFenced(
					record,
					this._failLaunch(record, attemptId, message, launchAtMs),
					lease,
				);
				completed = true;
				return failed;
			}

			const executionId = handle.executionId;
			this._emitExecutionEvent({
				type: "execution_started",
				eventId: `${record.missionId}:${attemptId}:${executionId}:execution_started`,
				atMs: this._now(),
				correlation: { ...correlation, executionId },
			});
			next = this._withTransition(record, "RUNNING", {
				reason: "executor launched",
				executionId,
			});
			const launchAttemptIndex = next.attempts.length - 1;
			next = {
				...next,
				currentAttemptId: attemptId,
				currentExecutionId: executionId,
				startedAtMs: record.startedAtMs ?? launchAtMs,
				attempts: next.attempts.map((a, i) => (i === launchAttemptIndex ? { ...a, executionId } : a)),
			};
			record = await this._commitFenced(record, next, lease);

			// Heartbeat starts only after RUNNING ownership is durably confirmed,
			// so an execution that never actually launched is never renewed.
			heartbeat.start(lease.expiresAtMs);

			const result = await executor.awaitResult(handle, { signal });

			// If the heartbeat proved authority was lost while we awaited the
			// result, never write a terminal record: the fence (or the lease
			// expiry + recovery path) remains the authority.
			if (authorityLostInfo) {
				this._emitExecutionEvent({
					type: "execution_failed",
					eventId: `${record.missionId}:${attemptId}:${executionId}:execution_failed`,
					atMs: this._now(),
					correlation: { ...correlation, executionId },
					state: "FAILED",
					executionOutcome: "CRASHED",
				});
				throw new ExecutionAuthorityLostError(authorityLostInfo);
			}

			next = this._withTransition(record, result.state, {
				reason: "executor result",
				executionId,
			});
			const attemptIndex = next.attempts.length - 1;
			const completedAttempt: DurableExecutionAttempt = {
				...next.attempts[attemptIndex],
				executionId,
				finishedAtMs: result.finishedAtMs,
				endReason: attemptEndReason(result),
			};
			next = {
				...next,
				result,
				resultExecutionId: executionId,
				finishedAtMs: result.finishedAtMs,
				currentAttemptId: undefined,
				currentExecutionId: undefined,
				lease: undefined,
				attempts: [...next.attempts.slice(0, attemptIndex), completedAttempt],
			};

			const terminal = await this._commitFenced(record, next, lease);
			this._emitExecutionEvent({
				type:
					result.state === "CANCELLED"
						? "execution_cancelled"
						: result.state === "FAILED" || result.state === "CRASHED" || result.state === "TIMED_OUT"
							? "execution_failed"
							: "execution_completed",
				eventId: `${record.missionId}:${attemptId}:${executionId}:terminal`,
				atMs: result.finishedAtMs,
				correlation: { ...correlation, executionId },
				state: result.state,
				executionOutcome: result.executionOutcome,
			});
			completed = true;
			return terminal;
		} finally {
			heartbeat.stop();
			this._activeExecutions.delete(missionId);
			if (!completed && handle) {
				// Abnormal exit (authority lost, commit failure, or executor
				// error): do not leave the child process running.
				try {
					await handle.cancel("execution aborted");
				} catch {
					// Best-effort: never mask the original failure.
				}
			}
		}
	}

	/**
	 * Build a terminal FAILED record for an executor that rejected `launch`.
	 * No execution id was ever established, so `resultExecutionId` stays unset;
	 * the attempt remains auditable with `endReason: CRASHED`. The lease is
	 * cleared atomically with the terminal transition.
	 */
	private _failLaunch(
		record: DurableMissionRecord,
		attemptId: string,
		message: string,
		atMs: number,
	): DurableMissionRecord {
		let next = this._withTransition(record, "FAILED", {
			reason: "executor rejected launch",
			attemptId,
			atMs,
		});
		const index = next.attempts.length - 1;
		const failedAttempt: DurableExecutionAttempt = {
			...next.attempts[index],
			finishedAtMs: atMs,
			endReason: "CRASHED",
		};
		next = {
			...next,
			result: createMissionResult({
				missionId: next.missionId,
				parentMissionId: next.parentMissionId,
				depth: next.depth,
				state: "FAILED",
				executionOutcome: "CRASHED",
				verification: { status: "unverified" },
				completionDecision: "unavailable",
				failures: [{ category: "LAUNCH", message }],
				executorDiagnostics: { executorId: this._executor.executorId, launchError: message },
				startedAtMs: next.startedAtMs ?? atMs,
				finishedAtMs: atMs,
			}),
			finishedAtMs: atMs,
			currentAttemptId: undefined,
			currentExecutionId: undefined,
			lease: undefined,
			attempts: [...next.attempts.slice(0, index), failedAttempt],
		};
		return next;
	}

	// =========================================================================
	// Internals
	// =========================================================================

	private _emitExecutionEvent(event: MissionExecutionEvent): void {
		try {
			this._executionObserver?.onEvent(event);
		} catch {
			// Observers are telemetry only and never alter execution authority.
		}
	}

	private _buildHeartbeat(
		missionId: string,
		proof: ExecutionLeaseProof,
		onAuthorityLost: (info: HeartbeatAuthorityLossInfo) => void,
	): ExecutionHeartbeat {
		return new ExecutionHeartbeat({
			missionId,
			leaseId: proof.leaseId,
			fencingToken: proof.fencingToken,
			timing: this._heartbeatTiming,
			now: this._now,
			schedule: this._heartbeatScheduler,
			renew: async (now) => {
				const renewed = await this.renewOwnership(missionId, proof, { now });
				return { expiresAtMs: renewed.lease.expiresAtMs };
			},
			onAuthorityLost,
		});
	}

	private _withTransition(
		record: DurableMissionRecord,
		to: MissionState,
		meta: { reason?: string; executionId?: string; attemptId?: string; atMs?: number },
	): DurableMissionRecord {
		const assertion = assertMissionTransition(record.state, to);
		if (!assertion.ok) {
			throw new Error(`Illegal mission transition for ${record.missionId}: ${assertion.error}`);
		}
		const from = record.state;
		const atMs = meta.atMs ?? this._now();
		const seq = record.transitions.length === 0 ? 0 : record.transitions[record.transitions.length - 1].seq + 1;
		return {
			...record,
			state: to,
			transitions: [
				...record.transitions,
				{ seq, from, to, atMs, reason: meta.reason, executionId: meta.executionId, attemptId: meta.attemptId },
			],
			updatedAtMs: atMs,
			revision: record.revision + 1,
		};
	}

	/**
	 * Persist an execution-authoritative transition under the current fence.
	 *
	 * This is an atomic store mutation, NOT an optimistic `save` against a
	 * coordinator-held snapshot. Heartbeat renewals legitimately advance the
	 * ordinary `revision` while the execution is running, so a snapshot-based
	 * `expectedRevision` would reject a valid terminal commit. The fencing token
	 * (leaseId + fencingToken) is the authority here; `revision` is rebased onto
	 * the current record so it remains a monotonic history counter.
	 */
	private async _commitFenced(
		previous: DurableMissionRecord,
		next: DurableMissionRecord,
		proof: ExecutionLeaseProof,
	): Promise<DurableMissionRecord> {
		type CommitOutcome =
			| { status: "committed"; record: DurableMissionRecord }
			| { status: "lease_not_found" }
			| { status: "stale_owner"; leaseId: string; fencingToken: number };

		const result = await this._store.mutate<CommitOutcome>(previous.missionId, (current) => {
			const lease = current.lease;
			if (!lease) return { kind: "noop", value: { status: "lease_not_found" as const } };
			if (lease.leaseId !== proof.leaseId || lease.fencingToken !== proof.fencingToken) {
				return {
					kind: "noop",
					value: { status: "stale_owner" as const, leaseId: lease.leaseId, fencingToken: lease.fencingToken },
				};
			}
			const committed: DurableMissionRecord = {
				...next,
				revision: current.revision + 1,
			};
			return { kind: "write", next: committed, value: { status: "committed" as const, record: committed } };
		});

		if (result.status === "missing") {
			throw new ExecutionOwnershipError("LEASE_NOT_FOUND", `Mission ${next.missionId} not found`);
		}
		if (result.status === "corrupt") {
			throw new Error(`Mission ${next.missionId} is corrupt: ${result.diagnostic}`);
		}
		const value = result.value;
		if (value.status === "committed") return value.record;
		if (value.status === "lease_not_found") {
			throw new ExecutionOwnershipError("LEASE_NOT_FOUND", `Mission ${next.missionId} has no execution lease`);
		}
		throw new ExecutionOwnershipError(
			"STALE_EXECUTION_OWNER",
			`Stale execution owner for mission ${next.missionId}: lease no longer authoritative`,
			{ missionId: next.missionId, leaseId: value.leaseId, fencingToken: value.fencingToken },
		);
	}

	private _mapRenewResult(
		missionId: string,
		result: DurableMissionMutateResult<RenewOutcome>,
	): { lease: ExecutionLease; record: DurableMissionRecord } {
		if (result.status === "missing") {
			throw new ExecutionOwnershipError("LEASE_NOT_FOUND", `Mission ${missionId} not found`);
		}
		if (result.status === "corrupt") {
			throw new Error(`Mission ${missionId} is corrupt: ${result.diagnostic}`);
		}
		const value = result.value;
		if (value.status === "renewed") return { lease: value.lease, record: value.record };
		if (value.status === "lease_not_found") {
			throw new ExecutionOwnershipError("LEASE_NOT_FOUND", `Mission ${missionId} has no execution lease`);
		}
		if (value.status === "stale_owner") {
			throw new ExecutionOwnershipError(
				"STALE_EXECUTION_OWNER",
				`Mission ${missionId} lease no longer belongs to this owner`,
				{ missionId, leaseId: value.lease.leaseId, fencingToken: value.lease.fencingToken },
			);
		}
		throw new ExecutionOwnershipError("LEASE_EXPIRED", `Execution lease for mission ${missionId} has expired`, {
			missionId,
			leaseId: value.lease.leaseId,
			fencingToken: value.lease.fencingToken,
			expiresAtMs: value.lease.expiresAtMs,
		});
	}

	private async _revokeInterrupted(
		missionId: string,
		now: number,
		reason: string,
	): Promise<
		| { status: "reconciled"; previousState: MissionState }
		| { status: "unchanged" }
		| { status: "corrupt"; diagnostic: string }
	> {
		const result = await this._store.mutate<RevokeOutcome>(missionId, (current) => {
			if (isTerminalMissionState(current.state) || current.state === "CREATED" || current.state === "INTERRUPTED") {
				return { kind: "noop", value: { status: "unchanged" as const } };
			}
			if (!ACTIVE_NONTERMINAL_STATES.has(current.state)) {
				return { kind: "noop", value: { status: "unchanged" as const } };
			}
			if (current.lease && isExecutionLeaseActive(current.lease, now)) {
				return { kind: "noop", value: { status: "unchanged" as const } };
			}

			const previousState = current.state;
			// Revoking an expired lease fenced the dead owner: bump the epoch so a
			// late wake-up with the old fence can never write again.
			const fencingToken = current.lease ? current.fencingToken + 1 : current.fencingToken;
			let next = this._withTransition(current, "INTERRUPTED", { reason, atMs: now });

			const attempts = [...current.attempts];
			if (current.currentAttemptId) {
				const index = attempts.findIndex((a) => a.attemptId === current.currentAttemptId);
				if (index >= 0) {
					attempts[index] = {
						...attempts[index],
						endReason: "INTERRUPTED",
						recovery: { reason, recoveredAtMs: now },
					};
				}
			}
			next = {
				...next,
				fencingToken,
				lease: undefined,
				currentAttemptId: undefined,
				currentExecutionId: undefined,
				attempts,
			};
			return { kind: "write", next, value: { status: "reconciled" as const, previousState } };
		});

		if (result.status === "missing") return { status: "unchanged" };
		if (result.status === "corrupt") return { status: "corrupt", diagnostic: result.diagnostic };
		return result.value;
	}
}
