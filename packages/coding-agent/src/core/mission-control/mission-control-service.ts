/**
 * Mission Control Plane — service (2.9.0).
 *
 * The authoritative application/operator boundary over durable missions.
 *
 * Read models aggregate durable record fields only. Mutations compose the
 * existing DurableMissionCoordinator / DurableMissionDelegator / child-session
 * restore semantics; the control plane never re-implements fencing, heartbeat,
 * recovery, or session binding. Consumers use this service instead of reaching
 * into FileDurableMissionStore, session directories, or lock files.
 */

import type { EvidenceArchive } from "../context-runtime/evidence-archive.js";
import {
	type EvidenceRetrievalOptions,
	type EvidenceRetrievalResult,
	retrieveEvidencePage,
} from "../context-runtime/evidence-retrieval.js";
import {
	buildChildResumeExecutor,
	resolveChildSessionForResume,
} from "../durable-child-session/child-session-restore.js";
import { DurableMissionDelegator } from "../durable-delegation/durable-delegation.js";
import {
	DurableMissionCoordinator,
	type DurableMissionCoordinatorOptions,
} from "../mission-domain/durable-coordinator.js";
import type { DurableMissionRecord, DurableMissionStore } from "../mission-domain/durable-store.js";
import type { HeartbeatTelemetry } from "../mission-domain/execution-heartbeat.js";
import { isExecutionLeaseActive } from "../mission-domain/execution-lease.js";
import { isTerminalMissionState } from "../mission-domain/mission-state.js";
import type { ProcessMissionVerifier } from "../mission-domain/process-mission-executor.js";
import {
	type AttemptHistoryView,
	type AttemptView,
	type BuildResumeLaunch,
	type LeaseStatus,
	type MissionCancellationView,
	type MissionControlActiveExecution,
	MissionControlError,
	type MissionControlResumeOutcome,
	type MissionDetail,
	type MissionEvidenceRef,
	type MissionListOptions,
	type MissionListResult,
	type MissionOwnershipView,
	type MissionRequestView,
	type MissionResultView,
	type MissionSummary,
	type MissionTreeNode,
	type Resumability,
} from "./mission-control-types.js";

export interface MissionControlServiceOptions {
	store: DurableMissionStore;
	/** Optional injected delegator (defaults to one built from `store`). */
	delegator?: DurableMissionDelegator;
	/** Optional evidence archive for availability checks + bounded retrieval. */
	evidenceArchive?: EvidenceArchive;
	/** Child AgentSession directory for explicit resume. */
	sessionDir?: string;
	/** Stable executor owner identity (defaults to a fresh host+UUID identity). */
	ownerId?: string;
	now?: () => number;
	leaseDurationMs?: number;
	heartbeatIntervalMs?: number;
	renewalSafetyMarginMs?: number;
	attemptIdFactory?: () => string;
	leaseIdFactory?: () => string;
}

/** Fraction of the lease window remaining that is reported as EXPIRING. */
const EXPIRING_FRACTION = 0.25;

/** Split a deterministic evidence id (`kind:source:hash`) without I/O. */
function parseEvidenceId(evidenceId: string): { kind?: string; source?: string } {
	const first = evidenceId.indexOf(":");
	if (first <= 0) return {};
	const second = evidenceId.indexOf(":", first + 1);
	if (second <= 0) return { kind: evidenceId.slice(0, first) };
	return { kind: evidenceId.slice(0, first), source: evidenceId.slice(first + 1, second) };
}

export class MissionControlService {
	private readonly _store: DurableMissionStore;
	private readonly _delegator: DurableMissionDelegator;
	private readonly _evidenceArchive?: EvidenceArchive;
	private readonly _sessionDir?: string;
	private readonly _now: () => number;
	private readonly _coordinatorOptions: DurableMissionCoordinatorOptions;
	private readonly _active = new Map<string, MissionControlActiveExecution>();

