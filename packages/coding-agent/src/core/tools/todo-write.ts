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
});

export type TodoWriteInput = Static<typeof todoWriteSchema>;

/** Todo item stored in session state */
export interface TodoItem {
	content: string;
	activeForm: string;
	status: "pending" | "in_progress" | "completed";
}

/**
 * Create the todo_write tool.
 * @param _getSessionTodos - Callback to get the current todos from session (reserved for future use)
 * @param setSessionTodos - Callback to set todos in session and trigger update event
 */
export function createTodoWriteTool(
	_getSessionTodos: () => TodoItem[],
	setSessionTodos: (todos: TodoItem[]) => void,
): AgentTool<typeof todoWriteSchema> {
	return {
		name: "todo_write",
		label: "todo_write",
		description:
			"Update the session's structured task/todo list. Use proactively for multi-step tasks. Full list replacement each call.",
		parameters: todoWriteSchema,
		execute: async (_toolCallId: string, { todos }: { todos: TodoItem[] }, _signal?: AbortSignal) => {
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
