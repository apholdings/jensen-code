/**
 * Live Reliability Kernel activation tests (2.2.0).
 *
 * These tests drive the REAL AgentSession + agent loop with a scripted fake
 * stream (no real LLM) and real tools, proving that the Reliability Kernel is
 * authoritative in the normal interactive execution path:
 *
 *   - real tool calls flow through before/after reliability hooks;
 *   - invalid (boundary-violating) tool calls are blocked before execution;
 *   - the Completion Gate controls live completion (premature "done" rejected);
 *   - mission state persists with the session and restores on resume.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type StreamFn } from "@apholdings/jensen-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Model,
	type Usage,
} from "@apholdings/jensen-ai";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../../src/core/agent-session.js";
import { AuthStorage } from "../../src/core/auth-storage.js";
import { ModelRegistry } from "../../src/core/model-registry.js";
import { DefaultResourceLoader } from "../../src/core/resource-loader.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const model = {
	id: "fixture",
	name: "fixture",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 1_000,
} as Model<any>;

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function textMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "fixture",
		usage,
		stopReason: "stop",
		timestamp: 1,
	};
}

function toolCallMessage(
	calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
): AssistantMessage {
	return {
		role: "assistant",
		content: calls.map((c) => ({ type: "toolCall", ...c })),
		api: "openai-responses",
		provider: "openai",
		model: "fixture",
		usage,
		stopReason: "toolUse",
		timestamp: 1,
	};
}

/** A deterministic fake stream that replays a fixed script of assistant messages. */
function scriptedStream(steps: AssistantMessage[]): StreamFn {
	let index = 0;
	return () => {
		const stream = new MockAssistantStream();
		const step = steps[index] ?? textMessage("Done.");
		index += 1;
		queueMicrotask(() => {
			const reason = step.content.some((c) => c.type === "toolCall") ? "toolUse" : "stop";
			stream.push({ type: "done", reason, message: step });
		});
		return stream;
	};
}

interface Fixture {
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	streamFn: StreamFn;
	session: AgentSession;
	agent: Agent;
}

function createFixture(streamFn: StreamFn, options: { sessionManager?: SessionManager } = {}): Fixture {
	const root = mkdtempSync(join(tmpdir(), "jensen-reliability-live-"));
	const cwd = join(root, "repo");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });

	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	const modelRegistry = new ModelRegistry(authStorage, undefined);
	modelRegistry.registerProvider("openai", {
		baseUrl: "https://example.invalid",
		apiKey: "dummy-key",
		api: "openai-responses",
		models: [model],
	});

	const settingsManager = SettingsManager.create(cwd, agentDir);
	const sessionManager = options.sessionManager ?? SessionManager.inMemory(cwd);
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });

	const agent = new Agent({
		initialState: { systemPrompt: "", model, thinkingLevel: "off", tools: [] },
		streamFn,
	});

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		resourceLoader,
		modelRegistry,
	});

	return { cwd, agentDir, sessionManager, streamFn, session, agent };
}

function missionDefinition(missionId = "mission_live") {
	return {
		missionId,
		goal: "Create the required files",
		criteria: [
			{
				id: "AC-1",
				description: "a.txt exists",
				source: "user" as const,
				verification: { kind: "file_exists" as const, path: "a.txt" },
			},
			{
				id: "AC-2",
				description: "b.txt exists",
				source: "user" as const,
				verification: { kind: "file_exists" as const, path: "b.txt" },
			},
			{
				id: "AC-3",
				description: "c.txt exists",
				source: "user" as const,
				verification: { kind: "file_exists" as const, path: "c.txt" },
			},
			{
				id: "AC-4",
				description: "d.txt exists",
				source: "user" as const,
				verification: { kind: "file_exists" as const, path: "d.txt" },
			},
		],
	};
}

