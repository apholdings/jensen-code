import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { createAgentSession } from "./sdk.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
import { createAllTools } from "./tools/index.js";

const WEB_TOOLS = ["web_search", "web_fetch", "deep_research", "web_research_status"] as const;

function createFixture(toolsConfig?: unknown) {
	const root = mkdtempSync(join(tmpdir(), "jensen-web-avail-"));
	const cwd = join(root, "repo");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProvider: "openrouter",
			defaultModel: "openai/gpt-5.6-terra-pro",
			...(toolsConfig !== undefined ? { tools: toolsConfig } : {}),
		}),
	);
	const authStorage = AuthStorage.inMemory({ openrouter: { type: "api_key", key: "test-key" } });
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.json"));
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
	return { root, cwd, agentDir, authStorage, settingsManager, modelRegistry, resourceLoader };
}

describe("deep_research production availability", () => {
	let root: string | undefined;
	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
		root = undefined;
	});

	it("registers deep_research in the production base registry and all-tools surface", () => {
		const registry = createAllTools("/tmp");
		expect(registry.deep_research.name).toBe("deep_research");
		expect(typeof registry.deep_research.execute).toBe("function");
		expect(registry.deep_research.parameters).toBeDefined();
		expect(registry.web_search.name).toBe("web_search");
		expect(registry.web_fetch.name).toBe("web_fetch");
		expect(registry.web_research_status.name).toBe("web_research_status");
	});

	it("exposes the web research family to a fresh session with no explicit tools config", async () => {
		const fixture = createFixture();
		root = fixture.root;
		await fixture.resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			authStorage: fixture.authStorage,
			modelRegistry: fixture.modelRegistry,
			settingsManager: fixture.settingsManager,
			resourceLoader: fixture.resourceLoader,
			sessionManager: SessionManager.inMemory(),
		});

		const active = session.getActiveToolNames();
		for (const name of WEB_TOOLS) {
			expect(active).toContain(name);
		}
		const defs = session.agent.state.tools ?? [];
		for (const name of WEB_TOOLS) {
			expect(defs.map((tool) => tool.name)).toContain(name);
		}
	});

	it("keeps explicit settings defaultActiveToolNames authoritative (does not force web tools when disabled)", async () => {
		const fixture = createFixture({ defaultActiveToolNames: ["read", "bash"], disabledToolNames: [] });
		root = fixture.root;
		const { session } = await createAgentSession({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			authStorage: fixture.authStorage,
			modelRegistry: fixture.modelRegistry,
			settingsManager: fixture.settingsManager,
			resourceLoader: fixture.resourceLoader,
			sessionManager: SessionManager.inMemory(),
		});
		const active = session.getActiveToolNames();
		expect(active).toContain("read");
		expect(active).not.toContain("deep_research");
	});
});
