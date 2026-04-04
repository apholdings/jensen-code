import { describe, expect, it } from "vitest";
import type { DelegatedTask, DelegatedWorkSummary } from "./delegated-work.js";
import type { MemoryItem } from "./memory.js";
import {
	buildWorkingContext,
	buildWorkingContextDelegatedWorkSummary,
	buildWorkingContextMemorySummary,
	buildWorkingContextTodoSummary,
	type WorkingContext,
} from "./working-context.js";

type TodoItem = { content: string; activeForm: string; status: "pending" | "in_progress" | "completed" };

function makeMemoryItem(key: string, timestamp = "2026-04-01T12:00:00.000Z"): MemoryItem {
	return { key, value: `${key} value`, timestamp };
}

function makeTodoItem(id: string, status: "pending" | "in_progress" | "completed", activeForm?: string): TodoItem {
	return {
		content: id,
		status,
		activeForm: activeForm ?? id,
	};
}

function makeDelegatedTask(agent: string, status: "active" | "completed" | "error" | "blocked"): DelegatedTask {
	return {
		toolCallId: `call_${agent}`,
		agent,
		agentSource: "user",
		task: `Task for ${agent}`,
		mode: "single",
		status,
		timestamp: Date.now(),
	};
}

function makeDelegatedWorkSummary(tasks: DelegatedTask[]): DelegatedWorkSummary {
	const active = tasks.filter((t) => t.status === "active");
	const completed = tasks.filter((t) => t.status === "completed");
	const failed = tasks.filter((t) => t.status === "error" || t.status === "blocked");

	return {
		active,
		completed,
		failed,
		total: tasks.length,
		isSessionState: true,
		note: "ephemeral current-session state; not persisted across sessions or branches",
	};
}

describe("buildWorkingContextMemorySummary", () => {
	it("returns zero-count summary for empty memory items", () => {
		const result = buildWorkingContextMemorySummary([]);
		expect(result).toEqual({
			itemCount: 0,
			staleCount: 0,
			keyPreview: [],
			isPersisted: true,
			scope: "current_branch_session_state",
		});
	});

	it("returns summary with correct counts", () => {
		const items: MemoryItem[] = [makeMemoryItem("alpha"), makeMemoryItem("beta"), makeMemoryItem("gamma")];

		const result = buildWorkingContextMemorySummary(items);
		expect(result).toEqual({
			itemCount: 3,
			staleCount: 0,
			keyPreview: ["alpha", "beta", "gamma"],
			isPersisted: true,
			scope: "current_branch_session_state",
		});
	});

	it("limits key preview to 4 items", () => {
		const items: MemoryItem[] = [
			makeMemoryItem("a"),
			makeMemoryItem("b"),
			makeMemoryItem("c"),
			makeMemoryItem("d"),
			makeMemoryItem("e"),
			makeMemoryItem("f"),
		];

		const result = buildWorkingContextMemorySummary(items);
		expect(result?.keyPreview).toEqual(["a", "b", "c", "d"]);
		expect(result?.itemCount).toBe(6);
	});

	it("marks memory as persisted", () => {
		const result = buildWorkingContextMemorySummary([makeMemoryItem("test")]);
		expect(result?.isPersisted).toBe(true);
	});
});

describe("buildWorkingContextTodoSummary", () => {
	it("returns zero-count summary for empty todos", () => {
		const result = buildWorkingContextTodoSummary([]);
		expect(result).toEqual({
			total: 0,
			completed: 0,
			isPersisted: true,
			scope: "current_branch_session_state",
		});
	});

	it("returns summary with correct counts", () => {
		const todos: TodoItem[] = [
			makeTodoItem("task1", "completed", "Completed task"),
			makeTodoItem("task2", "in_progress", "In-progress task"),
			makeTodoItem("task3", "pending"),
			makeTodoItem("task4", "pending"),
		];

		const result = buildWorkingContextTodoSummary(todos);
		expect(result).toEqual({
			total: 4,
			completed: 1,
			inProgress: "In-progress task",
			isPersisted: true,
			scope: "current_branch_session_state",
		});
	});

	it("marks todos as persisted", () => {
		const result = buildWorkingContextTodoSummary([makeTodoItem("task1", "pending")]);
		expect(result?.isPersisted).toBe(true);
	});
});

