/**
 * Durable Mission Coordinator (2.4.0).
 *
 * Composes the canonical mission lifecycle with a DurableMissionStore at the
 * mission execution boundary. The parent/domain layer never remembers to write
 * files; it talks to this coordinator, and the coordinator persists every
 * authoritative lifecycle transition before and after the executor runs.
 *
 * Design constraints:
 *   - The coordinator depends only on the injected `DurableMissionStore` port
 *     and a `MissionExecutor` seam — never on process/provider/CLI/UI code.
 *   - Opening/recovering the store NEVER auto-runs mission work.
 *   - Resume is explicit and always allocates a NEW execution attempt; it never
 *     fabricates continuity with a previous process.
 */

import { randomUUID } from "node:crypto";
import {
	createDurableMissionRecord,
	type DurableExecutionAttempt,
	type DurableExecutionAttemptEndReason,
	type DurableMissionRecord,
	type DurableMissionStore,
} from "./durable-store.js";
import type { MissionExecutor, MissionLaunchOptions } from "./mission-executor.js";
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

/**
 * Map a terminal MissionResult's executor-level outcome to an attempt end
 * reason. `MissionExecutionOutcome` is a strict subset of
 * `DurableExecutionAttemptEndReason` (INTERRUPTED is never a terminal result).
 */
function attemptEndReason(result: MissionResult): DurableExecutionAttemptEndReason {
	return result.executionOutcome;
}

export class DurableMissionCoordinator {
	private readonly _store: DurableMissionStore;
	private readonly _executor: MissionExecutor;
	private readonly _now: () => number;
	private readonly _attemptIdFactory: () => string;

	constructor(store: DurableMissionStore, executor: MissionExecutor, options: DurableMissionCoordinatorOptions = {}) {
		this._store = store;
		this._executor = executor;
		this._now = options.now ?? (() => Date.now());
		this._attemptIdFactory = options.attemptIdFactory ?? (() => `attempt_${randomUUID()}`);
	}

	/** The underlying persistence port (exposed for tests and load paths). */
	get store(): DurableMissionStore {
		return this._store;
	}

	get executor(): MissionExecutor {
		return this._executor;
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
	// Restart reconciliation (no auto re-execution)
	// =========================================================================

	/**
	 * Inspect every persisted non-terminal mission and reconcile lost executor
	 * ownership. Persisted active states (QUEUED/RUNNING/WAITING/BLOCKED/
	 * RETRYING) are never blindly trusted across a restart: they transition to
	 * INTERRUPTED with a `control_plane_restart` recovery reason. Terminal
	 * missions stay terminal; CREATED missions stay CREATED; already-interrupted
	 * missions are left alone. Nothing is executed.
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

			let next = this._withTransition(record, "INTERRUPTED", { reason, atMs: now });

			const attempts = [...record.attempts];
			if (record.currentAttemptId) {
				const index = attempts.findIndex((a) => a.attemptId === record.currentAttemptId);
				if (index >= 0) {
					attempts[index] = {
						...attempts[index],
						endReason: "INTERRUPTED",
						recovery: { reason, recoveredAtMs: now },
					};
				}
			}
			next = { ...next, currentAttemptId: undefined, currentExecutionId: undefined, attempts };

			await this._commit(record, next);
			report.reconciled.push(id);
			report.actions.push(`mission '${id}' reconciled ${record.state} → INTERRUPTED`);
		}

		return report;
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
		const loaded = await this._store.load(missionId);
		if (loaded.status === "missing") {
			throw new Error(`Mission not found: ${missionId}`);
		}
		if (loaded.status === "corrupt") {
			throw new Error(`Mission ${missionId} is corrupt: ${loaded.diagnostic}`);
		}

		let record = loaded.record;
		if (isTerminalMissionState(record.state)) {
			throw new Error(`Cannot resume terminal mission ${missionId} (${record.state})`);
		}
		if (record.state !== "CREATED" && record.state !== "INTERRUPTED") {
			throw new Error(`Cannot resume mission ${missionId} from state ${record.state}; reconcile (recover) first`);
		}

		const resuming = record.state === "INTERRUPTED";
		record = await this._commit(
			record,
			this._withTransition(record, "QUEUED", {
				reason: resuming ? "explicit resume (new execution attempt)" : "initial launch",
			}),
		);

		// Allocate the durable attempt identity and persist LAUNCHING BEFORE
		// invoking the executor. If Jensen crashes immediately after the executor
		// actually launches but before RUNNING is persisted, the attempt intent
		// survives durably and restart reconciliation marks it interrupted.
		const attemptId = this._attemptIdFactory();
		const launchAtMs = this._now();
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
		record = await this._commit(record, next);

		const executor = this._executor;
		let handle: MissionHandle;
		try {
			handle = await executor.launch(record.request, { signal: options.signal });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return this._commit(record, this._failLaunch(record, attemptId, message, launchAtMs));
		}

		const executionId = handle.executionId;
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
		record = await this._commit(record, next);

		const result = await executor.awaitResult(handle, { signal: options.signal });

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
			attempts: [...next.attempts.slice(0, attemptIndex), completedAttempt],
		};

		return this._commit(record, next);
	}

	/**
	 * Build a terminal FAILED record for an executor that rejected `launch`.
	 * No execution id was ever established, so `resultExecutionId` stays unset;
	 * the attempt remains auditable with `endReason: CRASHED`.
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
			attempts: [...next.attempts.slice(0, index), failedAttempt],
		};
		return next;
	}

	// =========================================================================
	// Internals
	// =========================================================================

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

	private async _commit(previous: DurableMissionRecord, next: DurableMissionRecord): Promise<DurableMissionRecord> {
		const result = await this._store.save(next, { expectedRevision: previous.revision });
		if (result.status === "stale") {
			throw new Error(
				`Stale revision for mission ${next.missionId}: expected ${result.expectedRevision}, found ${result.actualRevision}`,
			);
		}
		return next;
	}
}
