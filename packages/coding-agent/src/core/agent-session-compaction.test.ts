import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@apholdings/jensen-agent-core";
import type { Model } from "@apholdings/jensen-ai";
import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "./agent-session.js";
import { AuthStorage } from "./auth-storage.js";
import { SESSION_MEMORY_CUSTOM_TYPE, SESSION_TODOS_CUSTOM_TYPE } from "./memory.js";
import { ModelRegistry } from "./model-registry.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

function createTempDir(): string {
	return mkdtempSync(join(tmpdir(), "jensen-compact-"));
}

describe("AgentSession compact hardening", () => {
	it("persists the augmented compaction summary and rebuilds post-compact state from session context", async () => {
		const rootDir = createTempDir();

		try {
			const agentDir = join(rootDir, "agent");
			const cwd = join(rootDir, "repo");
			const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
			const modelRegistry = new ModelRegistry(authStorage, undefined);
			const model: Model<"openai-chat"> = {
				id: "test-model",
				name: "Test Model",
				provider: "test-provider",
				api: "openai-chat",
				baseUrl: "https://example.test",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8000,
				maxTokens: 4000,
			};

			modelRegistry.registerProvider("test-provider", {
				baseUrl: "https://example.test",
				apiKey: "test-key",
				api: "openai-chat",
				models: [model],
			});

			const settingsManager = SettingsManager.create(cwd, agentDir);
			vi.spyOn(settingsManager, "getCompactionSettings").mockReturnValue({
				enabled: true,
				reserveTokens: 256,
				keepRecentTokens: 1,
			});

			const sessionManager = SessionManager.inMemory(cwd);
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "Older context ".repeat(200) }],
				timestamp: 1,
			});
			sessionManager.appendMessage({
				role: "assistant",
				provider: model.provider,
				model: model.id,
				content: [{ type: "text", text: "Older assistant reply" }],
				stopReason: "endTurn",
				usage: {
					input: 100,
					output: 20,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 120,
					cost: { total: 0 },
				},
				timestamp: 2,
			} as any);
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "Keep this follow-up" }],
				timestamp: 3,
			});
			sessionManager.appendCustomEntry(SESSION_MEMORY_CUSTOM_TYPE, [
				{
					key: "project.constraint",
					value: "run npm run check",
					timestamp: new Date().toISOString(),
				},
			]);
			sessionManager.appendCustomEntry(SESSION_TODOS_CUSTOM_TYPE, [
				{
					content: "Verify compact cleanup",
					activeForm: "Verifying compact cleanup",
					status: "in_progress",
				},
			]);

			const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
			const agent = new Agent({
				initialState: {
					systemPrompt: "",
					model,
					thinkingLevel: "off",
					tools: [],
				},
			});
			agent.replaceMessages(sessionManager.buildSessionContext().messages);

			const session = new AgentSession({
				agent,
				sessionManager,
				settingsManager,
				cwd,
				resourceLoader,
				modelRegistry,
			});

			const extensionEvents: Array<{ type: string; summary?: string }> = [];
			(session as any)._extensionRunner = {
				hasHandlers: (eventType: string) => eventType === "session_before_compact",
				emit: vi.fn(
					async (event: { type: string; preparation: { firstKeptEntryId: string; tokensBefore: number } }) => {
						if (event.type === "session_before_compact") {
							return {
								compaction: {
									summary: "Base compact summary",
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
									details: { source: "test" },
								},
							};
						}
						extensionEvents.push({ type: event.type, summary: (event as any).compactionEntry?.summary });
						return undefined;
					},
				),
			};

			const result = await session.compact();
			const compactedContext = sessionManager.buildSessionContext();
			const compactionEntry = sessionManager
				.getEntries()
				.filter((entry) => entry.type === "compaction")
				.at(-1);

			expect(result.summary).toContain("## Active Session Memory");
			expect(result.summary).toContain("- project.constraint: run npm run check");
			expect(result.summary).toContain("## Active Todo State");
			expect(result.summary).toContain("- [in_progress] Verifying compact cleanup");
			expect(compactionEntry?.summary).toBe(result.summary);
			expect(extensionEvents).toContainEqual({ type: "session_compact", summary: result.summary });
			expect(agent.state.messages).toEqual(compactedContext.messages);
			expect(agent.state.messages.some((message) => message.role === "compactionSummary")).toBe(true);
			expect(
				agent.state.messages.some(
					(message) =>
						message.role === "user" &&
						Array.isArray(message.content) &&
						message.content.some((block) => block.type === "text" && block.text.includes("Older context")),
				),
			).toBe(false);
			expect(compactedContext.memoryItems.map((item) => item.key)).toEqual(["project.constraint"]);
			expect(compactedContext.todos.map((todo) => todo.activeForm)).toEqual(["Verifying compact cleanup"]);
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});
});
