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
	};
}

afterEach(() => {
	delete process.env.DEEPSEEK_API_KEY;
	delete process.env.OPENAI_API_KEY;
	mockState.clientConfig = undefined;
	mockState.params = undefined;
	vi.clearAllMocks();
});

describe("DeepSeek openai-completions compatibility", () => {
	it("registers deepseek as a built-in provider with official models", () => {
		const model = getModel("deepseek", "deepseek-chat");

		expect(getProviders()).toContain("deepseek");
		expect(model).toMatchObject({
			id: "deepseek-chat",
			api: "openai-completions",
			provider: "deepseek",
			baseUrl: "https://api.deepseek.com/v1",
		});
	});

	it("uses DEEPSEEK_API_KEY and serializes the system prompt without a developer role", async () => {
		process.env.DEEPSEEK_API_KEY = "deepseek-key";

		const model = getModel("deepseek", "deepseek-reasoner");
		const result = await streamSimpleOpenAICompletions(model, createContext(), {
			reasoning: "high",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(mockState.clientConfig).toMatchObject({
			apiKey: "deepseek-key",
			baseURL: "https://api.deepseek.com/v1",
		});

		const messages = mockState.params?.messages as Array<{ role: string; content: unknown }>;
		expect(messages[0]).toMatchObject({
			role: "system",
			content: "Follow the rules.",
		});
		expect(messages.some((message) => message.role === "developer")).toBe(false);
	});

	it("does not fall back to OPENAI_API_KEY for the deepseek provider", async () => {
		process.env.OPENAI_API_KEY = "openai-key";

		const result = await streamOpenAICompletions(getModel("deepseek", "deepseek-chat"), createContext()).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("DEEPSEEK_API_KEY");
		expect(mockState.clientConfig).toBeUndefined();
	});
});
