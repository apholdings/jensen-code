import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Model } from "@apholdings/jensen-ai";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "./agent-session.js";
import { AuthStorage } from "./auth-storage.js";
import type { ExtensionFactory } from "./extensions/types.js";
import { ModelRegistry } from "./model-registry.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { createAgentSession } from "./sdk.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

type FixtureToolCall = {
	id: string;
	name: string;
	args: Record<string, unknown>;
};

type FixtureReply = { type: "tool"; calls: FixtureToolCall[] } | { type: "text"; text: string };

type MockClientConfig = {
	apiKey: string;
	baseURL: string;
	dangerouslyAllowBrowser: boolean;
	defaultHeaders?: Record<string, string>;
};

const mockState = vi.hoisted(() => ({
	payloads: [] as Array<Record<string, unknown>>,
	serializedPayloads: [] as string[],
	replies: [] as FixtureReply[],
	transportCount: 0,
	clientConfigs: [] as MockClientConfig[],
}));

vi.mock("openai", () => {
	class MockOpenAI {
		chat = {
			completions: {
				create: async (params: Record<string, unknown>) => {
					const reply = mockState.replies[mockState.transportCount];
					if (!reply) {
						throw new Error(`Missing fixture reply for transport ${mockState.transportCount + 1}`);
					}
					mockState.transportCount++;
					mockState.payloads.push(structuredClone(params));
					mockState.serializedPayloads.push(JSON.stringify(params));

					const chunk =
						reply.type === "text"
							? ({
									id: `fixture-response-${mockState.transportCount}`,
									choices: [
										{
											index: 0,
											delta: { role: "assistant", content: reply.text },
											finish_reason: "stop",
										},
									],
								} as unknown as ChatCompletionChunk)
							: ({
									id: `fixture-response-${mockState.transportCount}`,
									choices: [
										{
											index: 0,
											delta: {
												role: "assistant",
												tool_calls: reply.calls.map((call, index) => ({
													index,
													id: call.id,
													type: "function",
													function: {
														name: call.name,
														arguments: JSON.stringify(call.args),
													},
												})),
											},
											finish_reason: "tool_calls",
										},
									],
								} as unknown as ChatCompletionChunk);

					return {
						async *[Symbol.asyncIterator](): AsyncIterator<ChatCompletionChunk> {
							yield chunk;
						},
					};
				},
			},
		};

		constructor(config: MockClientConfig) {
			mockState.clientConfigs.push(config);
		}
	}

	return { default: MockOpenAI };
});

type Route = {
	model: Model<"openai-completions">;
	label: string;
};

type WireTool = {
	type: string;
	function: { name: string };
};

type WireMessage = {
	role: string;
	tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
	tool_call_id?: string;
};

type Harness = {
	session: Awaited<ReturnType<typeof createAgentSession>>["session"];
	events: AgentSessionEvent[];
	rootDir: string;
};

const deepSeekRoute: Route = {
	label: "DeepSeek",
	model: {
		id: "deepseek/deepseek-v4-flash-0731",
		name: "DeepSeek V4 Flash 0731",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	},
};

const lunaRoute: Route = {
	label: "Luna",
	model: {
		id: "openai/gpt-5.6-luna",
		name: "OpenAI GPT-5.6 Luna",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	},
};

const todoList = [
	{ id: "task-a", content: "Inspect repair", activeForm: "Inspecting repair", status: "in_progress" },
	{ id: "task-b", content: "Prove harness", activeForm: "Proving harness", status: "pending" },
] as const;

function resetMock(replies: FixtureReply[]): void {
	mockState.payloads = [];
	mockState.serializedPayloads = [];
	mockState.replies = replies;
	mockState.transportCount = 0;
	mockState.clientConfigs = [];
}

function createRouteModel(route: Route): Model<"openai-completions"> {
	return { ...route.model };
}

