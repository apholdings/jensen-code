import { describe, expect, it } from "vitest";
import { updateAnthropicCacheTelemetry } from "../src/providers/anthropic.js";
import { parseChunkUsage } from "../src/providers/openai-completions.js";
import type { AssistantMessage, Model } from "../src/types.js";

const openAiModel: Model<"openai-completions"> = {
	id: "test",
	name: "test",
	api: "openai-completions",
	provider: "deepseek",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
	contextWindow: 8192,
	maxTokens: 2048,
};

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("provider cache telemetry normalization", () => {
	it("parses DeepSeek cache hit and miss token fields", () => {
		const usage = parseChunkUsage(
			{
				prompt_tokens: 100,
				completion_tokens: 5,
				prompt_cache_hit_tokens: 70,
				prompt_cache_miss_tokens: 30,
			},
			openAiModel,
		);

		expect(usage.input).toBe(30);
		expect(usage.cacheRead).toBe(70);
		expect(usage.cache).toEqual({ readTokens: 70, uncachedInputTokens: 30 });
	});

	it("keeps absent OpenAI-compatible telemetry unknown", () => {
		const usage = parseChunkUsage({ prompt_tokens: 20, completion_tokens: 5 }, openAiModel);

		expect(usage.input).toBe(20);
		expect(usage.cacheRead).toBe(0);
		expect(usage.cache).toBeUndefined();
	});

	it("normalizes Anthropic read, write, and uncached input tokens", () => {
		const usage = emptyUsage();
		usage.input = 25;
		usage.cacheRead = 50;
		usage.cacheWrite = 10;
		updateAnthropicCacheTelemetry(usage, {
			cache_read_input_tokens: 50,
			cache_creation_input_tokens: 10,
		});

		expect(usage.cache).toEqual({ readTokens: 50, writeTokens: 10, uncachedInputTokens: 35 });
	});

	it("does not fabricate Anthropic telemetry when both fields are absent", () => {
		const usage = emptyUsage();
		updateAnthropicCacheTelemetry(usage, {
			cache_read_input_tokens: null,
			cache_creation_input_tokens: null,
		});

		expect(usage.cache).toBeUndefined();
	});
});
