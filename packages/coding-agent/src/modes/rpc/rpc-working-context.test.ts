import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Agent, type AgentEvent } from "@apholdings/jensen-agent-core";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../../core/agent-session.js";
import { AuthStorage } from "../../core/auth-storage.js";
import { SESSION_MEMORY_CUSTOM_TYPE, SESSION_TASKS_CUSTOM_TYPE, SESSION_TODOS_CUSTOM_TYPE } from "../../core/memory.js";
import { ModelRegistry } from "../../core/model-registry.js";
import { DefaultResourceLoader } from "../../core/resource-loader.js";
import { SessionManager } from "../../core/session-manager.js";
import { SettingsManager } from "../../core/settings-manager.js";
import { buildWorkingContext } from "../../core/working-context.js";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import { runRpcMode } from "./rpc-mode.js";
import type { RpcCommand, RpcResponse } from "./rpc-types.js";

function createSession(sessionManager = SessionManager.inMemory("/tmp/project"), cwd = "/tmp/project"): AgentSession {
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd,
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
		cwd,
		resourceLoader,
		modelRegistry,
	});
}

function createPersistedSessionManager(
	cwd: string,
	sessionDir: string,
	options: {
		memoryItems: Array<{ key: string; value: string; timestamp: string }>;
		todos: Array<{ content: string; activeForm: string; status: string }>;
	},
): SessionManager {
	const sessionManager = SessionManager.create(cwd, sessionDir);
	sessionManager.appendCustomEntry(SESSION_MEMORY_CUSTOM_TYPE, options.memoryItems);
	sessionManager.appendCustomEntry(SESSION_TODOS_CUSTOM_TYPE, options.todos);
	sessionManager.appendMessage({
		role: "assistant",
		api: "openai-chat",
		provider: "test-provider",
		model: "test-model",
		stopReason: "stop",
		content: [{ type: "text", text: "seed persisted session state" }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	});
	return sessionManager;
}

async function emitSessionEvent(session: AgentSession, event: AgentEvent): Promise<void> {
	const sessionWithInternals = session as unknown as {
		_handleAgentEvent: (agentEvent: AgentEvent) => void;
		_agentEventQueue: Promise<void>;
	};
	sessionWithInternals._handleAgentEvent(event);
	await sessionWithInternals._agentEventQueue;
}

function waitForRpcReader(stdin: PassThrough): Promise<void> {
	if (stdin.listenerCount("data") > 0) {
		return Promise.resolve();
	}

	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			stdin.off("newListener", onNewListener);
			reject(new Error("RPC mode did not attach a stdin reader"));
		}, 250);

		const onNewListener = (eventName: string | symbol) => {
			if (eventName !== "data") {
				return;
			}
			clearTimeout(timeout);
			stdin.off("newListener", onNewListener);
			resolve();
		};

		stdin.on("newListener", onNewListener);
	});
}

async function runRpcCommand(session: AgentSession, command: RpcCommand): Promise<RpcResponse> {
	const fakeStdin = new PassThrough();
	const fakeStdout = new PassThrough();
	const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
	const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, "stdout");

	if (!stdinDescriptor || !stdoutDescriptor) {
		throw new Error("Failed to capture process stdio descriptors");
	}

	let resolveResponse: ((response: RpcResponse) => void) | undefined;
	let rejectResponse: ((error: Error) => void) | undefined;
	const responsePromise = new Promise<RpcResponse>((resolve, reject) => {
		resolveResponse = resolve;
		rejectResponse = reject;
	});
	const responseTimeout = setTimeout(() => {
		rejectResponse?.(new Error(`Timed out waiting for RPC response to ${command.type}`));
	}, 250);
	const detachOutputReader = attachJsonlLineReader(fakeStdout, (line) => {
		const parsed = JSON.parse(line) as RpcResponse;
		if (parsed.type === "response") {
			clearTimeout(responseTimeout);
			resolveResponse?.(parsed);
		}
	});

	Object.defineProperty(process, "stdin", { configurable: true, value: fakeStdin });
	Object.defineProperty(process, "stdout", { configurable: true, value: fakeStdout });

	try {
		const readerReady = waitForRpcReader(fakeStdin);
		void runRpcMode(session);
		await readerReady;
		fakeStdin.write(serializeJsonLine(command));
		return await responsePromise;
	} finally {
		clearTimeout(responseTimeout);
		detachOutputReader();
		fakeStdin.end();
		fakeStdout.end();
		Object.defineProperty(process, "stdin", stdinDescriptor);
		Object.defineProperty(process, "stdout", stdoutDescriptor);
	}
}

