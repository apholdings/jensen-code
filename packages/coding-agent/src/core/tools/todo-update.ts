import type { AgentTool } from "@apholdings/jensen-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { hashIntent, TodoEngine, type TodoPatchOp } from "../todo/index.js";
import { TodoLoopGuard } from "./todo-loop-guard.js";

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
		description:
			"Current revision from todo_read or last successful todo_write/todo_update. Jensen automatically reads and rebases once if stale.",
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

/**
 * @deprecated Retained for compatibility. Loop detection is now progress-aware
 * and nonfatal inside the engine; this counter no longer terminates the run.
 */
export interface TodoUpdateRejectionState {
	count: number;
}

// Re-export the engine types for callers.
export type { TodoItem, TodoRebaseResult } from "../todo/index.js";

import type { TodoItem } from "../todo/index.js";

function normaliseUpdateField(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	return value.trim();
}

/**
 * Apply a set of patch operations to a clone of the current items.
 * Returns the new items and whether anything actually changed.
 */
function applyOps(current: TodoItem[], ops: TodoPatchOp[]): { items: TodoItem[]; changed: boolean } {
	const items = current.map((t) => ({ ...t }));
	const byId = new Map<string, number>();
	for (let i = 0; i < items.length; i++) {
		const id = items[i].id;
		if (!id) continue;
		byId.set(id, i);
	}
	let changed = false;
	for (const op of ops) {
		const idx = byId.get(op.id);
		if (idx === undefined) continue; // unknown id — handled by caller
		const item = items[idx];
		if (op.status !== undefined && op.status !== item.status) {
			item.status = op.status;
			if (op.status === "completed") {
				item.completedAt = Date.now();
			}
			changed = true;
		}
		const newActiveForm = normaliseUpdateField(op.activeForm);
		if (newActiveForm !== undefined && newActiveForm !== item.activeForm) {
			item.activeForm = newActiveForm;
			changed = true;
		}
		const newContent = normaliseUpdateField(op.content);
		if (newContent !== undefined && newContent !== item.content) {
			item.content = newContent;
			changed = true;
		}
		if (changed && item.version !== undefined) item.version++;
	}
	return { items, changed };
}

function summarize(items: TodoItem[]): { total: number; pending: number; inProgress: number; completed: number } {
	return {
		total: items.length,
		pending: items.filter((t) => t.status === "pending").length,
		inProgress: items.filter((t) => t.status === "in_progress").length,
		completed: items.filter((t) => t.status === "completed").length,
	};
}

/**
 * Create the todo_update tool.
 *
 * Stale revisions are recovered internally and deterministically: the engine
 * reads the current state, rebases the (non-conflicting) intent exactly once,
 * and applies it. TODO failures are typed and never terminate the active run.
 *
 * @param getSessionTodos - Callback to get the current todos from session
 * @param setSessionTodos - Callback to set todos in session
 * @param getRevision - Callback to get the current todo revision number
 * @param loopGuard - Guard instance to track consecutive calls (backward-compat)
 * @param snapshotEnforcement - Optional snapshot validation (stale-safe)
 * @param rejectionState - Deprecated; retained for compatibility
 * @param engine - Optional shared TodoEngine (idempotency, rebase, loop detection)
 */
