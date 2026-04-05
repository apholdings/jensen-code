import { beforeAll, describe, expect, it } from "vitest";
import { initTheme } from "../theme/theme.js";
import { buildSidebarTaskData, buildSidebarTodoData, SidebarTodoPanel } from "./sidebar-todo-panel.js";

beforeAll(() => {
	initTheme("dark");
});

/**
 * These tests cover the todo list component that is mounted directly
 * beneath the Working Context panel in interactive mode. They exercise
 * both the pure data mapping from `session.getTodos()` and the renderer.
 */
describe("SidebarTodoPanel", () => {
	it("renders nothing when the panel has no data (empty state)", () => {
		const panel = new SidebarTodoPanel();
		expect(panel.render(80)).toEqual([]);
	});

	it("renders nothing after clear() (todos removed)", () => {
		const panel = new SidebarTodoPanel();
		panel.update({
			items: [{ id: "todo-0", content: "Ship it", status: "pending" }],
			totalCount: 1,
			completedCount: 0,
		});
		panel.clear();
		expect(panel.render(80)).toEqual([]);
	});

	it("renders each status (pending / in_progress / completed) with distinct markers", () => {
		const panel = new SidebarTodoPanel();
		panel.update({
			items: [
				{ id: "todo-0", content: "First task", activeForm: "Working on first task", status: "in_progress" },
				{ id: "todo-1", content: "Second task", activeForm: "Working on second task", status: "pending" },
				{ id: "todo-2", content: "Third task", activeForm: "Working on third task", status: "completed" },
			],
			totalCount: 3,
			completedCount: 1,
		});

		const lines = panel.render(80);
		// Header + 3 items
		expect(lines.length).toBeGreaterThanOrEqual(4);
		const joined = lines.join("\n");
		// Header shows progress count with the default "Todos" label
		expect(joined).toContain("Todos");
		expect(joined).toContain("1/3");
		// Status icons from sidebar-todo-panel
		expect(joined).toContain("[-]"); // in_progress
		expect(joined).toContain("[ ]"); // pending
		expect(joined).toContain("[x]"); // completed
		// in_progress renders activeForm at wider widths; pending/completed render content
		expect(joined).toContain("Working on first task");
		expect(joined).toContain("Second task");
		expect(joined).toContain("Third task");
	});

	it("sorts in_progress above pending above completed", () => {
		const panel = new SidebarTodoPanel();
		panel.update({
			items: [
				{ id: "a", content: "DONE ITEM", status: "completed" },
				{ id: "b", content: "PENDING ITEM", status: "pending" },
				{ id: "c", content: "ACTIVE ITEM", activeForm: "Doing active thing", status: "in_progress" },
			],
			totalCount: 3,
			completedCount: 1,
		});

		const lines = panel.render(80);
		// Skip leading blank spacer line; join rest for ordering checks
		const body = lines.slice(1).join("\n");
		const activeIdx = body.indexOf("Doing active thing");
		const pendingIdx = body.indexOf("PENDING ITEM");
		const doneIdx = body.indexOf("DONE ITEM");
		expect(activeIdx).toBeGreaterThanOrEqual(0);
		expect(pendingIdx).toBeGreaterThan(activeIdx);
		expect(doneIdx).toBeGreaterThan(pendingIdx);
	});
});