describe("RPC working-context payload", () => {
	it("is JSON-serializable with explicit persisted vs runtime scope markers", () => {
		const payload = buildWorkingContext({
			memoryItems: [{ key: "branch", value: "feature/refactor", timestamp: "2026-04-02T10:00:00.000Z" }],
			todos: [{ content: "Ship RPC surface", activeForm: "Shipping RPC surface", status: "in_progress" }],
			tasks: [],
			delegatedWorkSummary: {
				active: [
					{
						toolCallId: "call_worker",
						agent: "worker",
						agentSource: "user",
						task: "Implement RPC working context",
						mode: "single",
						status: "active",
						timestamp: Date.now(),
					},
				],
				completed: [],
				failed: [],
				total: 1,
				isSessionState: true,
				note: "ephemeral current-session state; not persisted across sessions or branches",
			},
		});

		const serialized = serializeJsonLine(payload);
		const parsed = JSON.parse(serialized);

		expect(parsed.memory.isPersisted).toBe(true);
		expect(parsed.memory.scope).toBe("current_branch_session_state");
		expect(parsed.todo.isPersisted).toBe(true);
		expect(parsed.todo.scope).toBe("current_branch_session_state");
		expect(parsed.delegatedWork.isPersisted).toBe(false);
		expect(parsed.delegatedWork.scope).toBe("current_process_runtime_state");
		expect(parsed.delegatedWork.note).toContain("not persisted");
	});

	it("represents the no-delegation case honestly with zero counts", () => {
		const payload = buildWorkingContext({
			memoryItems: [],
			todos: [],
			tasks: [],
			delegatedWorkSummary: {
				active: [],
				completed: [],
				failed: [],
				total: 0,
				isSessionState: true,
				note: "ephemeral current-session state; not persisted across sessions or branches",
			},
		});

		expect(payload.delegatedWork).toEqual({
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

	it("returns live working context through the RPC JSONL command path", async () => {
		const sessionManager = SessionManager.inMemory("/tmp/project");
		sessionManager.appendCustomEntry(SESSION_MEMORY_CUSTOM_TYPE, [
			{ key: "project.goal", value: "cover runtime RPC path", timestamp: "2026-04-02T12:00:00.000Z" },
		]);
		sessionManager.appendCustomEntry(SESSION_TODOS_CUSTOM_TYPE, [
			{ content: "Add runtime RPC test", activeForm: "Adding runtime RPC test", status: "in_progress" },
		]);
		const session = createSession(sessionManager);

		await emitSessionEvent(session, {
			type: "tool_execution_start",
			toolCallId: "call_worker",
			toolName: "subagent",
			args: { agent: "worker", task: "Verify live delegated work summary" },
		});

		const response = await runRpcCommand(session, { id: "wc-1", type: "get_working_context" });

		expect(response).toEqual({
			id: "wc-1",
			type: "response",
			command: "get_working_context",
			success: true,
			data: {
				memory: {
					itemCount: 1,
					staleCount: 0,
					keyPreview: ["project.goal"],
					isPersisted: true,
					scope: "current_branch_session_state",
				},
				todo: {
					total: 1,
					completed: 0,
					inProgress: "Adding runtime RPC test",
					isPersisted: true,
					scope: "current_branch_session_state",
				},
				tasks: {
					total: 0,
					pending: 0,
					inProgress: 0,
					completed: 0,
					inProgressTask: undefined,
					isPersisted: true,
					scope: "current_branch_session_state",
				},
				delegatedWork: {
					activeCount: 1,
					completedCount: 0,
					failedCount: 0,
					activeAgents: ["worker"],
					failurePreview: [],
					isPersisted: false,
					scope: "current_process_runtime_state",
					note: "live current-process state only; not persisted and resets on session switch/resume",
				},
			},
		});
	});

	it("proves honest reset boundary: delegated-work resets on session switch while persisted memory and todos remain available", async () => {
		const rootDir = mkdtempSync(join(tmpdir(), "jensen-rpc-working-context-"));
		const cwd = join(rootDir, "repo");
		const sessionDir = join(rootDir, "sessions");

		try {
			const sourceSessionManager = createPersistedSessionManager(cwd, sessionDir, {
				memoryItems: [{ key: "session.source", value: "source state", timestamp: "2026-04-02T12:00:00.000Z" }],
				todos: [{ content: "Source task", activeForm: "Working source task", status: "in_progress" }],
			});
			sourceSessionManager.appendCustomEntry(SESSION_TASKS_CUSTOM_TYPE, [
				{ id: "src_task_1", subject: "Source session task", description: "source desc", status: "pending" },
				{
					id: "src_task_2",
					subject: "Source in progress task",
					description: "source desc 2",
					status: "in_progress",
				},
			]);
			const targetSessionManager = createPersistedSessionManager(cwd, sessionDir, {
				memoryItems: [{ key: "session.target", value: "target state", timestamp: "2026-04-02T12:05:00.000Z" }],
				todos: [{ content: "Target task", activeForm: "Working target task", status: "in_progress" }],
			});
			targetSessionManager.appendCustomEntry(SESSION_TASKS_CUSTOM_TYPE, [
				{ id: "tgt_task_1", subject: "Target session task", description: "target desc", status: "pending" },
			]);
			const targetSessionFile = targetSessionManager.getSessionFile();
			if (!targetSessionFile) {
				throw new Error("Expected target persisted session file");
			}

			const session = createSession(sourceSessionManager, cwd);
			await emitSessionEvent(session, {
				type: "tool_execution_start",
				toolCallId: "call_worker",
				toolName: "subagent",
				args: { agent: "worker", task: "Verify reset boundary honesty" },
			});

			const beforeResponse = await runRpcCommand(session, { id: "wc-before", type: "get_working_context" });
			expect(beforeResponse).toEqual({
				id: "wc-before",
				type: "response",
				command: "get_working_context",
				success: true,
				data: {
					memory: {
						itemCount: 1,
						staleCount: 0,
						keyPreview: ["session.source"],
						isPersisted: true,
						scope: "current_branch_session_state",
					},
					todo: {
						total: 1,
						completed: 0,
						inProgress: "Working source task",
						isPersisted: true,
						scope: "current_branch_session_state",
					},
					tasks: {
						total: 2,
						pending: 1,
						inProgress: 1,
						completed: 0,
						inProgressTask: { id: "src_task_2", subject: "Source in progress task", activeForm: undefined },
						isPersisted: true,
						scope: "current_branch_session_state",
					},
					delegatedWork: {
						activeCount: 1,
						completedCount: 0,
						failedCount: 0,
						activeAgents: ["worker"],
						failurePreview: [],
						isPersisted: false,
						scope: "current_process_runtime_state",
						note: "live current-process state only; not persisted and resets on session switch/resume",
					},
				},
			});

			const switchResponse = await runRpcCommand(session, {
				id: "switch-1",
				type: "switch_session",
				sessionPath: targetSessionFile,
			});
			expect(switchResponse).toEqual({
				id: "switch-1",
				type: "response",
				command: "switch_session",
				success: true,
				data: { cancelled: false },
			});

			const afterResponse = await runRpcCommand(session, { id: "wc-after", type: "get_working_context" });
			expect(afterResponse).toEqual({
				id: "wc-after",
				type: "response",
				command: "get_working_context",
				success: true,
				data: {
					memory: {
						itemCount: 1,
						staleCount: 0,
						keyPreview: ["session.target"],
						isPersisted: true,
						scope: "current_branch_session_state",
					},
					todo: {
						total: 1,
						completed: 0,
						inProgress: "Working target task",
						isPersisted: true,
						scope: "current_branch_session_state",
					},
					tasks: {
						total: 1,
						pending: 1,
						inProgress: 0,
						completed: 0,
						inProgressTask: undefined,
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
				},
			});
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});
});