	constructor(options: MissionControlServiceOptions) {
		this._store = options.store;
		this._delegator =
			options.delegator ??
			new DurableMissionDelegator({
				store: options.store,
				now: options.now,
				ownerId: options.ownerId,
				leaseDurationMs: options.leaseDurationMs,
				heartbeatIntervalMs: options.heartbeatIntervalMs,
				renewalSafetyMarginMs: options.renewalSafetyMarginMs,
				attemptIdFactory: options.attemptIdFactory,
				leaseIdFactory: options.leaseIdFactory,
			});
		this._evidenceArchive = options.evidenceArchive;
		this._sessionDir = options.sessionDir;
		this._now = options.now ?? (() => Date.now());
		this._coordinatorOptions = {
			now: options.now,
			ownerId: this._delegator.ownerId,
			leaseDurationMs: options.leaseDurationMs,
			heartbeatIntervalMs: options.heartbeatIntervalMs,
			renewalSafetyMarginMs: options.renewalSafetyMarginMs,
			attemptIdFactory: options.attemptIdFactory,
			leaseIdFactory: options.leaseIdFactory,
		};
	}

	/** The underlying persistence port (read access for loaders/tests). */
	get store(): DurableMissionStore {
		return this._store;
	}

	/** Stable executor owner identity used for local ownership comparison. */
	get ownerId(): string {
		return this._delegator.ownerId;
	}

	// =========================================================================
	// Read model
	// =========================================================================

	async listMissions(options: MissionListOptions = {}): Promise<MissionListResult> {
		const ids = await this._store.listMissions();
		const records = new Map<string, DurableMissionRecord>();
		const corrupt: MissionListResult["corrupt"] = [];

		for (const id of ids) {
			const loaded = await this._store.load(id);
			if (loaded.status === "ok") records.set(id, loaded.record);
			else if (loaded.status === "corrupt") corrupt.push({ missionId: id, diagnostic: loaded.diagnostic });
			// missing (deleted between list and load) is skipped.
		}

		// One pass child counts so listing never becomes O(all children × all missions).
		const childCount = new Map<string, number>();
		for (const record of records.values()) {
			if (record.parentMissionId) {
				childCount.set(record.parentMissionId, (childCount.get(record.parentMissionId) ?? 0) + 1);
			}
		}

		const now = this._now();
		let entries: MissionSummary[] = [];
		for (const record of records.values()) {
			entries.push(this._toSummary(record, childCount.get(record.missionId) ?? 0, now));
		}

		const filter = options.filter;
		if (filter) {
			entries = entries.filter((entry) => {
				if (filter.state !== undefined && entry.state !== filter.state) return false;
				if (filter.parentMissionId !== undefined && entry.parentMissionId !== filter.parentMissionId) return false;
				if (filter.terminal !== undefined && entry.terminal !== filter.terminal) return false;
				if (filter.interrupted !== undefined && entry.interrupted !== filter.interrupted) return false;
				if (filter.owned !== undefined && entry.owned !== filter.owned) return false;
				if (filter.resumable !== undefined && entry.resumable !== filter.resumable) return false;
				if (filter.depth !== undefined && entry.depth !== filter.depth) return false;
				return true;
			});
		}

		const sort = options.sort ?? "missionId";
		const direction = options.direction ?? "asc";
		entries.sort((a, b) => {
			let cmp: number;
			if (sort === "missionId") cmp = a.missionId < b.missionId ? -1 : a.missionId > b.missionId ? 1 : 0;
			else cmp = a[sort] - b[sort];
			return direction === "desc" ? -cmp : cmp;
		});

		const offset = options.offset ?? 0;
		if (offset > 0) entries = entries.slice(offset);
		if (options.limit !== undefined) entries = entries.slice(0, options.limit);

		return { entries, corrupt };
	}

