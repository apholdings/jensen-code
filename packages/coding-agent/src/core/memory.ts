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
export const SESSION_TASKS_CUSTOM_TYPE = "session_tasks";

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

// ============================================================================
// Task Model
// ============================================================================

/** Valid task statuses */
export type TaskStatus = "pending" | "in_progress" | "completed";

/**
 * Structured task for multi-step work tracking.
 * Separate from todo_write items; tasks have explicit id, subject, and description
 * for model-visible work tracking across an extended session.
 */
export interface Task {
	/** Unique identifier for this task */
	id: string;
	/** Brief title/subject of the task */
	subject: string;
	/** Detailed description of what the task involves */
	description: string;
	/** Current status */
	status: TaskStatus;
	/** Active-form phrasing shown when task is in_progress (e.g., "Implementing feature X") */
	activeForm?: string;
	/** Optional free-form metadata */
	metadata?: Record<string, unknown>;
}

/** Input for creating a new task (excludes auto-assigned fields) */
export interface TaskCreateInput {
	subject: string;
	description: string;
	activeForm?: string;
	metadata?: Record<string, unknown>;
}

/** Input for updating an existing task */
export interface TaskUpdateInput {
	subject?: string;
	description?: string;
	status?: TaskStatus;
	activeForm?: string;
	metadata?: Record<string, unknown>;
}

let _taskIdCounter = 0;

/**
 * Generate a unique task ID.
 * Uses a counter to ensure uniqueness within the session.
 */
export function generateTaskId(): string {
	_taskIdCounter++;
	return `task_${Date.now()}_${_taskIdCounter}`;
}

/**
 * Parse a raw session entry data blob into an array of Task objects.
 * Skips malformed entries.
 */
export function parseTasks(data: unknown): Task[] {
	if (!Array.isArray(data)) return [];
	const tasks: Task[] = [];
	for (const item of data) {
		if (typeof item !== "object" || item === null) continue;
		const candidate = item as Record<string, unknown>;
		if (
			typeof candidate.id !== "string" ||
			typeof candidate.subject !== "string" ||
			typeof candidate.description !== "string" ||
			(candidate.status !== "pending" && candidate.status !== "in_progress" && candidate.status !== "completed")
		) {
			continue;
		}
		tasks.push({
			id: candidate.id,
			subject: candidate.subject,
			description: candidate.description,
			status: candidate.status as TaskStatus,
			activeForm: typeof candidate.activeForm === "string" ? candidate.activeForm : undefined,
			metadata:
				typeof candidate.metadata === "object" && candidate.metadata !== null
					? (candidate.metadata as Record<string, unknown>)
					: undefined,
		});
	}
	return tasks;
}

/**
 * Format a task list for display.
 */
export function formatTaskList(tasks: Task[]): string {
	if (tasks.length === 0) {
		return "No tasks.";
	}

	const lines: string[] = [];
	const pending = tasks.filter((t) => t.status === "pending");
	const inProgress = tasks.filter((t) => t.status === "in_progress");
	const completed = tasks.filter((t) => t.status === "completed");

	if (pending.length > 0) {
		lines.push(`Pending (${pending.length}):`);
		for (const task of pending) {
			lines.push(`  [${task.id}] ${task.subject}`);
		}
	}

	if (inProgress.length > 0) {
		lines.push(`In Progress (${inProgress.length}):`);
		for (const task of inProgress) {
			lines.push(`  [${task.id}] ${task.subject}${task.activeForm ? ` — ${task.activeForm}` : ""}`);
		}
	}

	if (completed.length > 0) {
		lines.push(`Completed (${completed.length}):`);
		for (const task of completed) {
			lines.push(`  [${task.id}] ${task.subject}`);
		}
	}

	return lines.join("\n");
}

/**
 * Format a single task for display.
 */
export function formatTaskDetail(task: Task): string {
	const lines = [`Task: ${task.subject}`, `ID: ${task.id}`, `Status: ${task.status}`];
	if (task.activeForm) {
		lines.push(`Active: ${task.activeForm}`);
	}
	if (task.description) {
		lines.push(`\n${task.description}`);
	}
	if (task.metadata && Object.keys(task.metadata).length > 0) {
		lines.push(`\nMetadata: ${JSON.stringify(task.metadata)}`);
	}
	return lines.join("\n");
}
