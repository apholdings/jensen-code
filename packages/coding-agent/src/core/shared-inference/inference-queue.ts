/**
 * Durable inference queue ledger — store port + validation (3.0.0 foundation).
 *
 * One ledger file per shared inference resource. The ledger is the
 * cross-process scheduling authority: QUEUED requests are durable across
 * restart, RUNNING requests carry a fencing lease, and terminal requests are
 * folded into a bounded history ring with aggregate counters.
 *
 * The ledger NEVER contains prompts, message bodies, or credentials — only
 * correlation ids, estimates, and lifecycle metadata. The surrounding durable
 * AgentSession owns the virtualized context; a queued logical agent is cold,
 * not a duplicated hot prompt.
 */

import type { InferenceRequestRecord, InferenceRequestSummary } from "./types.js";

export const INFERENCE_LEDGER_SCHEMA_VERSION = 1 as const;

/** Bounded history ring size (terminal request summaries). */
export const INFERENCE_HISTORY_LIMIT = 1000;

// =============================================================================
// Ledger model
// =============================================================================

/**
 * Per-resource durable ledger.
 *
 * `running` and `queue` are ordered collections. `running` is ordered by slot
 * (index = slot). `queue` is kept in deterministic admission order; the
 * scheduler re-sorts on promotion using the deterministic priority comparator.
 */
export interface InferenceResourceLedger {
	schemaVersion: 1;
	resourceId: string;
	capacity: number;
	/** Running (admitted) requests. Length must equal busySlots. */
	running: InferenceRequestRecord[];
	/** Queued requests awaiting admission. */
	queue: InferenceRequestRecord[];
	/** Most-recent-first bounded terminal summaries. */
	history: InferenceRequestSummary[];
	/** Monotonic request sequence for deterministic tiebreak ids. */
	nextSeq: number;
	/** Monotonic ownership epoch for slot leases. */
	fencingToken: number;
	// Aggregate telemetry counters (never reset).
	completedCount: number;
	cancelledCount: number;
	failedCount: number;
	interruptedCount: number;
	totalQueueWaitMs: number;
	totalInferenceMs: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	maxQueueDepth: number;
	updatedAtMs: number;
	revision: number;
}

// =============================================================================
// Store port
// =============================================================================

export type InferenceLedgerCreateResult =
	| { status: "created" }
	| { status: "idempotent"; ledger: InferenceResourceLedger }
	| { status: "conflict"; error: string };

export type InferenceLedgerLoadResult =
	| { status: "ok"; ledger: InferenceResourceLedger }
	| { status: "missing" }
	| { status: "corrupt"; resourceId: string; diagnostic: string };

export type InferenceLedgerMutation<T> =
	| { kind: "write"; next: InferenceResourceLedger; value: T }
	| { kind: "noop"; value: T };

export type InferenceLedgerMutateResult<T> =
	| { status: "ok"; value: T }
	| { status: "missing" }
	| { status: "corrupt"; resourceId: string; diagnostic: string };

export interface InferenceQueueStore {
	readonly storeId: string;
	create(resourceId: string, ledger: InferenceResourceLedger): Promise<InferenceLedgerCreateResult>;
	load(resourceId: string): Promise<InferenceLedgerLoadResult>;
	mutate<T>(
		resourceId: string,
		mutation: (current: InferenceResourceLedger) => InferenceLedgerMutation<T>,
	): Promise<InferenceLedgerMutateResult<T>>;
	listResources(): Promise<string[]>;
}

// =============================================================================
// Construction + validation
// =============================================================================

/** A resourceId is a path component; reject traversal/injection. */
export function isSafeResourceId(value: string): boolean {
	return /^[A-Za-z0-9._-]+$/u.test(value) && value !== "." && value !== "..";
}