	async getMission(missionId: string): Promise<MissionDetail> {
		const record = await this._requireRecord(missionId);
		const now = this._now();
		const children = await this._store.listChildren(missionId);
		const ownership = this._toOwnership(record, now);
		return {
			summary: this._toSummary(record, children.length, now),
			request: this._toRequestView(record),
			currentAttempt: this._currentAttemptView(record),
			ownership,
			result: this._toResultView(record),
			checkpointSummary: {
				objective: record.request.objective,
				constraints: [...(record.request.constraints ?? [])],
				lastTransition: record.transitions[record.transitions.length - 1],
				startedAtMs: record.startedAtMs,
				finishedAtMs: record.finishedAtMs,
			},
			evidenceRefs: await this._evidenceRefs(record),
			children,
			resumability: this._toResumability(record, now),
		};
	}

	async getAttempts(missionId: string): Promise<AttemptHistoryView> {
		const record = await this._requireRecord(missionId);
		return {
			missionId,
			attempts: record.attempts.map((attempt) => ({
				attemptId: attempt.attemptId,
				executionId: attempt.executionId,
				startedAtMs: attempt.startedAtMs,
				finishedAtMs: attempt.finishedAtMs,
				endReason: attempt.endReason,
				recovery: attempt.recovery,
			})),
			currentAttemptId: record.currentAttemptId,
			resultExecutionId: record.resultExecutionId,
		};
	}

	async getOwnership(missionId: string): Promise<MissionOwnershipView> {
		const record = await this._requireRecord(missionId);
		return this._toOwnership(record, this._now());
	}

	async getResult(missionId: string): Promise<MissionResultView> {
		const record = await this._requireRecord(missionId);
		return this._toResultView(record);
	}

	async getEvidenceRefs(missionId: string): Promise<MissionEvidenceRef[]> {
		const record = await this._requireRecord(missionId);
		return this._evidenceRefs(record);
	}

	async getResumability(missionId: string): Promise<Resumability> {
		const record = await this._requireRecord(missionId);
		return this._toResumability(record, this._now());
	}

	async getMissionTree(rootMissionId: string): Promise<MissionTreeNode> {
		return this._buildTree(rootMissionId, new Set());
	}

	/** Live local heartbeat telemetry, only when this process owns the execution. */
	localHeartbeatTelemetry(missionId: string): HeartbeatTelemetry | undefined {
		return this._active.get(missionId)?.coordinator.heartbeatTelemetry(missionId);
	}

	/**
	 * Bounded, integrity-verified evidence content retrieval. Delegates to the
	 * existing retrieval architecture; returns `not-found` when no archive is
	 * configured for this control plane.
	 */
	async resolveEvidence(evidenceId: string, options?: EvidenceRetrievalOptions): Promise<EvidenceRetrievalResult> {
		if (!this._evidenceArchive) {
			return {
				ok: false,
				status: "not-found",
				evidenceId,
				reason: "No evidence archive is configured for Mission Control.",
			};
		}
		return retrieveEvidencePage(this._evidenceArchive, evidenceId, options);
	}

	// =========================================================================
	// Mutations (compose authoritative semantics only)
	// =========================================================================

