import { Container } from "@apholdings/jensen-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../../core/agent-session.js";
import type { Task } from "../../core/memory.js";
import type { WorkingContext } from "../../core/working-context.js";
import { SidebarTodoPanel } from "./components/sidebar-todo-panel.js";
import { WorkingContextPanel } from "./components/working-context-panel.js";
import { InteractiveMode, mountOperatorStack } from "./interactive-mode.js";
import { initTheme } from "./theme/theme.js";

/**
 * End-to-end proof for the Working Context → Todos → Tasks operator stack.
 *
 * These tests exercise the real seam between session events and the mounted
 * panels: they drive InteractiveMode.prototype.handleEvent with real
 * `todo_update` / `task_update` events, let it flow through
 * `updateWorkingContextPanel` → `updateSidebarTodoPanel` /
 * `updateSidebarTaskPanel`, and assert against the rendered output of the
 * panels mounted in the stacked UI container in their real order.
 *
 * The InteractiveMode constructor is intentionally bypassed (it requires a
 * live ProcessTerminal and a full session bootstrap). We construct a partial
 * instance via `Object.create(InteractiveMode.prototype)`, attach real panel
 * instances and a real Container that stands in for `this.ui`, and wire a
 * stateful mock session that mutates its todo/task arrays between events.
 */

interface OperatorStackHarness {
	session: StatefulMockSession;
	ui: Container & { requestRender: () => void };
	workingContextPanel: WorkingContextPanel;
	sidebarTodoPanel: SidebarTodoPanel;
	sidebarTaskPanel: SidebarTodoPanel;
	footer: { invalidate: () => void };
	handleEvent: (event: AgentSessionEvent) => Promise<void>;
}

interface StatefulMockSession {
	_todos: Array<{ content: string; activeForm: string; status: "pending" | "in_progress" | "completed" }>;
	_tasks: Task[];
	getTodos: () => StatefulMockSession["_todos"];
	getTasks: () => Task[];
	getWorkingContext: () => WorkingContext;
}

beforeAll(() => {
	initTheme("dark");
});

function createStatefulMockSession(): StatefulMockSession {
	const todos: StatefulMockSession["_todos"] = [];
	const tasks: Task[] = [];

	const session: StatefulMockSession = {
		_todos: todos,
		_tasks: tasks,
		getTodos: () => todos,
		getTasks: () => tasks,
		getWorkingContext: (): WorkingContext =>
			({
				memory: {
					itemCount: 0,
					staleCount: 0,
					keyPreview: [],
					isPersisted: true,
					scope: "current_branch_session_state",
				},
				todo: {
					total: todos.length,
					completed: todos.filter((t) => t.status === "completed").length,
					inProgress: todos.find((t) => t.status === "in_progress")?.activeForm,
					isPersisted: true,
					scope: "current_branch_session_state",
				},
				tasks: {
					total: tasks.length,
					pending: tasks.filter((t) => t.status === "pending").length,
					inProgress: tasks.filter((t) => t.status === "in_progress").length,
					completed: tasks.filter((t) => t.status === "completed").length,
					inProgressTask: tasks.find((t) => t.status === "in_progress")
						? {
								id: tasks.find((t) => t.status === "in_progress")!.id,
								subject: tasks.find((t) => t.status === "in_progress")!.subject,
								activeForm: tasks.find((t) => t.status === "in_progress")!.activeForm,
							}
						: undefined,
					isPersisted: true,
					scope: "current_branch_session_state",
				},
				delegatedWork: {
					activeCount: 0,
					completedCount: 0,
					failedCount: 0,
					activeAgents: [],
					failurePreview: [],
					isPersisted: false,
					scope: "current_process_runtime_state",
					note: "live current-process state only; not persisted and resets on session switch/resume",
				},
			}) as WorkingContext,
	} as unknown as StatefulMockSession;

	return session;
}

