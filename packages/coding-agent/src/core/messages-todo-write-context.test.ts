import {
	type AgentContext,
	type AgentEvent,
	type AgentLoopConfig,
	agentLoop,
	type StreamFn,
} from "@apholdings/jensen-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	EventStream,
	type Model,
	type ToolResultMessage,
	type Usage,
	validateToolArguments,
} from "@apholdings/jensen-ai";
import { describe, expect, it } from "vitest";
import { convertToLlm } from "./messages.js";
import { createTodoReadTool } from "./tools/todo-read.js";
import { createTodoWriteTool, type TodoItem } from "./tools/todo-write.js";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

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

const model: Model<"openai-responses"> = {
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
};

function makeTodos(count: number, contentLength: number): TodoItem[] {
	return Array.from({ length: count }, (_, index) => ({
		content: `Task ${index} ${"x".repeat(contentLength)}`,
		activeForm: `Doing ${index} ${"y".repeat(contentLength)}`,
		status: index === count - 1 ? "in_progress" : "pending",
	}));
}

function makePendingTodos(count: number, contentLength: number): TodoItem[] {
	return makeTodos(count, contentLength).map((todo) => ({ ...todo, status: "pending" }));
}

function makeAssistant(todos: TodoItem[]): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "todo-call",
				name: "todo_write",
				arguments: { todos },
			},
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "fixture",
		usage,
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function byteLength(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

async function executeAndCapture(
	todos: TodoItem[],
	initial: TodoItem[] = [],
): Promise<{
	persisted: TodoItem[];
	uiEvent: TodoItem[];
	toolResult: ToolResultMessage;
	nextRequest: Context;
}> {
	let persisted: TodoItem[] = initial;
	let uiEvent: TodoItem[] = [];
	const tool = createTodoWriteTool(
		() => persisted,
		(next) => {
			persisted = next;
			uiEvent = next;
		},
	);
	const context: AgentContext = {
		systemPrompt: "fixed system prompt",
		messages: [],
		tools: [tool],
	};
	const config: AgentLoopConfig = { model, convertToLlm };
	const requests: Context[] = [];
	let callIndex = 0;
	const streamFn: StreamFn = (_model, request) => {
		requests.push(request);
		const stream = new MockAssistantStream();
		const currentCall = callIndex++;
		queueMicrotask(() => {
			if (currentCall === 0) {
				stream.push({ type: "done", reason: "toolUse", message: makeAssistant(todos) });
			} else {
				stream.push({
					type: "done",
					reason: "stop",
					message: { ...makeAssistant([]), content: [{ type: "text", text: "done" }], stopReason: "stop" },
				});
			}
		});
		return stream;
	};
	const events: AgentEvent[] = [];
	const stream = agentLoop(
		[{ role: "user", content: "Update todos", timestamp: 0 }],
		context,
		config,
		undefined,
		streamFn,
	);
	for await (const event of stream) {
		events.push(event);
	}
	const toolResultEvent = events.find((event) => event.type === "message_end" && event.message.role === "toolResult");
	if (toolResultEvent?.type !== "message_end" || toolResultEvent.message.role !== "toolResult") {
		throw new Error("Expected todo_write tool result");
	}
	const nextRequest = requests[1];
	if (!nextRequest) {
		throw new Error("Expected second provider request");
	}
	return {
		persisted,
		uiEvent,
		toolResult: toolResultEvent.message,
		nextRequest,
	};
}

function restoreFullArguments(request: Context, todos: TodoItem[]): Context {
	return {
		...request,
		messages: request.messages.map((message) =>
			message.role === "assistant" && message.content.some((block) => block.type === "toolCall")
				? makeAssistant(todos)
				: message,
		),
	};
}

describe("todo_write model context", () => {
	it.each([
		["creates a todo", makeTodos(1, 16), []],
		["updates an existing large todo list", makeTodos(1_000, 256), makePendingTodos(1_000, 256)],
	])("%s while preserving full state for persistence and UI", async (_label, todos, initial) => {
		const execution = await executeAndCapture(todos, initial);

		expect(execution.persisted).toEqual(todos);
		expect(execution.uiEvent).toEqual(todos);
		expect(execution.toolResult.content).toEqual([
			{
				type: "text",
				text:
					todos.length === 1
						? "Todo list updated (1 total: 0 pending, 1 in progress, 0 completed). Continue with the current in-progress task."
						: "Todo list updated (1000 total: 999 pending, 1 in progress, 0 completed). Continue with the current in-progress task.",
			},
		]);
		expect(initial).not.toEqual(todos);
	});

	it("keeps tool result and next request bounded as unrelated todos grow", async () => {
		const smallTodos = makeTodos(2, 16);
		const largeTodos = makeTodos(1_000, 256);
		const smallExecution = await executeAndCapture(smallTodos);
		const largeExecution = await executeAndCapture(largeTodos);
		const smallRequest = smallExecution.nextRequest;
		const largeRequest = largeExecution.nextRequest;
		const largeRequestBeforeFix = restoreFullArguments(largeRequest, largeTodos);

		const rawArgumentGrowth =
			byteLength(makeAssistant(largeTodos).content[0]) - byteLength(makeAssistant(smallTodos).content[0]);
		expect(rawArgumentGrowth).toBeGreaterThan(500_000);
		expect(byteLength(largeExecution.toolResult) - byteLength(smallExecution.toolResult)).toBeLessThan(16);
		expect(byteLength(largeRequest) - byteLength(smallRequest)).toBeLessThan(16);
		expect(byteLength(largeRequestBeforeFix) - byteLength(largeRequest)).toBeGreaterThan(500_000);

		const compactedCall = largeRequest.messages.find((message) => message.role === "assistant");
		if (!compactedCall || compactedCall.role !== "assistant") {
			throw new Error("Expected assistant message");
		}
		expect(compactedCall.content[0]).toMatchObject({
			type: "toolCall",
			name: "todo_write",
			arguments: { todos: [], snapshotOmitted: true },
		});
		const compactedToolCall = compactedCall.content[0];
		if (compactedToolCall.type !== "toolCall") throw new Error("Expected tool call");
		const toolDefinition = largeRequest.tools?.[0];
		if (!toolDefinition) throw new Error("Expected tool definition");
		expect(() => validateToolArguments(toolDefinition, compactedToolCall)).not.toThrow();
	});

	it("keeps arguments for an unexecuted todo_write call", () => {
		const todos = makeTodos(2, 16);
		const assistant = makeAssistant(todos);

		expect(convertToLlm([assistant])[0]).toEqual(assistant);
	});

	it("matches reused tool call IDs to the nearest preceding call", () => {
		const orphan = makeAssistant(makeTodos(2, 16));
		const completed = makeAssistant(makeTodos(3, 16));
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "todo-call",
			toolName: "todo_write",
			content: [{ type: "text", text: "done" }],
			isError: false,
			timestamp: 2,
		};
		const converted = convertToLlm([orphan, completed, result]);

		expect(converted[0]).toEqual(orphan);
		expect(converted[1]).toMatchObject({
			role: "assistant",
			content: [{ type: "toolCall", arguments: { todos: [], snapshotOmitted: true } }],
		});
	});

	describe("todo_read mode", () => {
		it("returns persisted state without modifying it", async () => {
			const existing = [
				{ content: "Task A", activeForm: "Doing A", status: "pending" as const },
				{ content: "Task B", activeForm: "Doing B", status: "in_progress" as const },
				{ content: "Task C", activeForm: "Doing C", status: "completed" as const },
			];
			const persisted = [...existing];
			const readTool = createTodoReadTool(() => persisted);
			const result = await readTool.execute("read-call", {});
			expect(result.content[0]).toMatchObject({
				type: "text",
			});
			const text = (result.content[0] as { type: "text"; text: string }).text;
			expect(text).toContain("Current todo list (3 total): 1 pending, 1 in progress, 1 completed");
			expect(text).toContain("[ ] Task A");
			expect(text).toContain("[>] Doing B");
			expect(text).toContain("[x] Task C");
			expect(persisted).toEqual(existing); // state unchanged
			expect(result.details).toEqual({ todos: existing });
		});

		it("returns empty message when no todos exist", async () => {
			const persisted: TodoItem[] = [];
			const readTool = createTodoReadTool(() => persisted);
			const result = await readTool.execute("read-call", {});
			expect(result.content).toEqual([{ type: "text", text: "Todo list is empty." }]);
			expect(result.details).toEqual({ todos: [] });
		});
	});

	describe("write-read-write round-trip", () => {
		it("preserves exact content across write, read, and write-update", async () => {
			let persisted: TodoItem[] = [];
			const writeTool = createTodoWriteTool(
				() => persisted,
				(next) => {
					persisted = next;
				},
			);
			const readTool = createTodoReadTool(() => persisted);

			// Step 1: Write initial list
			const initialList: TodoItem[] = [
				{ content: "Audit codebase", activeForm: "Auditing codebase", status: "pending" },
				{ content: "Implement fix", activeForm: "Implementing fix", status: "pending" },
				{ content: "Write tests", activeForm: "Writing tests", status: "pending" },
				{ content: "Review changes", activeForm: "Reviewing changes", status: "pending" },
				{ content: "Deploy", activeForm: "Deploying", status: "pending" },
			];
			await writeTool.execute("write-1", { todos: initialList });
			expect(persisted).toEqual(initialList);

			// Step 2: Read back via todo_read
			const readResult = await readTool.execute("read-1", {});
			expect(readResult.details).toEqual({ todos: initialList });

			// Step 3: Update: mark first as in_progress
			const updatedList: TodoItem[] = [
				{ content: "Audit codebase", activeForm: "Auditing codebase", status: "in_progress" },
				{ content: "Implement fix", activeForm: "Implementing fix", status: "pending" },
				{ content: "Write tests", activeForm: "Writing tests", status: "pending" },
				{ content: "Review changes", activeForm: "Reviewing changes", status: "pending" },
				{ content: "Deploy", activeForm: "Deploying", status: "pending" },
			];
			await writeTool.execute("write-2", { todos: updatedList });
			expect(persisted).toEqual(updatedList);

			// Step 4: Read again
			const readResult2 = await readTool.execute("read-2", {});
			expect(readResult2.details).toEqual({ todos: updatedList });
		});

		it("adding a task preserves all existing tasks", async () => {
			let persisted: TodoItem[] = [];
			const writeTool = createTodoWriteTool(
				() => persisted,
				(next) => {
					persisted = next;
				},
			);
			const readTool = createTodoReadTool(() => persisted);

			const initial: TodoItem[] = [
				{ content: "Task 1", activeForm: "Doing 1", status: "pending" },
				{ content: "Task 2", activeForm: "Doing 2", status: "pending" },
			];
			await writeTool.execute("write-1", { todos: initial });

			const readResult = await readTool.execute("read-1", {});
			expect(readResult.details).toEqual({ todos: initial });

			const withNew: TodoItem[] = [...initial, { content: "Task 3", activeForm: "Doing 3", status: "pending" }];
			await writeTool.execute("write-2", { todos: withNew });
			expect(persisted).toEqual(withNew);
			expect(persisted.length).toBe(3);
		});

		it("idempotent writes do not cause duplication", async () => {
			let persisted: TodoItem[] = [];
			const writeTool = createTodoWriteTool(
				() => persisted,
				(next) => {
					persisted = next;
				},
			);

			const list: TodoItem[] = [{ content: "Task A", activeForm: "Doing A", status: "pending" }];
			const res1 = await writeTool.execute("write-1", { todos: list });
			expect((res1.details as { changed?: boolean }).changed).toBe(true);

			const res2 = await writeTool.execute("write-2", { todos: list });
			expect((res2.details as { changed?: boolean }).changed).toBe(false);

			expect(persisted).toEqual(list);
			expect(persisted.length).toBe(1);
		});

		it("clearing the list requires confirmClear: true", async () => {
			let persisted: TodoItem[] = [];
			const writeTool = createTodoWriteTool(
				() => persisted,
				(next) => {
					persisted = next;
				},
			);
			const readTool = createTodoReadTool(() => persisted);

			const list: TodoItem[] = [{ content: "Task A", activeForm: "Doing A", status: "pending" }];
			await writeTool.execute("write-1", { todos: list });
			expect(persisted).toEqual(list);

			// Unconfirmed clear returns error
			const errRes = await writeTool.execute("write-2", { todos: [] });
			expect((errRes.content[0] as { text: string }).text).toContain(
				"Clearing all todos requires explicit confirmation",
			);
			expect(persisted).toEqual(list);

			// Confirmed clear succeeds
			await writeTool.execute("write-3", { todos: [], confirmClear: true });
			expect(persisted).toEqual([]);

			const readResult = await readTool.execute("read-1", {});
			expect(readResult.content).toEqual([{ type: "text", text: "Todo list is empty." }]);
		});
	});
});
