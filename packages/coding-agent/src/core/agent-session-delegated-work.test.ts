import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@apholdings/jensen-agent-core";
import type { Model } from "@apholdings/jensen-ai";
import { describe, expect, it } from "vitest";
import { AgentSession } from "./agent-session.js";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

function makeSession(): { rootDir: string; session: AgentSession } {
	const rootDir = mkdtempSync(join(tmpdir(), "jensen-delegated-work-"));
	const agentDir = join(rootDir, "agent");
	const cwd = join(rootDir, "repo");

	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	const modelRegistry = new ModelRegistry(authStorage, undefined);
	const model: Model<any> = {
		id: "test-model",
		name: "Test Model",
		provider: "test-provider",
		api: "openai-chat",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8000,
		maxTokens: 4000,
	};
	modelRegistry.registerProvider("test-provider", {
		baseUrl: "https://example.invalid",
		apiKey: "test-key",
		api: "openai-chat",
		models: [model],
	});

	const settingsManager = SettingsManager.create(cwd, agentDir);
	const sessionManager = SessionManager.create(cwd);
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
	const agent = new Agent({
		initialState: {
			systemPrompt: "",
			model,
			thinkingLevel: "off",
			tools: [],
		},
	});

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		resourceLoader,
		modelRegistry,
	});

	return { rootDir, session };
}

