import type { AgentTool } from "@apholdings/jensen-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { TodoLoopGuard } from "./todo-loop-guard.js";

/** Schema for the todo_write tool */
const todoWriteSchema = Type.Object({
	todos: Type.Array(
		Type.Object({
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
	content: string;
	activeForm: string;
	status: "pending" | "in_progress" | "completed";
}

/**
 * Redact sensitive credentials from text string.
 */
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
 */
export function createTodoWriteTool(
	getSessionTodos: () => TodoItem[],
	setSessionTodos: (todos: TodoItem[]) => void,
	loopGuard: TodoLoopGuard = new TodoLoopGuard(),
): AgentTool<typeof todoWriteSchema> {
	return {
		name: "todo_write",
		label: "todo_write",
		description:
			"Update the session's structured task/todo list for multi-step workflows. Full list replacement each call. To view the current todo list without modifying it, call todo_read.",
		parameters: todoWriteSchema,
		execute: async (_toolCallId: string, { todos, confirmClear }: TodoWriteInput, _signal?: AbortSignal) => {
			// Validate input
			if (!Array.isArray(todos)) {
				return {
					content: [{ type: "text", text: "Error: todos must be an array" }],
					details: undefined,
				};
			}

			// Validate each todo item
			const normalized: TodoItem[] = [];
			for (const todo of todos) {
				if (typeof todo.content !== "string" || !todo.content.trim()) {
					return {
						content: [{ type: "text", text: "Error: each todo must have a non-empty content field" }],
						details: undefined,
					};
				}
				if (typeof todo.activeForm !== "string" || !todo.activeForm.trim()) {
					return {
						content: [{ type: "text", text: "Error: each todo must have a non-empty activeForm field" }],
						details: undefined,
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
						details: undefined,
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
					details: undefined,
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
				const completed = current.filter((t) => t.status === "completed").length;
				return {
					content: [
						{
							type: "text",
							text: `Todo list unchanged (${current.length} total: ${pending} pending, ${inProgress} in progress, ${completed} completed). Continue executing the active task.`,
						},
					],
					details: {
						changed: false,
						total: current.length,
						pending,
						inProgress,
						completed,
					},
				};
			}

			// Update session state
			setSessionTodos(normalized);

			const pending = normalized.filter((t) => t.status === "pending").length;
			const inProgress = normalized.filter((t) => t.status === "in_progress").length;
			const completed = normalized.filter((t) => t.status === "completed").length;

			if (normalized.length === 0) {
				return {
					content: [{ type: "text", text: "Todo list cleared." }],
					details: { changed: true, total: 0, pending: 0, inProgress: 0, completed: 0 },
				};
			}

			const summary = `Todo list updated (${normalized.length} total: ${pending} pending, ${inProgress} in progress, ${completed} completed). Continue with the current in-progress task.`;

			return {
				content: [{ type: "text", text: summary }],
				details: {
					changed: true,
					total: normalized.length,
					pending,
					inProgress,
					completed,
				},
			};
		},
	};
}

/** Default todo_write tool - requires session binding for state management */
export const todoWriteTool: AgentTool<typeof todoWriteSchema> = createTodoWriteTool(
	() => [],
	() => {},
);
