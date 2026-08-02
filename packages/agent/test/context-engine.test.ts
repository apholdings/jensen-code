import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type Tool,
	type Usage,
} from "@apholdings/jensen-ai";
import { type TSchema, Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.js";
import {
	buildCacheStableContext,
	createContextCacheDiagnostics,
	toCanonicalContextJson,
} from "../src/context-engine.js";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentTool } from "../src/types.js";

const model: Model<"openai-responses"> = {
	id: "cache-model",
	name: "Cache Model",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
};

function usage(cache?: Usage["cache"]): Usage {
	return {
		input: 7,
		output: 3,
		cacheRead: cache?.readTokens ?? 0,
		cacheWrite: cache?.writeTokens ?? 0,
		totalTokens: 10,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		cache,
	};
}

function userMessage(text: string, timestamp: number): Message {
	return { role: "user", content: text, timestamp };
}

function tool(name: string, properties: Record<string, TSchema> = {}): Tool {
	return {
		name,
		description: `${name} description`,
		parameters: Type.Object(properties),
	};
}

function executableTool(name: string): AgentTool {
	return {
		...tool(name),
		label: name,
		execute: async () => ({ content: [{ type: "text", text: "unused" }], details: {} }),
	};
}

describe("cache-stable context construction", () => {
	it("produces byte-identical stable prefixes and fingerprints for identical inputs", async () => {
		const options = {
			systemPrompt: "stable\r\ninstructions",
			dynamicPrompt: "Current date: 2026-08-02",
			messages: [userMessage("first request", 1)],
			tools: [tool("read")],
			provider: "openai",
			model: "cache-model",
		};
		const first = await buildCacheStableContext(options);
		const second = await buildCacheStableContext(options);

		expect(toCanonicalContextJson(first.stablePrefix)).toBe(toCanonicalContextJson(second.stablePrefix));
		expect(first.snapshot).toEqual(second.snapshot);
	});

	it("canonicalizes unordered keys and tool order while preserving message order", async () => {
		const first = await buildCacheStableContext({
			systemPrompt: "stable",
			messages: [userMessage("one", 1), userMessage("two", 2)],
			tools: [tool("zeta", { b: Type.String(), a: Type.Number() }), tool("alpha")],
			provider: "openai",
			model: "cache-model",
		});
		const second = await buildCacheStableContext({
			systemPrompt: "stable",
			messages: [userMessage("one", 9), userMessage("two", 10)],
			tools: [tool("alpha"), tool("zeta", { a: Type.Number(), b: Type.String() })],
			provider: "openai",
			model: "cache-model",
		});

		expect(first.snapshot.prefixFingerprint).toBe(second.snapshot.prefixFingerprint);
		expect(first.stablePrefix.tools.map((entry) => entry.name)).toEqual(["alpha", "zeta"]);
		expect(first.dynamicSuffix.messages.map((message) => message.content)).toEqual(["one", "two"]);
	});

	it("keeps user requests, timestamps, and host state out of the stable prefix", async () => {
		const first = await buildCacheStableContext({
			systemPrompt: "stable",
			dynamicPrompt: "Current date: 2026-08-02",
			messages: [userMessage("first", 1)],
			provider: "openai",
			model: "cache-model",
		});
		const second = await buildCacheStableContext({
			systemPrompt: "stable",
			dynamicPrompt: "Current date: 2026-08-03",
			messages: [userMessage("second", 999)],
			provider: "openai",
			model: "cache-model",
		});

		expect(first.snapshot.prefixFingerprint).toBe(second.snapshot.prefixFingerprint);
		expect(toCanonicalContextJson(first.dynamicSuffix)).not.toBe(toCanonicalContextJson(second.dynamicSuffix));
	});

	it("reports stable instruction changes and invalidates provider continuity", async () => {
		const first = await buildCacheStableContext({
			systemPrompt: "stable one",
			messages: [],
			provider: "openai",
			model: "cache-model",
		});
		const changedSystem = await buildCacheStableContext({
			systemPrompt: "stable two",
			messages: [],
			provider: "openai",
			model: "cache-model",
		});
		const changedProvider = await buildCacheStableContext({
			systemPrompt: "stable one",
			messages: [],
			provider: "anthropic",
			model: "cache-model",
		});

		const systemDiagnostics = createContextCacheDiagnostics(changedSystem.snapshot, first.snapshot, usage());
		const providerDiagnostics = createContextCacheDiagnostics(changedProvider.snapshot, first.snapshot, usage());
		expect(systemDiagnostics.prefixChanged).toBe(true);
		expect(systemDiagnostics.changeReasons).toEqual(["system"]);
		expect(providerDiagnostics.continuity).toBe("invalidated");
		expect(providerDiagnostics.changeReasons).toEqual(["provider"]);
	});

	it("keeps missing telemetry unknown and preserves explicit zero values without secrets", async () => {
		const secret = "Authorization: Bearer secret-token";
		const built = await buildCacheStableContext({
			systemPrompt: `stable ${secret}`,
			messages: [],
			provider: "openai",
			model: "cache-model",
		});
		const unknown = createContextCacheDiagnostics(built.snapshot, undefined, usage());
		const explicitZero = createContextCacheDiagnostics(
			built.snapshot,
			undefined,
			usage({ readTokens: 0, writeTokens: 0, uncachedInputTokens: 7 }),
		);

		expect(unknown.cachedInputTokens).toBeUndefined();
		expect(explicitZero.cachedInputTokens).toBe(0);
		expect(JSON.stringify(explicitZero)).not.toContain(secret);
	});

	it("reports a deterministic synthetic multi-turn fixture", async () => {
		const first = await buildCacheStableContext({
			systemPrompt: "fixture contract",
			dynamicPrompt: "host revision 1",
			messages: [userMessage("turn one", 1)],
			tools: [tool("read")],
			provider: "openai",
			model: "cache-model",
		});
		const second = await buildCacheStableContext({
			systemPrompt: "fixture contract",
			dynamicPrompt: "host revision 2",
			messages: [userMessage("turn one", 1), userMessage("turn two", 2)],
			tools: [tool("read")],
			provider: "openai",
			model: "cache-model",
		});
		const diagnostics = createContextCacheDiagnostics(
			second.snapshot,
			first.snapshot,
			usage({ readTokens: 12, uncachedInputTokens: 5 }),
		);
		const report = {
			stablePrefixUnchanged: first.snapshot.prefixFingerprint === second.snapshot.prefixFingerprint,
			dynamicSuffixChanged: first.snapshot.dynamicSuffixBytes !== second.snapshot.dynamicSuffixBytes,
			fingerprintContinuity: diagnostics.continuity,
			promptSizeComposition: {
				stableBytes: diagnostics.stablePrefixBytes,
				dynamicBytes: diagnostics.dynamicSuffixBytes,
			},
			cacheTelemetry: {
				cachedInputTokens: diagnostics.cachedInputTokens,
				uncachedInputTokens: diagnostics.uncachedInputTokens,
			},
		};

		expect(report).toMatchObject({
			stablePrefixUnchanged: true,
			dynamicSuffixChanged: true,
			fingerprintContinuity: "continued",
			promptSizeComposition: {
				stableBytes: expect.any(Number),
				dynamicBytes: expect.any(Number),
			},
			cacheTelemetry: { cachedInputTokens: 12, uncachedInputTokens: 5 },
		});
		expect(report.promptSizeComposition.stableBytes).toBeGreaterThan(0);
		expect(report.promptSizeComposition.dynamicBytes).toBeGreaterThan(0);
	});
});

