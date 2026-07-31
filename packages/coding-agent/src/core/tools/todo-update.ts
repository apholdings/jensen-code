import type { AgentTool } from "@apholdings/jensen-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { TodoLoopGuard } from "./todo-loop-guard.js";
import type { TodoItem } from "./todo-write.js";

/** Schema for the todo_update tool */
const todoUpdateSchema = Type.Object({
	updates: Type.Array(
		Type.Object({
			id: Type.String({ description: "Stable identifier of the todo item to update" }),
			status: Type.Optional(
				Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")], {
					description: "New status for the todo item",
				}),
			),
			activeForm: Type.Optional(
				Type.String({ description: "Updated present continuous form shown during execution" }),
			),
			content: Type.Optional(Type.String({ description: "Updated imperative task description" })),
		}),
		{ description: "Array of partial updates to apply. Each update identifies a todo by stable id.", minItems: 1 },
	),
	expectedRevision: Type.Number({
		description: "Current revision from todo_read or last successful todo_write/todo_update. Fails if stale.",
	}),
});

export type TodoUpdateInput = Static<typeof todoUpdateSchema>;

export interface TodoUpdateSnapshot {
	revision: number;
	timestamp: number;
}

export interface TodoUpdateSnapshotEnforcement {
	/** Returns the current read snapshot, or null if none */
	getSnapshot: () => TodoUpdateSnapshot | null;
	/** Invalidates the current snapshot, requiring a fresh todo_read */
	invalidateSnapshot: () => void;
}

function normaliseUpdateField(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	return value.trim();
}

/**
 * Create the todo_update tool.
 * @param getSessionTodos - Callback to get the current todos from session
 * @param setSessionTodos - Callback to set todos in session
 * @param getRevision - Callback to get the current todo revision number
 * @param loopGuard - Guard instance to track consecutive calls
 * @param snapshotEnforcement - Optional snapshot validation for host-side enforcement
 */