	/**
	 * Explicitly resume a durable child mission through the existing fenced
	 * ownership architecture. The mission must be structurally resumable and
	 * must have a durable child session identity; other mission kinds expose
	 * their limitation structurally rather than faking generic execution.
	 */
	async resumeMission(
		missionId: string,
		options: {
			buildResumeLaunch: BuildResumeLaunch;
			signal?: AbortSignal;
			executorId?: string;
			verifier?: ProcessMissionVerifier;
		},
	): Promise<MissionControlResumeOutcome> {
		const resumability = await this.getResumability(missionId);
		if (!resumability.resumable) {
			throw new MissionControlError(
				resumability.reasonCode === "MISSION_TERMINAL"
					? "MISSION_TERMINAL"
					: resumability.reasonCode === "MISSION_ACTIVE"
						? "MISSION_ACTIVE"
						: resumability.reasonCode === "MISSING_CHILD_SESSION"
							? "NOT_A_DURABLE_CHILD"
							: "MISSION_NOT_RESUMABLE",
				resumability.reason ?? `Mission ${missionId} is not resumable`,
				{ missionId, reasonCode: resumability.reasonCode },
			);
		}

		const resolved = await resolveChildSessionForResume({
			store: this._store,
			missionId,
			sessionDir: this._sessionDir,
		});
		const built = buildChildResumeExecutor({
			record: resolved.record,
			sessionManager: resolved.sessionManager,
			childSessionId: resolved.childSessionId,
			buildResumeLaunch: options.buildResumeLaunch,
			executorId: options.executorId ?? "mission-control-resume",
			verifier: options.verifier,
		});

		const coordinator = new DurableMissionCoordinator(this._store, built.executor, this._coordinatorOptions);
		const resume = coordinator.resume(missionId, { signal: options.signal });
		this._active.set(missionId, { coordinator, resume });
		const terminal = await resume;

		const lastAttempt = terminal.attempts[terminal.attempts.length - 1];
		if (!terminal.result) {
			throw new MissionControlError("MISSION_NOT_RESUMABLE", `Mission ${missionId} did not reach a terminal result`);
		}
		return {
			missionId: terminal.missionId,
			parentMissionId: terminal.parentMissionId,
			childSessionId: terminal.request.childSessionId,
			attemptId: lastAttempt?.attemptId ?? "",
			executionId: terminal.resultExecutionId ?? lastAttempt?.executionId,
			missionState: terminal.state,
			fencingToken: terminal.fencingToken,
			success: terminal.result.success,
			result: terminal.result,
			record: terminal,
			heartbeatTelemetry: coordinator.heartbeatTelemetry(missionId),
		};
	}

	/**
	 * Request cancellation for a mission owned by THIS process. A terminal
	 * mission no-ops; a remote/other-process owner cannot be signalled live and
	 * is reported honestly as `remote_owner` (no remote control protocol is
	 * invented here). When a local execution is active it is aborted and the
	 * fenced terminal CANCELLED write is awaited so `executorConfirmedStopped`
	 * is accurate.
	 */
	async cancelMission(missionId: string, reason?: string): Promise<MissionCancellationView> {
		const record = await this._requireRecord(missionId);

		if (isTerminalMissionState(record.state)) {
			return { missionId, status: "terminal", executorConfirmedStopped: false };
		}

		const now = this._now();
		if (!record.lease || !isExecutionLeaseActive(record.lease, now)) {
			return { missionId, status: "not_running", executorConfirmedStopped: false };
		}

		if (record.lease.ownerId !== this._delegator.ownerId) {
			return {
				missionId,
				status: "remote_owner",
				executorConfirmedStopped: false,
				reason: `Execution is owned by another process (owner ${record.lease.ownerId}); live cancellation is not signalled cross-process`,
			};
		}

		const active = this._active.get(missionId);
		if (!active) {
			return {
				missionId,
				status: "not_running",
				executorConfirmedStopped: false,
				reason: "This process holds the lease but has no active local execution to abort",
			};
		}

		const requestedAtMs = now;
		const requested = await active.coordinator.requestCancellation(
			missionId,
			reason ?? "mission cancelled by operator",
		);
		if (requested.status !== "cancel_requested") {
			return { missionId, status: "not_running", executorConfirmedStopped: false };
		}

		let executorConfirmedStopped = false;
		try {
			await active.resume;
			executorConfirmedStopped = true;
		} catch {
			// Authority loss or a commit failure may reject the resume; cancellation
			// request still stands and the durable record is the authority.
		}

		return {
			missionId,
			status: executorConfirmedStopped ? "cancelled" : "cancel_requested",
			executorConfirmedStopped,
			requestedAtMs,
			reason: reason ?? "mission cancelled by operator",
		};
	}

	/** Conservative restart reconciliation. Never auto-runs missions. */
	async recoverMission(
		options: { now?: number } = {},
	): Promise<Awaited<ReturnType<DurableMissionDelegator["recover"]>>> {
		return this._delegator.recover(options);
	}

	// =========================================================================
	// Internals
	// =========================================================================