describe("production agent-loop integration", () => {
	it("sends the stable prefix first and emits metadata-only diagnostics", async () => {
		const context: AgentContext = {
			systemPrompt: "stable contract",
			dynamicPrompt: "Current date: 2026-08-02",
			messages: [],
			tools: [],
		};
		const config: AgentLoopConfig = {
			model,
			convertToLlm: (messages) => messages as Message[],
			getTools: () => [executableTool("zeta"), executableTool("alpha")],
		};
		let providerContext: { systemPrompt?: string; messages: Message[]; tools?: Tool[] } | undefined;
		const events: AgentEvent[] = [];
		const stream = agentLoop([userMessage("request", 42)], context, config, undefined, (_model, sentContext) => {
			providerContext = sentContext;
			const result = new EventStream<AssistantMessageEvent, AssistantMessage>(
				(event) => event.type === "done" || event.type === "error",
				(event) => {
					if (event.type === "done") return event.message;
					if (event.type === "error") return event.error;
					throw new Error("Unexpected non-terminal event");
				},
			);
			queueMicrotask(() => {
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					api: "openai-responses",
					provider: "openai",
					model: "cache-model",
					usage: usage({ readTokens: 4, uncachedInputTokens: 3 }),
					stopReason: "stop",
					timestamp: 43,
				};
				result.push({ type: "done", reason: "stop", message });
			});
			return result;
		});
		for await (const event of stream) events.push(event);

		expect(providerContext?.systemPrompt).toBe("stable contract");
		expect(providerContext?.tools?.map((entry) => entry.name)).toEqual(["alpha", "zeta"]);
		expect(providerContext?.messages[0]?.role).toBe("user");
		const hostContent = providerContext?.messages[0]?.content;
		expect(Array.isArray(hostContent) && hostContent[0]?.type === "text" ? hostContent[0].text : "").toContain(
			"<host-context>",
		);
		const diagnostics = events.find((event) => event.type === "context_cache");
		expect(diagnostics?.type === "context_cache" ? diagnostics.diagnostics.cachedInputTokens : undefined).toBe(4);
	});
});
