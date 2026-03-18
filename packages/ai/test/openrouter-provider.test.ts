import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICompletions, streamSimpleOpenAICompletions } from "../src/providers/openai-completions.js";
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

function createOpenRouterModel(overrides?: Partial<Model<"openai-completions">>): Model<"openai-completions"> {
	return {
		id: "anthropic/claude-sonnet-4",
		name: "Claude Sonnet 4",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
		...overrides,
	};
}

function createContext(): Context {
	return {
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
	delete process.env.OPENROUTER_API_KEY;
	delete process.env.OPENAI_API_KEY;
	mockState.clientConfig = undefined;
	mockState.params = undefined;
	vi.clearAllMocks();
});

describe("OpenRouter openai-completions compatibility", () => {
	it("uses OPENROUTER_API_KEY and sends OpenRouter reasoning and routing fields", async () => {
		process.env.OPENROUTER_API_KEY = "openrouter-key";

		const model = createOpenRouterModel({
			compat: {
				openRouterRouting: {
					only: ["anthropic"],
				},
			},
		});

		const result = await streamSimpleOpenAICompletions(model, createContext(), {
			reasoning: "high",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(mockState.clientConfig).toMatchObject({
			apiKey: "openrouter-key",
			baseURL: "https://openrouter.ai/api/v1",
		});
		expect(mockState.params).toMatchObject({
			model: "anthropic/claude-sonnet-4",
			reasoning: { effort: "high" },
			provider: { only: ["anthropic"] },
		});
		expect(mockState.params).not.toHaveProperty("reasoning_effort");
	});

	it("does not fall back to OPENAI_API_KEY for the openrouter provider", async () => {
		process.env.OPENAI_API_KEY = "openai-key";

		const result = await streamOpenAICompletions(createOpenRouterModel(), createContext()).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("OPENROUTER_API_KEY");
		expect(mockState.clientConfig).toBeUndefined();
	});
});