export function createEmptyInferenceLedger(options: {
	resourceId: string;
	capacity: number;
	now?: number;
}): InferenceResourceLedger {
	if (options.capacity < 1) throw new Error(`Inference resource capacity must be >= 1 (got ${options.capacity})`);
	return {
		schemaVersion: INFERENCE_LEDGER_SCHEMA_VERSION,
		resourceId: options.resourceId,
		capacity: options.capacity,
		running: [],
		queue: [],
		history: [],
		nextSeq: 0,
		fencingToken: 0,
		completedCount: 0,
		cancelledCount: 0,
		failedCount: 0,
		interruptedCount: 0,
		totalQueueWaitMs: 0,
		totalInferenceMs: 0,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		maxQueueDepth: 0,
		updatedAtMs: options.now ?? Date.now(),
		revision: 1,
	};
}

function invalid(why: string): { ok: false; diagnostic: string } {
	return { ok: false, diagnostic: why };
}

function isSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value);
}

function parsePriority(value: unknown): InferenceRequestRecord["priority"] | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const p = value as Record<string, unknown>;
	if (!isSafeInteger(p.base)) return undefined;
	return {
		base: p.base as number,
		interactive: typeof p.interactive === "boolean" ? p.interactive : undefined,
		verification: typeof p.verification === "boolean" ? p.verification : undefined,
	};
}

function parseRequest(value: unknown): { record: InferenceRequestRecord } | { error: string } {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return { error: "request must be an object" };
	const r = value as Record<string, unknown>;
	if (r.schemaVersion !== 1) return { error: `unsupported request schemaVersion: ${String(r.schemaVersion)}` };
	if (typeof r.inferenceRequestId !== "string" || r.inferenceRequestId.length === 0)
		return { error: "inferenceRequestId must be a non-empty string" };
	if (typeof r.logicalAgentId !== "string" || r.logicalAgentId.length === 0)
		return { error: "logicalAgentId must be a non-empty string" };
	if (typeof r.ownerId !== "string" || r.ownerId.length === 0) return { error: "ownerId must be a non-empty string" };
	if (typeof r.resourceId !== "string" || !isSafeResourceId(r.resourceId))
		return { error: "resourceId is missing or unsafe" };
	if (typeof r.provider !== "string" || typeof r.model !== "string")
		return { error: "provider and model must be strings" };
	if (!isSafeInteger(r.requestedAtMs) || !isSafeInteger(r.enqueuedAtMs))
		return { error: "requestedAtMs/enqueuedAtMs must be safe integers" };
	const priority = parsePriority(r.priority);
	if (!priority) return { error: "priority.base must be a safe integer" };
	if (
		!(
			r.state === "QUEUED" ||
			r.state === "RUNNING" ||
			r.state === "COMPLETED" ||
			r.state === "FAILED" ||
			r.state === "CANCELLED" ||
			r.state === "INTERRUPTED"
		)
	)
		return { error: `invalid request state: ${String(r.state)}` };

	let dependency: InferenceRequestRecord["dependency"];
	if (r.dependency !== undefined) {
		if (typeof r.dependency !== "object" || r.dependency === null || Array.isArray(r.dependency))
			return { error: "dependency must be an object" };
		const d = r.dependency as Record<string, unknown>;
		if (!isSafeInteger(d.unblocksCount) || (d.unblocksCount as number) < 0)
			return { error: "dependency.unblocksCount must be a non-negative integer" };
		dependency = { unblocksCount: d.unblocksCount as number };
	}

	let lease: InferenceRequestRecord["lease"];
	if (r.lease !== undefined) {
		if (typeof r.lease !== "object" || r.lease === null || Array.isArray(r.lease))
			return { error: "lease must be an object" };
		const l = r.lease as Record<string, unknown>;
		if (typeof l.ownerId !== "string" || typeof l.leaseId !== "string")
			return { error: "lease ownerId/leaseId must be strings" };
		if (!isSafeInteger(l.slot) || !isSafeInteger(l.acquiredAtMs) || !isSafeInteger(l.expiresAtMs))
			return { error: "lease slot/timestamps must be safe integers" };
		lease = {
			ownerId: l.ownerId as string,
			leaseId: l.leaseId as string,
			slot: l.slot as number,
			acquiredAtMs: l.acquiredAtMs as number,
			expiresAtMs: l.expiresAtMs as number,
		};
	}

	return {
		record: {
			schemaVersion: 1,
			inferenceRequestId: r.inferenceRequestId as string,
			logicalAgentId: r.logicalAgentId as string,
			ownerId: r.ownerId as string,
			missionId: typeof r.missionId === "string" ? r.missionId : undefined,
			assignmentId: typeof r.assignmentId === "string" ? r.assignmentId : undefined,
			executionId: typeof r.executionId === "string" ? r.executionId : undefined,
			resourceId: r.resourceId as string,
			provider: r.provider as string,
			model: r.model as string,
			requestedAtMs: r.requestedAtMs as number,
			enqueuedAtMs: r.enqueuedAtMs as number,
			priority,
			dependency,
			estimatedInputTokens: isSafeInteger(r.estimatedInputTokens) ? (r.estimatedInputTokens as number) : undefined,
			maxOutputTokens: isSafeInteger(r.maxOutputTokens) ? (r.maxOutputTokens as number) : undefined,
			state: r.state as InferenceRequestRecord["state"],
			lease,
			admittedAtMs: isSafeInteger(r.admittedAtMs) ? (r.admittedAtMs as number) : undefined,
			finishedAtMs: isSafeInteger(r.finishedAtMs) ? (r.finishedAtMs as number) : undefined,
			queueWaitMs: isSafeInteger(r.queueWaitMs) ? (r.queueWaitMs as number) : undefined,
			inferenceWallMs: isSafeInteger(r.inferenceWallMs) ? (r.inferenceWallMs as number) : undefined,
			inputTokens: isSafeInteger(r.inputTokens) ? (r.inputTokens as number) : undefined,
			outputTokens: isSafeInteger(r.outputTokens) ? (r.outputTokens as number) : undefined,
			errorMessage: typeof r.errorMessage === "string" ? r.errorMessage : undefined,
		},
	};
}