	private async _requireRecord(missionId: string): Promise<DurableMissionRecord> {
		const loaded = await this._store.load(missionId);
		if (loaded.status === "missing") {
			throw new MissionControlError("MISSION_NOT_FOUND", `Mission not found: ${missionId}`, { missionId });
		}
		if (loaded.status === "corrupt") {
			throw new MissionControlError("MISSION_CORRUPT", `Mission ${missionId} is corrupt: ${loaded.diagnostic}`, {
				missionId,
				diagnostic: loaded.diagnostic,
			});
		}
		return loaded.record;
	}

	private _toSummary(record: DurableMissionRecord, childCount: number, now: number): MissionSummary {
		const resumability = this._toResumability(record, now);
		const ownership = this._toOwnership(record, now);
		return {
			missionId: record.missionId,
			parentMissionId: record.parentMissionId,
			childSessionId: record.request.childSessionId,
			depth: record.depth,
			state: record.state,
			createdAtMs: record.createdAtMs,
			updatedAtMs: record.updatedAtMs,
			currentAttemptId: record.currentAttemptId,
			currentExecutionId: record.currentExecutionId,
			attemptCount: record.attempts.length,
			fencingToken: record.fencingToken,
			owned: ownership.owned,
			leaseStatus: ownership.leaseStatus,
			terminal: isTerminalMissionState(record.state),
			resultStatus: record.result?.state,
			verificationStatus: record.result?.verification.status,
			interrupted: record.state === "INTERRUPTED",
			resumable: resumability.resumable,
			childCount,
		};
	}

	private _toRequestView(record: DurableMissionRecord): MissionRequestView {
		const request = record.request;
		return {
			missionId: request.missionId,
			parentMissionId: request.parentMissionId,
			depth: request.depth,
			objective: request.objective,
			agent: request.agent,
			executionMode: request.executionMode,
			acceptanceCriteria: [...request.acceptanceCriteria],
			workspaceScope: request.workspaceScope ? { ...request.workspaceScope } : undefined,
			budget: request.budget ? { ...request.budget } : undefined,
			capabilities: request.capabilities ? [...request.capabilities] : undefined,
			modelPolicy: request.modelPolicy ? { ...request.modelPolicy } : undefined,
			idempotencyKey: request.idempotencyKey,
			childSessionId: request.childSessionId,
			constraints: request.constraints ? [...request.constraints] : undefined,
			contextKeys: request.context ? Object.keys(request.context).sort() : [],
			createdAtMs: request.createdAtMs,
		};
	}

	private _currentAttemptView(record: DurableMissionRecord): AttemptView | undefined {
		if (!record.currentAttemptId) return undefined;
		const attempt = record.attempts.find((a) => a.attemptId === record.currentAttemptId);
		if (!attempt) return undefined;
		return {
			attemptId: attempt.attemptId,
			executionId: attempt.executionId,
			startedAtMs: attempt.startedAtMs,
			finishedAtMs: attempt.finishedAtMs,
			endReason: attempt.endReason,
			recovery: attempt.recovery,
		};
	}

	private _toOwnership(record: DurableMissionRecord, now: number): MissionOwnershipView {
		const lease = record.lease;
		if (!lease) {
			return { owned: false, fencingToken: record.fencingToken, leaseStatus: "NONE" };
		}
		const status = this._leaseStatus(lease, now);
		const owned = isExecutionLeaseActive(lease, now);
		const view: MissionOwnershipView = {
			owned,
			ownerId: lease.ownerId,
			leaseId: lease.leaseId,
			fencingToken: lease.fencingToken,
			acquiredAtMs: lease.acquiredAtMs,
			renewedAtMs: lease.renewedAtMs,
			expiresAtMs: lease.expiresAtMs,
			remainingMs: Math.max(0, lease.expiresAtMs - now),
			leaseStatus: status,
		};
		const local = this.localHeartbeatTelemetry(record.missionId);
		if (local) {
			view.localRuntime = { known: true, heartbeatTelemetry: local };
		}
		return view;
	}