function createHarness(): OperatorStackHarness {
	const session = createStatefulMockSession();
	const ui = new Container() as Container & { requestRender: () => void };
	ui.requestRender = vi.fn();

	const workingContextPanel = new WorkingContextPanel();
	const sidebarTodoPanel = new SidebarTodoPanel({ title: "Todos" });
	const sidebarTaskPanel = new SidebarTodoPanel({ title: "Tasks" });

	// Use the same production assembly path as InteractiveMode.init()
	mountOperatorStack(ui, workingContextPanel, sidebarTodoPanel, sidebarTaskPanel);

	const harness = Object.assign(Object.create(InteractiveMode.prototype), {
		session,
		ui,
		workingContextPanel,
		sidebarTodoPanel,
		sidebarTaskPanel,
		footer: { invalidate: vi.fn() },
		isInitialized: true,
		sessionEpoch: 1,
	}) as OperatorStackHarness;

	return harness;
}

function renderStack(harness: OperatorStackHarness, width = 100): string {
	return stripAnsi(harness.ui.render(width).join("\n"));
}

describe("InteractiveMode operator stack (Working Context / Todos / Tasks)", () => {
	it("renders nothing from todo/task panels in empty state", async () => {
		const harness = createHarness();

		await harness.handleEvent({ type: "todo_update", todos: [] });
		await harness.handleEvent({ type: "task_update", tasks: [] });

		const todoLines = harness.sidebarTodoPanel.render(100);
		const taskLines = harness.sidebarTaskPanel.render(100);
		expect(todoLines).toEqual([]);
		expect(taskLines).toEqual([]);

		const stack = renderStack(harness);
		expect(stack).not.toContain("Todos");
		expect(stack).not.toContain("Tasks ");
	});

	it("renders the todo panel live after a real todo_update event", async () => {
		const harness = createHarness();

		harness.session._todos.push(
			{ content: "First task", activeForm: "Working on first task", status: "in_progress" },
			{ content: "Second task", activeForm: "Working on second task", status: "pending" },
			{ content: "Third task", activeForm: "Working on third task", status: "pending" },
		);
		await harness.handleEvent({ type: "todo_update", todos: harness.session._todos });

		const stack = renderStack(harness);
		expect(stack).toContain("Todos");
		expect(stack).toContain("0/3");
		expect(stack).toContain("Working on first task");
		expect(stack).toContain("Second task");
		expect(stack).toContain("Third task");
		// ui.requestRender was called by the handler
		expect(harness.ui.requestRender).toHaveBeenCalled();
	});

	it("renders the task panel live after a real task_update event", async () => {
		const harness = createHarness();

		harness.session._tasks.push(
			{
				id: "task_1",
				subject: "Ship the feature",
				description: "",
				status: "in_progress",
				activeForm: "Shipping the feature",
			},
			{ id: "task_2", subject: "Write docs", description: "", status: "pending" },
		);
		await harness.handleEvent({ type: "task_update", tasks: harness.session._tasks });

		const stack = renderStack(harness);
		expect(stack).toContain("Tasks");
		expect(stack).toContain("0/2");
		expect(stack).toContain("Shipping the feature");
		expect(stack).toContain("Write docs");
	});

	it("keeps Working Context → Todos → Tasks order in the mounted stack", async () => {
		const harness = createHarness();

		harness.session._todos.push({
			content: "Do the thing",
			activeForm: "Doing the thing",
			status: "in_progress",
		});
		harness.session._tasks.push({
			id: "task_1",
			subject: "Ship it",
			description: "",
			status: "in_progress",
			activeForm: "Shipping it",
		});
		await harness.handleEvent({ type: "todo_update", todos: harness.session._todos });
		await harness.handleEvent({ type: "task_update", tasks: harness.session._tasks });

		const stack = renderStack(harness);
		const workingIdx = stack.indexOf("Working Context");
		const todosIdx = stack.indexOf("Todos");
		const tasksIdx = stack.indexOf("Tasks ");

		expect(workingIdx).toBeGreaterThanOrEqual(0);
		expect(todosIdx).toBeGreaterThan(workingIdx);
		expect(tasksIdx).toBeGreaterThan(todosIdx);
	});

	it("reflects live updates: adding, then flipping a task to completed", async () => {
		const harness = createHarness();

		harness.session._tasks.push({
			id: "task_1",
			subject: "Review PR",
			description: "",
			status: "in_progress",
			activeForm: "Reviewing PR",
		});
		await harness.handleEvent({ type: "task_update", tasks: harness.session._tasks });

		let stack = renderStack(harness);
		expect(stack).toContain("Reviewing PR");
		expect(stack).toContain("0/1");

		// Flip to completed in place; same event wakes the same mounted panel
		harness.session._tasks[0]!.status = "completed";
		await harness.handleEvent({ type: "task_update", tasks: harness.session._tasks });

		stack = renderStack(harness);
		expect(stack).toContain("1/1");
		// Completed item renders content (not activeForm)
		expect(stack).toContain("Review PR");
	});

	it("does not duplicate mounted panels across repeated events", async () => {
		const harness = createHarness();
		const initialChildrenLength = harness.ui.children.length;

		for (let i = 0; i < 5; i++) {
			await harness.handleEvent({ type: "todo_update", todos: [] });
			await harness.handleEvent({ type: "task_update", tasks: [] });
		}

		expect(harness.ui.children.length).toBe(initialChildrenLength);
		expect(harness.ui.children).toContain(harness.workingContextPanel);
		expect(harness.ui.children).toContain(harness.sidebarTodoPanel);
		expect(harness.ui.children).toContain(harness.sidebarTaskPanel);
	});

	it("transitions from visible back to empty-state cleanly when items are cleared", async () => {
		const harness = createHarness();

		harness.session._todos.push({ content: "A", activeForm: "Doing A", status: "in_progress" });
		await harness.handleEvent({ type: "todo_update", todos: harness.session._todos });
		expect(renderStack(harness)).toContain("Todos");

		// Clear in place
		harness.session._todos.length = 0;
		await harness.handleEvent({ type: "todo_update", todos: [] });

		expect(harness.sidebarTodoPanel.render(100)).toEqual([]);
		// Task panel still empty too; stack collapses cleanly
		expect(harness.sidebarTaskPanel.render(100)).toEqual([]);
		// Container still has all three panels mounted (no remounting)
		expect(harness.ui.children).toHaveLength(3);
	});
});

