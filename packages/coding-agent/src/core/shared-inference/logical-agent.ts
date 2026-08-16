/**
 * Logical agent store — port + validation (3.0.0 foundation).
 *
 * A logical agent is a semantic execution context over the existing durable
 * identities (child session / mission / assignment / execution). This store is
 * a read/control model; it does not introduce a second agent identity and does
 * not replace the Mission state machine.
 */

import type { LogicalAgentRecord } from "./types.js";

export const LOGICAL_AGENT_SCHEMA_VERSION = 1 as const;

export type LogicalAgentLoadResult =
	| { status: "ok"; record: LogicalAgentRecord }
	| { status: "missing" }
	| { status: "corrupt"; logicalAgentId: string; diagnostic: string };

export type LogicalAgentSaveResult =
	| { status: "saved"; record: LogicalAgentRecord }
	| { status: "stale"; expectedRevision: number; actualRevision: number | undefined };

export interface LogicalAgentStore {
	readonly storeId: string;
	load(logicalAgentId: string): Promise<LogicalAgentLoadResult>;
	/** Optimistic-concurrency save: reject when on-disk revision differs. */
	save(record: LogicalAgentRecord, options?: { expectedRevision?: number }): Promise<LogicalAgentSaveResult>;
	list(): Promise<string[]>;
}

export function isSafeLogicalAgentId(value: string): boolean {
	return /^[A-Za-z0-9._-]+$/u.test(value) && value !== "." && value !== "..";
}

export function createLogicalAgentRecord(input: {
	logicalAgentId: string;
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
	activity: LogicalAgentRecord["activity"];
	waitingReason?: string;
	pendingInferenceRequestId?: string;
	priority?: number;
	now?: number;
}): LogicalAgentRecord {
	const now = input.now ?? Date.now();
	return {
		schemaVersion: LOGICAL_AGENT_SCHEMA_VERSION,
		logicalAgentId: input.logicalAgentId,
		parentAgentId: input.parentAgentId,
		missionId: input.missionId,
		assignmentId: input.assignmentId,
		attemptId: input.attemptId,
		executionId: input.executionId,
		workerId: input.workerId,
		executorId: input.executorId,
		modelPolicy: input.modelPolicy ? { ...input.modelPolicy } : undefined,
		sessionId: input.sessionId,
		sessionDir: input.sessionDir,
		evidenceRefs: [...(input.evidenceRefs ?? [])],
		activity: input.activity,
		waitingReason: input.waitingReason,
		pendingInferenceRequestId: input.pendingInferenceRequestId,
		priority: input.priority ?? 0,
		createdAtMs: now,
		updatedAtMs: now,
		revision: 1,
	};
}

export function parseLogicalAgentRecord(
	value: unknown,
): { ok: true; record: LogicalAgentRecord } | { ok: false; diagnostic: string } {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return { ok: false, diagnostic: "record must be an object" };
	const doc = value as Record<string, unknown>;
	if (doc.schemaVersion !== LOGICAL_AGENT_SCHEMA_VERSION)
		return { ok: false, diagnostic: `unsupported schemaVersion: ${String(doc.schemaVersion)}` };
	if (typeof doc.logicalAgentId !== "string" || !isSafeLogicalAgentId(doc.logicalAgentId))
		return { ok: false, diagnostic: "logicalAgentId is missing or unsafe" };
	if (typeof doc.sessionId !== "string" || doc.sessionId.length === 0)
		return { ok: false, diagnostic: "sessionId must be a non-empty string" };
	if (!(typeof doc.activity === "string")) return { ok: false, diagnostic: "activity must be a string" };
	if (!Array.isArray(doc.evidenceRefs)) return { ok: false, diagnostic: "evidenceRefs must be an array" };
	if (typeof doc.priority !== "number" || !Number.isSafeInteger(doc.priority))
		return { ok: false, diagnostic: "priority must be a safe integer" };
	if (
		!Number.isSafeInteger(doc.createdAtMs) ||
		!Number.isSafeInteger(doc.updatedAtMs) ||
		!Number.isSafeInteger(doc.revision)
	)
		return { ok: false, diagnostic: "timestamps/revision must be safe integers" };

	let modelPolicy: LogicalAgentRecord["modelPolicy"];
	if (doc.modelPolicy !== undefined) {
		if (typeof doc.modelPolicy !== "object" || doc.modelPolicy === null || Array.isArray(doc.modelPolicy))
			return { ok: false, diagnostic: "modelPolicy must be an object" };
		const mp = doc.modelPolicy as Record<string, unknown>;
		if (typeof mp.provider !== "string" || typeof mp.model !== "string")
			return { ok: false, diagnostic: "modelPolicy.provider/model must be strings" };
		modelPolicy = { provider: mp.provider, model: mp.model };
	}

	return {
		ok: true,
		record: {
			schemaVersion: LOGICAL_AGENT_SCHEMA_VERSION,
			logicalAgentId: doc.logicalAgentId as string,
			parentAgentId: typeof doc.parentAgentId === "string" ? doc.parentAgentId : undefined,
			missionId: typeof doc.missionId === "string" ? doc.missionId : undefined,
			assignmentId: typeof doc.assignmentId === "string" ? doc.assignmentId : undefined,
			attemptId: typeof doc.attemptId === "string" ? doc.attemptId : undefined,
			executionId: typeof doc.executionId === "string" ? doc.executionId : undefined,
			workerId: typeof doc.workerId === "string" ? doc.workerId : undefined,
			executorId: typeof doc.executorId === "string" ? doc.executorId : undefined,
			modelPolicy,
			sessionId: doc.sessionId as string,
			sessionDir: typeof doc.sessionDir === "string" ? doc.sessionDir : undefined,
			evidenceRefs: (doc.evidenceRefs as unknown[]).filter((e): e is string => typeof e === "string"),
			activity: doc.activity as LogicalAgentRecord["activity"],
			waitingReason: typeof doc.waitingReason === "string" ? doc.waitingReason : undefined,
			pendingInferenceRequestId:
				typeof doc.pendingInferenceRequestId === "string" ? doc.pendingInferenceRequestId : undefined,
			priority: doc.priority as number,
			createdAtMs: doc.createdAtMs as number,
			updatedAtMs: doc.updatedAtMs as number,
			revision: doc.revision as number,
		},
	};
}
