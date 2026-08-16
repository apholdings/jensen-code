import { Type } from "@sinclair/typebox";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { supportsXhigh } from "../src/models.js";
import {
	buildOpenAICompletionsParams,
	convertMessages,
	streamSimpleOpenAICompletions,
} from "../src/providers/openai-completions.js";
import type { Context, Model } from "../src/types.js";

type MockClientConfig = {
	apiKey: string;
	baseURL: string;
	dangerouslyAllowBrowser: boolean;
	defaultHeaders?: Record<string, string>;
};

const mockState = vi.hoisted(() => ({
	clientConfig: undefined as MockClientConfig | undefined,
	params: undefined as Record<string, unknown> | undefined,
}));

vi.mock("openai", () => {
	class MockOpenAI {
		chat = {
			completions: {
				create: vi.fn(async (params: Record<string, unknown>) => {
					mockState.params = params;
					return {
						async *[Symbol.asyncIterator](): AsyncIterator<ChatCompletionChunk> {
							yield {
								id: "resp_1",
								choices: [
									{
										index: 0,
										delta: { content: "ok" },
										finish_reason: "stop",
										logprobs: null,
									},
								],
							} as unknown as ChatCompletionChunk;
						},
					};
				}),
			},
		};

		constructor(config: MockClientConfig) {
			mockState.clientConfig = config;
		}
	}

	return { default: MockOpenAI };
});

function qwen38Model(compatOverrides: Record<string, unknown> = {}): Model<"openai-completions"> {
	return {
		id: "qwen3.8-27b",
		name: "Qwen3.8 27B",
		api: "openai-completions",
		provider: "llamacpp-qwen38-bucephalus",
		baseUrl: "http://127.0.0.1:8095/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 196608,
		maxTokens: 8192,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			supportsXhigh: true,
			preserveThinking: true,
			thinkingFormat: "qwen-chat-template",
			reasoningEffortMap: {
				minimal: "low",
				low: "low",
				medium: "medium",
				high: "xhigh",
				xhigh: "xhigh",
			},
			samplingDefaults: {
				temperature: 1.0,
				topP: 0.95,
				topK: 20,
				minP: 0.0,
				presencePenalty: 0.0,
				repetitionPenalty: 1.0,
			},
			...compatOverrides,
		},
	};
}

function plainOpenAICompatibleModel(): Model<"openai-completions"> {
	return {
		id: "some-custom-model",
		name: "Custom",
		api: "openai-completions",
		provider: "custom",
		baseUrl: "http://127.0.0.1:9999/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131072,
		maxTokens: 8192,
	};
}

function createContext(): Context {
	return {
		systemPrompt: "Follow the rules.",
		messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		tools: [
			{
				name: "lookup_weather",
				description: "Look up weather",
				parameters: Type.Object({ city: Type.String() }),
			},
		],
	};
}

afterEach(() => {
	delete process.env.OPENAI_API_KEY;
	mockState.clientConfig = undefined;
	mockState.params = undefined;
	vi.clearAllMocks();
});

describe("supportsXhigh capability model", () => {
	it("honors an explicit compat.supportsXhigh declaration", () => {
		expect(supportsXhigh(qwen38Model())).toBe(true);
		expect(supportsXhigh(qwen38Model({ supportsXhigh: false }))).toBe(false);
	});

	it("keeps legacy built-in detection when no declaration is present", () => {
		expect(supportsXhigh(plainOpenAICompatibleModel())).toBe(false);

		const gpt54 = { ...plainOpenAICompatibleModel(), id: "gpt-5.4-mini" };
		expect(supportsXhigh(gpt54)).toBe(true);

		const opus46 = { ...plainOpenAICompatibleModel(), id: "opus-4.6" };
		expect(supportsXhigh(opus46)).toBe(true);
	});
});