describe("buildWorkingContextDelegatedWorkSummary", () => {
	it("returns zero-count delegated summary for empty delegated work", () => {
		const summary = makeDelegatedWorkSummary([]);
		const result = buildWorkingContextDelegatedWorkSummary(summary);
		expect(result).toEqual({
			activeCount: 0,
			completedCount: 0,
			failedCount: 0,
			activeAgents: [],
			failurePreview: [],
			isPersisted: false,
			scope: "current_process_runtime_state",
			note: "live current-process state only; not persisted and resets on session switch/resume",
		});
	});

	it("returns summary with correct counts for active tasks only", () => {
		const tasks = [makeDelegatedTask("worker1", "active")];
		const summary = makeDelegatedWorkSummary(tasks);

		const result = buildWorkingContextDelegatedWorkSummary(summary);
		expect(result).toEqual({
			activeCount: 1,
			completedCount: 0,
			failedCount: 0,
			activeAgents: ["worker1"],
			failurePreview: [],
			isPersisted: false,
			scope: "current_process_runtime_state",
			note: "live current-process state only; not persisted and resets on session switch/resume",
		});
	});

	it("returns summary with correct counts for mixed tasks", () => {
		const tasks = [
			makeDelegatedTask("worker1", "active"),
			makeDelegatedTask("worker2", "active"),
			makeDelegatedTask("reviewer1", "completed"),
			makeDelegatedTask("scout1", "completed"),
			makeDelegatedTask("failed1", "error"),
		];
		const summary = makeDelegatedWorkSummary(tasks);

		const result = buildWorkingContextDelegatedWorkSummary(summary);
		expect(result?.activeCount).toBe(2);
		expect(result?.completedCount).toBe(2);
		expect(result?.failedCount).toBe(1);
		expect(result?.activeAgents).toEqual(["worker1", "worker2"]);
		expect(result?.failurePreview).toEqual([
			{
				agent: "failed1",
				task: "Task for failed1",
				mode: "single",
				status: "error",
				childIndex: undefined,
				step: undefined,
				exitCode: undefined,
				errorMessage: undefined,
			},
		]);
	});

	it("includes granular child failure previews without changing persistence semantics", () => {
		const tasks: DelegatedTask[] = [
			{
				toolCallId: "parallel_1",
				childIndex: 2,
				agent: "reviewer",
				agentSource: "user",
				task: "Review the panel",
				mode: "parallel",
				status: "error",
				exitCode: 1,
				errorMessage: "Review failed due to missing edge-case coverage.",
				timestamp: 2,
			},
			{
				toolCallId: "chain_1",
				agent: "worker",
				agentSource: "user",
				task: "Implement Plan complete",
				mode: "chain",
				status: "blocked",
				step: 2,
				exitCode: 0,
				errorMessage: "Approval required before writing production config.",
				timestamp: 3,
			},
		];
		const result = buildWorkingContextDelegatedWorkSummary(makeDelegatedWorkSummary(tasks));

		expect(result.isPersisted).toBe(false);
		expect(result.failurePreview).toEqual([
			{
				agent: "worker",
				task: "Implement Plan complete",
				mode: "chain",
				status: "blocked",
				step: 2,
				exitCode: 0,
				errorMessage: "Approval required before writing production config.",
			},
			{
				agent: "reviewer",
				task: "Review the panel",
				mode: "parallel",
				status: "error",
				childIndex: 2,
				exitCode: 1,
				errorMessage: "Review failed due to missing edge-case coverage.",
			},
		]);
	});

	it("explicitly marks delegated work as NOT persisted", () => {
		const tasks = [makeDelegatedTask("worker1", "completed")];
		const summary = makeDelegatedWorkSummary(tasks);

		const result = buildWorkingContextDelegatedWorkSummary(summary);
		expect(result?.isPersisted).toBe(false);
		expect(result?.scope).toBe("current_process_runtime_state");
		expect(result?.note).toBe("live current-process state only; not persisted and resets on session switch/resume");
	});
});

