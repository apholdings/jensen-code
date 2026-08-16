/**
 * Local Subagent Runtime (3.0.0 foundation).
 *
 * Maintains MANY logical agents independently of physical inference capacity. A
 * logical agent is a durable semantic execution context reusing existing Jensen
 * identities (child session / mission / assignment / execution). This runtime
 * is a control/read model; it does NOT implement automatic fan-out, does NOT
 * own the Mission state machine, and never owns an OS process.
 */

import { randomUUID } from "node:crypto";
import type { LogicalAgentStore } from "./logical-agent.js";
import { createLogicalAgentRecord } from "./logical-agent.js";
import type { LogicalAgentActivity, LogicalAgentRecord } from "./types.js";

export interface LocalSubagentRuntimeOptions {
	store: LogicalAgentStore;
	now?: () => number;
	idFactory?: () => string;
}

export interface RegisterLogicalAgentInput {
	logicalAgentId?: string;
	parentAgentId?: string;
	missionId?: string;
	assignmentId?: string;
	attemptId?: string;
	executionId?: string;
	workerId?: string;
	executorId?: string;
	modelPolicy?: { provider: string; model: string };
	sessionId: string;
	sessionDir?: string;
	evidenceRefs?: string[];
	activity?: LogicalAgentActivity;
	priority?: number;
}

export interface ActivityCounts {
	runningInference: number;
	waitingInference: number;
	tooling: number;
	parked: number;
	runnable: number;
	total: number;
}

export class LocalSubagentRuntime {
	private readonly _store: LogicalAgentStore;
	private readonly _now: () => number;
	private readonly _idFactory: () => string;

	constructor(options: LocalSubagentRuntimeOptions) {
		this._store = options.store;
		this._now = options.now ?? (() => Date.now());
		this._idFactory = options.idFactory ?? (() => `agent_${randomUUID()}`);
	}

	get store(): LogicalAgentStore {
		return this._store;
	}

	/** Register a logical agent (idempotent by logicalAgentId). Never creates a duplicate identity. */
	async register(input: RegisterLogicalAgentInput): Promise<LogicalAgentRecord> {
		const logicalAgentId = input.logicalAgentId ?? this._idFactory();
		const existing = await this._store.load(logicalAgentId);
		if (existing.status === "ok") return existing.record;
		if (existing.status === "corrupt") {
			throw new Error(`Cannot register logical agent ${logicalAgentId}: corrupt record (${existing.diagnostic})`);
		}
		const record = createLogicalAgentRecord({
			logicalAgentId,
			parentAgentId: input.parentAgentId,
			missionId: input.missionId,
			assignmentId: input.assignmentId,
			attemptId: input.attemptId,
			executionId: input.executionId,
			workerId: input.workerId,
			executorId: input.executorId,
			modelPolicy: input.modelPolicy,
			sessionId: input.sessionId,
			sessionDir: input.sessionDir,
			evidenceRefs: input.evidenceRefs,
			activity: input.activity ?? "RUNNABLE",
			priority: input.priority,
			now: this._now(),
		});
		const saved = await this._store.save(record);
		if (saved.status === "saved") return saved.record;
		throw new Error(`Failed to register logical agent ${logicalAgentId}: stale revision`);
	}

	async inspect(logicalAgentId: string): Promise<LogicalAgentRecord | undefined> {
		const loaded = await this._store.load(logicalAgentId);
		if (loaded.status === "ok") return loaded.record;
		if (loaded.status === "missing") return undefined;
		throw new Error(`Corrupt logical agent ${logicalAgentId}: ${loaded.diagnostic}`);
	}

	async list(): Promise<LogicalAgentRecord[]> {
		const ids = await this._store.list();
		const records: LogicalAgentRecord[] = [];
		for (const id of ids) {
			const loaded = await this._store.load(id);
			if (loaded.status === "ok") records.push(loaded.record);
		}
		return records.sort((a, b) => a.createdAtMs - b.createdAtMs || (a.logicalAgentId < b.logicalAgentId ? -1 : 1));
	}

