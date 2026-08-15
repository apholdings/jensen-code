/**
 * Durable Delegation (2.5.0).
 *
 * Production orchestration seam that turns a delegated child into a durable
 * first-class mission BEFORE external execution begins. This module composes
 * the canonical mission domain (DurableMissionCoordinator + MissionExecutor)
 * with a shared DurableMissionStore; it does not import process, provider,
 * CLI, or UI machinery — the execution mechanism arrives behind the
 * MissionExecutor seam.
 *
 * Invariants:
 *   - A child mission exists durably at CREATED before any executor.launch.
 *   - The coordinator owns every authoritative lifecycle transition
 *     (CREATED → QUEUED → LAUNCHING + attemptId → RUNNING + executionId →
 *     terminal); the caller never drives the executor directly.
 *   - Parent identity is structured (`missionId` + `depth`), never PID-derived.
 *   - Recovery (restart reconciliation) never auto-runs child work; it is a
 *     read-only store pass that marks lost ownership INTERRUPTED.
 */

import {
	DurableMissionCoordinator,
	type DurableMissionCoordinatorOptions,
	type DurableRecoveryReport,
} from "../mission-domain/durable-coordinator.js";
import type { DurableMissionRecord, DurableMissionStore } from "../mission-domain/durable-store.js";
import type { HeartbeatScheduler, HeartbeatTelemetry } from "../mission-domain/execution-heartbeat.js";
import {
	type ExecutionLease,
	type ExecutionLeaseProof,
	newExecutorOwnerId,
} from "../mission-domain/execution-lease.js";
import type { MissionExecutor } from "../mission-domain/mission-executor.js";
import { createMissionRequest, type MissionRequest } from "../mission-domain/mission-request.js";
import type { MissionResult } from "../mission-domain/mission-result.js";

/** Structured parent mission identity (never PID-derived). */
export interface DelegationParentIdentity {
	missionId: string;
	depth: number;
}

/** The durable + canonical outcome of one delegated child. */
export interface DurableDelegationChildOutcome {
	missionId: string;
	parentMissionId?: string;
	depth: number;
	/** Terminal durable record (authoritative lifecycle history). */
	record: DurableMissionRecord;
	/** Canonical terminal result (the parent consumes this, not prose). */
	result: MissionResult;
	/** Durable attempt identity allocated before launch. */
	attemptId: string;
	/** Executor execution identity attached after launch (when launch succeeded). */
	executionId?: string;
	/** Fencing epoch of the winning execution (ownership authority epoch). */
	fencingToken: number;
	/** Latest heartbeat telemetry for this execution (observability). */
	heartbeatTelemetry?: HeartbeatTelemetry;
}

export interface DurableMissionDelegatorOptions {
	store: DurableMissionStore;
	/** Now override for deterministic construction (tests). */
	now?: () => number;
	/** Attempt identity factory (tests). */
	attemptIdFactory?: () => string;
	/** Executor owner identity (defaults to a fresh host+UUID identity). */
	ownerId?: string;
	/** Execution lease lifetime override. */
	leaseDurationMs?: number;
	/** Lease identity factory (tests). */
	leaseIdFactory?: () => string;
	/** Heartbeat renewal cadence override (defaults to leaseDurationMs / 3). */
	heartbeatIntervalMs?: number;
	/** Heartbeat safety margin override (defaults to leaseDurationMs / 6). */
	renewalSafetyMarginMs?: number;
	/** Injectable timer scheduler for deterministic heartbeat tests. */
	heartbeatScheduler?: HeartbeatScheduler;
}

/**
 * Deterministic, session-scoped, non-PID identity for the transitional
 * root-delegation anchor used when no active first-class/reliability mission
 * exists. It is a safe path component and never derived from process state.
 */
export function rootDelegationMissionId(sessionId: string): string {
	return `delegation-root-${sessionId}`;
}

/**
 * Resolve the delegation parent identity from the active reliability mission
 * id when present; otherwise fall back to the deterministic session-scoped
 * root-delegation anchor. Depth is always 0 for the root parent.
 */
export function parentIdentityFor(activeMissionId: string | undefined, sessionId: string): DelegationParentIdentity {
	return { missionId: activeMissionId ?? rootDelegationMissionId(sessionId), depth: 0 };
}

/** Executor used only for read/recovery passes that never launch work. */
const NOOP_EXECUTOR: MissionExecutor = {
	executorId: "noop",
	async launch(): Promise<never> {
		throw new Error("noop executor cannot launch");
	},
	async awaitResult(): Promise<never> {
		throw new Error("noop executor cannot await");
	},
	async cancel(): Promise<void> {},
};

export class DurableMissionDelegator {
	private readonly _store: DurableMissionStore;
	private readonly _coordinatorOptions: DurableMissionCoordinatorOptions;
	private readonly _ownerId: string;

	constructor(options: DurableMissionDelegatorOptions) {
		this._store = options.store;
		this._ownerId = options.ownerId ?? newExecutorOwnerId();
		this._coordinatorOptions = {
			now: options.now,
			attemptIdFactory: options.attemptIdFactory,
			ownerId: this._ownerId,
			leaseDurationMs: options.leaseDurationMs,
			leaseIdFactory: options.leaseIdFactory,
			heartbeatIntervalMs: options.heartbeatIntervalMs,
			renewalSafetyMarginMs: options.renewalSafetyMarginMs,
			heartbeatScheduler: options.heartbeatScheduler,
		};
	}

	/** The underlying persistence port (tests/load paths). */
	get store(): DurableMissionStore {
		return this._store;
	}

	/** Stable executor owner identity used for lease acquisition. */
	get ownerId(): string {
		return this._ownerId;
	}