describe("buildSidebarTaskData", () => {
	it("returns undefined for an empty task list", () => {
		expect(buildSidebarTaskData([])).toBeUndefined();
	});

	it("maps session.getTasks() output (id/subject/activeForm/status) to SidebarTodoData", () => {
		const data = buildSidebarTaskData([
			{ id: "task_1", subject: "Fix the bug", activeForm: "Fixing the bug", status: "in_progress" },
			{ id: "task_2", subject: "Write docs", status: "pending" },
			{ id: "task_3", subject: "Ship it", activeForm: "Shipping", status: "completed" },
		]);

		expect(data).toBeDefined();
		if (!data) return;
		expect(data.totalCount).toBe(3);
		expect(data.completedCount).toBe(1);
		expect(data.items).toHaveLength(3);
		// Subjects become the panel's content field so the existing renderer works unchanged
		expect(data.items[0]).toMatchObject({
			id: "task_1",
			content: "Fix the bug",
			activeForm: "Fixing the bug",
			status: "in_progress",
		});
		// Preserves original task id (not synthetic index-based id)
		expect(data.items[1].id).toBe("task_2");
		expect(data.current?.content).toBe("Fix the bug");
	});

	it("renders through the panel end-to-end from session-shaped task data under a 'Tasks' header", () => {
		const panel = new SidebarTodoPanel({ title: "Tasks" });
		const data = buildSidebarTaskData([
			{ id: "task_1", subject: "Fix the bug", activeForm: "Fixing the bug", status: "in_progress" },
			{ id: "task_2", subject: "Write docs", status: "pending" },
		]);
		if (!data) throw new Error("expected data");
		panel.update(data);

		const joined = panel.render(80).join("\n");
		expect(joined).toContain("Tasks");
		expect(joined).toContain("0/2");
		expect(joined).toContain("Fixing the bug");
		expect(joined).toContain("Write docs");
	});
});

describe("buildSidebarTodoData", () => {
	it("returns undefined for an empty todo list", () => {
		expect(buildSidebarTodoData([])).toBeUndefined();
	});

	it("maps session.getTodos() output to SidebarTodoData", () => {
		const data = buildSidebarTodoData([
			{ content: "First task", activeForm: "Working on first task", status: "in_progress" },
			{ content: "Second task", activeForm: "Working on second task", status: "pending" },
			{ content: "Third task", activeForm: "Working on third task", status: "pending" },
		]);

		expect(data).toBeDefined();
		if (!data) return;
		expect(data.totalCount).toBe(3);
		expect(data.completedCount).toBe(0);
		expect(data.items).toHaveLength(3);
		expect(data.items[0]).toMatchObject({
			content: "First task",
			activeForm: "Working on first task",
			status: "in_progress",
		});
		expect(data.items[0].id).toBeTruthy();
		expect(data.current?.content).toBe("First task");
	});

	it("counts completed items", () => {
		const data = buildSidebarTodoData([
			{ content: "A", activeForm: "Doing A", status: "completed" },
			{ content: "B", activeForm: "Doing B", status: "completed" },
			{ content: "C", activeForm: "Doing C", status: "in_progress" },
		]);
		expect(data?.completedCount).toBe(2);
		expect(data?.totalCount).toBe(3);
	});

	it("renders with a custom title when configured (e.g. 'Tasks' vs 'Todos')", () => {
		const todoPanel = new SidebarTodoPanel({ title: "Todos" });
		const taskPanel = new SidebarTodoPanel({ title: "Tasks" });
		const data = {
			items: [{ id: "x", content: "something", status: "pending" as const }],
			totalCount: 1,
			completedCount: 0,
		};
		todoPanel.update(data);
		taskPanel.update(data);

		const todoJoined = todoPanel.render(80).join("\n");
		const taskJoined = taskPanel.render(80).join("\n");
		expect(todoJoined).toContain("Todos");
		expect(todoJoined).not.toContain("Tasks");
		expect(taskJoined).toContain("Tasks");
		expect(taskJoined).not.toContain("Todos");
	});

	it("renders through the panel end-to-end from session-shaped data", () => {
		// Simulates the exact path: session.getTodos() -> buildSidebarTodoData() -> panel.update() -> panel.render()
		const panel = new SidebarTodoPanel();
		const data = buildSidebarTodoData([
			{ content: "First task", activeForm: "Working on first task", status: "in_progress" },
			{ content: "Second task", activeForm: "Working on second task", status: "pending" },
			{ content: "Third task", activeForm: "Working on third task", status: "pending" },
		]);
		if (!data) throw new Error("expected data");
		panel.update(data);

		const lines = panel.render(80);
		expect(lines.length).toBeGreaterThan(0);
		const joined = lines.join("\n");
		expect(joined).toContain("0/3");
		expect(joined).toContain("Working on first task");
		expect(joined).toContain("Second task");
		expect(joined).toContain("Third task");
	});
});
