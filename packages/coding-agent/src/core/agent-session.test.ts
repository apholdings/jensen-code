import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@apholdings/jensen-agent-core";
import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "./agent-session.js";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

function createTempDir(): string {
	return mkdtempSync(join(tmpdir(), "jensen-fallback-"));
}

describe("AgentSession Fallback Models", () => {
	it("should fallback to the next model when API key validation fails for primary", async () => {
		const rootDir = createTempDir();
		const agentDir = join(rootDir, "agent");
		const cwd = join(rootDir, "repo");

		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = new ModelRegistry(authStorage, undefined);

		// Add dummy models
		const primaryModel = {
			id: "primary-1",
			provider: "test-provider",
			api: "openai-chat",
			baseUrl: "url",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8000,
			maxTokens: 4000,
		} as any;
		const fallbackModel = {
			id: "fallback-1",
			provider: "fallback-provider",
			api: "openai-chat",
			baseUrl: "url",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8000,
			maxTokens: 4000,
		} as any;

		modelRegistry.registerProvider("test-provider", {
			baseUrl: "url",
			apiKey: "dummy-key",
			api: "openai-chat",
			models: [primaryModel],
		});
		modelRegistry.registerProvider("fallback-provider", {
			baseUrl: "url",
			apiKey: "valid-key",
			api: "openai-chat",
			models: [fallbackModel],
		});

		// Remove the API key for the primary model to force failure
		authStorage.remove("test-provider");
		(modelRegistry as any).customProviderApiKeys.delete("test-provider");

		const settingsManager = SettingsManager.create(cwd, agentDir);
		const sessionManager = SessionManager.create(cwd);
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });

		const agent = new Agent({
			initialState: {
				systemPrompt: "",
				model: primaryModel,
				thinkingLevel: "off",
				tools: [],
			},
		});

		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd,
			fallbackModels: [fallbackModel],
			resourceLoader,
			modelRegistry,
		});

		// Mock prompt on agent to avoid real execution
		let agentPromptCalled = false;
		agent.prompt = async () => {
			agentPromptCalled = true;
		};

		// Should automatically fallback and not throw during validation
		await session.prompt("Hello");

		expect(session.model?.id).toBe("fallback-1");
		expect(agentPromptCalled).toBe(true);

		rmSync(rootDir, { recursive: true, force: true });
	});

	it("should fallback when retries are exhausted", async () => {
		const rootDir = createTempDir();
		const agentDir = join(rootDir, "agent");
		const cwd = join(rootDir, "repo");

		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = new ModelRegistry(authStorage, undefined);

		const primaryModel = {
			id: "primary-1",
			provider: "test-provider",
			api: "openai-chat",
			baseUrl: "url",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8000,
			maxTokens: 4000,
		} as any;
		const fallbackModel = {
			id: "fallback-1",
			provider: "fallback-provider",
			api: "openai-chat",
			baseUrl: "url",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8000,
			maxTokens: 4000,
		} as any;

		modelRegistry.registerProvider("test-provider", {
			baseUrl: "url",
			apiKey: "valid-key-1",
			api: "openai-chat",
			models: [primaryModel],
		});
		modelRegistry.registerProvider("fallback-provider", {
			baseUrl: "url",
			apiKey: "valid-key-2",
			api: "openai-chat",
			models: [fallbackModel],
		});

		const settingsManager = SettingsManager.create(cwd, agentDir);
		// Enable retries and set maxRetries to 1
		settingsManager.setRetryEnabled(true);
		// Can't directly set maxRetries via API easily here, but we can rely on default (3) or mock it.
		// We can just spy on the settings manager:
		const getRetrySettings = vi.spyOn(settingsManager, "getRetrySettings");
		getRetrySettings.mockReturnValue({ enabled: true, maxRetries: 1, maxDelayMs: 1000, baseDelayMs: 10 });

		const sessionManager = SessionManager.create(cwd);
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });

		const agent = new Agent({
			initialState: {
				systemPrompt: "",
				model: primaryModel,
				thinkingLevel: "off",
				tools: [],
			},
		});

		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd,
			fallbackModels: [fallbackModel],
			resourceLoader,
			modelRegistry,
		});

		// Emit an agent_end with a retryable error message
		const messages = [
			{
				role: "assistant",
				stopReason: "error",
				errorMessage: "Rate limit exceeded 429",
				content: [],
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
				timestamp: 0,
			},
		];

		// Mock agent.continue to just record call
		let continueCalled = 0;
		agent.continue = async () => {
			continueCalled++;
		};
		agent.state.messages = messages as any;

		// Force a process of agent_end which will trigger retry
		(session as any)._lastAssistantMessage = messages[0];
		(session as any)._handleAgentEvent({ type: "agent_end", messages } as any);

		// Wait for retry to be processed
		await new Promise((r) => setTimeout(r, 50));

		// It should have tried to retry once
		expect(continueCalled).toBe(1);
		expect(session.retryAttempt).toBe(1);
		expect(session.model?.id).toBe("primary-1"); // Still primary

		// Trigger failure again
		(session as any)._lastAssistantMessage = messages[0];
		(session as any)._handleAgentEvent({ type: "agent_end", messages } as any);

		// Wait for fallback
		await new Promise((r) => setTimeout(r, 50));

		// Should have fallen back!
		expect(session.model?.id).toBe("fallback-1");
		expect(session.retryAttempt).toBe(0); // Reset for the new model
		// Continue should have been called again for the fallback
		expect(continueCalled).toBe(2);

		rmSync(rootDir, { recursive: true, force: true });
	});
});
