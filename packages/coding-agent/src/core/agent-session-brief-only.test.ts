import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@apholdings/jensen-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "./agent-session.js";
import { AuthStorage } from "./auth-storage.js";
import { BTW_CUSTOM_TYPE } from "./btw-command.js";
import { ModelRegistry } from "./model-registry.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

function createHarness(options?: { briefOnly?: boolean }) {
	const rootDir = mkdtempSync(join(tmpdir(), "jensen-brief-only-"));
	const agentDir = join(rootDir, "agent");
	const cwd = join(rootDir, "repo");

	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	const modelRegistry = new ModelRegistry(authStorage, undefined);
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const sessionManager = SessionManager.create(cwd);
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
	const model = {
		id: "test-model",
		provider: "test-provider",
		api: "openai-chat",
		baseUrl: "url",
		reasoning: false,
		input: ["text"] as Array<"text" | "image">,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8000,
		maxTokens: 4000,
		name: "Test Model",
	};

	modelRegistry.registerProvider("test-provider", {
		baseUrl: "url",
		apiKey: "dummy-key",
		api: "openai-chat",
		models: [model],
	});

	const agent = new Agent({
		initialState: {
			systemPrompt: "",
			model,
			thinkingLevel: "off",
			tools: [],
		},
	});

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		resourceLoader,
		modelRegistry,
		briefOnly: options?.briefOnly,
	});

	return {
		rootDir,
		session,
		cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
	};
}

describe("AgentSession brief-only mode", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
	});

	it("leaves the default system prompt unchanged when brief-only is disabled", () => {
		const harness = createHarness();
		cleanups.push(harness.cleanup);

		expect(harness.session.briefOnly).toBe(false);
		expect(harness.session.systemPrompt).not.toContain("Brief-only mode is enabled for this session.");
	});

	it("adds the brief-only contract to the session system prompt when enabled", () => {
		const harness = createHarness();
		cleanups.push(harness.cleanup);

		harness.session.setBriefOnly(true);

		expect(harness.session.briefOnly).toBe(true);
		expect(harness.session.systemPrompt).toContain("Brief-only mode is enabled for this session.");
		expect(harness.session.systemPrompt).toContain("Suppress ordinary assistant prose.");
		expect(harness.session.systemPrompt).toContain("Do not hide tool activity, approvals, warnings, errors");
	});

	it("still routes explicit brief output through sendUserMessage semantics when brief-only is enabled", async () => {
		const harness = createHarness({ briefOnly: true });
		cleanups.push(harness.cleanup);

		const promptSpy = vi.spyOn(harness.session, "prompt").mockResolvedValue(undefined);

		await harness.session.sendUserMessage("brief update", { deliverAs: "followUp" });

		expect(promptSpy).toHaveBeenCalledWith("brief update", {
			expandPromptTemplates: false,
			streamingBehavior: "followUp",
			images: undefined,
			source: "extension",
		});
	});

	it("queues /btw notes as runtime-only next-turn context and clears them after injection", async () => {
		const harness = createHarness();
		cleanups.push(harness.cleanup);

		harness.session.queueByTheWay("keep the slice minimal");
		harness.session.queueByTheWay("do not broaden into /steer");

		expect(harness.session.getPendingByTheWayNotes()).toEqual([
			"keep the slice minimal",
			"do not broaden into /steer",
		]);
		expect(
			harness.session.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom_message" && entry.customType === BTW_CUSTOM_TYPE),
		).toBe(false);

		const promptSpy = vi.spyOn(harness.session.agent, "prompt").mockResolvedValue(undefined);
		await harness.session.prompt("continue with the main task");

		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(promptSpy.mock.calls[0]?.[0]).toMatchObject([
			{
				role: "user",
				content: [{ type: "text", text: "continue with the main task" }],
			},
			{
				role: "custom",
				customType: BTW_CUSTOM_TYPE,
				display: false,
				details: { note: "keep the slice minimal" },
			},
			{
				role: "custom",
				customType: BTW_CUSTOM_TYPE,
				display: false,
				details: { note: "do not broaden into /steer" },
			},
		]);
		expect(harness.session.getPendingByTheWayNotes()).toEqual([]);
	});

	it("keeps brief-only mode runtime-only across new session instances", () => {
		const enabledHarness = createHarness({ briefOnly: true });
		cleanups.push(enabledHarness.cleanup);
		expect(enabledHarness.session.briefOnly).toBe(true);

		const freshHarness = createHarness();
		cleanups.push(freshHarness.cleanup);
		expect(freshHarness.session.briefOnly).toBe(false);
	});
});
