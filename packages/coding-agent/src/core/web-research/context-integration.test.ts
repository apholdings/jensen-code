import { buildCacheStableContext } from "@apholdings/jensen-agent-core";
import type { Message, ToolResultMessage } from "@apholdings/jensen-ai";
import { describe, expect, it } from "vitest";
import { createDeepResearchTool } from "../tools/deep-research.js";
import { createWebFetchTool } from "../tools/web-fetch.js";
import { createWebSearchTool } from "../tools/web-search.js";

describe("web research context-engine integration", () => {
	it("keeps deterministic tool schemas stable while web results remain dynamic", async () => {
		const tools = [createWebSearchTool(), createWebFetchTool(), createDeepResearchTool()];
		const firstMessages: Message[] = [{ role: "user", content: "first query", timestamp: 1 }];
		const webResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "web-1",
			toolName: "web_fetch",
			content: [{ type: "text", text: "untrusted evidence reference web-abc" }],
			details: { evidenceId: "web-abc", completeContent: "large durable page".repeat(100) },
			isError: false,
			timestamp: 2,
		};
		const secondMessages: Message[] = [{ role: "user", content: "second query", timestamp: 3 }, webResult];
		const first = await buildCacheStableContext({
			systemPrompt: "stable",
			messages: firstMessages,
			tools,
			provider: "test",
			model: "test",
		});
		const second = await buildCacheStableContext({
			systemPrompt: "stable",
			messages: secondMessages,
			tools: [...tools].reverse(),
			provider: "test",
			model: "test",
		});
		expect(first.snapshot.prefixFingerprint).toBe(second.snapshot.prefixFingerprint);
		expect(first.snapshot.dynamicSuffixBytes).not.toBe(second.snapshot.dynamicSuffixBytes);
		expect(second.stablePrefix.systemPrompt).not.toContain("large durable page");
	});
});
