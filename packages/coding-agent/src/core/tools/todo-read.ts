import type { AgentTool } from "@apholdings/jensen-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import type { TodoItem } from "./todo-write.js";

const todoReadSchema = Type.Object({}, { description: "Read current todo list without modifying state" });

export type TodoReadInput = Static<typeof todoReadSchema>;

function formatTodoItem(todo: TodoItem): string {
	const statusMark = todo.status === "completed" ? "x" : todo.status === "in_progress" ? ">" : " ";
	return `- [${statusMark}] ${todo.status === "in_progress" ? todo.activeForm : todo.content}`;
}

export function createTodoReadTool(getSessionTodos: () => TodoItem[]): AgentTool<typeof todoReadSchema> {
	return {
		name: "todo_read",
		label: "todo_read",
		description: "Read the session's structured task/todo list state and summary without modifying it.",
		parameters: todoReadSchema,
		execute: async (_toolCallId: string, _input: TodoReadInput, _signal?: AbortSignal) => {
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
		},
	};
}

export const todoReadTool: AgentTool<typeof todoReadSchema> = createTodoReadTool(() => []);