describe("AgentSession delegated work state", () => {
	it("tracks live subagent tool execution state from tool lifecycle events", async () => {
		const { rootDir, session } = makeSession();

		try {
			(session as unknown as { _handleAgentEvent: (event: unknown) => void })._handleAgentEvent({
				type: "tool_execution_start",
				toolCallId: "call_1",
				toolName: "subagent",
				args: { agent: "worker", task: "Implement the panel" },
			});
			await (session as unknown as { _agentEventQueue: Promise<void> })._agentEventQueue;

			let summary = session.getDelegatedWorkSummary();
			expect(summary.total).toBe(1);
			expect(summary.active).toHaveLength(1);
			expect(summary.completed).toHaveLength(0);

			(session as unknown as { _handleAgentEvent: (event: unknown) => void })._handleAgentEvent({
				type: "tool_execution_end",
				toolCallId: "call_1",
				toolName: "subagent",
				result: {
					content: [{ type: "text", text: "Done" }],
					details: {
						mode: "single",
						agentScope: "user",
						projectAgentsDir: null,
						discoveryErrors: [],
						results: [
							{
								agent: "worker",
								agentSource: "user",
								task: "Implement the panel",
								exitCode: 0,
								messages: [{ role: "assistant", content: [{ type: "text", text: "Panel implemented." }] }],
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
							},
						],
					},
				},
				isError: false,
			});
			await (session as unknown as { _agentEventQueue: Promise<void> })._agentEventQueue;

			summary = session.getDelegatedWorkSummary();
			expect(summary.active).toHaveLength(0);
			expect(summary.completed).toHaveLength(1);
			expect(summary.failed).toHaveLength(0);
			expect(session.getRecentDelegatedTasks(1)[0]?.outputPreview).toBe("Panel implemented.");
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("tracks parallel child tasks more granularly during the current swarm operation", async () => {
		const { rootDir, session } = makeSession();

		try {
			(session as unknown as { _handleAgentEvent: (event: unknown) => void })._handleAgentEvent({
				type: "tool_execution_start",
				toolCallId: "parallel_1",
				toolName: "subagent",
				args: {
					tasks: [
						{ agent: "worker", task: "Implement the panel" },
						{ agent: "reviewer", task: "Review the panel" },
					],
				},
			});
			await (session as unknown as { _agentEventQueue: Promise<void> })._agentEventQueue;

			let summary = session.getDelegatedWorkSummary();
			expect(summary.total).toBe(2);
			expect(summary.active).toHaveLength(2);
			expect(summary.completed).toHaveLength(0);
			expect(summary.active.map((task) => task.childIndex)).toEqual([1, 2]);

			(session as unknown as { _handleAgentEvent: (event: unknown) => void })._handleAgentEvent({
				type: "tool_execution_update",
				toolCallId: "parallel_1",
				toolName: "subagent",
				args: {
					tasks: [
						{ agent: "worker", task: "Implement the panel" },
						{ agent: "reviewer", task: "Review the panel" },
					],
				},
				partialResult: {
					content: [{ type: "text", text: "Parallel: 1/2 done, 1 running..." }],
					details: {
						mode: "parallel",
						agentScope: "user",
						projectAgentsDir: null,
						discoveryErrors: [],
						results: [
							{
								agent: "worker",
								agentSource: "user",
								task: "Implement the panel",
								exitCode: 0,
								messages: [{ role: "assistant", content: [{ type: "text", text: "Panel implemented." }] }],
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
							},
							{
								agent: "reviewer",
								agentSource: "unknown",
								task: "Review the panel",
								exitCode: -1,
								messages: [],
								stderr: "",
								usage: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									cost: 0,
									contextTokens: 0,
									turns: 0,
								},
							},
						],
					},
				},
			});
			await (session as unknown as { _agentEventQueue: Promise<void> })._agentEventQueue;

			summary = session.getDelegatedWorkSummary();
			expect(summary.active).toHaveLength(1);
			expect(summary.completed).toHaveLength(1);
			expect(summary.failed).toHaveLength(0);
			expect(summary.active[0]?.agent).toBe("reviewer");
			expect(summary.completed[0]?.agent).toBe("worker");

			(session as unknown as { _handleAgentEvent: (event: unknown) => void })._handleAgentEvent({
				type: "tool_execution_end",
				toolCallId: "parallel_1",
				toolName: "subagent",
				result: {
					content: [{ type: "text", text: "Parallel complete" }],
					details: {
						mode: "parallel",
						agentScope: "user",
						projectAgentsDir: null,
						discoveryErrors: [],
						results: [
							{
								agent: "worker",
								agentSource: "user",
								task: "Implement the panel",
								exitCode: 0,
								messages: [{ role: "assistant", content: [{ type: "text", text: "Panel implemented." }] }],
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
							},
							{
								agent: "reviewer",
								agentSource: "user",
								task: "Review the panel",
								exitCode: 1,
								messages: [],
								stderr: "Review failed",
								usage: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									cost: 0,
									contextTokens: 0,
									turns: 1,
								},
							},
						],
					},
				},
				isError: false,
			});
			await (session as unknown as { _agentEventQueue: Promise<void> })._agentEventQueue;

			summary = session.getDelegatedWorkSummary();
			expect(summary.total).toBe(2);
			expect(summary.active).toHaveLength(0);
			expect(summary.completed).toHaveLength(1);
			expect(summary.failed).toHaveLength(1);
			expect(session.getWorkingContext().delegatedWork).toMatchObject({
				activeCount: 0,
				completedCount: 1,
				failedCount: 1,
				isPersisted: false,
				scope: "current_process_runtime_state",
				failurePreview: [
					{
						agent: "reviewer",
						mode: "parallel",
						status: "error",
						childIndex: 2,
						task: "Review the panel",
						exitCode: 1,
						errorMessage: "Review failed",
					},
				],
			});
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("tracks chain steps as separate runtime child entries across sequential progress", async () => {
		const { rootDir, session } = makeSession();

		try {
			(session as unknown as { _handleAgentEvent: (event: unknown) => void })._handleAgentEvent({
				type: "tool_execution_start",
				toolCallId: "chain_1",
				toolName: "subagent",
				args: {
					chain: [
						{ agent: "planner", task: "Plan the feature" },
						{ agent: "worker", task: "Implement {previous}" },
						{ agent: "reviewer", task: "Review {previous}" },
					],
				},
			});
			await (session as unknown as { _agentEventQueue: Promise<void> })._agentEventQueue;

			let summary = session.getDelegatedWorkSummary();
			expect(summary.total).toBe(1);
			expect(summary.active).toHaveLength(1);
			expect(summary.active[0]).toMatchObject({ step: 1, agent: "planner", status: "active" });

			(session as unknown as { _handleAgentEvent: (event: unknown) => void })._handleAgentEvent({
				type: "tool_execution_update",
				toolCallId: "chain_1",
				toolName: "subagent",
				args: {
					chain: [
						{ agent: "planner", task: "Plan the feature" },
						{ agent: "worker", task: "Implement {previous}" },
						{ agent: "reviewer", task: "Review {previous}" },
					],
				},
				partialResult: {
					content: [{ type: "text", text: "Chain: step 1 done, step 2 running..." }],
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
								usage: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									cost: 0,
									contextTokens: 0,
									turns: 1,
								},
							},
							{
								agent: "worker",
								agentSource: "user",
								task: "Implement Plan complete",
								exitCode: -1,
								step: 2,
								messages: [
									{ role: "assistant", content: [{ type: "text", text: "Working on implementation" }] },
								],
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
							},
						],
					},
				},
			});
			await (session as unknown as { _agentEventQueue: Promise<void> })._agentEventQueue;

			summary = session.getDelegatedWorkSummary();
			expect(summary.total).toBe(2);
			expect(summary.completed).toHaveLength(1);
			expect(summary.active).toHaveLength(1);
			expect(summary.completed[0]).toMatchObject({ step: 1, agent: "planner", status: "completed" });
			expect(summary.active[0]).toMatchObject({ step: 2, agent: "worker", status: "active", exitCode: -1 });
			expect(session.getWorkingContext().delegatedWork).toMatchObject({
				activeCount: 1,
				completedCount: 1,
				failedCount: 0,
				isPersisted: false,
				scope: "current_process_runtime_state",
			});
			expect(session.getDelegatedTasks().some((task) => task.mode === "chain" && task.step === 3)).toBe(false);
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("surfaces a blocked chain child distinctly from an earlier completed step", async () => {
		const { rootDir, session } = makeSession();

		try {
			(session as unknown as { _handleAgentEvent: (event: unknown) => void })._handleAgentEvent({
				type: "tool_execution_start",
				toolCallId: "chain_blocked",
				toolName: "subagent",
				args: {
					chain: [
						{ agent: "planner", task: "Plan the rollout" },
						{ agent: "worker", task: "Write production config {previous}" },
					],
				},
			});
			await (session as unknown as { _agentEventQueue: Promise<void> })._agentEventQueue;

			(session as unknown as { _handleAgentEvent: (event: unknown) => void })._handleAgentEvent({
				type: "tool_execution_end",
				toolCallId: "chain_blocked",
				toolName: "subagent",
				result: {
					content: [
						{
							type: "text",
							text: "Chain stopped at step 2 (worker): Approval required before writing production config.",
						},
					],
					details: {
						mode: "chain",
						agentScope: "user",
						projectAgentsDir: null,
						discoveryErrors: [],
						results: [
							{
								agent: "planner",
								agentSource: "user",
								task: "Plan the rollout",
								exitCode: 0,
								step: 1,
								messages: [{ role: "assistant", content: [{ type: "text", text: "Plan complete" }] }],
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
							},
							{
								agent: "worker",
								agentSource: "user",
								task: "Write production config Plan complete",
								exitCode: 0,
								step: 2,
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
				},
				isError: true,
			});
			await (session as unknown as { _agentEventQueue: Promise<void> })._agentEventQueue;

			const summary = session.getDelegatedWorkSummary();
			expect(summary.active).toHaveLength(0);
			expect(summary.completed).toMatchObject([{ step: 1, agent: "planner", status: "completed" }]);
			expect(summary.failed).toMatchObject([{ step: 2, agent: "worker", status: "blocked" }]);
			expect(session.getWorkingContext().delegatedWork).toMatchObject({
				activeCount: 0,
				completedCount: 1,
				failedCount: 1,
				isPersisted: false,
				scope: "current_process_runtime_state",
				failurePreview: [
					{
						agent: "worker",
						mode: "chain",
						status: "blocked",
						step: 2,
						task: "Write production config Plan complete",
						errorMessage: "Approval required before writing production config.",
					},
				],
			});
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("ignores non-subagent tools", async () => {
		const { rootDir, session } = makeSession();

		try {
			(session as unknown as { _handleAgentEvent: (event: unknown) => void })._handleAgentEvent({
				type: "tool_execution_start",
				toolCallId: "call_bash",
				toolName: "bash",
				args: { command: "echo hi" },
			});
			await (session as unknown as { _agentEventQueue: Promise<void> })._agentEventQueue;

			const summary = session.getDelegatedWorkSummary();
			expect(summary.total).toBe(0);
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});
});
