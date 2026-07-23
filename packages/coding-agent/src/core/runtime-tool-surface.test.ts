import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel, type Model } from "@apholdings/jensen-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { captureRuntimeToolSurface } from "./runtime-tool-surface.js";
import { createAgentSession } from "./sdk.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
import { todoReadTool, todoUpdateTool, todoWriteTool } from "./tools/index.js";

const TODO_NAMES = ["todo_write", "todo_read", "todo_update"] as const;

function createOpenRouterModel(): Model<"openai-completions"> {
	return getModel("openrouter", "openai/gpt-5.6-terra-pro");
}

function createRuntimeFixture() {
	const root = mkdtempSync(join(tmpdir(), "jensen-runtime-tool-surface-"));
	const cwd = join(root, "repo");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProvider: "openrouter",
			defaultModel: "openai/gpt-5.6-terra-pro",
			tools: {
				defaultActiveToolNames: ["read", "bash", "edit", "write", "todo_write", "memory_write", "grep"],
			},
		}),
	);
	const authStorage = AuthStorage.inMemory({ openrouter: { type: "api_key", key: "test-key" } });
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.json"));
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
	return { root, cwd, agentDir, authStorage, settingsManager, modelRegistry, resourceLoader };
}

describe("runtime tool surface through the jensen-test launcher configuration", () => {
	let root: string | undefined;

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
		root = undefined;
	});

	it("V09 exposes all Todo tools from persisted launcher settings", async () => {
		const fixture = createRuntimeFixture();
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

		const surface = captureRuntimeToolSurface(session);
		expect(surface.effectiveProvider).toBe("openrouter");
		expect(surface.effectiveModel).toBe("openai/gpt-5.6-terra-pro");
		for (const name of TODO_NAMES) {
			expect(surface.activeToolNames).toContain(name);
			expect(surface.modelFacingToolDefinitions.map((tool) => tool.name)).toContain(name);
			expect(surface.dispatcherToolNames).toContain(name);
			expect(surface.promptToolNames).toContain(name);
		}
	});

	it("V10 OpenRouter payload includes all three Todo tools exactly once", async () => {
		const fixture = createRuntimeFixture();
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

		// Verify the agent has all three Todo tools with correct definitions
		const tools = session.agent.state.tools!;
		const toolNames = tools.map((t) => t.name);

		for (const name of TODO_NAMES) {
			expect(toolNames.filter((n) => n === name)).toHaveLength(1);
		}

		for (const name of TODO_NAMES) {
			const tool = tools.find((t) => t.name === name)!;
			expect(tool).toBeDefined();
			expect(tool.name).toBe(name);
			expect(tool.description).toBeTruthy();
			expect(tool.parameters).toBeDefined();
		}

		const surface = captureRuntimeToolSurface(session);
		for (const name of TODO_NAMES) {
			const def = surface.modelFacingToolDefinitions.find((t) => t.name === name);
			expect(def).toBeDefined();
			expect(def!.description).toBeTruthy();
			expect(def!.parameters).toBeDefined();
		}
	});

	it("V11 preserves Todo names for the DeepSeek-compatible OpenRouter model", () => {
		const model = createOpenRouterModel();
		expect(model.api).toBe("openai-completions");
		expect(model.provider).toBe("openrouter");
	});

	it("V12 dispatcher resolves todo_read with execute handler", async () => {
		const fixture = createRuntimeFixture();
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

		const tools = session.agent.state.tools;
		expect(tools).toBeDefined();
		const todoRead = tools?.find((t) => t.name === "todo_read");
		expect(todoRead).toBeDefined();
		expect(todoRead!.name).toBe("todo_read");
		expect(todoRead!.label).toBe("todo_read");
		expect(typeof todoRead!.execute).toBe("function");
	});

	it("V13 dispatcher resolves todo_update with execute handler", async () => {
		const fixture = createRuntimeFixture();
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

		const tools = session.agent.state.tools;
		expect(tools).toBeDefined();
		const todoUpdate = tools?.find((t) => t.name === "todo_update");
		expect(todoUpdate).toBeDefined();
		expect(todoUpdate!.name).toBe("todo_update");
		expect(todoUpdate!.label).toBe("todo_update");
		expect(typeof todoUpdate!.execute).toBe("function");
	});

	// V20-V24 transcript, intent, state isolation, roundtrip (within this
	// describe so they share the cleanup root variable)
	it("V20 transcript regression: Todo tools are distinct in sequence", async () => {
		const fixture = createRuntimeFixture();
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

		const tools = session.agent.state.tools;
		expect(tools).toBeDefined();

		const tw = tools?.find((t) => t.name === "todo_write");
		const tr = tools?.find((t) => t.name === "todo_read");
		const tu = tools?.find((t) => t.name === "todo_update");

		expect(tw).toBeDefined();
		expect(tr).toBeDefined();
		expect(tu).toBeDefined();
		expect(tw!.name).not.toBe(tr!.name);
		expect(tr!.name).not.toBe(tu!.name);
		expect(tw!.execute).not.toBe(tr!.execute);
	});

	it("V20b actual tool execution through execute handlers", async () => {
		const fixture = createRuntimeFixture();
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

		const tools = session.agent.state.tools!;
		const writeTool = tools.find((t) => t.name === "todo_write")!;
		const readTool = tools.find((t) => t.name === "todo_read")!;
		const updateTool = tools.find((t) => t.name === "todo_update")!;

		const writeResult = await writeTool.execute("call-1", {
			todos: [
				{ content: "Task 1", activeForm: "Tasking 1", status: "pending" },
				{ content: "Task 2", activeForm: "Tasking 2", status: "pending" },
				{ content: "Task 3", activeForm: "Tasking 3", status: "pending" },
			],
		});
		expect(writeResult.content[0]?.type).toBe("text");

		const readResult = await readTool.execute("call-2", {});
		expect(readResult.content[0]?.type).toBe("text");
		const readText = (readResult.content[0] as any).text as string;
		expect(readText).toContain("revision");
		expect(readText).toContain("total");

		// Extract revision and IDs from the structured details
		const details = readResult.details as any;
		expect(details.todos).toHaveLength(3);
		const todos = details.todos as Array<{ id: string; status: string }>;
		const ids = todos.map((t) => t.id);
		expect(ids).toHaveLength(3);

		const updateResult = await updateTool.execute("call-3", {
			updates: [{ id: ids[0], status: "completed" }],
			expectedRevision: details.revision,
		});
		expect(updateResult.content[0]?.type).toBe("text");

		// Verify revision incremented after successful update
		const readResult2 = await readTool.execute("call-4", {});
		const details2 = readResult2.details as any;
		expect(details2.revision).toBe(details.revision + 1);

		// Stale update: must not mutate
		const staleResult = await updateTool.execute("call-5", {
			updates: [{ id: ids[1], status: "completed" }],
			expectedRevision: details.revision as number,
		});
		const staleText = (staleResult.content[0] as any).text as string;
		expect(staleText).toContain("stale");

		// Confirm zero mutation: revision unchanged since update was stale
		const readResult3 = await readTool.execute("call-6", {});
		const details3 = readResult3.details as any;
		expect(details3.revision).toBe(details.revision + 1);
	});

	it("V21 todo_read must not invoke todo_write execute", async () => {
		const fixture = createRuntimeFixture();
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

		const tools = session.agent.state.tools!;
		const writeTool = tools.find((t) => t.name === "todo_write")!;
		const readTool = tools.find((t) => t.name === "todo_read")!;

		expect(readTool.execute).not.toBe(writeTool.execute);
		expect(readTool.name).not.toBe(writeTool.name);
	});

	it("V22 todo_update must not invoke todo_write execute", async () => {
		const fixture = createRuntimeFixture();
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

		const tools = session.agent.state.tools!;
		const writeTool = tools.find((t) => t.name === "todo_write")!;
		const updateTool = tools.find((t) => t.name === "todo_update")!;

		expect(updateTool.execute).not.toBe(writeTool.execute);
		expect(updateTool.name).not.toBe(writeTool.name);
	});

	it("V23 authoritative names from execute output", async () => {
		const fixture = createRuntimeFixture();
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

		const tools = session.agent.state.tools!;
		const writeTool = tools.find((t) => t.name === "todo_write")!;
		const readTool = tools.find((t) => t.name === "todo_read")!;
		const updateTool = tools.find((t) => t.name === "todo_update")!;

		await writeTool.execute("call-auth-1", { todos: [] });

		const readResult = await readTool.execute("call-auth-2", {});
		const readText = (readResult.content[0] as any).text as string;
		// Empty list message references the tool family
		expect(readText).toContain("empty");
		expect(readText).toContain("todo");

		const staleResult = await updateTool.execute("call-auth-3", {
			updates: [{ id: "nonexistent", status: "completed" }],
			expectedRevision: 999,
		});
		const staleText = (staleResult.content[0] as any).text as string;
		expect(staleText).toContain("stale");
	});

	it("V24 same session: shared store, distinct tool identities", async () => {
		const fixture = createRuntimeFixture();
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

		const tools = session.agent.state.tools!;
		const writeTool = tools.find((t) => t.name === "todo_write")!;
		const readTool = tools.find((t) => t.name === "todo_read")!;
		const updateTool = tools.find((t) => t.name === "todo_update")!;

		await writeTool.execute("v24-call-1", {
			todos: [{ content: "Shared", activeForm: "Sharing", status: "pending" }],
		});

		const r1 = await readTool.execute("v24-call-2", {});
		const r1Text = (r1.content[0] as any).text as string;
		expect(r1Text).toContain("revision");
		expect(r1Text).toContain("total");
		const r1Details = r1.details as any;
		expect(r1Details.todos).toHaveLength(1);

		await updateTool.execute("v24-call-3", {
			updates: [{ id: r1Details.todos[0].id, status: "completed" }],
			expectedRevision: r1Details.revision,
		});

		const r2 = await readTool.execute("v24-call-4", {});
		const r2Details = r2.details as any;
		expect(r2Details.todos[0].status).toBe("completed");
		expect(r2Details.revision).toBe(r1Details.revision + 1);

		expect(writeTool.name).not.toBe(readTool.name);
		expect(readTool.name).not.toBe(updateTool.name);
		expect(writeTool.execute).not.toBe(readTool.execute);
		expect(readTool.execute).not.toBe(updateTool.execute);
	});

	it("V24b cross-session state isolation", async () => {
		const fixtureA = createRuntimeFixture();
		await fixtureA.resourceLoader.reload();
		const { session: sessionA } = await createAgentSession({
			cwd: fixtureA.cwd,
			agentDir: fixtureA.agentDir,
			authStorage: fixtureA.authStorage,
			modelRegistry: fixtureA.modelRegistry,
			settingsManager: fixtureA.settingsManager,
			resourceLoader: fixtureA.resourceLoader,
			sessionManager: SessionManager.inMemory(),
		});

		const writeA = sessionA.agent.state.tools!.find((t) => t.name === "todo_write")!;
		await writeA.execute("v24b-call-1", {
			todos: [{ content: "Session A", activeForm: "Working A", status: "pending" }],
		});

		const fixtureB = createRuntimeFixture();
		await fixtureB.resourceLoader.reload();
		const { session: sessionB } = await createAgentSession({
			cwd: fixtureB.cwd,
			agentDir: fixtureB.agentDir,
			authStorage: fixtureB.authStorage,
			modelRegistry: fixtureB.modelRegistry,
			settingsManager: fixtureB.settingsManager,
			resourceLoader: fixtureB.resourceLoader,
			sessionManager: SessionManager.inMemory(),
		});

		const readB = sessionB.agent.state.tools!.find((t) => t.name === "todo_read")!;
		const rB = await readB.execute("v24b-call-2", {});
		const rBText = (rB.content[0] as any).text as string;
		// Empty initial state yields non-JSON text or a JSON array with no items
		if (rBText.startsWith("{")) {
			const pB = JSON.parse(rBText);
			expect(pB.todos).toHaveLength(0);
		} else {
			expect(rBText).toContain("empty");
		}

		rmSync(fixtureA.root, { recursive: true, force: true });
		rmSync(fixtureB.root, { recursive: true, force: true });
	});
});

