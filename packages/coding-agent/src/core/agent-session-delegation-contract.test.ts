/**
 * Contract tests for operator state discipline around delegation.
 *
 * These tests prove the infrastructure is ready to track task/todo state around delegation.
 * They validate the co-occurrence rule: "delegation active implies task/todo entries exist".
 *
 * The tests are NOT about whether the agent follows guidance (non-deterministic).
 * They ARE about whether the infrastructure CAN detect gaps when they occur.
 */
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
	const rootDir = mkdtempSync(join(tmpdir(), "jensen-delegation-contract-"));
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

/** Fire a tool execution start event and wait for queue processing */
async function fireDelegationStart(
	session: AgentSession,
	toolCallId: string,
	args: Record<string, unknown>,
): Promise<void> {
	(session as unknown as { _handleAgentEvent: (event: unknown) => void })._handleAgentEvent({
		type: "tool_execution_start",
		toolCallId,
		toolName: "subagent",
		args,
	});
	await (session as unknown as { _agentEventQueue: Promise<void> })._agentEventQueue;
}

/** Seed task state directly via internal method */
function seedTask(session: AgentSession, subject: string, activeForm: string): void {
	const task = {
		id: `task_${Date.now()}`,
		subject,
		activeForm,
		status: "pending" as const,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	(session as unknown as { _setTasks: (tasks: unknown[]) => void })._setTasks([task]);
}

/** Seed todo state directly via internal method */
function seedTodo(session: AgentSession, content: string, activeForm: string): void {
	const todo = {
		content,
		activeForm,
		status: "pending" as const,
	};
	(session as unknown as { _setTodos: (todos: unknown[]) => void })._setTodos([todo]);
}

describe("AgentSession delegation contract: operator state discipline", () => {
	describe("infrastructure can detect state gaps during delegation", () => {
		it("delegation without prior task or todo: infrastructure can detect the gap", async () => {
			const { rootDir, session } = makeSession();

			try {
				// Seed: NO tasks/todos - pure infrastructure state
				expect(session.getTasks().length).toBe(0);
				expect(session.getTodos().length).toBe(0);

				// Fire delegation
				await fireDelegationStart(session, "call_contract_1", {
					agent: "worker",
					task: "Implement a feature",
				});

				// Infrastructure proves:
				// 1. Delegation is tracked (contract satisfied for tracking)
				const summary = session.getDelegatedWorkSummary();
				expect(summary.total).toBe(1);
				expect(summary.active).toHaveLength(1);

				// 2. Gap is visible (contract gap detectable)
				expect(session.getTasks().length).toBe(0);
				expect(session.getTodos().length).toBe(0);

				// The advisory can now fire because infrastructure detected the gap
			} finally {
				rmSync(rootDir, { recursive: true, force: true });
			}
		});

		it("delegation with prior task: infrastructure tracks both correctly", async () => {
			const { rootDir, session } = makeSession();

			try {
				// Seed with a task (simulating existing task context)
				seedTask(session, "Implement the panel", "Implementing the panel");

				// Verify seed
				expect(session.getTasks().length).toBe(1);
				expect(session.getTasks()[0]?.subject).toBe("Implement the panel");

				// Fire delegation
				await fireDelegationStart(session, "call_contract_2", {
					agent: "worker",
					task: "Implement a feature",
				});

				// Infrastructure proves both are tracked:
				expect(session.getTasks().length).toBe(1);
				const summary2 = session.getDelegatedWorkSummary();
				expect(summary2.total).toBe(1);
				expect(summary2.active).toHaveLength(1);
			} finally {
				rmSync(rootDir, { recursive: true, force: true });
			}
		});

		it("delegation with prior todo: infrastructure tracks both correctly", async () => {
			const { rootDir, session } = makeSession();

			try {
				// Seed with a todo (simulating existing todo context)
				seedTodo(session, "Review the PR", "Reviewing the PR");

				// Verify seed
				expect(session.getTodos().length).toBe(1);
				expect(session.getTodos()[0]?.content).toBe("Review the PR");

				// Fire delegation
				await fireDelegationStart(session, "call_contract_3", {
					agent: "worker",
					task: "Implement a feature",
				});

				// Infrastructure proves both are tracked:
				expect(session.getTodos().length).toBe(1);
				expect(session.getDelegatedWorkSummary().total).toBe(1);
			} finally {
				rmSync(rootDir, { recursive: true, force: true });
			}
		});
	});

	describe("runtime advisory fires correctly", () => {
		it("advisory fires when delegating without task/todo state", async () => {
			const { rootDir, session } = makeSession();

			try {
				// Ensure no task/todo state
				expect(session.getTasks().length).toBe(0);
				expect(session.getTodos().length).toBe(0);

				// Collect events
				const events: unknown[] = [];
				session.subscribe((event) => {
					events.push(event);
				});

				// Fire delegation - the advisory fires via tool_execution_start event handling
				await fireDelegationStart(session, "call_advisory_1", {
					agent: "worker",
					task: "Quick task",
				});

				// The advisory should have been emitted
				const advisoryEvent = events.find((e: unknown) => (e as { type?: string }).type === "notification");
				expect(advisoryEvent).toBeDefined();
				expect((advisoryEvent as { kind?: string }).kind).toBe("operator_discipline_advisory");
			} finally {
				rmSync(rootDir, { recursive: true, force: true });
			}
		});

		it("advisory does NOT fire when task state exists", async () => {
			const { rootDir, session } = makeSession();

			try {
				// Seed with a task
				seedTask(session, "Parent task", "Working on parent task");

				expect(session.getTasks().length).toBe(1);

				// Collect events
				const events: unknown[] = [];
				session.subscribe((event) => {
					events.push(event);
				});

				// Fire delegation with task context
				await fireDelegationStart(session, "call_advisory_2", {
					agent: "worker",
					task: "Child task",
				});

				// No advisory should fire because task state exists
				const advisoryEvent = events.find(
					(e: unknown) =>
						(e as { type?: string }).type === "notification" &&
						(e as { kind?: string }).kind === "operator_discipline_advisory",
				);
				expect(advisoryEvent).toBeUndefined();
			} finally {
				rmSync(rootDir, { recursive: true, force: true });
			}
		});

		it("advisory does NOT fire when todo state exists", async () => {
			const { rootDir, session } = makeSession();

			try {
				// Seed with a todo
				seedTodo(session, "Parent todo", "Working on parent todo");

				expect(session.getTodos().length).toBe(1);

				// Collect events
				const events: unknown[] = [];
				session.subscribe((event) => {
					events.push(event);
				});

				// Fire delegation with todo context
				await fireDelegationStart(session, "call_advisory_3", {
					agent: "worker",
					task: "Child task",
				});

				// No advisory should fire because todo state exists
				const advisoryEvent = events.find(
					(e: unknown) =>
						(e as { type?: string }).type === "notification" &&
						(e as { kind?: string }).kind === "operator_discipline_advisory",
				);
				expect(advisoryEvent).toBeUndefined();
			} finally {
				rmSync(rootDir, { recursive: true, force: true });
			}
		});
	});
});
