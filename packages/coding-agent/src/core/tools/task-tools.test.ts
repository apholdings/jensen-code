import { describe, expect, it, vi } from "vitest";
import type { Task } from "../memory.js";
import { formatTaskDetail, formatTaskList, generateTaskId, parseTasks, SESSION_TASKS_CUSTOM_TYPE } from "../memory.js";
import { SessionManager } from "../session-manager.js";
import { createTaskCreateTool, createTaskGetTool, createTaskListTool, createTaskUpdateTool } from "./task-tools.js";

describe("task model", () => {
	describe("generateTaskId", () => {
		it("generates unique IDs", () => {
			const id1 = generateTaskId();
			const id2 = generateTaskId();
			expect(id1).not.toBe(id2);
		});

		it("generates IDs with task_ prefix", () => {
			const id = generateTaskId();
			expect(id.startsWith("task_")).toBe(true);
		});
	});

	describe("parseTasks", () => {
		it("parses valid task entries", () => {
			const data = [
				{ id: "task_1", subject: "Fix bug", description: "Fix the login bug", status: "pending" },
				{ id: "task_2", subject: "Add tests", description: "Add unit tests", status: "completed" },
			];
			const tasks = parseTasks(data);
			expect(tasks).toHaveLength(2);
			expect(tasks[0].id).toBe("task_1");
			expect(tasks[0].subject).toBe("Fix bug");
			expect(tasks[0].status).toBe("pending");
			expect(tasks[1].status).toBe("completed");
		});

		it("parses optional fields", () => {
			const data = [
				{
					id: "task_1",
					subject: "Refactor",
					description: "Refactor the module",
					status: "in_progress",
					activeForm: "Refactoring the module",
					metadata: { priority: "high" },
				},
			];
			const tasks = parseTasks(data);
			expect(tasks).toHaveLength(1);
			expect(tasks[0].activeForm).toBe("Refactoring the module");
			expect(tasks[0].metadata).toEqual({ priority: "high" });
		});

		it("skips invalid entries", () => {
			const data = [
				{ id: "task_1", subject: "Valid", description: "Valid task", status: "pending" },
				{ id: 123, subject: "Invalid id" },
				{ subject: "Missing id" },
				{ id: "task_2", subject: "Invalid status", description: "x", status: "invalid" },
			];
			const tasks = parseTasks(data);
			expect(tasks).toHaveLength(1);
			expect(tasks[0].id).toBe("task_1");
		});

		it("returns empty array for non-array input", () => {
			expect(parseTasks(null)).toHaveLength(0);
			expect(parseTasks("not an array")).toHaveLength(0);
			expect(parseTasks(undefined)).toHaveLength(0);
		});
	});

	describe("formatTaskList", () => {
		it("returns 'No tasks.' for empty list", () => {
			expect(formatTaskList([])).toBe("No tasks.");
		});

		it("groups tasks by status", () => {
			const tasks: Task[] = [
				{ id: "task_1", subject: "Pending task", description: "", status: "pending" },
				{
					id: "task_2",
					subject: "In progress task",
					description: "",
					status: "in_progress",
					activeForm: "Working on it",
				},
				{ id: "task_3", subject: "Done task", description: "", status: "completed" },
			];
			const output = formatTaskList(tasks);
			expect(output).toContain("Pending (1):");
			expect(output).toContain("In Progress (1):");
			expect(output).toContain("Completed (1):");
			expect(output).toContain("[task_1] Pending task");
			expect(output).toContain("[task_2] In progress task — Working on it");
		});
	});

	describe("formatTaskDetail", () => {
		it("formats a task with all fields", () => {
			const task: Task = {
				id: "task_1",
				subject: "Build feature",
				description: "Build the new feature end-to-end",
				status: "in_progress",
				activeForm: "Building the feature",
				metadata: { estimate: "2h" },
			};
			const output = formatTaskDetail(task);
			expect(output).toContain("Task: Build feature");
			expect(output).toContain("ID: task_1");
			expect(output).toContain("Status: in_progress");
			expect(output).toContain("Active: Building the feature");
			expect(output).toContain("Build the new feature end-to-end");
		});

		it("omits activeForm when not set", () => {
			const task: Task = { id: "task_1", subject: "Simple", description: "desc", status: "pending" };
			const output = formatTaskDetail(task);
			expect(output).not.toContain("Active:");
		});
	});

	describe("task persistence via SessionManager", () => {
		it("persists and restores tasks", () => {
			const session = SessionManager.inMemory("/tmp/project");
			const tasks: Task[] = [{ id: "task_1", subject: "Persisted task", description: "desc", status: "pending" }];
			session.appendCustomEntry(SESSION_TASKS_CUSTOM_TYPE, tasks);

			const restored = session.getLatestSessionTasks();
			expect(restored).toHaveLength(1);
			expect(restored[0].id).toBe("task_1");
			expect(restored[0].subject).toBe("Persisted task");
		});

		it("getLatestSessionTasks returns empty array when no tasks exist", () => {
			const session = SessionManager.inMemory("/tmp/project");
			const tasks = session.getLatestSessionTasks();
			expect(tasks).toHaveLength(0);
		});
	});
});