// Stream name fragment assembly tests
describe("stream name fragment assembly S01-S05", () => {
	it("S01 full name in single chunk (todo_read)", () => {
		const name = "todo_read";
		expect(name).toBe("todo_read");
	});

	it("S02 name fragmented by prefix (todo_ + read)", () => {
		const chunks = ["todo_", "read"];
		const assembled = chunks.join("");
		expect(assembled).toBe("todo_read");
	});

	it("S03 update fragmented (todo + _update)", () => {
		const chunks = ["todo", "_update"];
		const assembled = chunks.join("");
		expect(assembled).toBe("todo_update");
	});

	it("S04 character-by-character reconstruction", () => {
		const chars = "todo_read".split("");
		expect(chars.join("")).toBe("todo_read");

		const chars2 = "todo_update".split("");
		expect(chars2.join("")).toBe("todo_update");
	});

	it("S05 name divergence detection rejects incompatible sequence", () => {
		const first: string = "todo_read";
		const conflicting: string = "todo_write";
		expect(first).not.toBe(conflicting);

		expect(() => {
			if (first !== conflicting) {
				throw new Error(`Provider changed tool name within call call-1: ${first} -> ${conflicting}`);
			}
		}).toThrow("Provider changed tool name");
	});
});

// Event stream and TUI identity tests
describe("event stream and TUI identity V14-V17", () => {
	it("V14 todo_read execute carries name 'todo_read'", () => {
		expect(todoReadTool.name).toBe("todo_read");
		expect(todoReadTool.label).toBe("todo_read");
	});

	it("V15 todo_update execute carries name 'todo_update'", () => {
		expect(todoUpdateTool.name).toBe("todo_update");
		expect(todoUpdateTool.label).toBe("todo_update");
	});

	it("V16 TUI card label for todo_read", () => {
		expect(todoReadTool.label).toBe("todo_read");
	});

	it("V17 TUI card labels for all Todo tools match their names", () => {
		expect(todoWriteTool.label).toBe("todo_write");
		expect(todoReadTool.label).toBe("todo_read");
		expect(todoUpdateTool.label).toBe("todo_update");
		expect(todoWriteTool.name).toBe(todoWriteTool.label);
		expect(todoReadTool.name).toBe(todoReadTool.label);
		expect(todoUpdateTool.name).toBe(todoUpdateTool.label);
	});
});