export function createTodoUpdateTool(
	getSessionTodos: () => TodoItem[],
	setSessionTodos: (todos: TodoItem[]) => void,
	getRevision: () => number,
	loopGuard: TodoLoopGuard,
	snapshotEnforcement?: TodoUpdateSnapshotEnforcement,
): AgentTool<typeof todoUpdateSchema> {
	return {
		name: "todo_update",
		label: "todo_update",
		description:
			"Apply partial progress transitions to the todo list without replacing the entire list. " +
			"Use this to mark items as in_progress or completed, or to update activeForm/content. " +
			"Each update identifies a todo by its stable id from todo_read or a prior todo_write. " +
			"Requires expectedRevision from the last read or mutation. " +
			"Multiple updates in one call are applied atomically.",
		parameters: todoUpdateSchema,
		execute: async (_toolCallId: string, input: TodoUpdateInput, _signal?: AbortSignal) => {
			const { updates, expectedRevision } = input;

			// Host-side snapshot enforcement: require a fresh todo_read before any update
			if (snapshotEnforcement) {
				const snapshot = snapshotEnforcement.getSnapshot();
				if (!snapshot) {
					return {
						content: [
							{
								type: "text" as const,
								text: "TODO_READ_REQUIRED: You must call todo_read before using todo_update. No read snapshot is available.",
							},
						],
						details: { errorCode: "TODO_READ_REQUIRED", reason: "no_snapshot" },
					};
				}
			}

			// Validate updates not empty
			if (!Array.isArray(updates) || updates.length === 0) {
				return {
					content: [{ type: "text", text: "Error: updates must be a non-empty array" }],
					details: undefined,
				};
			}

			// Validate each update has at least one change
			for (const update of updates) {
				if (!update.id || typeof update.id !== "string") {
					return {
						content: [{ type: "text", text: "Error: each update must have a non-empty id field" }],
						details: undefined,
					};
				}
				if (update.status === undefined && update.activeForm === undefined && update.content === undefined) {
					return {
						content: [
							{
								type: "text",
								text: `Error: update for id "${update.id}" has no fields to change (status, activeForm, or content required)`,
							},
						],
						details: undefined,
					};
				}
				if (update.status !== undefined && !["pending", "in_progress", "completed"].includes(update.status)) {
					return {
						content: [
							{
								type: "text",
								text: `Error: invalid status "${update.status}" for id "${update.id}"`,
							},
						],
						details: undefined,
					};
				}
			}

			// Check stale revision - invalidate snapshot and return typed error
			const currentRevision = getRevision();
			if (expectedRevision !== currentRevision) {
				// Invalidate the cached snapshot so further updates are blocked
				snapshotEnforcement?.invalidateSnapshot();
				return {
					content: [
						{
							type: "text" as const,
							text: `TODO_READ_REQUIRED: Stale revision. Snapshot was at revision ${expectedRevision} but current is ${currentRevision}. Call todo_read to get the current state before retrying.`,
						},
					],
					details: {
						errorCode: "TODO_READ_REQUIRED",
						reason: "stale_revision",
						snapshotRevision: expectedRevision,
						currentRevision,
					},
				};
			}

			// Check loop guard
			const guardResult = loopGuard.recordWrite(false);
			if (!guardResult.allowed) {
				return {
					content: [{ type: "text", text: guardResult.message! }],
					details: {
						loopGuardTriggered: true,
						todoWriteTemporarilyBlocked: guardResult.circuitOpen,
						requiredNextAction: guardResult.message
							? "execute a non-todo tool or return a useful response"
							: undefined,
					},
				};
			}

			// Apply updates atomically
			const current = getSessionTodos().map((t) => ({ ...t }));
			const idIndex = new Map<string, number>();
			for (let i = 0; i < current.length; i++) {
				const id = current[i].id;
				if (!id) continue; // should not happen after normalization, but guard
				idIndex.set(id, i);
			}

			// Validate all IDs exist
			for (const update of updates) {
				if (!idIndex.has(update.id)) {
					return {
						content: [
							{
								type: "text",
								text: `Error: unknown todo id "${update.id}". Call todo_read to get current IDs and retry.`,
							},
						],
						details: { unknownId: update.id },
					};
				}
			}

			// Apply all updates (no mutation of store until all pass)
			let changed = false;
			for (const update of updates) {
				const idx = idIndex.get(update.id)!;
				const item = current[idx];
				if (update.status !== undefined && update.status !== item.status) {
					item.status = update.status;
					changed = true;
				}
				const newActiveForm = normaliseUpdateField(update.activeForm);
				if (newActiveForm !== undefined && newActiveForm !== item.activeForm) {
					item.activeForm = newActiveForm;
					changed = true;
				}
				const newContent = normaliseUpdateField(update.content);
				if (newContent !== undefined && newContent !== item.content) {
					item.content = newContent;
					changed = true;
				}
			}

			if (!changed) {
				// No-op: nothing was actually changed
				const pending = current.filter((t) => t.status === "pending").length;
				const inProgress = current.filter((t) => t.status === "in_progress").length;
				const completed = current.filter((t) => t.status === "completed").length;
				return {
					content: [
						{
							type: "text",
							text: `Todo progress unchanged (${current.length} total: ${pending} pending, ${inProgress} in progress, ${completed} completed). Continue executing the active task.`,
						},
					],
					details: {
						changed: false,
						total: current.length,
						pending,
						inProgress,
						completed,
						revision: currentRevision,
					},
				};
			}

			// Persist updated todos
			setSessionTodos(current);
			// Invalidate snapshot after mutation - subsequent updates need fresh read
			snapshotEnforcement?.invalidateSnapshot();
			const newRevision = getRevision();

			const pending = current.filter((t) => t.status === "pending").length;
			const inProgress = current.filter((t) => t.status === "in_progress").length;
			const completed = current.filter((t) => t.status === "completed").length;

			return {
				content: [
					{
						type: "text",
						text: `Todo progress updated. Continue executing the active task.`,
					},
				],
				details: {
					changed: true,
					total: current.length,
					pending,
					inProgress,
					completed,
					revision: newRevision,
				},
			};
		},
	};
}

/** Default todo_update tool - requires session binding for state management */
export const todoUpdateTool: AgentTool<typeof todoUpdateSchema> = createTodoUpdateTool(
	() => [],
	() => {},
	() => 0,
	new TodoLoopGuard(),
);