async function createHarness(route: Route, extensionFactory?: ExtensionFactory): Promise<Harness> {
	const rootDir = mkdtempSync(join("/tmp", "jensen-production-harness-"));
	const cwd = join(rootDir, "repo");
	const agentDir = join(rootDir, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });

	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	const modelRegistry = new ModelRegistry(authStorage);
	modelRegistry.registerProvider("openrouter", {
		api: "openai-completions",
		apiKey: "harness-openrouter-key",
		baseUrl: route.model.baseUrl,
		models: [
			{
				id: route.model.id,
				name: route.model.name,
				api: route.model.api,
				reasoning: route.model.reasoning,
				input: route.model.input,
				cost: route.model.cost,
				contextWindow: route.model.contextWindow,
				maxTokens: route.model.maxTokens,
			},
		],
	});

	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: extensionFactory ? [extensionFactory] : [],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await resourceLoader.reload();

	const result = await createAgentSession({
		cwd,
		agentDir,
		authStorage,
		modelRegistry,
		model: createRouteModel(route),
		thinkingLevel: "off",
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager,
	});
	const events: AgentSessionEvent[] = [];
	result.session.subscribe((event) => events.push(event));

	return { session: result.session, events, rootDir };
}

async function runPrompt(harness: Harness, text: string): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			harness.session.prompt(text),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`Harness timeout: ${text}`)), 5_000);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Expected object");
	}
	return value as Record<string, unknown>;
}

function wireMessages(payload: Record<string, unknown>): WireMessage[] {
	const messages = payload.messages;
	if (!Array.isArray(messages)) throw new Error("Expected messages array");
	return messages.map((message) => {
		const record = asRecord(message);
		return {
			role: String(record.role),
			tool_calls: Array.isArray(record.tool_calls)
				? record.tool_calls.map((call) => {
						const callRecord = asRecord(call);
						const fn = asRecord(callRecord.function);
						return {
							id: String(callRecord.id),
							function: { name: String(fn.name), arguments: String(fn.arguments) },
						};
					})
				: undefined,
			tool_call_id: record.tool_call_id === undefined ? undefined : String(record.tool_call_id),
		};
	});
}

function wireTools(payload: Record<string, unknown>): WireTool[] {
	if (!Array.isArray(payload.tools)) throw new Error("Expected tools array");
	return payload.tools.map((tool) => {
		const record = asRecord(tool);
		const fn = asRecord(record.function);
		return { type: String(record.type), function: { name: String(fn.name) } };
	});
}

function toolResultDetails(event: AgentSessionEvent): Record<string, unknown> | undefined {
	const details =
		event.type === "tool_execution_end"
			? event.result.details
			: event.type === "message_end" && event.message.role === "toolResult"
				? event.message.details
				: undefined;
	return details && typeof details === "object" ? (details as Record<string, unknown>) : undefined;
}

function assistantToolCalls(events: AgentSessionEvent[]): FixtureToolCall[] {
	return events.flatMap((event) => {
		if (event.type !== "message_end" || event.message.role !== "assistant") return [];
		return event.message.content.flatMap((content) =>
			content.type === "toolCall"
				? [{ id: content.id, name: content.name, args: content.arguments as Record<string, unknown> }]
				: [],
		);
	});
}

function assistantFinalMessages(events: AgentSessionEvent[]) {
	return events.filter(
		(event) =>
			event.type === "message_end" &&
			event.message.role === "assistant" &&
			event.message.stopReason === "stop" &&
			event.message.content.some((content) => content.type === "text"),
	);
}

function assertSerializedPayloads(): void {
	expect(mockState.serializedPayloads).toHaveLength(mockState.payloads.length);
	for (let index = 0; index < mockState.payloads.length; index++) {
		expect(JSON.parse(mockState.serializedPayloads[index])).toEqual(mockState.payloads[index]);
	}
}

function assertCanonicalTranscript(payload: Record<string, unknown>): void {
	const messages = wireMessages(payload);
	const calls = messages.flatMap((message) => message.tool_calls?.map((call) => call.id) ?? []);
	const results = messages.flatMap((message) => (message.tool_call_id ? [message.tool_call_id] : []));
	expect(new Set(calls).size).toBe(calls.length);
	expect(new Set(results).size).toBe(results.length);
	expect(results).toEqual(calls.slice(0, results.length));
	expect(messages.filter((message) => message.role !== "system").map((message) => message.role)).toEqual([
		"user",
		"user",
		...Array.from({ length: results.length }, () => ["assistant", "tool"]).flat(),
	]);
}

