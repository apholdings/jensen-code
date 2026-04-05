import { Container } from "@apholdings/jensen-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent, AgentSessionEventListener } from "../../core/agent-session.js";
import type { Task } from "../../core/memory.js";
import type { WorkingContext } from "../../core/working-context.js";
import { SidebarTodoPanel } from "./components/sidebar-todo-panel.js";
import { WorkingContextPanel } from "./components/working-context-panel.js";
import { InteractiveMode, mountOperatorStack } from "./interactive-mode.js";
import { initTheme } from "./theme/theme.js";

/**
 * Proof for the subscribe indirection seam.
 *
 * The operator-stack tests already prove handleEvent → panels. These tests prove
 * the real path one level up: subscribeToAgent() → session.subscribe() → listener
 * → handleEvent() → panels.
 *
 * subscribeToAgent() is called once inside init() (interactive-mode.ts:1355).
 * init() is double-guarded (isInitialized + initializing) so it can never run
 * twice for the same InteractiveMode instance. The stored this.unsubscribe
 * function splices the listener out of the session's listener array on demand.
 * The sessionEpoch check at the top of handleEvent drops events that were
 * captured under a different epoch (stale-session guard).
 */

beforeAll(() => {
	initTheme("dark");
});

/** Minimal session with real subscribe/unsubscribe semantics and a test emit helper. */
class SubscribableMockSession {
	readonly listeners: AgentSessionEventListener[] = [];

	_todos: Array<{ content: string; activeForm: string; status: "pending" | "in_progress" | "completed" }> = [];
	_tasks: Task[] = [];

	subscribe(listener: AgentSessionEventListener): () => void {
		this.listeners.push(listener);
		return () => {
			const i = this.listeners.indexOf(listener);
			if (i !== -1) this.listeners.splice(i, 1);
		};
	}

	/** Emit an event and await all listener promises (listeners are async). */
	async emit(event: AgentSessionEvent): Promise<void> {
		await Promise.all(this.listeners.map((l) => l(event)));
	}

	getTodos() {
		return this._todos;
	}

	getTasks(): Task[] {
		return this._tasks;
	}

	getWorkingContext(): WorkingContext {
		const todos = this._todos;
		const tasks = this._tasks;
		return {
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
		} as WorkingContext;
	}
}

interface SubscribeHarness {
	mode: {
		sessionEpoch: number;
		isInitialized: boolean;
		unsubscribe: (() => void) | undefined;
		init: () => Promise<void>;
	};
	session: SubscribableMockSession;
	ui: Container & { requestRender: () => void };
	workingContextPanel: WorkingContextPanel;
	sidebarTodoPanel: SidebarTodoPanel;
	sidebarTaskPanel: SidebarTodoPanel;
}

function createSubscribeHarness(): SubscribeHarness {
	const session = new SubscribableMockSession();
	const ui = new Container() as Container & { requestRender: () => void };
	ui.requestRender = vi.fn();

	const workingContextPanel = new WorkingContextPanel();
	const sidebarTodoPanel = new SidebarTodoPanel({ title: "Todos" });
	const sidebarTaskPanel = new SidebarTodoPanel({ title: "Tasks" });

	mountOperatorStack(ui, workingContextPanel, sidebarTodoPanel, sidebarTaskPanel);

	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		session,
		ui,
		workingContextPanel,
		sidebarTodoPanel,
		sidebarTaskPanel,
		footer: { invalidate: vi.fn() },
		isInitialized: true,
		sessionEpoch: 1,
		unsubscribe: undefined,
	}) as SubscribeHarness["mode"];

	return { mode, session, ui, workingContextPanel, sidebarTodoPanel, sidebarTaskPanel };
}

function renderStack(harness: SubscribeHarness, width = 100): string {
	return stripAnsi(harness.ui.render(width).join("\n"));
}

