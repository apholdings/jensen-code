import type { ToolResultMessage } from "@apholdings/jensen-ai";
import { describe, expect, it } from "vitest";
import {
	applyDelegatedResult,
	buildDelegatedWorkSummary,
	extractDelegatedTasks,
	getRecentDelegatedTasks,
	mergeDelegatedTask,
	reconcileDelegatedResult,
	syncDelegatedWork,
} from "./delegated-work.js";
import type { ToolCallEvent } from "./extensions/index.js";

describe("delegated-work", () => {
	// =========================================================================
	// extractDelegatedTasks
	// =========================================================================

	describe("extractDelegatedTasks", () => {
		it("returns empty array for non-subagent tool calls", () => {
			const event: ToolCallEvent = {
				type: "tool_call",
				toolCallId: "call_1",
				toolName: "bash",
				input: { command: "echo hello" },
			};
			expect(extractDelegatedTasks(event)).toEqual([]);
		});

		it("extracts single mode task with agent and task", () => {
			const event: ToolCallEvent = {
				type: "tool_call",
				toolCallId: "call_1",
				toolName: "subagent",
				input: {
					agent: "worker",
					task: "Fix the bug in auth module",
				},
			};
			const tasks = extractDelegatedTasks(event);
			expect(tasks).toEqual([
				{
					toolCallId: "call_1",
					agent: "worker",
					agentSource: "unknown",
					task: "Fix the bug in auth module",
					mode: "single",
					status: "active",
					rawArgs: { agent: "worker", task: "Fix the bug in auth module" },
					timestamp: expect.any(Number),
				},
			]);
		});

		it("extracts one child task per parallel request", () => {
			const event: ToolCallEvent = {
				type: "tool_call",
				toolCallId: "call_2",
				toolName: "subagent",
				input: {
					tasks: [
						{ agent: "worker", task: "Task 1" },
						{ agent: "reviewer", task: "Task 2" },
					],
				},
			};
			const tasks = extractDelegatedTasks(event);
			expect(tasks).toMatchObject([
				{
					toolCallId: "call_2",
					childIndex: 1,
					agent: "worker",
					task: "Task 1",
					mode: "parallel",
					status: "active",
				},
				{
					toolCallId: "call_2",
					childIndex: 2,
					agent: "reviewer",
					task: "Task 2",
					mode: "parallel",
					status: "active",
				},
			]);
		});

		it("extracts only the first active chain step at tool-call start", () => {
			const event: ToolCallEvent = {
				type: "tool_call",
				toolCallId: "call_3",
				toolName: "subagent",
				input: {
					chain: [
						{ agent: "planner", task: "Plan the feature" },
						{ agent: "worker", task: "Implement it" },
					],
				},
			};
			const tasks = extractDelegatedTasks(event);
			expect(tasks).toMatchObject([
				{
					toolCallId: "call_3",
					agent: "planner",
					task: "Plan the feature",
					mode: "chain",
					status: "active",
					step: 1,
				},
			]);
		});

		it("returns empty array when agent is missing", () => {
			const event: ToolCallEvent = {
				type: "tool_call",
				toolCallId: "call_4",
				toolName: "subagent",
				input: { task: "Some task without agent" },
			};
			expect(extractDelegatedTasks(event)).toEqual([]);
		});

		it("returns empty array when task is missing", () => {
			const event: ToolCallEvent = {
				type: "tool_call",
				toolCallId: "call_5",
				toolName: "subagent",
				input: { agent: "worker" },
			};
			expect(extractDelegatedTasks(event)).toEqual([]);
		});

		it("returns empty array for empty input", () => {
			const event: ToolCallEvent = {
				type: "tool_call",
				toolCallId: "call_6",
				toolName: "subagent",
				input: {},
			};
			expect(extractDelegatedTasks(event)).toEqual([]);
		});
	});

	// =========================================================================
	// applyDelegatedResult
	// =========================================================================

	describe("applyDelegatedResult", () => {
		it("returns undefined for non-subagent results", () => {
			const task = {
				toolCallId: "call_1",
				agent: "worker",
				agentSource: "unknown" as const,
				task: "Test task",
				mode: "single" as const,
				status: "active" as const,
				timestamp: Date.now(),
			};
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "bash",
				content: [],
				isError: false,
				timestamp: Date.now(),
			};
			expect(applyDelegatedResult(task, result)).toBeUndefined();
		});

		it("returns task unchanged when result has no details yet (still running)", () => {
			const task = {
				toolCallId: "call_1",
				agent: "worker",
				agentSource: "unknown" as const,
				task: "Test task",
				mode: "single" as const,
				status: "active" as const,
				timestamp: Date.now(),
			};
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "subagent",
				content: [{ type: "text", text: "(running...)" }],
				isError: false,
				timestamp: Date.now(),
			};
			const updated = applyDelegatedResult(task, result);
			expect(updated?.status).toBe("active");
		});

		it("marks task as completed with successful exit code", () => {
			const task = {
				toolCallId: "call_1",
				agent: "worker",
				agentSource: "unknown" as const,
				task: "Test task",
				mode: "single" as const,
				status: "active" as const,
				timestamp: Date.now(),
			};
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "subagent",
				content: [{ type: "text", text: "Done" }],
				isError: false,
				timestamp: Date.now(),
				details: {
					mode: "single",
					agentScope: "user",
					projectAgentsDir: null,
					discoveryErrors: [],
					results: [
						{
							agent: "worker",
							agentSource: "user",
							task: "Test task",
							exitCode: 0,
							messages: [{ role: "assistant", content: [{ type: "text", text: "Completed successfully" }] }],
							stderr: "",
							usage: {
								input: 100,
								output: 50,
								cacheRead: 0,
								cacheWrite: 0,
								cost: 0,
								contextTokens: 150,
								turns: 1,
							},
						},
					],
				},
			};
			const updated = applyDelegatedResult(task, result);
			expect(updated?.status).toBe("completed");
			expect(updated?.agentSource).toBe("user");
			expect(updated?.exitCode).toBe(0);
			expect(updated?.outputPreview).toBe("Completed successfully");
		});

		it("marks task as error with non-zero exit code", () => {
			const task = {
				toolCallId: "call_1",
				agent: "worker",
				agentSource: "unknown" as const,
				task: "Test task",
				mode: "single" as const,
				status: "active" as const,
				timestamp: Date.now(),
			};
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "subagent",
				content: [{ type: "text", text: "Failed" }],
				isError: false,
				timestamp: Date.now(),
				details: {
					mode: "single",
					agentScope: "user",
					projectAgentsDir: null,
					discoveryErrors: [],
					results: [
						{
							agent: "worker",
							agentSource: "user",
							task: "Test task",
							exitCode: 1,
							messages: [],
							stderr: "Command failed",
							usage: {
								input: 100,
								output: 50,
								cacheRead: 0,
								cacheWrite: 0,
								cost: 0,
								contextTokens: 150,
								turns: 1,
							},
						},
					],
				},
			};
			const updated = applyDelegatedResult(task, result);
			expect(updated?.status).toBe("error");
			expect(updated?.exitCode).toBe(1);
			expect(updated?.errorMessage).toBe("Command failed");
		});

		it("marks task as error with failureStage set", () => {
			const task = {
				toolCallId: "call_1",
				agent: "worker",
				agentSource: "unknown" as const,
				task: "Test task",
				mode: "single" as const,
				status: "active" as const,
				timestamp: Date.now(),
			};
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "subagent",
				content: [],
				isError: false,
				timestamp: Date.now(),
				details: {
					mode: "single",
					agentScope: "user",
					projectAgentsDir: null,
					discoveryErrors: [],
					results: [
						{
							agent: "worker",
							agentSource: "user",
							task: "Test task",
							exitCode: 0,
							messages: [],
							stderr: "",
							usage: {
								input: 100,
								output: 50,
								cacheRead: 0,
								cacheWrite: 0,
								cost: 0,
								contextTokens: 150,
								turns: 1,
							},
							failureStage: "provider",
							diagnosticMessage: "API rate limit exceeded",
						},
					],
				},
			};
			const updated = applyDelegatedResult(task, result);
			expect(updated?.status).toBe("error");
			expect(updated?.errorMessage).toBe("API rate limit exceeded");
		});

		it("marks task as blocked when child execution aborts with runtime evidence", () => {
			const task = {
				toolCallId: "call_blocked",
				agent: "worker",
				agentSource: "unknown" as const,
				task: "Write to protected config",
				mode: "single" as const,
				status: "active" as const,
				timestamp: Date.now(),
			};
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "call_blocked",
				toolName: "subagent",
				content: [{ type: "text", text: "Blocked by approval policy" }],
				isError: true,
				timestamp: Date.now(),
				details: {
					mode: "single",
					agentScope: "user",
					projectAgentsDir: null,
					discoveryErrors: [],
					results: [
						{
							agent: "worker",
							agentSource: "user",
							task: "Write to protected config",
							exitCode: 0,
							messages: [],
							stderr: "",
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								cost: 0,
								contextTokens: 0,
								turns: 1,
							},
							stopReason: "aborted",
							errorMessage: "Approval required before writing production config.",
						},
					],
				},
			};
			const updated = applyDelegatedResult(task, result);
			expect(updated).toMatchObject({
				status: "blocked",
				errorMessage: "Approval required before writing production config.",
				exitCode: 0,
			});
		});

		it("keeps parallel siblings distinct when only one child has completed", () => {
			const completedChild = {
				toolCallId: "call_parallel",
				childIndex: 1,
				agent: "worker",
				agentSource: "unknown" as const,
				task: "Implement panel",
				mode: "parallel" as const,
				status: "active" as const,
				timestamp: Date.now(),
			};
			const runningChild = {
				toolCallId: "call_parallel",
				childIndex: 2,
				agent: "reviewer",
				agentSource: "unknown" as const,
				task: "Review panel",
				mode: "parallel" as const,
				status: "active" as const,
				timestamp: Date.now(),
			};
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "call_parallel",
				toolName: "subagent",
				content: [{ type: "text", text: "Parallel: 1/2 done, 1 running..." }],
				isError: false,
				timestamp: Date.now(),
				details: {
					mode: "parallel",
					agentScope: "user",
					projectAgentsDir: null,
					discoveryErrors: [],
					results: [
						{
							agent: "worker",
							agentSource: "user",
							task: "Implement panel",
							exitCode: 0,
							messages: [{ role: "assistant", content: [{ type: "text", text: "Panel done" }] }],
							stderr: "",
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
						},
						{
							agent: "reviewer",
							agentSource: "unknown",
							task: "Review panel",
							exitCode: -1,
							messages: [],
							stderr: "",
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						},
					],
				},
			};

			expect(applyDelegatedResult(completedChild, result)).toMatchObject({
				status: "completed",
				agent: "worker",
				childIndex: 1,
				outputPreview: "Panel done",
			});
			expect(applyDelegatedResult(runningChild, result)).toMatchObject({
				status: "active",
				agent: "reviewer",
				childIndex: 2,
				exitCode: -1,
			});
		});
	});

	describe("reconcileDelegatedResult", () => {
		it("adds granular chain step entries from runtime results without inventing future steps", () => {
			const seedTask = {
				toolCallId: "chain_1",
				agent: "planner",
				agentSource: "unknown" as const,
				task: "Plan the feature",
				mode: "chain" as const,
				status: "active" as const,
				step: 1,
				rawArgs: {
					chain: [
						{ agent: "planner", task: "Plan the feature" },
						{ agent: "worker", task: "Implement {previous}" },
						{ agent: "reviewer", task: "Review {previous}" },
					],
				},
				timestamp: 100,
			};
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "chain_1",
				toolName: "subagent",
				content: [{ type: "text", text: "Chain: step 1 done, step 2 running..." }],
				isError: false,
				timestamp: 200,
				details: {
					mode: "chain",
					agentScope: "user",
					projectAgentsDir: null,
					discoveryErrors: [],
					results: [
						{
							agent: "planner",
							agentSource: "user",
							task: "Plan the feature",
							exitCode: 0,
							step: 1,
							messages: [{ role: "assistant", content: [{ type: "text", text: "Plan complete" }] }],
							stderr: "",
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
						},
						{
							agent: "worker",
							agentSource: "user",
							task: "Implement Plan complete",
							exitCode: -1,
							step: 2,
							messages: [{ role: "assistant", content: [{ type: "text", text: "Working on it" }] }],
							stderr: "",
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
						},
					],
				},
			};

			const reconciled = reconcileDelegatedResult([seedTask], result);
			expect(reconciled).toHaveLength(2);
			expect(reconciled).toMatchObject([
				{
					toolCallId: "chain_1",
					mode: "chain",
					step: 1,
					agent: "planner",
					status: "completed",
					outputPreview: "Plan complete",
				},
				{
					toolCallId: "chain_1",
					mode: "chain",
					step: 2,
					agent: "worker",
					status: "active",
					exitCode: -1,
				},
			]);
			expect(reconciled.some((task) => task.step === 3)).toBe(false);
		});

		it("marks still-active children as blocked when the parent tool ends with cancellation evidence", () => {
			const tasks = [
				{
					toolCallId: "parallel_approval",
					childIndex: 1,
					agent: "worker",
					agentSource: "unknown" as const,
					task: "Implement the change",
					mode: "parallel" as const,
					status: "active" as const,
					timestamp: 100,
				},
				{
					toolCallId: "parallel_approval",
					childIndex: 2,
					agent: "reviewer",
					agentSource: "unknown" as const,
					task: "Review the change",
					mode: "parallel" as const,
					status: "active" as const,
					timestamp: 101,
				},
			];
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "parallel_approval",
				toolName: "subagent",
				content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
				isError: false,
				timestamp: 200,
				details: {
					mode: "parallel",
					agentScope: "both",
					projectAgentsDir: "/tmp/project/.jensen/agents",
					discoveryErrors: [],
					results: [],
				},
			};

			const reconciled = reconcileDelegatedResult(tasks, result);
			expect(reconciled).toMatchObject([
				{
					childIndex: 1,
					status: "blocked",
					errorMessage: "Canceled: project-local agents not approved.",
				},
				{
					childIndex: 2,
					status: "blocked",
					errorMessage: "Canceled: project-local agents not approved.",
				},
			]);
		});
	});

	// =========================================================================
	// buildDelegatedWorkSummary
	// =========================================================================

	describe("buildDelegatedWorkSummary", () => {
		it("returns empty summary for no tasks", () => {
			const summary = buildDelegatedWorkSummary([]);
			expect(summary.total).toBe(0);
			expect(summary.active).toEqual([]);
			expect(summary.completed).toEqual([]);
			expect(summary.failed).toEqual([]);
			expect(summary.isSessionState).toBe(true);
		});

		it("categorizes tasks by status", () => {
			const tasks = [
				{
					toolCallId: "1",
					agent: "w1",
					agentSource: "user" as const,
					task: "t1",
					mode: "single" as const,
					status: "active" as const,
					timestamp: 1,
				},
				{
					toolCallId: "2",
					agent: "w2",
					agentSource: "user" as const,
					task: "t2",
					mode: "single" as const,
					status: "completed" as const,
					timestamp: 2,
				},
				{
					toolCallId: "3",
					agent: "w3",
					agentSource: "user" as const,
					task: "t3",
					mode: "single" as const,
					status: "error" as const,
					timestamp: 3,
				},
				{
					toolCallId: "4",
					agent: "w4",
					agentSource: "user" as const,
					task: "t4",
					mode: "single" as const,
					status: "blocked" as const,
					timestamp: 4,
				},
			];
			const summary = buildDelegatedWorkSummary(tasks);
			expect(summary.total).toBe(4);
			expect(summary.active).toHaveLength(1);
			expect(summary.completed).toHaveLength(1);
			expect(summary.failed).toHaveLength(2); // error + blocked
		});

		it("includes honesty note about session state", () => {
			const summary = buildDelegatedWorkSummary([]);
			expect(summary.note).toContain("ephemeral");
			expect(summary.note).toContain("not persisted");
		});
	});

	// =========================================================================
	// getRecentDelegatedTasks
	// =========================================================================

	describe("getRecentDelegatedTasks", () => {
		it("returns tasks sorted by timestamp descending", () => {
			const tasks = [
				{
					toolCallId: "1",
					agent: "a",
					agentSource: "user" as const,
					task: "t",
					mode: "single" as const,
					status: "active" as const,
					timestamp: 100,
				},
				{
					toolCallId: "2",
					agent: "a",
					agentSource: "user" as const,
					task: "t",
					mode: "single" as const,
					status: "active" as const,
					timestamp: 300,
				},
				{
					toolCallId: "3",
					agent: "a",
					agentSource: "user" as const,
					task: "t",
					mode: "single" as const,
					status: "active" as const,
					timestamp: 200,
				},
			];
			const recent = getRecentDelegatedTasks(tasks);
			expect(recent[0]?.toolCallId).toBe("2");
			expect(recent[1]?.toolCallId).toBe("3");
			expect(recent[2]?.toolCallId).toBe("1");
		});

		it("filters by status when provided", () => {
			const tasks = [
				{
					toolCallId: "1",
					agent: "a",
					agentSource: "user" as const,
					task: "t",
					mode: "single" as const,
					status: "active" as const,
					timestamp: 1,
				},
				{
					toolCallId: "2",
					agent: "a",
					agentSource: "user" as const,
					task: "t",
					mode: "single" as const,
					status: "completed" as const,
					timestamp: 2,
				},
				{
					toolCallId: "3",
					agent: "a",
					agentSource: "user" as const,
					task: "t",
					mode: "single" as const,
					status: "active" as const,
					timestamp: 3,
				},
			];
			const active = getRecentDelegatedTasks(tasks, { status: "active" });
			expect(active).toHaveLength(2);
			expect(active.every((t) => t.status === "active")).toBe(true);
		});

		it("respects limit parameter", () => {
			const tasks = [
				{
					toolCallId: "1",
					agent: "a",
					agentSource: "user" as const,
					task: "t",
					mode: "single" as const,
					status: "active" as const,
					timestamp: 100,
				},
				{
					toolCallId: "2",
					agent: "a",
					agentSource: "user" as const,
					task: "t",
					mode: "single" as const,
					status: "active" as const,
					timestamp: 200,
				},
				{
					toolCallId: "3",
					agent: "a",
					agentSource: "user" as const,
					task: "t",
					mode: "single" as const,
					status: "active" as const,
					timestamp: 300,
				},
			];
			const recent = getRecentDelegatedTasks(tasks, { limit: 2 });
			expect(recent).toHaveLength(2);
		});
	});

	// =========================================================================
	// mergeDelegatedTask
	// =========================================================================

	describe("mergeDelegatedTask", () => {
		it("adds new task to empty list", () => {
			const task = {
				toolCallId: "1",
				agent: "w",
				agentSource: "user" as const,
				task: "t",
				mode: "single" as const,
				status: "active" as const,
				timestamp: 1,
			};
			const merged = mergeDelegatedTask([], task);
			expect(merged).toHaveLength(1);
			expect(merged[0].toolCallId).toBe("1");
		});

		it("replaces existing task with same logical identity", () => {
			const existing = {
				toolCallId: "1",
				agent: "w",
				agentSource: "user" as const,
				task: "t",
				mode: "single" as const,
				status: "active" as const,
				timestamp: 1,
			};
			const updated = { ...existing, status: "completed" as const };
			const merged = mergeDelegatedTask([existing], updated);
			expect(merged).toHaveLength(1);
			expect(merged[0].status).toBe("completed");
		});

		it("keeps parallel siblings with the same parent toolCallId separate", () => {
			const first = {
				toolCallId: "parallel_1",
				childIndex: 1,
				agent: "worker",
				agentSource: "user" as const,
				task: "task 1",
				mode: "parallel" as const,
				status: "active" as const,
				timestamp: 1,
			};
			const second = {
				toolCallId: "parallel_1",
				childIndex: 2,
				agent: "reviewer",
				agentSource: "user" as const,
				task: "task 2",
				mode: "parallel" as const,
				status: "active" as const,
				timestamp: 2,
			};
			const merged = mergeDelegatedTask(mergeDelegatedTask([], first), second);
			expect(merged).toHaveLength(2);
			expect(merged.map((task) => task.childIndex)).toEqual([1, 2]);
		});
	});

	// =========================================================================
	// syncDelegatedWork
	// =========================================================================

	describe("syncDelegatedWork", () => {
		it("activates tasks from tool call events", () => {
			const events: ToolCallEvent[] = [
				{
					type: "tool_call",
					toolCallId: "call_1",
					toolName: "subagent",
					input: { agent: "worker", task: "Fix bug" },
				},
			];
			const synced = syncDelegatedWork([], events, []);
			expect(synced).toHaveLength(1);
			expect(synced[0].status).toBe("active");
		});

		it("expands parallel subagent calls into one runtime task per child", () => {
			const events: ToolCallEvent[] = [
				{
					type: "tool_call",
					toolCallId: "parallel_call",
					toolName: "subagent",
					input: {
						tasks: [
							{ agent: "worker", task: "Implement panel" },
							{ agent: "reviewer", task: "Review panel" },
						],
					},
				},
			];
			const synced = syncDelegatedWork([], events, []);
			expect(synced).toHaveLength(2);
			expect(synced.map((task) => task.childIndex)).toEqual([1, 2]);
			expect(synced.every((task) => task.status === "active")).toBe(true);
		});

		it("updates tasks with result data", () => {
			const task = {
				toolCallId: "call_1",
				agent: "w",
				agentSource: "user" as const,
				task: "t",
				mode: "single" as const,
				status: "active" as const,
				timestamp: 1,
			};
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "subagent",
				content: [],
				isError: false,
				timestamp: 2,
				details: {
					mode: "single",
					agentScope: "user",
					projectAgentsDir: null,
					discoveryErrors: [],
					results: [
						{
							agent: "w",
							agentSource: "user",
							task: "t",
							exitCode: 0,
							messages: [],
							stderr: "",
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						},
					],
				},
			};
			const synced = syncDelegatedWork([task], [], [result]);
			expect(synced).toHaveLength(1);
			expect(synced[0].status).toBe("completed");
		});

		it("ignores non-subagent tool calls and results", () => {
			const events: ToolCallEvent[] = [
				{
					type: "tool_call",
					toolCallId: "call_bash",
					toolName: "bash",
					input: { command: "echo" },
				},
			];
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "call_bash",
				toolName: "bash",
				content: [{ type: "text", text: "echo" }],
				isError: false,
				timestamp: 1,
			};
			const synced = syncDelegatedWork([], events, [result]);
			expect(synced).toHaveLength(0);
		});
	});
});