function closeHarness(harness: Harness): void {
	harness.session.dispose();
	rmSync(harness.rootDir, { recursive: true, force: true });
}

afterEach(() => {
	resetMock([]);
});

describe("production todo/provider harness", () => {
	it.each([deepSeekRoute, lunaRoute])("runs bounded seven-request workflow for $label", async (route) => {
		resetMock([
			{
				type: "tool",
				calls: [{ id: "call-1", name: "todo_write", args: { todos: [...todoList] } }],
			},
			{ type: "tool", calls: [{ id: "call-2", name: "bash", args: { command: "printf shell-step-2" } }] },
			{ type: "tool", calls: [{ id: "call-3", name: "todo_read", args: {} }] },
			{
				type: "tool",
				calls: [
					{
						id: "call-4",
						name: "todo_update",
						args: { updates: [{ id: "task-a", status: "completed" }], expectedRevision: 1 },
					},
				],
			},
			{ type: "tool", calls: [{ id: "call-5", name: "bash", args: { command: "printf shell-step-5" } }] },
			{ type: "tool", calls: [{ id: "call-6", name: "todo_read", args: {} }] },
			{ type: "text", text: "workflow complete" },
		]);
		const harness = await createHarness(route);
		try {
			expect(harness.session.model).toMatchObject({
				id: route.model.id,
				provider: "openrouter",
				api: "openai-completions",
			});
			await runPrompt(harness, `run ${route.label} workflow`);

			expect(mockState.transportCount).toBe(7);
			expect(mockState.payloads).toHaveLength(7);
			expect(mockState.clientConfigs).toHaveLength(7);
			expect(mockState.clientConfigs[0]).toMatchObject({ baseURL: route.model.baseUrl });
			expect(mockState.clientConfigs[0].apiKey).toBeTruthy();
			assertSerializedPayloads();

			const firstTools = wireTools(mockState.payloads[0]);
			const firstToolNames = firstTools.map((tool) => tool.function.name);
			expect(firstToolNames).toEqual([
				"bash",
				"edit",
				"memory_write",
				"read",
				"todo_read",
				"todo_update",
				"todo_write",
				"write",
			]);
			expect(firstTools.filter((tool) => tool.type !== "function")).toEqual([]);
			const toolsAfterWrite = firstTools.filter((tool) => tool.function.name !== "todo_write");
			for (const payload of mockState.payloads.slice(1)) {
				expect(wireTools(payload)).toEqual(toolsAfterWrite);
				expect(wireTools(payload).some((tool) => tool.function.name === "todo_write")).toBe(false);
				expect(wireTools(payload).some((tool) => tool.function.name === "todo_read")).toBe(true);
				expect(wireTools(payload).some((tool) => tool.function.name === "todo_update")).toBe(true);
			}

			const expectedCallIds = ["call-1", "call-2", "call-3", "call-4", "call-5", "call-6"];
			for (const payload of mockState.payloads) assertCanonicalTranscript(payload);
			const finalWireMessages = wireMessages(mockState.payloads[6]);
			const finalCallIds = finalWireMessages.flatMap((message) => message.tool_calls?.map((call) => call.id) ?? []);
			const finalResultIds = finalWireMessages.flatMap((message) =>
				message.tool_call_id ? [message.tool_call_id] : [],
			);
			expect(finalCallIds).toEqual(expectedCallIds);
			expect(finalResultIds).toEqual(expectedCallIds);
			expect(
				finalWireMessages.filter((message) => message.role !== "system").map((message) => message.role),
			).toEqual([
				"user",
				"user",
				"assistant",
				"tool",
				"assistant",
				"tool",
				"assistant",
				"tool",
				"assistant",
				"tool",
				"assistant",
				"tool",
				"assistant",
				"tool",
			]);

			const emittedCalls = assistantToolCalls(harness.events);
			expect(emittedCalls.filter((call) => call.name === "todo_write")).toHaveLength(1);
			const toolEnds = harness.events.filter((event) => event.type === "tool_execution_end");
			const todoWriteEnds = toolEnds.filter((event) => event.toolName === "todo_write");
			expect(
				todoWriteEnds.filter((event) => !event.isError && toolResultDetails(event)?.changed === true),
			).toHaveLength(1);
			expect(harness.events.filter((event) => event.type === "todo_update")).toHaveLength(2);
			expect(
				toolEnds.filter(
					(event) =>
						event.toolName === "todo_update" && !event.isError && toolResultDetails(event)?.changed === true,
				),
			).toHaveLength(1);

			const readResults = harness.events.filter(
				(event) =>
					event.type === "message_end" &&
					event.message.role === "toolResult" &&
					event.message.toolName === "todo_read",
			);
			expect(readResults).toHaveLength(2);
			expect(toolResultDetails(readResults[0])?.revision as number).toBe(1);
			expect(toolResultDetails(readResults[1])?.revision as number).toBe(2);
			const updateCall = emittedCalls.find((call) => call.name === "todo_update");
			expect(updateCall?.args).toEqual({
				updates: [{ id: "task-a", status: "completed" }],
				expectedRevision: 1,
			});
			expect(harness.session.todoRevision).toBe(2);
			expect(assistantFinalMessages(harness.events)).toHaveLength(1);
			expect(mockState.transportCount).toBe(mockState.replies.length);
		} finally {
			closeHarness(harness);
		}
	});

	it("rejects invalid post-hook payload before transport", async () => {
		resetMock([{ type: "text", text: "must not transport" }]);
		let hookInvocations = 0;
		const extensionFactory: ExtensionFactory = (pi) => {
			pi.on("before_provider_request", (event) => {
				hookInvocations++;
				const payload = asRecord(event.payload);
				const messages = Array.isArray(payload.messages) ? payload.messages : [];
				return {
					...payload,
					messages: [...messages, { role: "tool", tool_call_id: "orphan-hook-call", content: "orphan" }],
				};
			});
		};
		const harness = await createHarness(deepSeekRoute, extensionFactory);
		try {
			await runPrompt(harness, "invalid hook payload");
			expect(hookInvocations).toBe(1);
			expect(mockState.transportCount).toBe(0);
			expect(harness.events.filter((event) => event.type === "auto_retry_start")).toHaveLength(0);
			expect(harness.session.agent.state.error).toContain("INVALID_TOOL_TRANSCRIPT");
			expect(
				harness.events.filter((event) => event.type === "message_end" && event.message.role === "assistant"),
			).toHaveLength(1);
		} finally {
			closeHarness(harness);
		}
	});

	it("transports valid post-hook payload exactly once", async () => {
		resetMock([{ type: "text", text: "valid hook complete" }]);
		let hookInvocations = 0;
		let hookPayload: Record<string, unknown> | undefined;
		let hookSerializedPayload: string | undefined;
		const extensionFactory: ExtensionFactory = (pi) => {
			pi.on("before_provider_request", (event) => {
				hookInvocations++;
				const payload = asRecord(event.payload);
				hookPayload = { ...payload, temperature: 0 };
				hookSerializedPayload = JSON.stringify(hookPayload);
				return hookPayload;
			});
		};
		const harness = await createHarness(lunaRoute, extensionFactory);
		try {
			await runPrompt(harness, "valid hook payload");
			expect(hookInvocations).toBe(1);
			expect(mockState.transportCount).toBe(1);
			expect(mockState.serializedPayloads[0]).toBe(hookSerializedPayload);
			expect(mockState.payloads[0].temperature).toBe(0);
			expect(assistantFinalMessages(harness.events)).toHaveLength(1);
		} finally {
			closeHarness(harness);
		}
	});

	it("terminates repeated todo_write and keeps next turn usable", async () => {
		const writeArgs = { todos: [...todoList] };
		resetMock([
			{ type: "tool", calls: [{ id: "write-1", name: "todo_write", args: writeArgs }] },
			{ type: "tool", calls: [{ id: "write-2", name: "todo_write", args: writeArgs }] },
			{ type: "tool", calls: [{ id: "write-3", name: "todo_write", args: writeArgs }] },
			{ type: "text", text: "new turn works" },
		]);
		const harness = await createHarness(deepSeekRoute);
		try {
			await runPrompt(harness, "repeat todo write");
			expect(mockState.transportCount).toBe(3);
			expect(harness.session.agent.state.error).toContain("REPEATED_TOOL_CALL_LOOP");
			expect(
				harness.events.filter(
					(event) =>
						event.type === "message_end" &&
						event.message.role === "toolResult" &&
						event.message.toolName === "todo_write",
				),
			).toHaveLength(3);
			expect(
				harness.events.filter(
					(event) =>
						event.type === "message_end" &&
						event.message.role === "toolResult" &&
						toolResultDetails(event)?.todoWriteAlreadyApplied === true,
				),
			).toHaveLength(1);
			expect(harness.session.todoRevision).toBe(1);
			const terminalTransportCount = mockState.transportCount;

			await runPrompt(harness, "recover after repeated write");
			expect(mockState.transportCount).toBe(terminalTransportCount + 1);
			expect(assistantFinalMessages(harness.events)).toHaveLength(1);
		} finally {
			closeHarness(harness);
		}
	});

	it("terminates repeated stale todo_update and recovers with fresh read", async () => {
		resetMock([
			{ type: "tool", calls: [{ id: "seed-write", name: "todo_write", args: { todos: [...todoList] } }] },
			{ type: "text", text: "seeded" },
			{ type: "tool", calls: [{ id: "stale-read", name: "todo_read", args: {} }] },
			{
				type: "tool",
				calls: [
					{
						id: "stale-update-1",
						name: "todo_update",
						args: { updates: [{ id: "task-a", status: "completed" }], expectedRevision: 0 },
					},
				],
			},
			{
				type: "tool",
				calls: [
					{
						id: "stale-update-2",
						name: "todo_update",
						args: { updates: [{ id: "task-a", status: "completed" }], expectedRevision: 0 },
					},
				],
			},
			{ type: "tool", calls: [{ id: "recovery-read", name: "todo_read", args: {} }] },
			{
				type: "tool",
				calls: [
					{
						id: "recovery-update",
						name: "todo_update",
						args: { updates: [{ id: "task-a", status: "completed" }], expectedRevision: 1 },
					},
				],
			},
			{ type: "text", text: "stale recovery complete" },
		]);
		const harness = await createHarness(deepSeekRoute);
		try {
			await runPrompt(harness, "seed todos");
			await runPrompt(harness, "repeat stale update");
			expect(mockState.transportCount).toBe(5);
			expect(harness.session.agent.state.error).toContain("REPEATED_TODO_UPDATE_LOOP");
			expect(harness.session.todoRevision).toBe(1);
			expect(
				harness.events.filter(
					(event) =>
						event.type === "message_end" &&
						event.message.role === "toolResult" &&
						toolResultDetails(event)?.errorCode === "TODO_READ_REQUIRED",
				),
			).toHaveLength(1);
			expect(
				harness.events.filter(
					(event) => event.type === "tool_execution_end" && event.toolName === "todo_update" && !event.isError,
				),
			).toHaveLength(1);
			const terminalTransportCount = mockState.transportCount;

			await runPrompt(harness, "recover stale update");
			expect(mockState.transportCount).toBe(8);
			expect(mockState.transportCount).toBeGreaterThan(terminalTransportCount);
			const updateCalls = assistantToolCalls(harness.events).filter((call) => call.name === "todo_update");
			expect(updateCalls.at(-1)?.args).toEqual({
				updates: [{ id: "task-a", status: "completed" }],
				expectedRevision: 1,
			});
			expect(harness.session.todoRevision).toBe(2);
			expect(assistantFinalMessages(harness.events)).toHaveLength(2);
		} finally {
			closeHarness(harness);
		}
	});

	it("atomically reserves todo_write under forced concurrent interleaving", async () => {
		const list2 = [
			...todoList,
			{ id: "task-c", content: "Run checks", activeForm: "Running checks", status: "pending" as const },
		];
		const list3 = [
			...list2,
			{ id: "task-d", content: "Report evidence", activeForm: "Reporting evidence", status: "pending" as const },
		];
		const list4 = [
			...list3,
			{ id: "task-e", content: "Stop safely", activeForm: "Stopping safely", status: "pending" as const },
		];
		resetMock([
			{
				type: "tool",
				calls: [
					{ id: "race-1", name: "todo_write", args: { todos: [...todoList] } },
					{ id: "race-2", name: "todo_write", args: { todos: [...todoList] } },
				],
			},
			{ type: "text", text: "race complete" },
			{
				type: "tool",
				calls: [
					{ id: "failed-validation", name: "todo_write", args: { todos: [] } },
					{ id: "after-failed-validation", name: "todo_write", args: { todos: list2 } },
				],
			},
			{ type: "text", text: "validation release complete" },
			{
				type: "tool",
				calls: [
					{ id: "no-op", name: "todo_write", args: { todos: list2 } },
					{ id: "after-no-op", name: "todo_write", args: { todos: list3 } },
				],
			},
			{ type: "text", text: "no-op release complete" },
			{ type: "tool", calls: [{ id: "next-turn-write", name: "todo_write", args: { todos: list4 } }] },
			{ type: "text", text: "next turn write complete" },
		]);
		const harness = await createHarness(deepSeekRoute);
		try {
			const todoWriteTool = harness.session.agent.state.tools.find((tool) => tool.name === "todo_write");
			if (!todoWriteTool) throw new Error("todo_write tool missing");
			let phase: "race" | "sequential" = "race";
			let barrierReady = 0;
			let releaseBarrier: (() => void) | undefined;
			let barrier = Promise.resolve();
			const originalExecute = todoWriteTool.execute;
			todoWriteTool.isConcurrencySafe = () => phase === "race";
			todoWriteTool.execute = async (...args: Parameters<typeof originalExecute>) => {
				if (phase === "race") {
					barrierReady++;
					if (barrierReady === 2) releaseBarrier?.();
					await barrier;
				}
				return originalExecute(...args);
			};
			barrier = new Promise<void>((resolve) => {
				releaseBarrier = resolve;
			});

			await runPrompt(harness, "race todo writes");
			phase = "sequential";
			await runPrompt(harness, "failed validation then write");
			await runPrompt(harness, "no-op then write");
			await runPrompt(harness, "write on new turn");
			expect(mockState.transportCount).toBe(8);
			expect(harness.session.todoRevision).toBe(4);
			const todoWriteEnds = harness.events.filter(
				(event): event is Extract<AgentSessionEvent, { type: "tool_execution_end" }> =>
					event.type === "tool_execution_end" && event.toolName === "todo_write",
			);
			expect(
				todoWriteEnds.filter((event) => !event.isError && toolResultDetails(event)?.changed === true),
			).toHaveLength(4);
			expect(
				todoWriteEnds.filter((event) => toolResultDetails(event)?.todoWriteAlreadyApplied === true),
			).toHaveLength(1);
			expect(
				todoWriteEnds.filter(
					(event) =>
						toolResultDetails(event)?.changed === false &&
						toolResultDetails(event)?.todoWriteAlreadyApplied !== true,
				),
			).toHaveLength(1);
			expect(
				todoWriteEnds.filter(
					(event) =>
						event.result.content[0]?.type === "text" &&
						event.result.content[0].text.includes("Clearing all todos"),
				),
			).toHaveLength(1);
			expect(harness.events.filter((event) => event.type === "todo_update")).toHaveLength(4);
			expect(assistantFinalMessages(harness.events)).toHaveLength(4);
		} finally {
			closeHarness(harness);
		}
	});
});