	/** Transition activity with a waiting reason. Optimistic revision guarded. */
	async transition(
		logicalAgentId: string,
		activity: LogicalAgentActivity,
		options: {
			waitingReason?: string;
			pendingInferenceRequestId?: string;
			executionId?: string;
			attemptId?: string;
			assignmentId?: string;
		} = {},
	): Promise<LogicalAgentRecord> {
		// Control planes may race (e.g. a fire-and-forget release handler and an
		// explicit operator transition). Retry a bounded number of times on stale
		// revision; the last load wins deterministically.
		for (let attempt = 0; attempt < 5; attempt++) {
			let loaded = await this._store.load(logicalAgentId);
			if (loaded.status === "missing") {
				// A logical agent may begin inference before an explicit register
				// call. Auto-register a minimal durable record (idempotent) so the
				// read/control model is self-sufficient.
				await this.register({ logicalAgentId, sessionId: logicalAgentId });
				loaded = await this._store.load(logicalAgentId);
			}
			if (loaded.status !== "ok") throw new Error(`Logical agent ${logicalAgentId} not found`);
			const current = loaded.record;
			const next: LogicalAgentRecord = {
				...current,
				activity,
				waitingReason: options.waitingReason,
				pendingInferenceRequestId: options.pendingInferenceRequestId ?? current.pendingInferenceRequestId,
				executionId: options.executionId ?? current.executionId,
				attemptId: options.attemptId ?? current.attemptId,
				assignmentId: options.assignmentId ?? current.assignmentId,
				updatedAtMs: this._now(),
			};
			const saved = await this._store.save(next, { expectedRevision: current.revision });
			if (saved.status === "saved") return saved.record;
		}
		throw new Error(`Logical agent ${logicalAgentId} transition conflicted after retries (stale revision)`);
	}

	/** Park a logical agent (durable identity + reason preserved; no hot KV reservation). */
	async park(logicalAgentId: string, reason: string): Promise<LogicalAgentRecord> {
		return this.transition(logicalAgentId, "PARKED", { waitingReason: reason });
	}

	/** Resume a parked/waiting agent back to RUNNABLE. */
	async resume(logicalAgentId: string): Promise<LogicalAgentRecord> {
		return this.transition(logicalAgentId, "RUNNABLE", {
			waitingReason: undefined,
			pendingInferenceRequestId: undefined,
		});
	}

	async cancel(logicalAgentId: string, reason?: string): Promise<LogicalAgentRecord> {
		return this.transition(logicalAgentId, "CANCELLED", { waitingReason: reason });
	}

	async complete(logicalAgentId: string, state: "COMPLETED" | "FAILED" = "COMPLETED"): Promise<LogicalAgentRecord> {
		return this.transition(logicalAgentId, state, { waitingReason: undefined, pendingInferenceRequestId: undefined });
	}

	/** Deterministic activity counts (used to enrich scheduler status). */
	async activityCounts(): Promise<ActivityCounts> {
		const records = await this.list();
		const counts: ActivityCounts = {
			runningInference: 0,
			waitingInference: 0,
			tooling: 0,
			parked: 0,
			runnable: 0,
			total: records.length,
		};
		for (const record of records) {
			switch (record.activity) {
				case "RUNNING_INFERENCE":
					counts.runningInference += 1;
					break;
				case "WAITING_INFERENCE":
					counts.waitingInference += 1;
					break;
				case "RUNNING_TOOL":
				case "WAITING_TOOL":
				case "VERIFYING":
					counts.tooling += 1;
					break;
				case "PARKED":
					counts.parked += 1;
					break;
				case "RUNNABLE":
					counts.runnable += 1;
					break;
				default:
					break;
			}
		}
		return counts;
	}
}