export function createTodoUpdateTool(
	getSessionTodos: () => TodoItem[],
	setSessionTodos: (todos: TodoItem[]) => void,
	getRevision: () => number,
	_loopGuard: TodoLoopGuard,
	snapshotEnforcement?: TodoUpdateSnapshotEnforcement,
	_rejectionState?: TodoUpdateRejectionState,
	engine: TodoEngine = new TodoEngine("session"),
): AgentTool<typeof todoUpdateSchema> {
	return {
		name: "todo_update",
		label: "todo_update",
		description:
			"Apply partial progress transitions to the todo list without replacing the entire list. " +
			"Use this to mark items as in_progress or completed, or to update activeForm/content. " +
			"Each update identifies a todo by its stable id from todo_read or a prior todo_write. " +
			"Requires expectedRevision from the last read or mutation. " +
			"Multiple updates in one call are applied atomically. " +
			"Jensen automatically reads the current state and rebases a stale revision once.",
		parameters: todoUpdateSchema,
		execute: async (_toolCallId: string, input: TodoUpdateInput, _signal?: AbortSignal) => {
			const { updates } = input;
			const requestedRevision = input.expectedRevision;

			const returnConflict = (result: { message: string; currentItems: TodoItem[]; currentRevision: number }) => {
				const sum = summarize(result.currentItems);
				return {
					content: [{ type: "text" as const, text: result.message }],
					details: {
						errorCode: "TODO_REBASE_CONFLICT",
						recoverable: true,
						runMustContinue: true,
						requestedRevision,
						currentRevision: result.currentRevision,
						conflictItemIds: undefined,
						sum,
					},
				};
			};

			// Validate updates non-empty
			if (!Array.isArray(updates) || updates.length === 0) {
				return {
					content: [{ type: "text", text: "Error: updates must be a non-empty array" }],
					details: undefined,
				};
			}

			// Validate each update has at least one change and a valid status
			const ops: TodoPatchOp[] = [];
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
				ops.push({
					id: update.id,
					status: update.status,
					activeForm: update.activeForm,
					content: update.content,
				});
			}

			const currentItems = getSessionTodos().map((t) => ({ ...t }));
			const currentRevision = getRevision();
			const intentHash = hashIntent(ops);
			const idempotencyKey = `${engine.scopeId}|${intentHash}|${requestedRevision}`;

			// Idempotency: exact already-applied retries return the original result.
			if (engine.lookupApplied(idempotencyKey)) {
				engine.emit({
					type: "TODO_INTENT_ALREADY_APPLIED",
					intentId: intentHash,
					requestedRevision,
					currentRevision,
				});
				const sum = summarize(currentItems);
				return {
					content: [
						{
							type: "text",
							text: `Todo progress already applied in a previous call (revision ${requestedRevision}). Continue executing the active task.`,
						},
					],
					details: {
						changed: true,
						alreadyApplied: true,
						total: sum.total,
						pending: sum.pending,
						inProgress: sum.inProgress,
						completed: sum.completed,
						revision: currentRevision,
					},
				};
			}

			// Any mutation is progress: breaks any outstanding failure chain.
			engine.recordProgress();
			engine.emit({
				type: "TODO_MUTATION_INTENT_CREATED",
				intentId: intentHash,
				requestedRevision,
				currentRevision,
			});

			// -------- Current-revision fast path --------
			if (requestedRevision === currentRevision) {
				const before = summarize(currentItems);
				// All IDs must exist for a direct apply.
				const knownIds = new Set(currentItems.map((t) => t.id).filter(Boolean));
				for (const op of ops) {
					if (!knownIds.has(op.id)) {
						const sum = summarize(currentItems);
						return {
							content: [
								{
									type: "text",
									text: `Error: unknown todo id "${op.id}". Call todo_read to get current IDs and retry.`,
								},
							],
							details: { unknownId: op.id, errorCode: "TODO_ITEM_NOT_FOUND", sum },
						};
					}
				}
				const { items, changed } = applyOps(currentItems, ops);
				if (!changed) {
					engine.emit({
						type: "TODO_MUTATION_REJECTED",
						intentId: intentHash,
						requestedRevision,
						currentRevision,
					});
					return {
						content: [
							{
								type: "text",
								text: `Todo progress unchanged (${before.total} total: ${before.pending} pending, ${before.inProgress} in progress, ${before.completed} completed). Continue executing the active task.`,
							},
						],
						details: {
							changed: false,
							total: before.total,
							pending: before.pending,
							inProgress: before.inProgress,
							completed: before.completed,
							revision: currentRevision,
						},
					};
				}
				setSessionTodos(items);
				const newRevision = getRevision();
				engine.recordApplied(idempotencyKey, newRevision);
				engine.emit({
					type: "TODO_MUTATION_COMMITTED",
					intentId: intentHash,
					currentRevision: newRevision,
				});
				snapshotEnforcement?.invalidateSnapshot();
				const sum = summarize(items);
				return {
					content: [{ type: "text", text: `Todo progress updated. Continue executing the active task.` }],
					details: {
						changed: true,
						total: sum.total,
						pending: sum.pending,
						inProgress: sum.inProgress,
						completed: sum.completed,
						requestedRevision,
						revision: newRevision,
					},
				};
			}

			// -------- Stale revision: internal read + bounded rebase --------
			engine.emit({
				type: "TODO_REVISION_STALE_DETECTED",
				intentId: intentHash,
				requestedRevision,
				currentRevision,
			});
			engine.emit({
				type: "TODO_INTERNAL_READ_COMPLETED",
				currentRevision,
			});
			engine.emit({ type: "TODO_REBASE_STARTED", intentId: intentHash, currentRevision });

			const maxAttempts = engine.limits.maxInternalRebaseAttempts;
			let attempt = 0;
			let rebase = engine.rebase(requestedRevision, currentRevision, currentItems, ops);

			// Bounded retry: if the state advanced again during our read, retry once.
			while (rebase.status === "conflict" && attempt < maxAttempts && getRevision() !== currentRevision) {
				const latestItems = getSessionTodos().map((t) => ({ ...t }));
				const latestRevision = getRevision();
				engine.emit({
					type: "TODO_INTERNAL_READ_COMPLETED",
					currentRevision: latestRevision,
				});
				rebase = engine.rebase(requestedRevision, latestRevision, latestItems, ops);
				attempt++;
			}

			if (rebase.status === "conflict") {
				if (rebase.status === "conflict") {
					engine.emit({
						type: "TODO_REBASE_CONFLICT",
						intentId: intentHash,
						currentRevision,
						conflictItemIds: rebase.conflictItemIds,
					});
					engine.emit({
						type: "TODO_MUTATION_REJECTED",
						intentId: intentHash,
						requestedRevision,
						currentRevision,
					});
				}
				// Typed, nonfatal conflict (or rebase ambiguity). Run continues.
				const conflictList =
					rebase.conflictItemIds.length > 0 ? rebase.conflictItemIds.join(", ") : "unknown items";
				return returnConflict({
					message: `TODO_REBASE_CONFLICT: The todo list advanced to revision ${currentRevision}; your intent based on revision ${requestedRevision} conflicts with concurrent changes (items: ${conflictList}). No update was applied and execution continues. Read current state with todo_read if you want to retry.`,
					currentItems,
					currentRevision,
				});
			}

			// Rebase succeeded (rebased or already_applied).
			if (rebase.status === "already_applied") {
				engine.recordApplied(idempotencyKey, currentRevision);
				engine.emit({
					type: "TODO_INTENT_ALREADY_APPLIED",
					intentId: intentHash,
					requestedRevision,
					currentRevision,
				});
				engine.resetFailureChain();
				const sum = summarize(currentItems);
				return {
					content: [
						{
							type: "text",
							text: `Todo progress unchanged (revision ${currentRevision}); your intended transitions were already applied. Continuing execution.`,
						},
					],
					details: {
						changed: false,
						alreadyApplied: true,
						rebaseStatus: "already_applied",
						total: sum.total,
						pending: sum.pending,
						inProgress: sum.inProgress,
						completed: sum.completed,
						requestedRevision,
						currentRevision,
						revision: currentRevision,
					},
				};
			}

			// Conflict-free rebase: apply rebased ops onto the current state.
			const { items, changed } = applyOps(currentItems, ops);
			if (changed) {
				setSessionTodos(items);
				const newRevision = getRevision();
				engine.recordApplied(idempotencyKey, newRevision);
				engine.emit({
					type: "TODO_REBASE_SUCCEEDED",
					intentId: intentHash,
					currentRevision: newRevision,
					requestedRevision,
				});
				engine.emit({
					type: "TODO_MUTATION_COMMITTED",
					intentId: intentHash,
					currentRevision: newRevision,
				});
				snapshotEnforcement?.invalidateSnapshot();
				engine.resetFailureChain();
				const sum = summarize(items);
				return {
					content: [
						{
							type: "text",
							text: `Todo progress updated after automatic rebase (revision ${requestedRevision} -> ${newRevision}). Continued executing the active task.`,
						},
					],
					details: {
						changed: true,
						rebased: true,
						originalRevision: requestedRevision,
						currentRevision: newRevision,
						preservedConcurrentChanges: rebase.preservedConcurrentChanges,
						total: sum.total,
						pending: sum.pending,
						inProgress: sum.inProgress,
						completed: sum.completed,
						revision: newRevision,
					},
				};
			}

			// No actual change after rebase.
			engine.resetFailureChain();
			const sum = summarize(currentItems);
			return {
				content: [
					{
						type: "text",
						text: `Todo progress unchanged (revision ${currentRevision}). Continuing execution.`,
					},
				],
				details: {
					changed: false,
					rebaseStatus: "rebased",
					total: sum.total,
					pending: sum.pending,
					inProgress: sum.inProgress,
					completed: sum.completed,
					revision: currentRevision,
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