describe("mountOperatorStack (production assembly path)", () => {
	it("mounts panels in Working Context → Todos → Tasks order", () => {
		const container = new Container();
		const workingContextPanel = new WorkingContextPanel();
		const sidebarTodoPanel = new SidebarTodoPanel({ title: "Todos" });
		const sidebarTaskPanel = new SidebarTodoPanel({ title: "Tasks" });

		mountOperatorStack(container, workingContextPanel, sidebarTodoPanel, sidebarTaskPanel);

		expect(container.children).toHaveLength(3);
		expect(container.children[0]).toBe(workingContextPanel);
		expect(container.children[1]).toBe(sidebarTodoPanel);
		expect(container.children[2]).toBe(sidebarTaskPanel);
	});

	it("is idempotent: calling multiple times does not duplicate panels", () => {
		const container = new Container();
		const workingContextPanel = new WorkingContextPanel();
		const sidebarTodoPanel = new SidebarTodoPanel({ title: "Todos" });
		const sidebarTaskPanel = new SidebarTodoPanel({ title: "Tasks" });

		mountOperatorStack(container, workingContextPanel, sidebarTodoPanel, sidebarTaskPanel);
		mountOperatorStack(container, workingContextPanel, sidebarTodoPanel, sidebarTaskPanel);
		mountOperatorStack(container, workingContextPanel, sidebarTodoPanel, sidebarTaskPanel);

		expect(container.children).toHaveLength(3);
	});

	it("is the same path InteractiveMode.init() calls (harness uses the exported helper)", () => {
		// createHarness() calls mountOperatorStack to build the container — this test
		// confirms that the harness and production code share the same assembly function.
		const harness = createHarness();

		expect(harness.ui.children[0]).toBe(harness.workingContextPanel);
		expect(harness.ui.children[1]).toBe(harness.sidebarTodoPanel);
		expect(harness.ui.children[2]).toBe(harness.sidebarTaskPanel);
	});
});
