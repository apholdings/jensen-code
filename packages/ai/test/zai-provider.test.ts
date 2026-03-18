import { Type } from "@sinclair/typebox";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel, getProviders } from "../src/models.js";
import { streamOpenAICompletions, streamSimpleOpenAICompletions } from "../src/providers/openai-completions.js";
import type { Context } from "../src/types.js";

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
							} as ChatCompletionChunk;
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

function createContext(): Context {
	return {
		systemPrompt: "Follow the rules.",
		messages: [
			{
				role: "user",
				content: "hello",
				timestamp: Date.now(),
			},
		],
		tools: [
			{
				name: "lookup_weather",
				description: "Look up weather",
				parameters: Type.Object({
					city: Type.String(),
				}),
			},
		],
	};
}

afterEach(() => {
	delete process.env.ZAI_API_KEY;
	delete process.env.OPENAI_API_KEY;
	mockState.clientConfig = undefined;
	mockState.params = undefined;
	vi.clearAllMocks();
});

describe("Z.AI openai-completions compatibility", () => {
	it("registers zai as a built-in provider with the built-in base URL override", () => {
		const model = getModel("zai", "glm-4.5");

		expect(getProviders()).toContain("zai");
		expect(model).toMatchObject({
			id: "glm-4.5",
			api: "openai-completions",
			provider: "zai",
			baseUrl: "https://api.z.ai/api/paas/v4",
			compat: {
				thinkingFormat: "zai",
			},
		});
	});

	it("uses ZAI_API_KEY and sends zai thinking plus tool definitions through the shared OpenAI-compatible path", async () => {
		process.env.ZAI_API_KEY = "zai-key";

		const result = await streamSimpleOpenAICompletions(getModel("zai", "glm-4.5"), createContext(), {
			reasoning: "high",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(mockState.clientConfig).toMatchObject({
			apiKey: "zai-key",
			baseURL: "https://api.z.ai/api/paas/v4",
		});

		expect(mockState.params).toMatchObject({
			model: "glm-4.5",
			enable_thinking: true,
			tools: [
				{
					type: "function",
					function: {
						name: "lookup_weather",
						description: "Look up weather",
						parameters: {
							type: "object",
						},
						strict: false,
					},
				},
			],
		});
		expect(mockState.params).not.toHaveProperty("reasoning_effort");

		const messages = mockState.params?.messages as Array<{ role: string; content: unknown }>;
		expect(messages[0]).toMatchObject({
			role: "system",
			content: "Follow the rules.",
		});
		expect(messages.some((message) => message.role === "developer")).toBe(false);
	});

	it("does not fall back to OPENAI_API_KEY for the zai provider", async () => {
		process.env.OPENAI_API_KEY = "openai-key";

		const result = await streamOpenAICompletions(getModel("zai", "glm-4.5"), createContext()).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("ZAI_API_KEY");
		expect(mockState.clientConfig).toBeUndefined();
	});
});
