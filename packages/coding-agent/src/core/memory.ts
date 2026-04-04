import type { AgentMessage } from "@apholdings/jensen-agent-core";
import type { ImageContent, TextContent } from "@apholdings/jensen-ai";

export interface MemoryItem {
	key: string;
	value: string;
	timestamp: string;
}

export interface TodoSnapshotItem {
	content: string;
	activeForm: string;
	status: "pending" | "in_progress" | "completed";
}

export interface SessionMemoryState {
	items: MemoryItem[];
}

export const SESSION_MEMORY_CUSTOM_TYPE = "session_memory";
export const SESSION_TODOS_CUSTOM_TYPE = "session_todos";

export const SESSION_MEMORY_PREFIX = `Session memory recorded during this conversation. Treat it as active working context, but prefer newer user instructions if they conflict.\n\n<memory>\n`;
export const SESSION_MEMORY_SUFFIX = `\n</memory>`;

export function normalizeMemoryKey(key: string): string {
	return key.trim().replace(/\s+/g, ".").toLowerCase();
}

export function normalizeMemoryValue(value: string): string {
	return value.trim();
}

export function upsertMemoryItems(items: MemoryItem[], key: string, value: string, timestamp: string): MemoryItem[] {
	const normalizedKey = normalizeMemoryKey(key);
	const normalizedValue = normalizeMemoryValue(value);
	if (!normalizedKey || !normalizedValue) {
		return items;
	}

	const next = items.filter((item) => item.key !== normalizedKey);
	next.push({ key: normalizedKey, value: normalizedValue, timestamp });
	next.sort((a, b) => a.key.localeCompare(b.key));
	return next;
}

export function clearMemoryItems(): MemoryItem[] {
	return [];
}

export function deleteMemoryItem(items: MemoryItem[], key: string): MemoryItem[] {
	const normalizedKey = normalizeMemoryKey(key);
	return items.filter((item) => item.key !== normalizedKey);
}

export function getMemoryItem(items: readonly MemoryItem[], key: string): MemoryItem | undefined {
	const normalizedKey = normalizeMemoryKey(key);
	return items.find((item) => item.key === normalizedKey);
}

export function memoryItemsToText(items: MemoryItem[]): string {
	if (items.length === 0) {
		return "(none)";
	}

	return items.map((item) => `- ${item.key}: ${item.value}`).join("\n");
}

export function createMemoryContextMessage(items: MemoryItem[]): AgentMessage | undefined {
	if (items.length === 0) {
		return undefined;
	}

	return {
		role: "custom",
		customType: SESSION_MEMORY_CUSTOM_TYPE,
		content: `${SESSION_MEMORY_PREFIX}${memoryItemsToText(items)}${SESSION_MEMORY_SUFFIX}`,
		display: false,
		details: { items },
		timestamp: Date.now(),
	};
}

export function serializeMemoryItems(items: MemoryItem[]): string | (TextContent | ImageContent)[] {
	return memoryItemsToText(items);
}

export function parseMemoryItems(data: unknown): MemoryItem[] {
	if (!Array.isArray(data)) return [];
	const items: MemoryItem[] = [];
	for (const item of data) {
		if (typeof item !== "object" || item === null) continue;
		const candidate = item as Record<string, unknown>;
		if (typeof candidate.key !== "string" || typeof candidate.value !== "string") continue;
		items.push({
			key: normalizeMemoryKey(candidate.key),
			value: normalizeMemoryValue(candidate.value),
			timestamp: typeof candidate.timestamp === "string" ? candidate.timestamp : new Date().toISOString(),
		});
	}
	return items.filter((item) => item.key.length > 0 && item.value.length > 0);
}

export function parseTodoSnapshot(data: unknown): TodoSnapshotItem[] {
	if (!Array.isArray(data)) return [];
	const todos: TodoSnapshotItem[] = [];
	for (const item of data) {
		if (typeof item !== "object" || item === null) continue;
		const candidate = item as Record<string, unknown>;
		if (
			typeof candidate.content !== "string" ||
			typeof candidate.activeForm !== "string" ||
			(candidate.status !== "pending" && candidate.status !== "in_progress" && candidate.status !== "completed")
		) {
			continue;
		}
		todos.push({
			content: candidate.content,
			activeForm: candidate.activeForm,
			status: candidate.status,
		});
	}
	return todos;
}

/**
 * Snapshot of session memory at a point in time.
 * History is derived from persisted session entries with customType === "session_memory".
 * Because persistence is snapshot-based, not event-sourced, each snapshot represents
 * the complete memory state at that point, not individual add/update/delete events.
 */
export interface MemoryHistorySnapshot {
	/** Session entry id for this snapshot */
	entryId: string;
	/** Parent entry id in the session tree (null for root) */
	parentId: string | null;
	/** When this snapshot was recorded (ISO timestamp) */
	recordedAt: string;
	/** Complete memory state at this point in time */
	items: MemoryItem[];
	/** True if this is the latest snapshot on the current branch */
	isCurrent: boolean;
}