function parseSummary(value: unknown): { record: InferenceRequestSummary } | { error: string } {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return { error: "summary must be an object" };
	const r = value as Record<string, unknown>;
	if (typeof r.inferenceRequestId !== "string" || typeof r.logicalAgentId !== "string")
		return { error: "summary must have string inferenceRequestId/logicalAgentId" };
	if (typeof r.resourceId !== "string" || typeof r.provider !== "string" || typeof r.model !== "string")
		return { error: "summary must have string resourceId/provider/model" };
	if (!isSafeInteger(r.requestedAtMs) || !isSafeInteger(r.enqueuedAtMs))
		return { error: "summary timestamps must be safe integers" };
	if (!(r.state === "COMPLETED" || r.state === "FAILED" || r.state === "CANCELLED" || r.state === "INTERRUPTED"))
		return { error: `invalid summary state: ${String(r.state)}` };

	return {
		record: {
			inferenceRequestId: r.inferenceRequestId as string,
			logicalAgentId: r.logicalAgentId as string,
			resourceId: r.resourceId as string,
			provider: r.provider as string,
			model: r.model as string,
			requestedAtMs: r.requestedAtMs as number,
			enqueuedAtMs: r.enqueuedAtMs as number,
			state: r.state as InferenceRequestSummary["state"],
			admittedAtMs: isSafeInteger(r.admittedAtMs) ? (r.admittedAtMs as number) : undefined,
			finishedAtMs: isSafeInteger(r.finishedAtMs) ? (r.finishedAtMs as number) : undefined,
			queueWaitMs: isSafeInteger(r.queueWaitMs) ? (r.queueWaitMs as number) : undefined,
			inferenceWallMs: isSafeInteger(r.inferenceWallMs) ? (r.inferenceWallMs as number) : undefined,
			inputTokens: isSafeInteger(r.inputTokens) ? (r.inputTokens as number) : undefined,
			outputTokens: isSafeInteger(r.outputTokens) ? (r.outputTokens as number) : undefined,
			errorMessage: typeof r.errorMessage === "string" ? r.errorMessage : undefined,
		},
	};
}