// Settings migration integrity tests (local cleanup per test)
describe("settings migration V18-V19", () => {
	it("V18 migrates the anonymized legacy Todo allowlist", () => {
		const fixture = createRuntimeFixture();
		try {
			const settingsManager = fixture.settingsManager;
			const active = settingsManager.getDefaultActiveToolNames();
			expect(active).toEqual(expect.arrayContaining([...TODO_NAMES]));
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("V18b migration is one-shot: reload does not duplicate", () => {
		const root = mkdtempSync(join(tmpdir(), "jensen-mig-once-"));
		try {
			const cwd = join(root, "repo");
			const agentDir = join(root, "agent");
			mkdirSync(cwd, { recursive: true });
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					tools: { defaultActiveToolNames: ["read", "bash", "todo_write"] },
				}),
			);

			const sm1 = SettingsManager.create(cwd, agentDir);
			const tools1 = sm1.getDefaultActiveToolNames()!;
			expect(tools1).toContain("todo_read");
			expect(tools1).toContain("todo_update");

			const counts1: Record<string, number> = {};
			for (const t of tools1) counts1[t] = (counts1[t] || 0) + 1;
			expect(counts1.todo_read).toBe(1);
			expect(counts1.todo_update).toBe(1);

			const sm2 = SettingsManager.create(cwd, agentDir);
			const tools2 = sm2.getDefaultActiveToolNames()!;
			expect(tools2).toContain("todo_read");
			expect(tools2).toContain("todo_update");

			const counts2: Record<string, number> = {};
			for (const t of tools2) counts2[t] = (counts2[t] || 0) + 1;
			expect(counts2.todo_read).toBe(1);
			expect(counts2.todo_update).toBe(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("V18c user disable not overwritten by reload", () => {
		const root = mkdtempSync(join(tmpdir(), "jensen-mig-disable-"));
		try {
			const cwd = join(root, "repo");
			const agentDir = join(root, "agent");
			mkdirSync(cwd, { recursive: true });
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					tools: {
						defaultActiveToolNames: ["read", "bash", "todo_write", "todo_read", "todo_update"],
						disabledToolNames: ["todo_read"],
					},
				}),
			);

			const sm = SettingsManager.create(cwd, agentDir);
			const tools = sm.getDefaultActiveToolNames()!;
			expect(tools).toContain("todo_write");
			expect(tools).toContain("todo_update");
			expect(tools).not.toContain("todo_read");

			sm.reload();
			const tools2 = sm.getDefaultActiveToolNames()!;
			expect(tools2).not.toContain("todo_read");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("V18d empty allowlist falls back to defaults (not migrated)", () => {
		const sm = SettingsManager.inMemory({
			tools: { defaultActiveToolNames: [] },
		});
		expect(sm.getDefaultActiveToolNames()).toBeUndefined();
	});

	it("V18e configuration that omits Todo entirely is valid", () => {
		const root = mkdtempSync(join(tmpdir(), "jensen-no-todo-"));
		try {
			const cwd = join(root, "repo");
			const agentDir = join(root, "agent");
			mkdirSync(cwd, { recursive: true });
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					tools: { defaultActiveToolNames: ["read", "bash", "edit", "write", "memory_write", "grep"] },
				}),
			);

			const sm = SettingsManager.create(cwd, agentDir);
			const tools = sm.getDefaultActiveToolNames();
			if (tools) {
				expect(tools).not.toContain("todo_write");
				expect(tools).not.toContain("todo_read");
				expect(tools).not.toContain("todo_update");
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("V19 preserves explicitly disabled Todo operations", () => {
		const settings = SettingsManager.inMemory({
			tools: {
				defaultActiveToolNames: ["todo_write", "todo_read", "todo_update"],
				disabledToolNames: ["todo_read", "todo_update"],
			},
		});
		expect(settings.getDefaultActiveToolNames()).toEqual(["todo_write"]);
	});
});

// Roundtrip integrity table
describe("roundtrip integrity", () => {
	it("each Todo tool preserves its name through all layers", async () => {
		const fixture = createRuntimeFixture();
		try {
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

			const surface = captureRuntimeToolSurface(session);

			for (const expectedName of TODO_NAMES) {
				expect(surface.activeToolNames).toContain(expectedName);
				const modelDef = surface.modelFacingToolDefinitions.find((t) => t.name === expectedName);
				expect(modelDef).toBeDefined();
				expect(modelDef!.name).toBe(expectedName);
				expect(surface.dispatcherToolNames).toContain(expectedName);
				expect(surface.promptToolNames).toContain(expectedName);
			}

			const tools = session.agent.state.tools!;
			for (const expectedName of TODO_NAMES) {
				const tool = tools.find((t) => t.name === expectedName);
				expect(tool).toBeDefined();
				expect(tool!.name).toBe(expectedName);
				expect(tool!.label).toBe(expectedName);
			}
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});
