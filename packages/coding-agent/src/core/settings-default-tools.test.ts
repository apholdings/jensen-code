import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@apholdings/jensen-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { createAgentSession } from "./sdk.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

function createTestModel(): Model<"openai-chat"> {
	return {
		id: "default-tools-test-model",
		name: "Default Tools Test Model",
		provider: "default-tools-test-provider",
		api: "openai-chat",
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_000,
	};
}

function setupTestEnv() {
	const rootDir = require("fs").mkdtempSync(join(tmpdir(), "jensen-default-tools-"));
	const cwd = join(rootDir, "repo");
	const agentDir = join(rootDir, "agent");
	const sessionDir = join(rootDir, "sessions");

	require("fs").mkdirSync(cwd, { recursive: true });
	require("fs").mkdirSync(agentDir, { recursive: true });
	require("fs").mkdirSync(sessionDir, { recursive: true });

	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	const modelRegistry = new ModelRegistry(authStorage);
	const testModel = createTestModel();
	modelRegistry.registerProvider(testModel.provider, {
		api: testModel.api,
		apiKey: "test-api-key",
		baseUrl: testModel.baseUrl,
		models: [
			{
				id: testModel.id,
				name: testModel.name,
				api: testModel.api,
				reasoning: testModel.reasoning,
				input: testModel.input,
				cost: testModel.cost,
				contextWindow: testModel.contextWindow,
				maxTokens: testModel.maxTokens,
			},
		],
	});

	return { rootDir, cwd, agentDir, sessionDir, authStorage, modelRegistry, testModel };
}