describe("Qwen3.8 request serialization", () => {
	it("sends native xhigh through chat_template_kwargs without clamping to high", () => {
		const params = buildOpenAICompletionsParams(qwen38Model(), createContext(), {
			reasoningEffort: "xhigh",
		}) as unknown as { chat_template_kwargs?: Record<string, unknown> };

		expect(params.chat_template_kwargs).toMatchObject({
			enable_thinking: true,
			preserve_thinking: true,
			reasoning_effort: "xhigh",
		});
	});

	it("maps Jensen high to Qwen xhigh", () => {
		const params = buildOpenAICompletionsParams(qwen38Model(), createContext(), {
			reasoningEffort: "high",
		}) as unknown as { chat_template_kwargs?: Record<string, unknown> };

		expect(params.chat_template_kwargs?.reasoning_effort).toBe("xhigh");
	});

	it("maps Jensen medium/low/minimal to Qwen medium/low/low", () => {
		for (const [input, expected] of [
			["medium", "medium"],
			["low", "low"],
			["minimal", "low"],
		] as const) {
			const params = buildOpenAICompletionsParams(qwen38Model(), createContext(), {
				reasoningEffort: input,
			}) as unknown as { chat_template_kwargs?: Record<string, unknown> };
			expect(params.chat_template_kwargs?.reasoning_effort).toBe(expected);
		}
	});

	it("disables thinking and omits reasoning/preserve when no effort is requested", () => {
		const params = buildOpenAICompletionsParams(qwen38Model(), createContext()) as unknown as {
			chat_template_kwargs?: Record<string, unknown>;
		};

		expect(params.chat_template_kwargs).toEqual({ enable_thinking: false });
	});

	it("preserves the legacy xhigh -> high clamp for undeclared models", async () => {
		await streamSimpleOpenAICompletions(plainOpenAICompatibleModel(), createContext(), {
			reasoning: "xhigh",
			apiKey: "test-key",
		}).result();

		expect(mockState.params?.reasoning_effort).toBe("high");
	});
});

describe("Qwen3.8 sampling profile", () => {
	it("applies sampling defaults when the caller does not override", () => {
		const params = buildOpenAICompletionsParams(qwen38Model(), createContext()) as unknown as {
			temperature?: number;
			top_p?: number;
			top_k?: number;
			min_p?: number;
			presence_penalty?: number;
			repetition_penalty?: number;
		};

		expect(params.temperature).toBe(1.0);
		expect(params.top_p).toBe(0.95);
		expect(params.top_k).toBe(20);
		expect(params.min_p).toBe(0.0);
		expect(params.presence_penalty).toBe(0.0);
		expect(params.repetition_penalty).toBe(1.0);
	});

	it("lets explicit operator values win over profile defaults", () => {
		const params = buildOpenAICompletionsParams(qwen38Model(), createContext(), {
			temperature: 0.3,
			topP: 0.5,
		}) as unknown as {
			temperature?: number;
			top_p?: number;
			top_k?: number;
		};

		expect(params.temperature).toBe(0.3);
		expect(params.top_p).toBe(0.5);
		expect(params.top_k).toBe(20); // default still applies where not overridden
	});
});

describe("Qwen3.8 thinking round-trip", () => {
	it("re-emits reasoning_content for a tool-call continuation", () => {
		const context: Context = {
			systemPrompt: "Follow the rules.",
			messages: [
				{ role: "user", content: "hello", timestamp: Date.now() },
				{
					role: "assistant",
					api: "openai-completions",
					provider: "llamacpp-qwen38-bucephalus",
					model: "qwen3.8-27b",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: Date.now(),
					content: [
						{
							type: "thinking",
							thinking: "I should look up the weather.",
							thinkingSignature: "reasoning_content",
						},
						{
							type: "toolCall",
							id: "call_1",
							name: "lookup_weather",
							arguments: { city: "Paris" },
						},
					],
				},
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "lookup_weather",
					content: [{ type: "text", text: "sunny" }],
					isError: false,
					timestamp: Date.now(),
				},
			],
			tools: [
				{
					name: "lookup_weather",
					description: "Look up weather",
					parameters: Type.Object({ city: Type.String() }),
				},
			],
		};

		const messages = convertMessages(qwen38Model(), context, {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			supportsXhigh: true,
			reasoningEffortMap: {},
			supportsUsageInStreaming: true,
			maxTokensField: "max_completion_tokens",
			requiresToolResultName: false,
			requiresAssistantAfterToolResult: false,
			requiresThinkingAsText: false,
			thinkingFormat: "qwen-chat-template",
			preserveThinking: true,
			samplingDefaults: {},
			openRouterRouting: {},
			vercelGatewayRouting: {},
			supportsStrictMode: true,
		}) as Array<{ role: string; reasoning_content?: string; tool_calls?: unknown[] }>;

		const assistant = messages.find((m) => m.role === "assistant");
		expect(assistant?.reasoning_content).toBe("I should look up the weather.");
		expect(assistant?.tool_calls?.[0]).toMatchObject({
			function: { name: "lookup_weather" },
		});
	});
});

describe("Qwen3.8 end-to-end xhigh through streamSimple", () => {
	it("passes native xhigh through the shared OpenAI-compatible path", async () => {
		await streamSimpleOpenAICompletions(qwen38Model(), createContext(), {
			reasoning: "xhigh",
			apiKey: "local",
		}).result();

		const kwargs = mockState.params?.chat_template_kwargs as Record<string, unknown> | undefined;
		expect(kwargs).toMatchObject({
			enable_thinking: true,
			preserve_thinking: true,
			reasoning_effort: "xhigh",
		});
	});
});