describe("InteractiveMode subscribe wiring (subscribeToAgent → session.subscribe → handleEvent → panels)", () => {
	it("subscribeToAgent registers exactly one listener on the session", () => {
		const { mode, session } = createSubscribeHarness();

		expect(session.listeners).toHaveLength(0);
		(mode as unknown as { subscribeToAgent(): void }).subscribeToAgent();
		expect(session.listeners).toHaveLength(1);
		expect(mode.unsubscribe).toBeTypeOf("function");
	});

	it("todo_update emitted through subscribe path reaches handleEvent and updates the todo panel", async () => {
		const { mode, session, sidebarTodoPanel } = createSubscribeHarness();
		(mode as unknown as { subscribeToAgent(): void }).subscribeToAgent();

		session._todos.push(
			{ content: "First task", activeForm: "Working on first task", status: "in_progress" },
			{ content: "Second task", activeForm: "", status: "pending" },
		);
		await session.emit({ type: "todo_update", todos: session._todos });

		const rendered = stripAnsi(sidebarTodoPanel.render(100).join("\n"));
		expect(rendered).toContain("Todos");
		expect(rendered).toContain("Working on first task");
		expect(rendered).toContain("Second task");
	});

	it("task_update emitted through subscribe path reaches handleEvent and updates the task panel", async () => {
		const { mode, session, sidebarTaskPanel } = createSubscribeHarness();
		(mode as unknown as { subscribeToAgent(): void }).subscribeToAgent();

		session._tasks.push(
			{ id: "t1", subject: "Ship feature", description: "", status: "in_progress", activeForm: "Shipping feature" },
			{ id: "t2", subject: "Write docs", description: "", status: "pending" },
		);
		await session.emit({ type: "task_update", tasks: session._tasks });

		const rendered = stripAnsi(sidebarTaskPanel.render(100).join("\n"));
		expect(rendered).toContain("Tasks");
		expect(rendered).toContain("Shipping feature");
		expect(rendered).toContain("Write docs");
	});

	it("both panels update from a single subscribe path emission (full stack)", async () => {
		const harness = createSubscribeHarness();
		(harness.mode as unknown as { subscribeToAgent(): void }).subscribeToAgent();

		harness.session._todos.push({ content: "Todo item", activeForm: "Doing it", status: "in_progress" });
		harness.session._tasks.push({
			id: "t1",
			subject: "Task item",
			description: "",
			status: "in_progress",
			activeForm: "Doing task",
		});

		await harness.session.emit({ type: "todo_update", todos: harness.session._todos });
		await harness.session.emit({ type: "task_update", tasks: harness.session._tasks });

		const stack = renderStack(harness);
		expect(stack).toContain("Todos");
		expect(stack).toContain("Tasks");
		expect(stack).toContain("Doing it");
		expect(stack).toContain("Doing task");
	});

	it("unsubscribe removes the listener and subsequent events are not delivered to panels", async () => {
		const { mode, session, sidebarTodoPanel } = createSubscribeHarness();
		(mode as unknown as { subscribeToAgent(): void }).subscribeToAgent();

		expect(session.listeners).toHaveLength(1);

		// Call the stored unsubscribe function
		mode.unsubscribe!();
		expect(session.listeners).toHaveLength(0);

		// Emit after unsubscribe — panel must stay empty
		session._todos.push({ content: "Should not appear", activeForm: "Working", status: "in_progress" });
		await session.emit({ type: "todo_update", todos: session._todos });

		expect(sidebarTodoPanel.render(100)).toEqual([]);
	});

	it("stale event is dropped when sessionEpoch changes during async init", async () => {
		const { mode, session, sidebarTodoPanel } = createSubscribeHarness();

		// Start uninitialized so handleEvent will await init()
		mode.isInitialized = false;
		mode.sessionEpoch = 1;

		// Replace init with a mock that increments epoch before yielding — simulates a
		// session switch arriving while a previous event is waiting for initialization.
		let initResolve!: () => void;
		const initBarrier = new Promise<void>((res) => {
			initResolve = res;
		});
		(mode as unknown as { init(): Promise<void> }).init = async () => {
			mode.sessionEpoch++; // epoch now 2; event captured epoch 1 → will be dropped
			mode.isInitialized = true;
			await initBarrier;
		};

		(mode as unknown as { subscribeToAgent(): void }).subscribeToAgent();

		session._todos.push({ content: "Stale todo", activeForm: "Working", status: "in_progress" });

		// Emit fires the async listener; it awaits init() which increments epoch then
		// blocks on initBarrier. We resolve the barrier so handleEvent can finish.
		const emitPromise = session.emit({ type: "todo_update", todos: session._todos });
		initResolve();
		await emitPromise;

		// Panel must remain empty: epoch mismatch caused handleEvent to return early
		expect(sidebarTodoPanel.render(100)).toEqual([]);
	});

	it("calling subscribeToAgent twice leaves exactly one live listener (idempotent via unsubscribe-before-resubscribe)", () => {
		// subscribeToAgent() calls this.unsubscribe?.() before registering a new listener,
		// so a second call splices out the first listener and registers a fresh one.
		// Exactly one listener remains active regardless of how many times it is called.
		const { mode, session } = createSubscribeHarness();

		(mode as unknown as { subscribeToAgent(): void }).subscribeToAgent();
		(mode as unknown as { subscribeToAgent(): void }).subscribeToAgent();

		expect(session.listeners).toHaveLength(1);
	});

	it("double subscribeToAgent does not duplicate event delivery to panels", async () => {
		const { mode, session, sidebarTodoPanel } = createSubscribeHarness();

		(mode as unknown as { subscribeToAgent(): void }).subscribeToAgent();
		(mode as unknown as { subscribeToAgent(): void }).subscribeToAgent();

		// Only one listener remains; emitting once should update the panel exactly once.
		// If two listeners were present, the panel would still render correctly but
		// handleEvent would run twice — this proves it runs only once per emit.
		session._todos.push({ content: "Dedup check", activeForm: "Running dedup check", status: "in_progress" });
		await session.emit({ type: "todo_update", todos: session._todos });

		const rendered = stripAnsi(sidebarTodoPanel.render(100).join("\n"));
		expect(rendered).toContain("Running dedup check");
		expect(session.listeners).toHaveLength(1);
	});
});
