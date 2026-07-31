import type { AgentTool } from "@apholdings/jensen-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { generateTodoId } from "../memory.js";
import { TodoLoopGuard } from "./todo-loop-guard.js";

/** Schema for the todo_write tool */
const todoWriteSchema = Type.Object({
	todos: Type.Array(
		Type.Object({
			id: Type.Optional(
				Type.String({
					description:
						"Stable identifier from a prior todo_read or write. Omit for new items; preserved on replacement.",
				}),
			),
			content: Type.String({ description: "Imperative task description (what needs to be done)" }),
			activeForm: Type.String({ description: "Present continuous form shown during execution" }),
			status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")], {
				description: "Task status: pending, in_progress, or completed",
			}),
		}),
		{ description: "Full replacement list of all tasks" },
	),
	confirmClear: Type.Optional(
		Type.Boolean({ description: "Set to true explicitly when passing empty todos to clear the list" }),
	),
});

export type TodoWriteInput = Static<typeof todoWriteSchema>;

/** Todo item stored in session state */
export interface TodoItem {
	id?: string;
	content: string;
	activeForm: string;
	status: "pending" | "in_progress" | "completed";
}

/**
 * Per-user-turn lock marker.
 * Prevents duplicate todo_write within the same user turn.
 */
export interface PerTurnLock {
	currentTurn: number;
	lockedUntil: number;
	isActive(): boolean;
	setLockedForCurrentTurn(): void;
}

/** Redact sensitive credentials from text string. */
export function redactSecrets(text: string): string {
	if (!text) return text;
	let result = text;
	result = result.replace(/EXAMPLE_SECRET_DO_NOT_LOG[^\s]*/g, "[REDACTED_SECRET]");
	result = result.replace(/(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, "$1[REDACTED_SECRET]");
	result = result.replace(
		/(password|passwd|secret|api_key|apikey|access_token|auth_token)\s*[:=]\s*['"]?([^'"]\S+)['"]?/gi,
		"$1=[REDACTED_SECRET]",
	);
	result = result.replace(/\b(sk|ghp|gho|glpat|aws_secret|xoxb|xoxp)-[A-Za-z0-9_]{16,}\b/g, "[REDACTED_SECRET]");
	result = result.replace(
		/-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g,
		"[REDACTED_SECRET]",
	);
	return result;
}

function normalizeTodoItem(item: TodoItem): TodoItem {
	return {
		id: item.id || generateTodoId(),
		content: redactSecrets(item.content.trim()),
		activeForm: redactSecrets(item.activeForm.trim()),
		status: item.status,
	};
}

function areTodosEqual(a: TodoItem[], b: TodoItem[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i].content !== b[i].content || a[i].activeForm !== b[i].activeForm || a[i].status !== b[i].status) {
			return false;
		}
	}
	return true;
}

/**
 * Create the todo_write tool.
 * @param getSessionTodos - Callback to get the current todos from session
 * @param setSessionTodos - Callback to set todos in session and trigger update event
 * @param loopGuard - Guard instance to track consecutive calls
 * @param getRevision - Callback to get the current todo revision number
 * @param perTurnLock - Optional lock to prevent duplicate writes within a single user turn
 */
