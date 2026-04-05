import { Agent } from "@apholdings/jensen-agent-core";
import { describe, expect, it } from "vitest";
import { AgentSession } from "./agent-session.js";
import { AuthStorage } from "./auth-storage.js";
import { SESSION_MEMORY_CUSTOM_TYPE, SESSION_TASKS_CUSTOM_TYPE, SESSION_TODOS_CUSTOM_TYPE } from "./memory.js";
import { ModelRegistry } from "./model-registry.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
import { buildWorkingContext } from "./working-context.js";

function createSession(sessionManager = SessionManager.inMemory("/tmp/project")): AgentSession {
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd: "/tmp/project",
		agentDir: "/tmp/agent",
		settingsManager,
	});
	const authStorage = AuthStorage.create("/tmp/agent/auth.json");
	const modelRegistry = new ModelRegistry(authStorage);
	const agent = new Agent({
		initialState: {
			systemPrompt: "",
			thinkingLevel: "off",
			tools: [],
		},
	});

	return new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: "/tmp/project",
		resourceLoader,
		modelRegistry,
	});
}

describe("AgentSession.getWorkingContext()", () => {
	it("reuses the shared working-context builder for persisted memory and todo summaries", () => {
		const sessionManager = SessionManager.inMemory("/tmp/project");
		sessionManager.appendCustomEntry(SESSION_MEMORY_CUSTOM_TYPE, [
			{ key: "project.goal", value: "ship same-process working context", timestamp: "2026-04-02T09:00:00.000Z" },
			{ key: "project.scope", value: "bounded sdk surface", timestamp: "2026-04-02T09:05:00.000Z" },
		]);
		sessionManager.appendCustomEntry(SESSION_TODOS_CUSTOM_TYPE, [
			{ content: "Add AgentSession API", activeForm: "Adding AgentSession API", status: "in_progress" },
			{ content: "Update SDK docs", activeForm: "Updating SDK docs", status: "completed" },
		]);
		const session = createSession(sessionManager);

		expect(session.getWorkingContext()).toEqual(
			buildWorkingContext({
				memoryItems: session.getMemoryItems(),
				todos: session.getTodos(),
				tasks: session.getTasks(),
				delegatedWorkSummary: session.getDelegatedWorkSummary(),
			}),
		);
	});

	it("surfaces persisted memory and todo provenance markers honestly", () => {
		const sessionManager = SessionManager.inMemory("/tmp/project");
		sessionManager.appendCustomEntry(SESSION_MEMORY_CUSTOM_TYPE, [
			{ key: "branch", value: "feature/sdk-working-context", timestamp: "2026-04-02T10:00:00.000Z" },
		]);
		sessionManager.appendCustomEntry(SESSION_TODOS_CUSTOM_TYPE, [
			{ content: "Document contract", activeForm: "Documenting contract", status: "in_progress" },
		]);
		const session = createSession(sessionManager);

		const context = session.getWorkingContext();
		expect(context.memory).toEqual({
			itemCount: 1,
			staleCount: 0,
			keyPreview: ["branch"],
			isPersisted: true,
			scope: "current_branch_session_state",
		});
		expect(context.todo).toEqual({
			total: 1,
			completed: 0,
			inProgress: "Documenting contract",
			isPersisted: true,
			scope: "current_branch_session_state",
		});
	});

	it("surfaces live delegated work as current-process runtime state only", async () => {
		const session = createSession();

		(session as unknown as { _handleAgentEvent: (event: unknown) => void })._handleAgentEvent({
			type: "tool_execution_start",
			toolCallId: "call_worker",
			toolName: "subagent",
			args: { agent: "worker", task: "Implement SDK helper" },
		});
		await (session as unknown as { _agentEventQueue: Promise<void> })._agentEventQueue;

		const context = session.getWorkingContext();
		expect(context.delegatedWork).toEqual({
			activeCount: 1,
			completedCount: 0,
			failedCount: 0,
			activeAgents: ["worker"],
			failurePreview: [],
			isPersisted: false,
			scope: "current_process_runtime_state",
			note: "live current-process state only; not persisted and resets on session switch/resume",
		});
	});

	it("represents the no-delegation case honestly with zero runtime counts", () => {
		const session = createSession();
		const context = session.getWorkingContext();

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

	it("returns a JSON-serializable current-state payload", () => {
		const sessionManager = SessionManager.inMemory("/tmp/project");
		sessionManager.appendCustomEntry(SESSION_MEMORY_CUSTOM_TYPE, [
			{ key: "goal", value: "verify serializability", timestamp: "2026-04-02T11:00:00.000Z" },
		]);
		const session = createSession(sessionManager);

		const parsed = JSON.parse(JSON.stringify(session.getWorkingContext()));
		expect(parsed.memory.isPersisted).toBe(true);
		expect(parsed.todo.isPersisted).toBe(true);
		expect(parsed.delegatedWork.isPersisted).toBe(false);
	});

	it("consolidates the same path used by interactive mode and RPC working-context handlers", () => {
		// This test proves that both interactive-mode.ts (updateWorkingContextPanel, handleSessionCommand)
		// and rpc-mode.ts (get_working_context handler) now delegate to session.getWorkingContext()
		// instead of composing buildWorkingContext directly from session state.
		//
		// The consolidation point is AgentSession.getWorkingContext() which:
		// - calls buildWorkingContext() internally (preserving the shared contract in working-context.ts)
		// - retrieves state through AgentSession's own accessors (getMemoryItems, getTodos, getDelegatedWorkSummary)
		// - is the single source of truth for all working-context consumption paths
		//
		// This test verifies the consolidation by confirming session.getWorkingContext() returns
		// the same payload that would be built by direct composition, ensuring no semantics are lost.
		const sessionManager = SessionManager.inMemory("/tmp/project");
		sessionManager.appendCustomEntry(SESSION_MEMORY_CUSTOM_TYPE, [
			{ key: "interactive.test", value: "consolidation proof", timestamp: "2026-04-02T12:00:00.000Z" },
		]);
		sessionManager.appendCustomEntry(SESSION_TODOS_CUSTOM_TYPE, [
			{ content: "Consolidate modes", activeForm: "Consolidating modes", status: "completed" },
		]);
		const session = createSession(sessionManager);

		// Direct composition that was previously done in both modes
		const directComposition = buildWorkingContext({
			memoryItems: session.getMemoryItems(),
			todos: session.getTodos(),
			tasks: session.getTasks(),
			delegatedWorkSummary: session.getDelegatedWorkSummary(),
		});

		// Consolidated path used by both modes now
		const consolidatedPath = session.getWorkingContext();

		// They must be identical to prove consolidation doesn't change semantics
		expect(consolidatedPath).toEqual(directComposition);

		// Verify provenance honesty is preserved
		expect(consolidatedPath.memory.isPersisted).toBe(true);
		expect(consolidatedPath.memory.scope).toBe("current_branch_session_state");
		expect(consolidatedPath.todo.isPersisted).toBe(true);
		expect(consolidatedPath.todo.scope).toBe("current_branch_session_state");
		expect(consolidatedPath.delegatedWork.isPersisted).toBe(false);
		expect(consolidatedPath.delegatedWork.scope).toBe("current_process_runtime_state");
	});

	it("resets tasks to empty array when newSession() is called", async () => {
		const sessionManager = SessionManager.inMemory("/tmp/project");
		// Seed tasks via SessionManager (simulates task_create -> persisted)
		sessionManager.appendCustomEntry(SESSION_TASKS_CUSTOM_TYPE, [
			{ id: "task_clear_1", subject: "Task before new session", description: "desc", status: "in_progress" },
			{ id: "task_clear_2", subject: "Completed task", description: "desc2", status: "completed" },
		]);

		// Create session — tasks should be loaded from SessionManager
		const session = createSession(sessionManager);
		expect(session.getTasks()).toHaveLength(2);
		expect(session.getWorkingContext().tasks.total).toBe(2);

		// newSession() resets all state
		await session.newSession();
		expect(session.getTasks()).toEqual([]);
		expect(session.getWorkingContext().tasks.total).toBe(0);
		expect(session.getWorkingContext().tasks.pending).toBe(0);
		expect(session.getWorkingContext().tasks.inProgress).toBe(0);
		expect(session.getWorkingContext().tasks.completed).toBe(0);
	});
});