	private _leaseStatus(lease: NonNullable<DurableMissionRecord["lease"]>, now: number): LeaseStatus {
		if (lease.expiresAtMs <= now) return "EXPIRED";
		const window = Math.max(1, lease.expiresAtMs - lease.renewedAtMs);
		const remaining = lease.expiresAtMs - now;
		return remaining <= window * EXPIRING_FRACTION ? "EXPIRING" : "ACTIVE";
	}

	private _toResumability(record: DurableMissionRecord, now: number): Resumability {
		if (isTerminalMissionState(record.state)) {
			return {
				resumable: false,
				reasonCode: "MISSION_TERMINAL",
				reason: `Mission ${record.missionId} is terminal (${record.state})`,
			};
		}
		if (record.lease && isExecutionLeaseActive(record.lease, now)) {
			return {
				resumable: false,
				reasonCode: "MISSION_ACTIVE",
				reason: `Mission ${record.missionId} has an active execution owner`,
			};
		}
		if (record.state !== "CREATED" && record.state !== "INTERRUPTED") {
			return {
				resumable: false,
				reasonCode: "MISSION_NOT_RUNNABLE_STATE",
				reason: `Mission ${record.missionId} is ${record.state}; reconcile first`,
			};
		}
		if (!record.request.childSessionId) {
			return {
				resumable: false,
				reasonCode: "MISSING_CHILD_SESSION",
				reason: `Mission ${record.missionId} has no durable child session identity`,
			};
		}
		return { resumable: true };
	}

	private _toResultView(record: DurableMissionRecord): MissionResultView {
		if (!record.result) {
			return { available: false };
		}
		return { available: true, resultExecutionId: record.resultExecutionId, result: record.result };
	}

	private async _evidenceRefs(record: DurableMissionRecord): Promise<MissionEvidenceRef[]> {
		const ids = record.result?.evidenceRefs ?? [];
		const refs: MissionEvidenceRef[] = [];
		for (const evidenceId of ids) {
			const parsed = parseEvidenceId(evidenceId);
			let available: boolean | undefined;
			if (this._evidenceArchive) {
				available = await this._evidenceArchive.has(evidenceId);
			}
			refs.push({ evidenceId, kind: parsed.kind, source: parsed.source, available });
		}
		return refs;
	}

	private async _buildTree(missionId: string, path: Set<string>): Promise<MissionTreeNode> {
		if (path.has(missionId)) {
			throw new MissionControlError("MISSION_TREE_CORRUPT", `Cycle detected at mission ${missionId}`, { missionId });
		}
		const record = await this._requireRecord(missionId);
		const now = this._now();
		const childIds = await this._store.listChildren(missionId);

		// Verify every listed child actually points back at this parent (durable
		// relation integrity), then build children deterministically.
		const children: MissionTreeNode[] = [];
		for (const childId of [...childIds].sort()) {
			const childLoaded = await this._store.load(childId);
			if (childLoaded.status !== "ok") {
				throw new MissionControlError(
					"MISSION_TREE_CORRUPT",
					`Child mission ${childId} of ${missionId} is missing or corrupt`,
					{ parentMissionId: missionId, childId, loadStatus: childLoaded.status },
				);
			}
			if (childLoaded.record.parentMissionId !== missionId) {
				throw new MissionControlError(
					"MISSION_TREE_CORRUPT",
					`Child mission ${childId} does not reference parent ${missionId}`,
					{ parentMissionId: missionId, childId, actualParent: childLoaded.record.parentMissionId },
				);
			}
			children.push(await this._buildTree(childId, new Set(path).add(missionId)));
		}

		const ownership = this._toOwnership(record, now);
		return {
			missionId: record.missionId,
			state: record.state,
			depth: record.depth,
			childSessionId: record.request.childSessionId,
			summary: {
				attemptCount: record.attempts.length,
				terminal: isTerminalMissionState(record.state),
				resultStatus: record.result?.state,
				verificationStatus: record.result?.verification.status,
			},
			ownership: {
				owned: ownership.owned,
				leaseId: ownership.leaseId,
				fencingToken: ownership.fencingToken,
				leaseStatus: ownership.leaseStatus,
			},
			children,
		};
	}
}
