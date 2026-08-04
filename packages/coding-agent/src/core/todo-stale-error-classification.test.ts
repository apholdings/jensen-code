/**
 * Tests: stale todo_update revision handling after durable recovery.
 *
 * A stale todo_update revision is now recovered INTERNALLY and
 * DETERMINISTICALLY: the engine reads the current state, rebases the
 * non-conflicting intent exactly once, and applies it. A stale revision is
 * NEVER a run-terminal condition and NEVER requires the model to manually
 * issue todo_read merely to satisfy an internal concurrency protocol.
 *
 * The prior false-positive behavior (REQUIRE_READ + REPEATED_TODO_UPDATE_LOOP
 * run termination) is gone; this file documents the corrected behavior.
 */

import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "@apholdings/jensen-agent-core";
import { agentLoop } from "@apholdings/jensen-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Model,
	type UserMessage,
} from "@apholdings/jensen-ai";
import { describe, expect, it } from "vitest";
import { TodoEngine } from "./todo/index.js";
import { TodoLoopGuard } from "./tools/todo-loop-guard.js";
import { createTodoReadTool } from "./tools/todo-read.js";
import { createTodoUpdateTool } from "./tools/todo-update.js";
import { createTodoWriteTool, type TodoItem } from "./tools/todo-write.js";

// ---------------------------------------------------------------------------
// Agent-loop helpers (same pattern as packages/agent/test/agent-loop.test.ts)
// ---------------------------------------------------------------------------

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

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function identityConverter(messages: AgentMessage[]): import("@apholdings/jensen-ai").Message[] {
	return messages.filter(
		(m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
	) as import("@apholdings/jensen-ai").Message[];
}

// ---------------------------------------------------------------------------
// Shared test setup — one engine shared across read/update tools
// ---------------------------------------------------------------------------

function createTodoTools() {
	let persisted: TodoItem[] = [];
	let revision = 0;
	const guard = new TodoLoopGuard();
	const engine = new TodoEngine("test-session");

	const writeTool = createTodoWriteTool(
		() => persisted,
		(next) => {
			persisted = next;
			revision++;
		},
		guard,
		() => revision,
	);

	const readTool = createTodoReadTool(
		() => persisted,
		() => revision,
		undefined,
		engine,
	);

	const updateTool = createTodoUpdateTool(
		() => persisted,
		(next) => {
			persisted = next;
			revision++;
		},
		() => revision,
		guard,
		undefined,
		undefined,
		engine,
	);

	return {
		writeTool,
		readTool,
		updateTool,
		engine,
		getPersisted: () => persisted,
		getRevision: () => revision,
	};
}

// ---------------------------------------------------------------------------
// C01–C08: corrected stale-recovery behavior through the real agent loop
// ---------------------------------------------------------------------------

describe("stale todo_update auto-recovery (real agent loop)", () => {
	it("C01: stale non-conflicting revision auto-rebases and updates with isError=false", async () => {
		const { writeTool, readTool, updateTool, getPersisted } = createTodoTools();
		await makeTodos(writeTool, "Task A");
		const firstTodoId = getPersisted()[0].id!;
		await readTool.execute("r1", {}); // snapshot revision 2

		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [updateTool as unknown as AgentTool],
		};
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };

		let callIndex = 0;
		const streamFn = () => {
			const s = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					s.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[
								{
									type: "toolCall",
									id: "stale-1",
									name: "todo_update",
									arguments: {
										updates: [{ id: firstTodoId, status: "completed" }],
										expectedRevision: 0, // far-stale
									},
								},
							],
							"toolUse",
						),
					});
				} else {
					s.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "Done" }]),
					});
				}
				callIndex++;
			});
			return s;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("go")], context, config, undefined, streamFn);
		for await (const event of stream) {
			events.push(event);
		}

		const toolEnd = events.find(
			(e): e is Extract<AgentEvent, { type: "tool_execution_end" }> => e.type === "tool_execution_end",
		);
		expect(toolEnd).toBeDefined();
		expect(toolEnd!.isError).toBe(false);

		const text = (toolEnd!.result.content as Array<{ type: string; text?: string }>)
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("\n");
		expect(text).not.toContain("TODO_READ_REQUIRED");
		expect(text).toContain("rebase");

		// C01: item was actually completed
		expect(getPersisted()[0].status).toBe("completed");
	});

	it("C02: a conflicting stale update is typed and nonfatal; run continues", async () => {
		const { writeTool, readTool, updateTool, getPersisted } = createTodoTools();
		await makeTodos(writeTool, "Task B");
		const firstTodoId = getPersisted()[0].id!;
		await readTool.execute("r1", {}); // base snapshot at revision 2 (content "Task B")

		// The model legitimately changes content, advancing the store to revision 3.
		const first = await updateTool.execute("v2", {
			updates: [{ id: firstTodoId, content: "Version 2" }],
			expectedRevision: 2,
		});
		if (first.content[0].type !== "text") throw new Error("text expected");

		// A later stale update based on the OLD snapshot (rev 2) targets content that
		// was concurrently changed (now "Version 2"). This must be a typed, nonfatal
		// conflict — never a throw, never run termination.
		const result = await updateTool.execute("conflict-1", {
			updates: [{ id: firstTodoId, content: "Model X" }],
			expectedRevision: 2,
		});
		const text = result.content[0];
		if (text.type !== "text") throw new Error("expected text");
		const details = result.details as Record<string, unknown> | undefined;
		expect(text.text.includes("TODO_REBASE_CONFLICT") || details?.errorCode === "TODO_REBASE_CONFLICT").toBe(true);
	});

	it("C03: valid current-revision update succeeds with isError=false", async () => {
		const { writeTool, readTool, updateTool, getPersisted, getRevision } = createTodoTools();
		await makeTodos(writeTool, "Task C");
		const firstTodoId = getPersisted()[0].id!;
		const currentRev = getRevision();
		await readTool.execute("r1", {});

		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [updateTool as unknown as AgentTool],
		};
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };

		let callIndex = 0;
		const streamFn = () => {
			const s = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					s.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[
								{
									type: "toolCall",
									id: "valid-1",
									name: "todo_update",
									arguments: {
										updates: [{ id: firstTodoId, status: "completed" }],
										expectedRevision: currentRev,
									},
								},
							],
							"toolUse",
						),
					});
				} else {
					s.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "Done" }]),
					});
				}
				callIndex++;
			});
			return s;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("go")], context, config, undefined, streamFn);
		for await (const event of stream) {
			events.push(event);
		}

		const toolEnd = events.find(
			(e): e is Extract<AgentEvent, { type: "tool_execution_end" }> => e.type === "tool_execution_end",
		);
		expect(toolEnd).toBeDefined();
		expect(toolEnd!.isError).toBe(false);
		expect(getPersisted()[0].status).toBe("completed");
	});

	it("C04: stale recovery produces a non-error model-facing toolResult", async () => {
		const { writeTool, readTool, updateTool, getPersisted } = createTodoTools();
		await makeTodos(writeTool, "Task D");
		const firstTodoId = getPersisted()[0].id!;
		await readTool.execute("r1", {});

		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [updateTool as unknown as AgentTool],
		};
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };

		let callIndex = 0;
		const streamFn = () => {
			const s = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					s.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[
								{
									type: "toolCall",
									id: "stale-2",
									name: "todo_update",
									arguments: {
										updates: [{ id: firstTodoId, status: "completed" }],
										expectedRevision: 0,
									},
								},
							],
							"toolUse",
						),
					});
				} else {
					s.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "Done" }]),
					});
				}
				callIndex++;
			});
			return s;
		};

		const stream = agentLoop([createUserMessage("go")], context, config, undefined, streamFn);
		const messages = await stream.result();
		const toolResults = messages.filter((m) => m.role === "toolResult");
		expect(toolResults.length).toBe(1);
		const texts = toolResults[0].content.filter((c): c is { type: "text"; text: string } => c.type === "text");
		expect(texts[0].text.length).toBeGreaterThan(20);
		expect(texts[0].text).not.toContain("TODO_READ_REQUIRED");
		expect(texts[0].text).not.toContain("REPEATED_TODO_UPDATE_LOOP");
	});

	it("C05: agent-loop completes normally across stale recovery", async () => {
		const { writeTool, readTool, updateTool, getPersisted } = createTodoTools();
		await makeTodos(writeTool, "Task E");
		const firstTodoId = getPersisted()[0].id!;
		await readTool.execute("r1", {});

		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [updateTool as unknown as AgentTool],
		};
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };

		let callIndex = 0;
		const streamFn = () => {
			const s = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					s.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[
								{
									type: "toolCall",
									id: "stale-3",
									name: "todo_update",
									arguments: {
										updates: [{ id: firstTodoId, status: "completed" }],
										expectedRevision: 0,
									},
								},
							],
							"toolUse",
						),
					});
				} else {
					s.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "Done" }]),
					});
				}
				callIndex++;
			});
			return s;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("go")], context, config, undefined, streamFn);
		for await (const event of stream) {
			events.push(event);
		}
		const eventTypes = events.map((e) => e.type);
		expect(eventTypes).toContain("agent_start");
		expect(eventTypes).toContain("tool_execution_end");
		expect(eventTypes).toContain("agent_end");
	});
});