describe("Reliability Kernel live activation", () => {
	it("A10 completion gate controls live completion: premature done is rejected then accepted", async () => {
		// Model: write 3 files, claim done (rejected), write the 4th, done (accepted).
		const stream = scriptedStream([
			toolCallMessage([
				{ id: "w-a", name: "write", arguments: { path: "a.txt", content: "a" } },
				{ id: "w-b", name: "write", arguments: { path: "b.txt", content: "b" } },
				{ id: "w-c", name: "write", arguments: { path: "c.txt", content: "c" } },
			]),
			textMessage("Everything is complete. Tests pass."),
			toolCallMessage([{ id: "w-d", name: "write", arguments: { path: "d.txt", content: "d" } }]),
			textMessage("All files created."),
		]);

		const fixture = createFixture(stream);
		fixture.session.startMission(missionDefinition());

		await fixture.session.prompt("Create a.txt, b.txt, c.txt, d.txt");

		expect(fixture.session.reliabilityActive).toBe(true);
		expect(fixture.session.reliabilityPhase).toBe("COMPLETED");
		for (const criterion of fixture.session.getReliabilityCriteria()) {
			expect(criterion.status).toBe("passed");
		}

		// Completion was rejected at least once before the model fixed AC-4.
		const finalizationRejections = fixture.session.reliabilityRuntime?.recorder
			.events()
			.filter((e) => e.name === "finalization_rejected");
		expect((finalizationRejections ?? []).length).toBeGreaterThanOrEqual(1);

		rmSync(fixture.cwd, { recursive: true, force: true });
	});

	it("A09 boundary prevents real execution: violating tool is never invoked", async () => {
		const stream = scriptedStream([
			toolCallMessage([{ id: "r-1", name: "read", arguments: { path: "/etc/passwd" } }]),
			textMessage("Done."),
		]);

		const fixture = createFixture(stream);

		// Spy on the real read tool to prove the violating call never reaches execution.
		const readTool = fixture.agent.state.tools.find((t) => t.name === "read");
		expect(readTool).toBeDefined();
		let readExecutions = 0;
		const originalExecute = readTool!.execute.bind(readTool);
		(readTool as { execute: typeof originalExecute }).execute = async (...args: unknown[]) => {
			readExecutions += 1;
			return originalExecute(...(args as Parameters<typeof originalExecute>));
		};

		fixture.session.startMission(missionDefinition());

		await fixture.session.prompt("Read a file");

		expect(readExecutions).toBe(0);

		const toolResults = fixture.agent.state.messages.filter((m) => m.role === "toolResult");
		expect(toolResults.length).toBe(1);
		expect((toolResults[0] as { isError?: boolean }).isError).toBe(true);

		rmSync(fixture.cwd, { recursive: true, force: true });
	});

	it("A02 real tool outcomes become evidence (success observation + failure evidence)", async () => {
		const stream = scriptedStream([
			toolCallMessage([
				{ id: "w-ok", name: "write", arguments: { path: "a.txt", content: "a" } },
				{ id: "b-fail", name: "bash", arguments: { command: "exit 7" } },
			]),
			textMessage("Done."),
		]);

		const fixture = createFixture(stream);
		fixture.session.startMission(missionDefinition());

		await fixture.session.prompt("Write a file and run a failing command");

		// The production write tool actually executed (real tool path used).
		expect(readFileSync(join(fixture.cwd, "a.txt"), "utf8")).toBe("a");

		const evidence = fixture.session.reliabilityRuntime?.ledger.evidence ?? [];
		expect(evidence.length).toBeGreaterThanOrEqual(2);

		// Successful tool outcome → authoritative observation (status "unknown":
		// observed, not yet proof of a criterion).
		const writeEvidence = evidence.find((e) => e.summary === "write executed");
		expect(writeEvidence).toBeDefined();
		expect(writeEvidence?.status).toBe("unknown");
		expect(writeEvidence?.metadata?.tool).toBe("write");
		expect(writeEvidence?.source).toBe("runtime:command-result");

		// Failed tool outcome → recorded as a failure evidence entry, never dropped.
		const failEvidence = evidence.find((e) => e.summary === "bash failed");
		expect(failEvidence).toBeDefined();
		expect(failEvidence?.status).toBe("fail");
		expect(failEvidence?.metadata?.tool).toBe("bash");

		rmSync(fixture.cwd, { recursive: true, force: true });
	});

	it("A01/A05 reliability hooks and extension hooks compose deterministically without duplication", async () => {
		const order: string[] = [];

		const stream = scriptedStream([
			toolCallMessage([
				// Boundary violation: reliability must block this before the extension
				// hook and before execution.
				{ id: "bad", name: "read", arguments: { path: "/etc/passwd" } },
				// Valid call: must flow through both reliability and extension hooks.
				{ id: "ok", name: "write", arguments: { path: "a.txt", content: "a" } },
			]),
			textMessage("Done."),
		]);

		const fixture = createFixture(stream);

		// Inject a minimal extension runner. The AgentSession hook callbacks read
		// `_extensionRunner` at execution time, so this exercises the real hook
		// composition path with a controlled dependency.
		(fixture.session as unknown as { _extensionRunner: unknown })._extensionRunner = {
			hasHandlers(type: string) {
				return type === "tool_call" || type === "tool_result";
			},
			async emitBeforeAgentStart() {
				return undefined;
			},
			async emit() {
				return undefined;
			},
			async emitInput() {
				return undefined;
			},
			async emitToolCall(event: { toolName: string }) {
				order.push(`ext_before:${event.toolName}`);
				return undefined;
			},
			async emitToolResult(event: { toolName: string }) {
				order.push(`ext_after:${event.toolName}`);
				return undefined;
			},
		};

		fixture.session.startMission(missionDefinition());
		await fixture.session.prompt("Read a file and write a file");

		// The valid write passed through both extension hooks exactly once.
		expect(order.filter((o) => o === "ext_before:write")).toHaveLength(1);
		expect(order.filter((o) => o === "ext_after:write")).toHaveLength(1);

		// The boundary-violating read was rejected before the extension hook ran
		// (reliability is authoritative and ordered first) and before execution.
		expect(order).not.toContain("ext_before:read");
		expect(order).not.toContain("ext_after:read");

		// Reliability recorded the structured rejection.
		const rejections = fixture.session.reliabilityRuntime?.recorder
			.events()
			.filter((e) => e.name === "action_validation_failure");
		expect((rejections ?? []).length).toBeGreaterThanOrEqual(1);

		rmSync(fixture.cwd, { recursive: true, force: true });
	});

	it("A06 resume restores the same mission with preserved criterion state", async () => {
		const sessionsDir = mkdtempSync(join(tmpdir(), "jensen-reliability-sessions-"));
		const cwd = join(sessionsDir, "repo");
		mkdirSync(cwd, { recursive: true });

		// First session: create a mission, complete only AC-1.
		const sessionManager = SessionManager.create(cwd, sessionsDir);
		const stream1 = scriptedStream([
			toolCallMessage([{ id: "w-a", name: "write", arguments: { path: "a.txt", content: "a" } }]),
			textMessage("Done."),
		]);

		const authStorage = AuthStorage.create(join(sessionsDir, "agent", "auth.json"));
		const modelRegistry = new ModelRegistry(authStorage, undefined);
		modelRegistry.registerProvider("openai", {
			baseUrl: "https://example.invalid",
			apiKey: "dummy-key",
			api: "openai-responses",
			models: [model],
		});
		const settingsManager = SettingsManager.create(cwd, join(sessionsDir, "agent"));
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: join(sessionsDir, "agent"), settingsManager });
		const agent1 = new Agent({
			initialState: { systemPrompt: "", model, thinkingLevel: "off", tools: [] },
			streamFn: stream1,
		});
		const session1 = new AgentSession({
			agent: agent1,
			sessionManager,
			settingsManager,
			cwd,
			resourceLoader,
			modelRegistry,
		});

		session1.startMission({
			missionId: "mission_resume",
			goal: "Create files",
			criteria: [
				{
					id: "AC-1",
					description: "a.txt exists",
					source: "user",
					verification: { kind: "file_exists", path: "a.txt" },
				},
				{
					id: "AC-2",
					description: "b.txt exists",
					source: "user",
					verification: { kind: "file_exists", path: "b.txt" },
				},
			],
		});
		await session1.prompt("Create a.txt");

		expect(session1.getReliabilityCriteria().find((c) => c.id === "AC-1")?.status).toBe("passed");
		expect(session1.reliabilityPhase).not.toBe("COMPLETED");

		const sessionFile = sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();

		// Second session: resume the same session file with a fresh resource loader.
		const opened = SessionManager.open(sessionFile!);
		const resourceLoader2 = new DefaultResourceLoader({ cwd, agentDir: join(sessionsDir, "agent"), settingsManager });
		const agent2 = new Agent({
			initialState: { systemPrompt: "", model, thinkingLevel: "off", tools: [] },
			streamFn: stream1,
		});
		const session2 = new AgentSession({
			agent: agent2,
			sessionManager: opened,
			settingsManager,
			cwd,
			resourceLoader: resourceLoader2,
			modelRegistry,
		});

		expect(session2.reliabilityActive).toBe(true);
		expect(session2.missionId).toBe("mission_resume");
		expect(session2.getReliabilityCriteria().find((c) => c.id === "AC-1")?.status).toBe("passed");
		expect(session2.getReliabilityCriteria().find((c) => c.id === "AC-2")?.status).toBe("pending");

		rmSync(sessionsDir, { recursive: true, force: true });
	});

	it("A08 legacy session without reliability state loads safely", async () => {
		const fixture = createFixture(scriptedStream([textMessage("hello")]));
		// No mission started — the kernel runs in governance mode.
		await fixture.session.prompt("Hello");

		expect(fixture.session.reliabilityActive).toBe(false);
		expect(fixture.session.reliabilityRuntime).toBeUndefined();
		expect(fixture.session.corruptReliabilityState).toBe(false);

		rmSync(fixture.cwd, { recursive: true, force: true });
	});
});