describe("task_create tool", () => {
	it("creates a task with auto-generated id and pending status", async () => {
		let captured: Task[] = [];
		const getTasks = () => captured;
		const setTasks = (tasks: Task[]) => {
			captured = tasks;
		};
		const tool = createTaskCreateTool(getTasks, setTasks);

		const result = await tool.execute("call_1", {
			subject: "Implement feature X",
			description: "Build the feature from scratch",
			activeForm: "Implementing feature X",
		});

		expect(result.content[0]).toEqual({ type: "text", text: expect.stringContaining("Implement feature X") });
		expect(result.content[0]).toEqual({ type: "text", text: expect.stringContaining("pending") });
		expect(result.details?.task).toMatchObject({ subject: "Implement feature X", status: "pending" });
		expect(captured).toHaveLength(1);
		expect(captured[0].id).toMatch(/^task_/);
		expect(captured[0].subject).toBe("Implement feature X");
		expect(captured[0].status).toBe("pending");
		expect(captured[0].activeForm).toBe("Implementing feature X");
	});

	it("creates a task without optional fields", async () => {
		let captured: Task[] = [];
		const tool = createTaskCreateTool(
			() => captured,
			(t) => {
				captured = t;
			},
		);

		const result = await tool.execute("call_2", {
			subject: "Simple task",
			description: "A simple task",
		});

		expect(result.content[0]).toEqual({ type: "text", text: expect.stringContaining("Simple task") });
		expect(captured[0].activeForm).toBeUndefined();
		expect(captured[0].metadata).toBeUndefined();
	});

	it("rejects empty subject", async () => {
		const tool = createTaskCreateTool(
			() => [],
			() => {},
		);
		const result = await tool.execute("call_3", { subject: "   ", description: "" });
		expect(result.content[0]).toEqual({ type: "text", text: expect.stringContaining("subject") });
		expect(result.details).toBeUndefined();
	});
});

describe("task_list tool", () => {
	it("lists all tasks grouped by status", async () => {
		const tasks: Task[] = [
			{ id: "task_1", subject: "First", description: "", status: "pending" },
			{ id: "task_2", subject: "Second", description: "", status: "completed" },
		];
		const tool = createTaskListTool(
			() => tasks,
			() => {},
		);

		const result = await tool.execute("call_1", {});

		expect(result.content[0]).toEqual({ type: "text", text: expect.stringContaining("Pending (1)") });
		expect(result.content[0]).toEqual({ type: "text", text: expect.stringContaining("Completed (1)") });
		expect(result.details?.tasks).toHaveLength(2);
	});

	it("returns 'No tasks.' for empty list", async () => {
		const tool = createTaskListTool(
			() => [],
			() => {},
		);
		const result = await tool.execute("call_2", {});
		expect(result.content[0]).toEqual({ type: "text", text: "No tasks." });
	});

	it("includes task IDs in output", async () => {
		const tasks: Task[] = [{ id: "task_1", subject: "Task", description: "", status: "pending" }];
		const tool = createTaskListTool(
			() => tasks,
			() => {},
		);
		const result = await tool.execute("call_3", {});
		expect((result.content[0] as any).text).toContain("[task_1] Task");
	});
});