	/** Build a coordinator bound to one child's execution mechanism. */
	private coordinator(executor: MissionExecutor): DurableMissionCoordinator {
		return new DurableMissionCoordinator(this._store, executor, this._coordinatorOptions);
	}

	/**
	 * Ensure the transitional root-delegation anchor exists durably at CREATED.
	 * Idempotent across calls (the request is fully deterministic so a re-create
	 * with the same identity is recognized, never a conflict).
	 */
	async ensureRootDelegationMission(sessionId: string): Promise<DelegationParentIdentity> {
		const missionId = rootDelegationMissionId(sessionId);
		const request = createMissionRequest({
			missionId,
			objective: "Root delegation anchor for this session",
			agent: "root-delegation",
			executionMode: "execute",
			acceptanceCriteria: [],
			now: 0,
		});
		await this.coordinator(NOOP_EXECUTOR).createMission(request);
		return { missionId, depth: 0 };
	}

	/**
	 * Persist a child mission at CREATED. Does not launch anything. The caller
	 * supplies the execution mechanism so launch can never precede durable
	 * creation — the coordinator persists first and only then invokes it.
	 */
	async createChild(request: MissionRequest, executor: MissionExecutor): Promise<DurableMissionRecord> {
		return this.coordinator(executor).createMission(request);
	}

	/**
	 * Create + run one child to a terminal durable state. The child is persisted
	 * at CREATED before `executor.launch`; then QUEUED, LAUNCHING (attemptId),
	 * RUNNING (executionId) and finally a terminal result are persisted around
	 * the executor call. The caller never drives the executor directly.
	 */
	async executeChild(
		request: MissionRequest,
		executor: MissionExecutor,
		options: { signal?: AbortSignal } = {},
	): Promise<DurableDelegationChildOutcome> {
		const coordinator = this.coordinator(executor);
		await coordinator.createMission(request);
		const terminal = await coordinator.resume(request.missionId, { signal: options.signal });
		return this._outcome(terminal, coordinator.heartbeatTelemetry(request.missionId));
	}

	/**
	 * Explicitly resume an interrupted child to terminal state. Does NOT create
	 * the mission (it must already exist durably). Allocates a NEW execution
	 * attempt while preserving the prior attempt history and the immutable
	 * mission/session identity.
	 */
	async resumeMission(
		missionId: string,
		executor: MissionExecutor,
		options: { signal?: AbortSignal } = {},
	): Promise<DurableDelegationChildOutcome> {
		const coordinator = this.coordinator(executor);
		const terminal = await coordinator.resume(missionId, { signal: options.signal });
		return this._outcome(terminal, coordinator.heartbeatTelemetry(missionId));
	}

	private _outcome(
		terminal: DurableMissionRecord,
		heartbeatTelemetry?: HeartbeatTelemetry,
	): DurableDelegationChildOutcome {
		const result = terminal.result;
		if (!result) {
			throw new Error(`Mission ${terminal.missionId} did not reach a terminal result`);
		}
		const lastAttempt = terminal.attempts[terminal.attempts.length - 1];
		return {
			missionId: terminal.missionId,
			parentMissionId: terminal.parentMissionId,
			depth: terminal.depth,
			record: terminal,
			result,
			attemptId: lastAttempt?.attemptId ?? "",
			executionId: terminal.resultExecutionId ?? lastAttempt?.executionId,
			fencingToken: terminal.fencingToken,
			heartbeatTelemetry,
		};
	}

	// =========================================================================
	// Read + recovery (never launch work)
	// =========================================================================

	/** Load a mission record, or `undefined` when missing. Corrupt records throw. */
	async getMission(missionId: string): Promise<DurableMissionRecord | undefined> {
		return this.coordinator(NOOP_EXECUTOR).getMission(missionId);
	}

	async listMissions(): Promise<string[]> {
		return this.coordinator(NOOP_EXECUTOR).listMissions();
	}

	async listNonterminalMissions(): Promise<string[]> {
		return this.coordinator(NOOP_EXECUTOR).listNonterminalMissions();
	}

	async listChildren(parentMissionId: string): Promise<string[]> {
		return this.coordinator(NOOP_EXECUTOR).listChildren(parentMissionId);
	}

	/**
	 * Restart reconciliation: mark lost executor ownership INTERRUPTED. Never
	 * launches work and never fabricates success. See DurableMissionCoordinator.
	 */
	async recover(options: { now?: number } = {}): Promise<DurableRecoveryReport> {
		return this.coordinator(NOOP_EXECUTOR).recover(options);
	}

	// =========================================================================
	// Ownership control (no executor work)
	// =========================================================================

	/** Atomically acquire execution ownership without invoking the executor. */
	async acquireOwnership(missionId: string): Promise<{ record: DurableMissionRecord; lease: ExecutionLease }> {
		return this.coordinator(NOOP_EXECUTOR).acquireOwnership(missionId);
	}

	/** Renew a live lease (heartbeat). Does not change the fencing token. */
	async renewOwnership(
		missionId: string,
		proof: ExecutionLeaseProof,
		options: { now?: number } = {},
	): Promise<{ lease: ExecutionLease; record: DurableMissionRecord }> {
		return this.coordinator(NOOP_EXECUTOR).renewOwnership(missionId, proof, options);
	}

	/** Release a live lease without reaching a terminal state. */
	async releaseOwnership(
		missionId: string,
		proof: ExecutionLeaseProof,
		options: { now?: number } = {},
	): Promise<DurableMissionRecord> {
		return this.coordinator(NOOP_EXECUTOR).releaseOwnership(missionId, proof, options);
	}
}