describe("settings default tools", () => {
	let rootDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		const env = setupTestEnv();
		rootDir = env.rootDir;
		cwd = env.cwd;
		agentDir = env.agentDir;
	});

	afterEach(() => {
		require("fs").rmSync(rootDir, { recursive: true, force: true });
	});

	describe("getDefaultActiveToolNames", () => {
		it("returns undefined when tools config is absent", () => {
			const settingsManager = SettingsManager.inMemory({});
			expect(settingsManager.getDefaultActiveToolNames()).toBeUndefined();
		});

		it("returns undefined when tools config is empty object", () => {
			const settingsManager = SettingsManager.inMemory({ tools: {} });
			expect(settingsManager.getDefaultActiveToolNames()).toBeUndefined();
		});

		it("returns configured tool names when present", () => {
			const settingsManager = SettingsManager.inMemory({
				tools: { defaultActiveToolNames: ["read", "bash"] },
			});
			expect(settingsManager.getDefaultActiveToolNames()).toEqual(["read", "bash"]);
		});

		it("filters unknown tool names", () => {
			const settingsManager = SettingsManager.inMemory({
				tools: { defaultActiveToolNames: ["read", "unknown_tool", "bash"] },
			});
			expect(settingsManager.getDefaultActiveToolNames()).toEqual(["read", "bash"]);
		});

		it("returns undefined when all configured tools are unknown", () => {
			const settingsManager = SettingsManager.inMemory({
				tools: { defaultActiveToolNames: ["unknown1", "unknown2"] },
			});
			expect(settingsManager.getDefaultActiveToolNames()).toBeUndefined();
		});

		it("supports web_search in configured tools", () => {
			const settingsManager = SettingsManager.inMemory({
				tools: { defaultActiveToolNames: ["web_search"] },
			});
			expect(settingsManager.getDefaultActiveToolNames()).toEqual(["web_search"]);
		});

		it("supports powershell in configured tools", () => {
			const settingsManager = SettingsManager.inMemory({
				tools: { defaultActiveToolNames: ["powershell"] },
			});
			expect(settingsManager.getDefaultActiveToolNames()).toEqual(["powershell"]);
		});

		it("returns undefined for empty array", () => {
			const settingsManager = SettingsManager.inMemory({
				tools: { defaultActiveToolNames: [] },
			});
			expect(settingsManager.getDefaultActiveToolNames()).toBeUndefined();
		});

		it("filters out non-string entries", () => {
			const settingsManager = SettingsManager.inMemory({
				// @ts-expect-error - testing runtime behavior with invalid data
				tools: { defaultActiveToolNames: ["read", 123, null, "bash", undefined] },
			});
			expect(settingsManager.getDefaultActiveToolNames()).toEqual(["read", "bash"]);
		});
	});

	describe("createAgentSession with settings default tools", () => {
		it("uses legacy defaults when settings have no tools config", async () => {
			const env = setupTestEnv();
			rootDir = env.rootDir;
			cwd = env.cwd;
			agentDir = env.agentDir;

			try {
				const settingsManager = SettingsManager.inMemory({});
				const sessionManager = SessionManager.inMemory();
				const resourceLoader = new DefaultResourceLoader({
					cwd,
					agentDir,
					settingsManager,
				});
				await resourceLoader.reload();

				const { session } = await createAgentSession({
					cwd,
					agentDir,
					settingsManager,
					authStorage: env.authStorage,
					modelRegistry: env.modelRegistry,
					resourceLoader,
					sessionManager,
				});

				// Legacy defaults: read, bash, edit, write
				const activeTools = session.getActiveToolNames();
				expect(activeTools).toContain("read");
				expect(activeTools).toContain("bash");
				expect(activeTools).toContain("edit");
				expect(activeTools).toContain("write");
			} finally {
				require("fs").rmSync(rootDir, { recursive: true, force: true });
			}
		});

		it("uses configured tools from settings when no explicit tools provided", async () => {
			const env = setupTestEnv();
			rootDir = env.rootDir;
			cwd = env.cwd;
			agentDir = env.agentDir;

			try {
				const settingsManager = SettingsManager.inMemory({
					tools: { defaultActiveToolNames: ["read", "bash"] },
				});
				const sessionManager = SessionManager.inMemory();
				const resourceLoader = new DefaultResourceLoader({
					cwd,
					agentDir,
					settingsManager,
				});
				await resourceLoader.reload();

				const { session } = await createAgentSession({
					cwd,
					agentDir,
					settingsManager,
					authStorage: env.authStorage,
					modelRegistry: env.modelRegistry,
					resourceLoader,
					sessionManager,
				});

				// Should use configured settings tools
				const activeTools = session.getActiveToolNames();
				expect(activeTools).toContain("read");
				expect(activeTools).toContain("bash");
				expect(activeTools).not.toContain("edit");
				expect(activeTools).not.toContain("write");
			} finally {
				require("fs").rmSync(rootDir, { recursive: true, force: true });
			}
		});

		it("uses explicit tools over settings when provided", async () => {
			const env = setupTestEnv();
			rootDir = env.rootDir;
			cwd = env.cwd;
			agentDir = env.agentDir;

			try {
				const settingsManager = SettingsManager.inMemory({
					tools: { defaultActiveToolNames: ["read", "bash"] },
				});
				const sessionManager = SessionManager.inMemory();
				const resourceLoader = new DefaultResourceLoader({
					cwd,
					agentDir,
					settingsManager,
				});
				await resourceLoader.reload();

				// Provide explicit tools - should override settings
				const { session } = await createAgentSession({
					cwd,
					agentDir,
					settingsManager,
					authStorage: env.authStorage,
					modelRegistry: env.modelRegistry,
					resourceLoader,
					sessionManager,
					tools: [{ name: "grep" }] as any,
				});

				// Should use explicit tools, not settings
				const activeTools = session.getActiveToolNames();
				expect(activeTools).toContain("grep");
			} finally {
				require("fs").rmSync(rootDir, { recursive: true, force: true });
			}
		});

		it("falls back to legacy defaults when all configured tools are invalid", async () => {
			const env = setupTestEnv();
			rootDir = env.rootDir;
			cwd = env.cwd;
			agentDir = env.agentDir;

			try {
				const settingsManager = SettingsManager.inMemory({
					tools: { defaultActiveToolNames: ["invalid1", "invalid2"] },
				});
				const sessionManager = SessionManager.inMemory();
				const resourceLoader = new DefaultResourceLoader({
					cwd,
					agentDir,
					settingsManager,
				});
				await resourceLoader.reload();

				const { session } = await createAgentSession({
					cwd,
					agentDir,
					settingsManager,
					authStorage: env.authStorage,
					modelRegistry: env.modelRegistry,
					resourceLoader,
					sessionManager,
				});

				// Should fall back to legacy defaults
				const activeTools = session.getActiveToolNames();
				expect(activeTools).toContain("read");
				expect(activeTools).toContain("bash");
				expect(activeTools).toContain("edit");
				expect(activeTools).toContain("write");
			} finally {
				require("fs").rmSync(rootDir, { recursive: true, force: true });
			}
		});
	});
});