// C10: direct execute contract — stale revision auto-recovers, no TODO_READ_REQUIRED
describe("direct todo_update.execute contract", () => {
	it("C10: stale revision returns automatic-rebase success details (not TODO_READ_REQUIRED)", async () => {
		const { writeTool, readTool, updateTool, getPersisted, getRevision } = createTodoTools();
		await makeTodos(writeTool, "Task F");
		const firstTodoId = getPersisted()[0].id!;
		const revBefore = getRevision();
		await readTool.execute("r1", {});

		const result = await updateTool.execute("stale-dir", {
			updates: [{ id: firstTodoId, status: "completed" }],
			expectedRevision: revBefore - 1,
		});
		const text = result.content[0];
		if (text.type !== "text") throw new Error("expected text");
		expect(text.text).not.toContain("TODO_READ_REQUIRED");
		expect(text.text).toContain("rebase");
		// mutated once via automatic rebase
		expect(getPersisted()[0].status).toBe("completed");
	});
});

function makeTodos(writeTool: ReturnType<typeof createTodoTools>["writeTool"], content: string): Promise<string> {
	return writeTool
		.execute("w-seed", {
			todos: [{ content, activeForm: `Working on ${content}`, status: "pending" }],
		})
		.then(() => ""); // id captured after write via getPersisted
}
