import type { AgentTool } from "@apholdings/jensen-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { formatTaskDetail, formatTaskList, generateTaskId, type Task, type TaskStatus } from "../memory.js";

// Re-export Task for consumers of this module (e.g., agent-session.ts)
export type { Task } from "../memory.js";

// ============================================================================
// Tool Schemas
// ============================================================================

/** Schema for task_create */
const taskCreateSchema = Type.Object({
	subject: Type.String({ description: "Brief title/subject of the task (required)" }),
	description: Type.String({ description: "Detailed description of what the task involves" }),
	activeForm: Type.Optional(
		Type.String({ description: "Active-form phrasing when task is in_progress (e.g., 'Implementing feature X')" }),
	),
	metadata: Type.Optional(
		Type.Record(Type.String({}), Type.Unknown(), { description: "Optional free-form metadata" }),
	),
});

/** Schema for task_list */
const taskListSchema = Type.Object({});

/** Schema for task_get */
const taskGetSchema = Type.Object({
	taskId: Type.String({ description: "The unique ID of the task to retrieve" }),
});

/** Schema for task_update */
const taskUpdateSchema = Type.Object({
	taskId: Type.String({ description: "The unique ID of the task to update" }),
	subject: Type.Optional(Type.String({ description: "New subject/title for the task" })),
	description: Type.Optional(Type.String({ description: "New description for the task" })),
	status: Type.Optional(
		Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")], {
			description: "New status for the task",
		}),
	),
	activeForm: Type.Optional(Type.String({ description: "New active-form phrasing for in_progress display" })),
	metadata: Type.Optional(
		Type.Record(Type.String({}), Type.Unknown(), {
			description: "Replacement metadata object (merges if not provided)",
		}),
	),
});

export type TaskCreateInputParsed = Static<typeof taskCreateSchema>;
export type TaskListInputParsed = Static<typeof taskListSchema>;
export type TaskGetInputParsed = Static<typeof taskGetSchema>;
export type TaskUpdateInputParsed = Static<typeof taskUpdateSchema>;

// ============================================================================
// Tool Factories
// ============================================================================

/** Callback to get the current task list from session */
type GetTasksCallback = () => Task[];
/** Callback to set tasks in session and trigger update event */
type SetTasksCallback = (tasks: Task[]) => void;

/**
 * Create the task_create tool.
 */
export function createTaskCreateTool(
	getTasks: GetTasksCallback,
	_setTasks: SetTasksCallback,
): AgentTool<typeof taskCreateSchema> {
	return {
		name: "task_create",
		label: "task_create",
		description:
			"Create a structured task for multi-step work tracking. Use when work is multi-step, should be tracked explicitly, or spans multiple sessions.",
		parameters: taskCreateSchema,
		execute: async (_toolCallId: string, params: TaskCreateInputParsed) => {
			if (!params.subject?.trim()) {
				return {
					content: [{ type: "text", text: "Error: subject is required and must be non-empty." }],
					details: undefined,
				};
			}

			const newTask: Task = {
				id: generateTaskId(),
				subject: params.subject.trim(),
				description: params.description?.trim() ?? "",
				status: "pending",
				activeForm: params.activeForm?.trim() || undefined,
				metadata: params.metadata,
			};

			const currentTasks = getTasks();
			const updatedTasks = [...currentTasks, newTask];
			_setTasks(updatedTasks);

			return {
				content: [
					{
						type: "text",
						text: `Created task "${newTask.subject}" [${newTask.id}] (status: pending)`,
					},
				],
				details: { task: { id: newTask.id, subject: newTask.subject, status: newTask.status } },
			};
		},
	};
}

/**
 * Create the task_list tool.
 */
export function createTaskListTool(
	getTasks: GetTasksCallback,
	_setTasks: SetTasksCallback,
): AgentTool<typeof taskListSchema> {
	return {
		name: "task_list",
		label: "task_list",
		description: "List all structured tasks with their current status. Returns a summary view grouped by status.",
		parameters: taskListSchema,
		execute: async (_toolCallId: string, _params: TaskListInputParsed) => {
			const tasks = getTasks();
			const summary = formatTaskList(tasks);
			return {
				content: [{ type: "text", text: summary }],
				details: { tasks: tasks.map((t) => ({ id: t.id, subject: t.subject, status: t.status })) },
			};
		},
	};
}

/**
 * Create the task_get tool.
 */
export function createTaskGetTool(
	getTasks: GetTasksCallback,
	_setTasks: SetTasksCallback,
): AgentTool<typeof taskGetSchema> {
	return {
		name: "task_get",
		label: "task_get",
		description:
			"Retrieve full details of a specific task by its ID. Returns subject, description, status, activeForm, and metadata.",
		parameters: taskGetSchema,
		execute: async (_toolCallId: string, params: TaskGetInputParsed) => {
			if (!params.taskId?.trim()) {
				return {
					content: [{ type: "text", text: "Error: taskId is required." }],
					details: undefined,
				};
			}

			const tasks = getTasks();
			const task = tasks.find((t) => t.id === params.taskId.trim());

			if (!task) {
				return {
					content: [{ type: "text", text: `Task not found: ${params.taskId}` }],
					details: { task: null },
				};
			}

			return {
				content: [{ type: "text", text: formatTaskDetail(task) }],
				details: { task },
			};
		},
	};
}

/**
 * Create the task_update tool.
 */
export function createTaskUpdateTool(
	getTasks: GetTasksCallback,
	setTasks: SetTasksCallback,
): AgentTool<typeof taskUpdateSchema> {
	return {
		name: "task_update",
		label: "task_update",
		description:
			"Update one or more fields of an existing task. Update status as work progresses or completes. Use task_get first if you need the current state before updating.",
		parameters: taskUpdateSchema,
		execute: async (_toolCallId: string, params: TaskUpdateInputParsed) => {
			if (!params.taskId?.trim()) {
				return {
					content: [{ type: "text", text: "Error: taskId is required." }],
					details: undefined,
				};
			}

			const tasks = getTasks();
			const index = tasks.findIndex((t) => t.id === params.taskId.trim());

			if (index === -1) {
				return {
					content: [{ type: "text", text: `Task not found: ${params.taskId}` }],
					details: undefined,
				};
			}

			const existing = tasks[index];
			const updated: Task = {
				...existing,
				...(params.subject !== undefined ? { subject: params.subject.trim() } : {}),
				...(params.description !== undefined ? { description: params.description.trim() } : {}),
				...(params.status !== undefined ? { status: params.status as TaskStatus } : {}),
				...(params.activeForm !== undefined ? { activeForm: params.activeForm.trim() || undefined } : {}),
				...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
			};

			const updatedTasks = [...tasks];
			updatedTasks[index] = updated;
			setTasks(updatedTasks);

			return {
				content: [
					{
						type: "text",
						text: `Updated task "${updated.subject}" [${updated.id}] (status: ${updated.status})`,
					},
				],
				details: { task: { id: updated.id, subject: updated.subject, status: updated.status } },
			};
		},
	};
}