export function createTodoWriteTool(
	getSessionTodos: () => TodoItem[],
	setSessionTodos: (todos: TodoItem[]) => void,
	loopGuard: TodoLoopGuard = new TodoLoopGuard(),
	getRevision?: () => number,
	perTurnLock?: PerTurnLock,
): AgentTool<typeof todoWriteSchema> {
	const execute = async (
		_toolCallId: string,
		{ todos, confirmClear }: TodoWriteInput,
		_signal?: AbortSignal,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> => {
		// Per-user-turn lock: reject duplicate todo_write within the same turn.
		if (perTurnLock?.isActive()) {
			const list = [...getSessionTodos()];
			const pending = list.filter((t) => t.status === "pending").length;
			const inProgress = list.filter((t) => t.status === "in_progress").length;
			const completedCount = list.filter((t) => t.status === "completed").length;

			return {
				content: [
					{
						type: "text",
						text: `${list.length} todo(s) already exist (${pending} pending, ${inProgress} in progress, ${completedCount} completed). The plan already exists. Do not call todo_write again during this user turn. Use todo_read, todo_update, or execute the active task.`,
					},
				],
				details: {
					changed: false,
					total: list.length,
					pending,
					inProgress,
					completed: completedCount,
					todoWriteAlreadyApplied: true,
				},
			};
		}

		// Validate input
		if (!Array.isArray(todos)) {
			return {
				content: [{ type: "text", text: "Error: todos must be an array" }],
				details: {},
			};
		}

		// Validate each todo item
		const normalized: TodoItem[] = [];
		for (const todo of todos) {
			if (typeof todo.content !== "string" || !todo.content.trim()) {
				return {
					content: [{ type: "text", text: "Error: each todo must have a non-empty content field" }],
					details: {},
				};
			}
			if (typeof todo.activeForm !== "string" || !todo.activeForm.trim()) {
				return {
					content: [{ type: "text", text: "Error: each todo must have a non-empty activeForm field" }],
					details: {},
				};
			}
			if (!["pending", "in_progress", "completed"].includes(todo.status)) {
				return {
					content: [
						{
							type: "text",
							text: "Error: each todo must have status of 'pending', 'in_progress', or 'completed'",
						},
					],
					details: {},
				};
			}
			normalized.push(normalizeTodoItem(todo as TodoItem));
		}

		// Empty list requires explicit confirmation
		if (normalized.length === 0 && confirmClear !== true) {
			return {
				content: [
					{
						type: "text",
						text: "Error: Clearing all todos requires explicit confirmation (set confirmClear: true). To view current todos without modifying them, call todo_read.",
					},
				],
				details: {},
			};
		}

		const current = getSessionTodos().map(normalizeTodoItem);
		const isNoOp = areTodosEqual(normalized, current);

		// Check loop guard
		const guardResult = loopGuard.recordWrite(isNoOp);
		if (guardResult.blocked) {
			return {
				content: [{ type: "text", text: guardResult.message! }],
				details: {
					loopGuardTriggered: true,
					todoWriteTemporarilyBlocked: true,
					requiredNextAction: guardResult.requiredNextAction,
				},
			};
		}

		if (isNoOp) {
			const pending = current.filter((t) => t.status === "pending").length;
			const inProgress = current.filter((t) => t.status === "in_progress").length;
			const completedCount = current.filter((t) => t.status === "completed").length;
			const total = current.length;
			const lockNote =
				"\n\nTodo list is locked for this user turn. Next permitted operations: todo_read, todo_update.";

			return {
				content: [
					{
						type: "text",
						text: `Todo list unchanged (${total} total: ${pending} pending, ${inProgress} in progress, ${completedCount} completed). Continue executing the active task.${lockNote}`,
					},
				],
				details: {
					changed: false,
					total,
					pending,
					inProgress,
					completed: completedCount,
				},
			};
		}

		// Update session state
		setSessionTodos(normalized);

		const pending = normalized.filter((t) => t.status === "pending").length;
		const inProgress = normalized.filter((t) => t.status === "in_progress").length;
		const completedCount = normalized.filter((t) => t.status === "completed").length;
		const total = normalized.length;

		// Apply per-user-turn lock (only on successful mutations)
		if (perTurnLock) {
			perTurnLock.setLockedForCurrentTurn();
		}

		const revision = getRevision?.();
		const lockNote = "\n\nTodo list is locked for this user turn. Next permitted operations: todo_read, todo_update.";

		const summary = `Todo list updated (${total} total: ${pending} pending, ${inProgress} in progress, ${completedCount} completed).${lockNote}`;

		return {
			content: [{ type: "text", text: summary }],
			details: {
				changed: true,
				total,
				pending,
				inProgress,
				completed: completedCount,
				revision,
			},
		};
	};

	return {
		name: "todo_write",
		label: "todo_write",
		description:
			"Update the session's structured task/todo list for multi-step workflows. " +
			"Call this for initial creation, deliberate complete replacement, or explicit confirmed clear. " +
			"Use todo_update for status or progress transitions. " +
			"Use todo_read when the current IDs or revision are not available. " +
			"Do not reconstruct or replace the entire list merely to complete one item. " +
			"To view the current todo list without modifying it, call todo_read.",
		parameters: todoWriteSchema,
		execute,
	};
}

/** Default todo_write tool - requires session binding for state management */
export const todoWriteTool: AgentTool<typeof todoWriteSchema> = createTodoWriteTool(
	() => [],
	() => {},
);
