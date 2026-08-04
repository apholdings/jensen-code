import type { AgentTool } from "@apholdings/jensen-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { TodoEngine, type TodoItem } from "../todo/index.js";

const todoReadSchema = Type.Object({}, { description: "Read current todo list without modifying state" });

export type TodoReadInput = Static<typeof todoReadSchema>;

function formatTodoItem(todo: TodoItem): string {
	const statusMark = todo.status === "completed" ? "x" : todo.status === "in_progress" ? ">" : " ";
	return `- [${statusMark}] ${todo.status === "in_progress" ? todo.activeForm : todo.content}  (id: ${todo.id})`;
}

export interface TodoReadOptions {
	/** Called after a successful read to record the read snapshot */
	onRead?: () => void;
}

/**
 * Create the todo_read tool.
 * @param getSessionTodos - Callback to get the current todos from session
 * @param getRevision - Callback to get the current revision number
 * @param options - Optional callbacks for snapshot tracking
 * @param engine - Optional shared TodoEngine (records read snapshots + progress)
 */
export function createTodoReadTool(
	getSessionTodos: () => TodoItem[],
	getRevision?: () => number,
	options?: TodoReadOptions,
	engine: TodoEngine = new TodoEngine("session"),
): AgentTool<typeof todoReadSchema> {
	return {
		name: "todo_read",
		label: "todo_read",
		description:
			"Read the session's structured task/todo list state and summary without modifying it. " +
			"Returns stable IDs and current revision for use with todo_update. " +
			"Use todo_update for progress transitions, not todo_write.",
		parameters: todoReadSchema,
		execute: async (_toolCallId: string, _input: TodoReadInput, _signal?: AbortSignal) => {
			const current = getSessionTodos();
			const revision = getRevision?.();
			engine.emit({ type: "TODO_STATE_READ", currentRevision: revision });
			// Record the read snapshot for internal rebase + progress-aware loop reset.
			if (revision !== undefined) {
				engine.recordReadSnapshot(revision, current);
				engine.recordTodoRead(revision);
			}
			// Record the read snapshot for host-side enforcement
			options?.onRead?.();
			if (current.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "Todo list is empty. Current todo state retrieved. Use todo_write to create a new plan.",
						},
					],
					details: { todos: [], revision },
				};
			}
			const lines = current.map(formatTodoItem);
			const pending = current.filter((t) => t.status === "pending").length;
			const inProgress = current.filter((t) => t.status === "in_progress").length;
			const completed = current.filter((t) => t.status === "completed").length;
			const header = `Current todo list (${current.length} total, revision ${revision}): ${pending} pending, ${inProgress} in progress, ${completed} completed.`;
			return {
				content: [
					{
						type: "text",
						text: `${header}\n${lines.join("\n")}\n\nCurrent todo state retrieved. Use todo_update for progress transitions.`,
					},
				],
				details: {
					todos: current.map((t) => ({
						id: t.id,
						content: t.content,
						activeForm: t.activeForm,
						status: t.status,
					})),
					revision,
				},
			};
		},
	};
}

export const todoReadTool: AgentTool<typeof todoReadSchema> = createTodoReadTool(() => []);
