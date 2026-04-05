import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@apholdings/jensen-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "./auth-storage.js";
import { SESSION_MEMORY_CUSTOM_TYPE, SESSION_TASKS_CUSTOM_TYPE, SESSION_TODOS_CUSTOM_TYPE } from "./memory.js";
import { ModelRegistry } from "./model-registry.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { createAgentSession } from "./sdk.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

function createTestModel(): Model<"openai-chat"> {
	return {
		id: "startup-resume-model",
		name: "Startup Resume Model",
		provider: "startup-test-provider",
		api: "openai-chat",
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_000,
	};
}

describe("createAgentSession startup resume boundary", () => {
	it("restores persisted session state when startup opens an existing session", async () => {
		const rootDir = mkdtempSync(join(tmpdir(), "jensen-sdk-startup-resume-"));
		const cwd = join(rootDir, "repo");
		const agentDir = join(rootDir, "agent");
		const sessionDir = join(rootDir, "sessions");

		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(sessionDir, { recursive: true });

		try {
			const settingsManager = SettingsManager.inMemory();
			settingsManager.setDefaultThinkingLevel("high");

			const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
			const modelRegistry = new ModelRegistry(authStorage);
			const restoredModel = createTestModel();
			modelRegistry.registerProvider(restoredModel.provider, {
				api: restoredModel.api,
				apiKey: "test-api-key",
				baseUrl: restoredModel.baseUrl,
				models: [
					{
						id: restoredModel.id,
						name: restoredModel.name,
						api: restoredModel.api,
						reasoning: restoredModel.reasoning,
						input: restoredModel.input,
						cost: restoredModel.cost,
						contextWindow: restoredModel.contextWindow,
						maxTokens: restoredModel.maxTokens,
					},
				],
			});

			const persistedSession = SessionManager.create(cwd, sessionDir);
			persistedSession.appendModelChange(restoredModel.provider, restoredModel.id);
			persistedSession.appendThinkingLevelChange("low");
			persistedSession.appendCustomEntry(SESSION_MEMORY_CUSTOM_TYPE, [
				{ key: "project.goal", value: "restore startup state", timestamp: "2026-04-02T12:00:00.000Z" },
			]);
			persistedSession.appendCustomEntry(SESSION_TODOS_CUSTOM_TYPE, [
				{ content: "Resume startup test", activeForm: "Restoring startup test", status: "in_progress" },
			]);
			persistedSession.appendCustomEntry(SESSION_TASKS_CUSTOM_TYPE, [
				{
					id: "task_resume_1",
					subject: "Resume test task",
					description: "verify startup resume",
					status: "in_progress",
				},
			]);
			persistedSession.appendMessage({
				role: "assistant",
				api: restoredModel.api,
				provider: restoredModel.provider,
				model: restoredModel.id,
				stopReason: "stop",
				content: [{ type: "text", text: "persisted assistant reply" }],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			});

			const sessionFile = persistedSession.getSessionFile();
			if (!sessionFile) {
				throw new Error("Expected persisted session file");
			}

			const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
			await resourceLoader.reload();

			const openedSession = SessionManager.open(sessionFile, sessionDir);
			const { session } = await createAgentSession({
				cwd,
				agentDir,
				settingsManager,
				authStorage,
				modelRegistry,
				resourceLoader,
				sessionManager: openedSession,
			});

			expect(session.sessionFile).toBe(sessionFile);
			expect(session.sessionId).toBe(openedSession.getSessionId());
			expect(session.model?.provider).toBe(restoredModel.provider);
			expect(session.model?.id).toBe(restoredModel.id);
			expect(session.thinkingLevel).toBe("low");
			expect(session.getMemoryItems()).toEqual([
				{ key: "project.goal", value: "restore startup state", timestamp: "2026-04-02T12:00:00.000Z" },
			]);
			expect(session.getTodos()).toEqual([
				{ content: "Resume startup test", activeForm: "Restoring startup test", status: "in_progress" },
			]);
			expect(session.getTasks()).toEqual([
				{
					id: "task_resume_1",
					subject: "Resume test task",
					description: "verify startup resume",
					status: "in_progress",
				},
			]);
			expect(session.messages).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						role: "assistant",
						provider: restoredModel.provider,
						model: restoredModel.id,
						content: [{ type: "text", text: "persisted assistant reply" }],
					}),
				]),
			);
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("starts fresh when startup opens a corrupt session file with partial persisted state", async () => {
		const rootDir = mkdtempSync(join(tmpdir(), "jensen-sdk-startup-resume-"));
		const cwd = join(rootDir, "repo");
		const agentDir = join(rootDir, "agent");
		const sessionDir = join(rootDir, "sessions");

		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(sessionDir, { recursive: true });

		try {
			const settingsManager = SettingsManager.inMemory();
			settingsManager.setDefaultThinkingLevel("high");
			settingsManager.setDefaultModelAndProvider("startup-test-provider", "startup-resume-model");

			const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
			const modelRegistry = new ModelRegistry(authStorage);
			const fallbackModel = createTestModel();
			modelRegistry.registerProvider(fallbackModel.provider, {
				api: fallbackModel.api,
				apiKey: "test-api-key",
				baseUrl: fallbackModel.baseUrl,
				models: [
					{
						id: fallbackModel.id,
						name: fallbackModel.name,
						api: fallbackModel.api,
						reasoning: fallbackModel.reasoning,
						input: fallbackModel.input,
						cost: fallbackModel.cost,
						contextWindow: fallbackModel.contextWindow,
						maxTokens: fallbackModel.maxTokens,
					},
				],
			});

			const corruptSessionFile = join(sessionDir, "corrupt-startup-session.jsonl");
			writeFileSync(
				corruptSessionFile,
				[
					JSON.stringify({
						type: "not_session",
						id: "claimed-corrupt-session-id",
						timestamp: "2026-04-02T12:00:00.000Z",
						cwd,
					}),
					JSON.stringify({
						type: "model_change",
						id: "model-entry",
						parentId: null,
						timestamp: "2026-04-02T12:00:01.000Z",
						provider: "corrupt-provider",
						modelId: "corrupt-model",
					}),
					JSON.stringify({
						type: "thinking_level_change",
						id: "thinking-entry",
						parentId: "model-entry",
						timestamp: "2026-04-02T12:00:02.000Z",
						thinkingLevel: "low",
					}),
					JSON.stringify({
						type: "custom",
						id: "memory-entry",
						parentId: "thinking-entry",
						timestamp: "2026-04-02T12:00:03.000Z",
						customType: SESSION_MEMORY_CUSTOM_TYPE,
						data: [
							{
								key: "project.goal",
								value: "corrupt restore leak",
								timestamp: "2026-04-02T12:00:03.000Z",
							},
						],
					}),
					JSON.stringify({
						type: "custom",
						id: "todo-entry",
						parentId: "memory-entry",
						timestamp: "2026-04-02T12:00:04.000Z",
						customType: SESSION_TODOS_CUSTOM_TYPE,
						data: [
							{
								content: "Corrupt todo",
								activeForm: "Corrupt todo",
								status: "in_progress",
							},
						],
					}),
					JSON.stringify({
						type: "message",
						id: "assistant-entry",
						parentId: "todo-entry",
						timestamp: "2026-04-02T12:00:05.000Z",
						message: {
							role: "assistant",
							api: fallbackModel.api,
							provider: "corrupt-provider",
							model: "corrupt-model",
							stopReason: "stop",
							content: [{ type: "text", text: "corrupt persisted assistant reply" }],
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							timestamp: Date.now(),
						},
					}),
				].join("\n"),
			);

			const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
			await resourceLoader.reload();

			const openedSession = SessionManager.open(corruptSessionFile, sessionDir);
			const { session } = await createAgentSession({
				cwd,
				agentDir,
				settingsManager,
				authStorage,
				modelRegistry,
				resourceLoader,
				sessionManager: openedSession,
			});

			expect(session.sessionFile).toBe(corruptSessionFile);
			expect(session.sessionId).toBe(openedSession.getSessionId());
			expect(session.sessionId).not.toBe("claimed-corrupt-session-id");
			expect(session.model?.provider).toBe(fallbackModel.provider);
			expect(session.model?.id).toBe(fallbackModel.id);
			expect(session.thinkingLevel).toBe("high");
			expect(session.getMemoryItems()).toEqual([]);
			expect(session.getTodos()).toEqual([]);
			expect(session.messages).toHaveLength(0);
			expect(session.messages).not.toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						role: "assistant",
						provider: "corrupt-provider",
						model: "corrupt-model",
						content: [{ type: "text", text: "corrupt persisted assistant reply" }],
					}),
				]),
			);
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("starts fresh when startup opens a missing session file path", async () => {
		const rootDir = mkdtempSync(join(tmpdir(), "jensen-sdk-startup-resume-"));
		const cwd = join(rootDir, "repo");
		const agentDir = join(rootDir, "agent");
		const sessionDir = join(rootDir, "sessions");

		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(sessionDir, { recursive: true });

		try {
			const settingsManager = SettingsManager.inMemory();
			settingsManager.setDefaultThinkingLevel("high");
			settingsManager.setDefaultModelAndProvider("startup-test-provider", "startup-resume-model");

			const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
			const modelRegistry = new ModelRegistry(authStorage);
			const fallbackModel = createTestModel();
			modelRegistry.registerProvider(fallbackModel.provider, {
				api: fallbackModel.api,
				apiKey: "test-api-key",
				baseUrl: fallbackModel.baseUrl,
				models: [
					{
						id: fallbackModel.id,
						name: fallbackModel.name,
						api: fallbackModel.api,
						reasoning: fallbackModel.reasoning,
						input: fallbackModel.input,
						cost: fallbackModel.cost,
						contextWindow: fallbackModel.contextWindow,
						maxTokens: fallbackModel.maxTokens,
					},
				],
			});

			const missingSessionFile = join(sessionDir, "missing-startup-session.jsonl");
			expect(existsSync(missingSessionFile)).toBe(false);

			const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
			await resourceLoader.reload();

			const openedSession = SessionManager.open(missingSessionFile, sessionDir);
			const { session } = await createAgentSession({
				cwd,
				agentDir,
				settingsManager,
				authStorage,
				modelRegistry,
				resourceLoader,
				sessionManager: openedSession,
			});

			expect(session.sessionFile).toBe(missingSessionFile);
			expect(session.sessionId).toBe(openedSession.getSessionId());
			expect(session.model?.provider).toBe(fallbackModel.provider);
			expect(session.model?.id).toBe(fallbackModel.id);
			expect(session.thinkingLevel).toBe("high");
			expect(session.getMemoryItems()).toEqual([]);
			expect(session.getTodos()).toEqual([]);
			expect(session.messages).toHaveLength(0);
			expect(existsSync(missingSessionFile)).toBe(false);
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("starts fresh when startup opens a valid-header session file with a malformed later entry", async () => {
		const rootDir = mkdtempSync(join(tmpdir(), "jensen-sdk-startup-resume-"));
		const cwd = join(rootDir, "repo");
		const agentDir = join(rootDir, "agent");
		const sessionDir = join(rootDir, "sessions");

		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(sessionDir, { recursive: true });

		try {
			const settingsManager = SettingsManager.inMemory();
			settingsManager.setDefaultThinkingLevel("high");
			settingsManager.setDefaultModelAndProvider("startup-test-provider", "startup-resume-model");

			const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
			const modelRegistry = new ModelRegistry(authStorage);
			const fallbackModel = createTestModel();
			modelRegistry.registerProvider(fallbackModel.provider, {
				api: fallbackModel.api,
				apiKey: "test-api-key",
				baseUrl: fallbackModel.baseUrl,
				models: [
					{
						id: fallbackModel.id,
						name: fallbackModel.name,
						api: fallbackModel.api,
						reasoning: fallbackModel.reasoning,
						input: fallbackModel.input,
						cost: fallbackModel.cost,
						contextWindow: fallbackModel.contextWindow,
						maxTokens: fallbackModel.maxTokens,
					},
				],
			});

			const corruptSessionFile = join(sessionDir, "valid-header-malformed-entry-session.jsonl");
			writeFileSync(
				corruptSessionFile,
				[
					JSON.stringify({
						type: "session",
						version: 3,
						id: "claimed-valid-header-session-id",
						timestamp: "2026-04-02T12:00:00.000Z",
						cwd,
					}),
					JSON.stringify({
						type: "model_change",
						id: "model-entry",
						parentId: null,
						timestamp: "2026-04-02T12:00:01.000Z",
						provider: "corrupt-provider",
						modelId: "corrupt-model",
					}),
					JSON.stringify({
						type: "thinking_level_change",
						id: "thinking-entry",
						parentId: "model-entry",
						timestamp: "2026-04-02T12:00:02.000Z",
						thinkingLevel: "low",
					}),
					JSON.stringify({
						type: "custom",
						id: "memory-entry",
						parentId: "thinking-entry",
						timestamp: "2026-04-02T12:00:03.000Z",
						customType: SESSION_MEMORY_CUSTOM_TYPE,
						data: [
							{
								key: "project.goal",
								value: "malformed later entry should not leak",
								timestamp: "2026-04-02T12:00:03.000Z",
							},
						],
					}),
					JSON.stringify({
						type: "custom",
						id: "todo-entry",
						parentId: "memory-entry",
						timestamp: "2026-04-02T12:00:04.000Z",
						customType: SESSION_TODOS_CUSTOM_TYPE,
						data: [
							{
								content: "Leaky todo",
								activeForm: "Leaky todo",
								status: "in_progress",
							},
						],
					}),
					JSON.stringify({
						type: "message",
						id: "assistant-entry",
						parentId: "todo-entry",
						timestamp: "2026-04-02T12:00:05.000Z",
						message: {
							role: "assistant",
							api: fallbackModel.api,
							provider: "corrupt-provider",
							model: "corrupt-model",
							stopReason: "stop",
							content: [{ type: "text", text: "partial assistant state should not restore" }],
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							timestamp: Date.now(),
						},
					}),
					'{"type":"message","id":"broken-entry","parentId":"assistant-entry","timestamp":"2026-04-02T12:00:06.000Z"',
				].join("\n"),
			);

			const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
			await resourceLoader.reload();

			const openedSession = SessionManager.open(corruptSessionFile, sessionDir);
			const { session } = await createAgentSession({
				cwd,
				agentDir,
				settingsManager,
				authStorage,
				modelRegistry,
				resourceLoader,
				sessionManager: openedSession,
			});

			expect(session.sessionFile).toBe(corruptSessionFile);
			expect(session.sessionId).toBe(openedSession.getSessionId());
			expect(session.sessionId).not.toBe("claimed-valid-header-session-id");
			expect(session.model?.provider).toBe(fallbackModel.provider);
			expect(session.model?.id).toBe(fallbackModel.id);
			expect(session.thinkingLevel).toBe("high");
			expect(session.getMemoryItems()).toEqual([]);
			expect(session.getTodos()).toEqual([]);
			expect(session.messages).toHaveLength(0);
			expect(session.messages).not.toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						role: "assistant",
						provider: "corrupt-provider",
						model: "corrupt-model",
						content: [{ type: "text", text: "partial assistant state should not restore" }],
					}),
				]),
			);
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});
});
