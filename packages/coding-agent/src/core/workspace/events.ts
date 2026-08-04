/**
 * Durable workspace-index events. Bounded, sanitized, replayable and free of
 * source-code dumps and secrets.
 */

export const WORKSPACE_INDEX_EVENTS = {
	DISCOVERED: "WORKSPACE_INDEX_DISCOVERED",
	BUILD_STARTED: "WORKSPACE_INDEX_BUILD_STARTED",
	FILE_CLASSIFIED: "WORKSPACE_INDEX_FILE_CLASSIFIED",
	FILE_UPDATED: "WORKSPACE_INDEX_FILE_UPDATED",
	FILE_REMOVED: "WORKSPACE_INDEX_FILE_REMOVED",
	CHUNK_CREATED: "WORKSPACE_INDEX_CHUNK_CREATED",
	SYMBOLS_UPDATED: "WORKSPACE_INDEX_SYMBOLS_UPDATED",
	EMBEDDING_CREATED: "WORKSPACE_INDEX_EMBEDDING_CREATED",
	GENERATION_READY: "WORKSPACE_INDEX_GENERATION_READY",
	BUILD_FAILED: "WORKSPACE_INDEX_BUILD_FAILED",
	BUILD_CANCELLED: "WORKSPACE_INDEX_BUILD_CANCELLED",
	CORRUPTION_DETECTED: "WORKSPACE_INDEX_CORRUPTION_DETECTED",
	REBUILD_STARTED: "WORKSPACE_INDEX_REBUILD_STARTED",
	REBUILD_COMPLETED: "WORKSPACE_INDEX_REBUILD_COMPLETED",
	RETRIEVAL_PLANNED: "WORKSPACE_RETRIEVAL_PLANNED",
	RETRIEVAL_EXECUTED: "WORKSPACE_RETRIEVAL_EXECUTED",
	RESULT_SELECTED: "WORKSPACE_RETRIEVAL_RESULT_SELECTED",
	RESULT_REVALIDATED: "WORKSPACE_RETRIEVAL_RESULT_REVALIDATED",
	RESULT_STALE: "WORKSPACE_RETRIEVAL_RESULT_STALE",
} as const;

export type WorkspaceIndexEventName = (typeof WORKSPACE_INDEX_EVENTS)[keyof typeof WORKSPACE_INDEX_EVENTS];

export interface WorkspaceIndexDurableEvent {
	eventType: string;
	workspaceId: string;
	generationId?: string;
	path?: string;
	counts?: Record<string, number>;
	modelId?: string;
	reasonCode?: string;
	occurredAt: string;
}

/** Sanitize an event payload: never leak source content or secret-bearing values. */
export function sanitizeEventPayload(payload?: Record<string, unknown>): Record<string, unknown> | undefined {
	if (!payload) return undefined;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(payload)) {
		if (typeof v === "string" && /(secret|token|key|password|credential)/i.test(k)) continue;
		out[k] = v;
	}
	return out;
}

export interface EventSink {
	emit(payload: WorkspaceIndexDurableEvent): void;
}

/** No-op sink used when no session/bus is attached. */
export const nullSink: EventSink = { emit: () => {} };

/** Aggregates boring per-item events so we don't emit one event per posting. */
export function aggregateCounts(events: WorkspaceIndexDurableEvent[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const e of events) counts[e.eventType] = (counts[e.eventType] ?? 0) + 1;
	return counts;
}