describe("task_get tool", () => {
	it("returns full task detail for valid ID", async () => {
		const tasks: Task[] = [
			{ id: "task_1", subject: "Feature", description: "Build it", status: "in_progress", activeForm: "Building" },
		];
		const tool = createTaskGetTool(
			() => tasks,
			() => {},
		);

		const result = await tool.execute("call_1", { taskId: "task_1" });

		expect((result.content[0] as any).text).toContain("Feature");
		expect((result.content[0] as any).text).toContain("task_1");
		expect((result.content[0] as any).text).toContain("in_progress");
		expect(result.details?.task).toMatchObject({ id: "task_1", subject: "Feature" });
	});

	it("returns null details for unknown ID", async () => {
		const tasks: Task[] = [{ id: "task_1", subject: "Task", description: "", status: "pending" }];
		const tool = createTaskGetTool(
			() => tasks,
			() => {},
		);

		const result = await tool.execute("call_2", { taskId: "unknown" });

		expect((result.content[0] as any).text).toContain("not found");
		expect(result.details?.task).toBeNull();
	});

	it("rejects empty taskId", async () => {
		const tool = createTaskGetTool(
			() => [],
			() => {},
		);
		const result = await tool.execute("call_3", { taskId: "   " });
		expect((result.content[0] as any).text).toContain("taskId");
	});
});

describe("task_update tool", () => {
	it("updates task status to in_progress", async () => {
		const tasks: Task[] = [{ id: "task_1", subject: "Feature", description: "desc", status: "pending" }];
		let captured = [...tasks];
		const tool = createTaskUpdateTool(
			() => captured,
			(t) => {
				captured = t;
			},
		);

		const result = await tool.execute("call_1", { taskId: "task_1", status: "in_progress" });

		expect((result.content[0] as any).text).toContain("Feature");
		expect((result.content[0] as any).text).toContain("in_progress");
		expect(captured[0].status).toBe("in_progress");
	});

	it("updates multiple fields at once", async () => {
		const tasks: Task[] = [{ id: "task_1", subject: "Old", description: "Old desc", status: "pending" }];
		let captured = [...tasks];
		const tool = createTaskUpdateTool(
			() => captured,
			(t) => {
				captured = t;
			},
		);

		await tool.execute("call_2", {
			taskId: "task_1",
			subject: "New subject",
			description: "New description",
			status: "completed",
		});

		expect(captured[0].subject).toBe("New subject");
		expect(captured[0].description).toBe("New description");
		expect(captured[0].status).toBe("completed");
	});

	it("updates activeForm when provided", async () => {
		const tasks: Task[] = [{ id: "task_1", subject: "Feature", description: "", status: "pending" }];
		let captured = [...tasks];
		const tool = createTaskUpdateTool(
			() => captured,
			(t) => {
				captured = t;
			},
		);

		await tool.execute("call_3", { taskId: "task_1", status: "in_progress", activeForm: "Working on feature" });

		expect(captured[0].activeForm).toBe("Working on feature");
	});

	it("returns error for unknown taskId", async () => {
		const tool = createTaskUpdateTool(
			() => [],
			() => {},
		);
		const result = await tool.execute("call_4", { taskId: "ghost" });
		expect((result.content[0] as any).text).toContain("not found");
	});

	it("rejects empty taskId", async () => {
		const tool = createTaskUpdateTool(
			() => [],
			() => {},
		);
		const result = await tool.execute("call_5", { taskId: "" });
		expect((result.content[0] as any).text).toContain("taskId");
	});

	it("partial update preserves unchanged fields", async () => {
		const tasks: Task[] = [
			{ id: "task_1", subject: "Original", description: "Original desc", status: "pending", activeForm: "Working" },
		];
		let captured = [...tasks];
		const tool = createTaskUpdateTool(
			() => captured,
			(t) => {
				captured = t;
			},
		);

		await tool.execute("call_6", { taskId: "task_1", status: "completed" });

		expect(captured[0].subject).toBe("Original");
		expect(captured[0].description).toBe("Original desc");
		expect(captured[0].activeForm).toBe("Working");
		expect(captured[0].status).toBe("completed");
	});
});

describe("task_update emits task_update event", () => {
	it("calls setTasks with the updated task list", async () => {
		const tasks: Task[] = [{ id: "task_1", subject: "Task", description: "", status: "pending" }];
		const setTasks = vi.fn();
		const tool = createTaskUpdateTool(() => tasks, setTasks);

		await tool.execute("call_1", { taskId: "task_1", status: "completed" });

		expect(setTasks).toHaveBeenCalledTimes(1);
		const updated = setTasks.mock.calls[0][0] as Task[];
		expect(updated).toHaveLength(1);
		expect(updated[0].status).toBe("completed");
	});
});