describe("buildWorkingContext (full integration)", () => {
	it("returns explicit zero-state context when all sources are empty", () => {
		const context = buildWorkingContext({
			memoryItems: [],
			todos: [],
			delegatedWorkSummary: makeDelegatedWorkSummary([]),
		});

		expect(context).toEqual({
			memory: {
				itemCount: 0,
				staleCount: 0,
				keyPreview: [],
				isPersisted: true,
				scope: "current_branch_session_state",
			},
			todo: {
				total: 0,
				completed: 0,
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
		});
	});

	it("returns explicit context when only memory exists", () => {
		const memoryItems: MemoryItem[] = [makeMemoryItem("alpha")];

		const context = buildWorkingContext({
			memoryItems,
			todos: [],
			delegatedWorkSummary: makeDelegatedWorkSummary([]),
		});

		expect(context).toEqual({
			memory: {
				itemCount: 1,
				staleCount: 0,
				keyPreview: ["alpha"],
				isPersisted: true,
				scope: "current_branch_session_state",
			},
			todo: {
				total: 0,
				completed: 0,
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
		});
	});

	it("returns explicit context when only todos exist", () => {
		const todos: TodoItem[] = [makeTodoItem("task1", "completed")];

		const context = buildWorkingContext({
			memoryItems: [],
			todos,
			delegatedWorkSummary: makeDelegatedWorkSummary([]),
		});

		expect(context).toEqual({
			memory: {
				itemCount: 0,
				staleCount: 0,
				keyPreview: [],
				isPersisted: true,
				scope: "current_branch_session_state",
			},
			todo: {
				total: 1,
				completed: 1,
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
		});
	});

	it("returns explicit context when only delegated work exists", () => {
		const tasks = [makeDelegatedTask("worker1", "active")];
		const summary = makeDelegatedWorkSummary(tasks);

		const context = buildWorkingContext({
			memoryItems: [],
			todos: [],
			delegatedWorkSummary: summary,
		});

		expect(context).toEqual({
			memory: {
				itemCount: 0,
				staleCount: 0,
				keyPreview: [],
				isPersisted: true,
				scope: "current_branch_session_state",
			},
			todo: {
				total: 0,
				completed: 0,
				isPersisted: true,
				scope: "current_branch_session_state",
			},
			delegatedWork: {
				activeCount: 1,
				completedCount: 0,
				failedCount: 0,
				activeAgents: ["worker1"],
				failurePreview: [],
				isPersisted: false,
				scope: "current_process_runtime_state",
				note: "live current-process state only; not persisted and resets on session switch/resume",
			},
		});
	});

	it("returns full context when all sources have data", () => {
		const memoryItems: MemoryItem[] = [makeMemoryItem("alpha"), makeMemoryItem("beta")];
		const todos: TodoItem[] = [makeTodoItem("task1", "completed"), makeTodoItem("task2", "in_progress", "Working")];
		const tasks = [makeDelegatedTask("worker1", "active"), makeDelegatedTask("scout1", "completed")];
		const summary = makeDelegatedWorkSummary(tasks);

		const context = buildWorkingContext({
			memoryItems,
			todos,
			delegatedWorkSummary: summary,
		});

		expect(context.memory).toBeDefined();
		expect(context.memory?.itemCount).toBe(2);
		expect(context.memory?.isPersisted).toBe(true);

		expect(context.todo).toBeDefined();
		expect(context.todo?.total).toBe(2);
		expect(context.todo?.completed).toBe(1);
		expect(context.todo?.isPersisted).toBe(true);

		expect(context.delegatedWork).toBeDefined();
		expect(context.delegatedWork?.activeCount).toBe(1);
		expect(context.delegatedWork?.completedCount).toBe(1);
		expect(context.delegatedWork?.isPersisted).toBe(false);
	});

	it("produces JSON-serializable output", () => {
		const context = buildWorkingContext({
			memoryItems: [makeMemoryItem("alpha")],
			todos: [makeTodoItem("task1", "in_progress", "Current")],
			delegatedWorkSummary: makeDelegatedWorkSummary([makeDelegatedTask("worker1", "active")]),
		});

		const serialized = JSON.stringify(context);
		const parsed = JSON.parse(serialized) as WorkingContext;

		expect(parsed.memory?.isPersisted).toBe(true);
		expect(parsed.todo?.isPersisted).toBe(true);
		expect(parsed.delegatedWork?.isPersisted).toBe(false);
	});

	it("empty delegated work case is represented explicitly with zero counts", () => {
		const context = buildWorkingContext({
			memoryItems: [makeMemoryItem("alpha")],
			todos: [makeTodoItem("task1", "pending")],
			delegatedWorkSummary: makeDelegatedWorkSummary([]),
		});

		expect(context.memory).toBeDefined();
		expect(context.todo).toBeDefined();
		expect(context.delegatedWork).toEqual({
			activeCount: 0,
			completedCount: 0,
			failedCount: 0,
			activeAgents: [],
			failurePreview: [],
			isPersisted: false,
			scope: "current_process_runtime_state",
			note: "live current-process state only; not persisted and resets on session switch/resume",
		});
	});
});
