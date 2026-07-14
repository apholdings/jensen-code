import type { AgentTool } from "@apholdings/jensen-agent-core";
import { type Static, Type } from "@sinclair/typebox";

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
	snapshotOmitted: Type.Optional(
		Type.Boolean({
			description: "Internal history marker indicating the full snapshot was omitted from model context",
		}),
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
 * Format a single todo item for display.
 */
function formatTodoItem(todo: TodoItem): string {
	const statusMark = todo.status === "completed" ? "x" : todo.status === "in_progress" ? ">" : " ";
	return `- [${statusMark}] ${todo.status === "in_progress" ? todo.activeForm : todo.content}`;
}

/**
 * Create the todo_write tool.
 * @param getSessionTodos - Callback to get the current todos from session
 * @param setSessionTodos - Callback to set todos in session and trigger update event
 */
export function createTodoWriteTool(
	getSessionTodos: () => TodoItem[],
	setSessionTodos: (todos: TodoItem[]) => void,
): AgentTool<typeof todoWriteSchema> {
	return {
		name: "todo_write",
		label: "todo_write",
		description:
			"Update the session's structured task/todo list for multi-step workflows. Full list replacement each call. When the conversation history shows '{todos:[], snapshotOmitted:true}', call todo_write with those exact arguments to retrieve the current state before editing.",
		parameters: todoWriteSchema,
		execute: async (_toolCallId: string, { todos, snapshotOmitted }: TodoWriteInput, _signal?: AbortSignal) => {
			// Read mode: snapshot was omitted from context, return current state
			if (snapshotOmitted === true && (!todos || todos.length === 0)) {
				const current = getSessionTodos();
				if (current.length === 0) {
					return {
						content: [{ type: "text", text: "Todo list is empty." }],
						details: { todos: [] },
					};
				}
				const lines = current.map(formatTodoItem);
				const pending = current.filter((t) => t.status === "pending").length;
				const inProgress = current.filter((t) => t.status === "in_progress").length;
				const completed = current.filter((t) => t.status === "completed").length;
				const header = `Current todo list (${current.length} total): ${pending} pending, ${inProgress} in progress, ${completed} completed.`;
				return {
					content: [{ type: "text", text: `${header}\n${lines.join("\n")}` }],
					details: { todos: current },
				};
			}

			// Write mode: full list replacement
			// Validate todos
			if (!Array.isArray(todos)) {
				return {
					content: [{ type: "text", text: "Error: todos must be an array" }],
					details: undefined,
				};
			}

			// Validate each todo item
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
			}

			// Update session state and emit event
			setSessionTodos(todos);

			const pending = todos.filter((t) => t.status === "pending").length;
			const inProgress = todos.filter((t) => t.status === "in_progress").length;
			const completed = todos.filter((t) => t.status === "completed").length;

			let summary = `Updated todo list (${todos.length} total)`;
			if (todos.length > 0) {
				summary += `: ${pending} pending, ${inProgress} in progress, ${completed} completed`;
			}
			summary +=
				". Full snapshot stored outside model context. Call todo_write with {todos:[], snapshotOmitted:true} to retrieve current state.";

			return {
				content: [{ type: "text", text: summary }],
				details: undefined,
			};
		},
	};
}

/** Default todo_write tool - requires session binding for state management */
export const todoWriteTool: AgentTool<typeof todoWriteSchema> = createTodoWriteTool(
	() => [],
	() => {},
);