/**
 * Validate an untrusted persisted ledger. Corruption is surfaced structurally
 * and never fabricated into a free slot or a completed inference.
 */
export function parseInferenceResourceLedger(
	value: unknown,
): { ok: true; ledger: InferenceResourceLedger } | { ok: false; diagnostic: string } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid("ledger must be an object");
	const doc = value as Record<string, unknown>;
	if (doc.schemaVersion !== INFERENCE_LEDGER_SCHEMA_VERSION)
		return invalid(`unsupported schemaVersion: ${String(doc.schemaVersion)}`);
	if (typeof doc.resourceId !== "string" || !isSafeResourceId(doc.resourceId))
		return invalid("resourceId is missing or unsafe");
	const resourceId = doc.resourceId;
	if (!isSafeInteger(doc.capacity) || (doc.capacity as number) < 1) return invalid("capacity must be an integer >= 1");
	if (!isSafeInteger(doc.nextSeq) || (doc.nextSeq as number) < 0)
		return invalid("nextSeq must be a non-negative integer");
	if (!isSafeInteger(doc.fencingToken) || (doc.fencingToken as number) < 0)
		return invalid("fencingToken must be a non-negative integer");
	if (!isSafeInteger(doc.updatedAtMs) || !isSafeInteger(doc.revision))
		return invalid("updatedAtMs/revision must be safe integers");
	for (const key of ["completedCount", "cancelledCount", "failedCount", "interruptedCount", "maxQueueDepth"]) {
		if (!isSafeInteger(doc[key]) || (doc[key] as number) < 0) return invalid(`${key} must be a non-negative integer`);
	}
	for (const key of ["totalQueueWaitMs", "totalInferenceMs", "totalInputTokens", "totalOutputTokens"]) {
		if (!isSafeInteger(doc[key]) || (doc[key] as number) < 0) return invalid(`${key} must be a non-negative integer`);
	}

	if (!Array.isArray(doc.running) || !Array.isArray(doc.queue) || !Array.isArray(doc.history))
		return invalid("running/queue/history must be arrays");

	const running: InferenceRequestRecord[] = [];
	for (const entry of doc.running) {
		const parsed = parseRequest(entry);
		if ("error" in parsed) return invalid(`running: ${parsed.error}`);
		running.push(parsed.record);
	}
	const queue: InferenceRequestRecord[] = [];
	for (const entry of doc.queue) {
		const parsed = parseRequest(entry);
		if ("error" in parsed) return invalid(`queue: ${parsed.error}`);
		queue.push(parsed.record);
	}
	const history: InferenceRequestSummary[] = [];
	for (const entry of doc.history) {
		const parsed = parseSummary(entry);
		if ("error" in parsed) return invalid(`history: ${parsed.error}`);
		history.push(parsed.record);
	}

	// Structural invariant: the slot count is derived from running.length; the
	// ledger never persists a separate busySlots field that could drift.
	const busySlots = running.length;
	if (busySlots > (doc.capacity as number)) return invalid("running.length exceeds capacity");

	return {
		ok: true,
		ledger: {
			schemaVersion: INFERENCE_LEDGER_SCHEMA_VERSION,
			resourceId,
			capacity: doc.capacity as number,
			running,
			queue,
			history,
			nextSeq: doc.nextSeq as number,
			fencingToken: doc.fencingToken as number,
			completedCount: doc.completedCount as number,
			cancelledCount: doc.cancelledCount as number,
			failedCount: doc.failedCount as number,
			interruptedCount: doc.interruptedCount as number,
			totalQueueWaitMs: doc.totalQueueWaitMs as number,
			totalInferenceMs: doc.totalInferenceMs as number,
			totalInputTokens: doc.totalInputTokens as number,
			totalOutputTokens: doc.totalOutputTokens as number,
			maxQueueDepth: doc.maxQueueDepth as number,
			updatedAtMs: doc.updatedAtMs as number,
			revision: doc.revision as number,
		},
	};
}
