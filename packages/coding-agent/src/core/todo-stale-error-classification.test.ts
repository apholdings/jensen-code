/**
 * Tests: stale todo_update revision rejections are classified as tool errors.
 *
 * This file exercises the real production path:
 *   real Todo ledger → real createTodoUpdateTool → real agentLoop
 *   → real executePreparedToolCall catch → isError=true
 *
 * It does NOT test or claim to fix any TUI render stall, input restoration,
 * or blank-frame issue.
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
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { ToolExecutionComponent } from "../modes/interactive/components/tool-execution.js";
import { initTheme } from "../modes/interactive/theme/theme.js";
import { TodoLoopGuard } from "./tools/todo-loop-guard.js";
import { createTodoUpdateTool } from "./tools/todo-update.js";
import { createTodoWriteTool, type TodoItem } from "./tools/todo-write.js";

initTheme("dark");

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
// Shared test setup
// ---------------------------------------------------------------------------

function createTodoTools() {
	let persisted: TodoItem[] = [];
	let revision = 0;
	const guard = new TodoLoopGuard();

	const writeTool = createTodoWriteTool(
		() => persisted,
		(next) => {
			persisted = next;
			revision++;
		},
		guard,
		() => revision,
	);

	const updateTool = createTodoUpdateTool(
		() => persisted,
		(next) => {
			persisted = next;
			revision++;
		},
		() => revision,
		guard,
	);

	return { writeTool, updateTool, getPersisted: () => persisted, getRevision: () => revision };
}

// ---------------------------------------------------------------------------
// C01: Real stale classification through the agent loop
// ---------------------------------------------------------------------------

describe("stale todo_update error classification (real agent loop)", () => {
	it("C01: stale revision → tool_execution_end emits isError=true", async () => {
		const { writeTool, updateTool, getPersisted } = createTodoTools();

		// Pre-populate: write todos to advance the revision
		await writeTool.execute("w1", {
			todos: [{ content: "Task A", activeForm: "Working on A", status: "pending" }],
		});
		const firstTodoId = getPersisted()[0].id!;

		// Stale call: revision is already 1, ask with 0
		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [updateTool as unknown as AgentTool],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let callIndex = 0;
		const streamFn = () => {
			const s = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const msg = createAssistantMessage(
						[
							{
								type: "toolCall",
								id: "stale-1",
								name: "todo_update",
								arguments: {
									updates: [{ id: firstTodoId, status: "completed" }],
									expectedRevision: 0,
								},
							},
						],
						"toolUse",
					);
					s.push({ type: "done", reason: "toolUse", message: msg });
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

		// C01: tool_execution_end emitted with isError=true
		const toolEnd = events.find(
			(e): e is Extract<AgentEvent, { type: "tool_execution_end" }> => e.type === "tool_execution_end",
		);
		expect(toolEnd).toBeDefined();
		expect(toolEnd!.isError).toBe(true);

		// C01: text contains expected and current revisions
		const textBlocks = toolEnd!.result.content.filter(
			(c: { type: string; text?: string }): c is { type: "text"; text: string } => c.type === "text",
		);
		expect(textBlocks.length).toBe(1);
		expect(textBlocks[0].text).toContain("Stale revision");
		expect(textBlocks[0].text).toContain("Expected revision 0");
		expect(textBlocks[0].text).toContain("current is 1");
	});

	// -----------------------------------------------------------------------
	// C02: Ledger immutability
	// -----------------------------------------------------------------------

	it("C02: stale rejection leaves ledger and revision unchanged", async () => {
		const { writeTool, updateTool, getPersisted, getRevision } = createTodoTools();

		await writeTool.execute("w1", {
			todos: [{ content: "Task A", activeForm: "Working on A", status: "pending" }],
		});

		const firstTodoId = getPersisted()[0].id!;
		const beforeStatus = getPersisted()[0].status;
		const beforeRev = getRevision();
		const beforeIds = getPersisted().map((t) => t.id);

		// Direct execute: stale revision
		await expect(
			updateTool.execute("stale-dir", {
				updates: [{ id: firstTodoId, status: "completed" }],
				expectedRevision: beforeRev - 1,
			}),
		).rejects.toThrow("Stale revision");

		// C02: zero mutation
		expect(getPersisted()[0].status).toBe(beforeStatus);
		expect(getRevision()).toBe(beforeRev);
		expect(getPersisted().map((t) => t.id)).toEqual(beforeIds);

		// C02: ledger remains readable
		const { createTodoReadTool } = await import("./tools/todo-read.js");
		const readTool = createTodoReadTool(
			() => getPersisted(),
			() => getRevision(),
		);
		const readResult = await readTool.execute("r1", {});
		expect(readResult.details).toBeDefined();
		expect((readResult.details as { todos: TodoItem[] }).todos.length).toBe(1);
	});

	// -----------------------------------------------------------------------
	// C03: Normal update still succeeds
	// -----------------------------------------------------------------------

	it("C03: valid expectedRevision updates successfully with isError=false", async () => {
		const { writeTool, updateTool, getPersisted, getRevision } = createTodoTools();

		await writeTool.execute("w1", {
			todos: [{ content: "Task B", activeForm: "Working on B", status: "pending" }],
		});

		const firstTodoId = getPersisted()[0].id!;
		const currentRev = getRevision();

		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [updateTool as unknown as AgentTool],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

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

		// C03: ledger mutated exactly once
		expect(getPersisted()[0].status).toBe("completed");
	});

	// -----------------------------------------------------------------------
	// C04: Model-facing error result
	// -----------------------------------------------------------------------

	it("C04: stale revision produces model-facing error toolResult", async () => {
		const { writeTool, updateTool, getPersisted } = createTodoTools();

		await writeTool.execute("w1", {
			todos: [{ content: "Task C", activeForm: "Working on C", status: "pending" }],
		});
		const firstTodoId = getPersisted()[0].id!;

		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [updateTool as unknown as AgentTool],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

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

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("go")], context, config, undefined, streamFn);

		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();
		const toolResults = messages.filter((m) => m.role === "toolResult");
		expect(toolResults.length).toBe(1);

		// C04: model-facing result is classified as error
		const tr = toolResults[0];
		expect(tr.isError).toBe(true);

		// C04: meaningful non-empty text
		const texts = tr.content.filter(
			(c: { type: string; text?: string }): c is { type: "text"; text: string } => c.type === "text",
		);
		expect(texts.length).toBe(1);
		expect(texts[0].text.length).toBeGreaterThan(20);
	});

	// -----------------------------------------------------------------------
	// C05: Renderer classification (real component with real outcome)
	// -----------------------------------------------------------------------

	it("C05: isError=true outcome is rendered with error styling and visible text", async () => {
		const { writeTool, updateTool, getPersisted } = createTodoTools();

		await writeTool.execute("w1", {
			todos: [{ content: "Task D", activeForm: "Working on D", status: "pending" }],
		});
		const firstTodoId = getPersisted()[0].id!;

		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [updateTool as unknown as AgentTool],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

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

		// Capture the real emitted outcome
		const toolEnd = events.find(
			(e): e is Extract<AgentEvent, { type: "tool_execution_end" }> => e.type === "tool_execution_end",
		);
		expect(toolEnd).toBeDefined();
		expect(toolEnd!.isError).toBe(true);

		// Feed the real outcome through the ToolExecutionComponent renderer
		const ui = { requestRender: () => {} };
		const component = new ToolExecutionComponent(
			"todo_update",
			{ updates: [{ id: firstTodoId, status: "completed" }], expectedRevision: 0 },
			{ showImages: true },
			undefined,
			ui as any,
			"/tmp",
		);

		component.updateResult({ ...toolEnd!.result, isError: toolEnd!.isError });

		// C05: renderer does not throw
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(() => component.render(80)).not.toThrow();

		// C05: visible stale-revision text rendered
		expect(rendered).toContain("Stale revision");
		expect(rendered).toContain("todo_read");

		// C05: output is non-empty
		expect(rendered.trim().length).toBeGreaterThan(0);
	});

	// -----------------------------------------------------------------------
	// C06: Normal agent-loop completion (no regression)
	// -----------------------------------------------------------------------

	it("C06: throwing on stale revision does not regress agent-loop completion", async () => {
		const { writeTool, updateTool, getPersisted } = createTodoTools();

		await writeTool.execute("w1", {
			todos: [{ content: "Task E", activeForm: "Working on E", status: "pending" }],
		});
		const firstTodoId = getPersisted()[0].id!;

		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [updateTool as unknown as AgentTool],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

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
									id: "stale-4",
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

		// C06: agent loop completes normally
		const eventTypes = events.map((e) => e.type);
		expect(eventTypes).toContain("agent_start");
		expect(eventTypes).toContain("tool_execution_start");
		expect(eventTypes).toContain("tool_execution_end");
		expect(eventTypes).toContain("agent_end");
	});

	// -----------------------------------------------------------------------
	// C07: Direct execute contract — throws on stale revision
	// -----------------------------------------------------------------------

	it("C07: direct todo_update.execute() rejects with Error on stale revision", async () => {
		const { writeTool, updateTool, getPersisted } = createTodoTools();

		await writeTool.execute("w1", {
			todos: [{ content: "Task F", activeForm: "Working on F", status: "pending" }],
		});
		const firstTodoId = getPersisted()[0].id!;

		// C07: stale call rejects with Error
		await expect(
			updateTool.execute("stale-dir-2", {
				updates: [{ id: firstTodoId, status: "completed" }],
				expectedRevision: 0,
			}),
		).rejects.toThrow("Stale revision");
	});

	// -----------------------------------------------------------------------
	// C08: Structured information — error message contains revision numbers
	// -----------------------------------------------------------------------

	it("C08: stale error message contains expected and current revision numbers", async () => {
		const { writeTool, updateTool, getPersisted } = createTodoTools();

		await writeTool.execute("w1", {
			todos: [{ content: "Task G", activeForm: "Working on G", status: "pending" }],
		});
		const firstTodoId = getPersisted()[0].id!;

		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [updateTool as unknown as AgentTool],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

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
									id: "stale-5",
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

		const toolEnd = events.find(
			(e): e is Extract<AgentEvent, { type: "tool_execution_end" }> => e.type === "tool_execution_end",
		);
		expect(toolEnd).toBeDefined();

		const text = toolEnd!.result.content
			.filter((c: { type: string; text?: string }): c is { type: "text"; text: string } => c.type === "text")
			.map((c: { type: "text"; text: string }) => c.text)
			.join("\n");

		// C08: error message contains both revision numbers
		expect(text).toMatch(/expected revision\s+0/i);
		expect(text).toMatch(/current is\s+1/i);
	});
});
