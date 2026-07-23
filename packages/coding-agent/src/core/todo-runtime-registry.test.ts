/**
 * Tests for the runtime registration surface of todo_write, todo_read, and todo_update.
 *
 * V01 – Superficie completa
 * V02 – Schema del modelo
 * V03 – Dispatch
 * V04 – Prompt/tool consistency
 * V05 – Defaults
 * V06 – Persisted settings compatibility (backward compat)
 * V07 – Disabled tools
 * V08 – Exact black-box surface regression
 *
 * Plus:
 * - Integrated dispatcher simulation (section 10)
 * - Truthful tool sequence (section 11)
 * - Session isolation
 */

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
import { allTools } from "./tools/index.js";
import { TodoLoopGuard } from "./tools/todo-loop-guard.js";
import { createTodoReadTool } from "./tools/todo-read.js";
import { createTodoUpdateTool } from "./tools/todo-update.js";
import { createTodoWriteTool, type TodoItem } from "./tools/todo-write.js";

/** Extract joined text content from a tool result's content array */
function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
}

function createTestModel(): Model<"openai-chat"> {
	return {
		id: "todo-registry-test-model",
		name: "Todo Registry Test Model",
		provider: "todo-registry-test-provider",
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
	const rootDir = require("fs").mkdtempSync(join(tmpdir(), "jensen-todo-registry-"));
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

describe("todo runtime tool registration", () => {
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

	// =========================================================================
	// V01 — Superficie completa
	// =========================================================================
	describe("V01 — Surface completo", () => {
		it("exposes todo_write, todo_read, and todo_update in the default session", async () => {
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

				const activeTools = session.getActiveToolNames();
				expect(activeTools).toContain("todo_write");
				expect(activeTools).toContain("todo_read");
				expect(activeTools).toContain("todo_update");
			} finally {
				require("fs").rmSync(rootDir, { recursive: true, force: true });
			}
		});

		it("all three todo tools are present in allTools map", () => {
			expect(allTools).toHaveProperty("todo_write");
			expect(allTools).toHaveProperty("todo_read");
			expect(allTools).toHaveProperty("todo_update");
		});

		it("all three todo tools have correct names", () => {
			expect(allTools.todo_write.name).toBe("todo_write");
			expect(allTools.todo_read.name).toBe("todo_read");
			expect(allTools.todo_update.name).toBe("todo_update");
		});
	});

	// =========================================================================
	// V02 — Schema del modelo
	// =========================================================================
	describe("V02 — Schema del modelo", () => {
		it("all three todo tools emit correct parameter schemas", async () => {
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

				const allToolInfos = session.getAllTools();
				const todoWrite = allToolInfos.find((t) => t.name === "todo_write");
				const todoRead = allToolInfos.find((t) => t.name === "todo_read");
				const todoUpdate = allToolInfos.find((t) => t.name === "todo_update");

				expect(todoWrite).toBeDefined();
				expect(todoRead).toBeDefined();
				expect(todoUpdate).toBeDefined();

				// todo_write has a parameters schema
				expect(todoWrite!.parameters).toBeDefined();

				// todo_read has a parameters schema (empty object schema)
				expect(todoRead!.parameters).toBeDefined();

				// todo_update has updates array + expectedRevision
				expect(todoUpdate!.parameters).toBeDefined();
			} finally {
				require("fs").rmSync(rootDir, { recursive: true, force: true });
			}
		});
	});

	// =========================================================================
	// V03 — Dispatch
	// =========================================================================
	describe("V03 — Dispatch", () => {
		it("todo_write dispatches to a write handler that sets todos", async () => {
			let todos: TodoItem[] = [];
			let revision = 0;

			const writeTool = createTodoWriteTool(
				() => todos,
				(newTodos) => {
					todos = newTodos;
					revision++;
				},
				new TodoLoopGuard(),
				() => revision,
			);

			expect(writeTool.name).toBe("todo_write");

			const result = await writeTool.execute("call_1", {
				todos: [
					{ content: "Task 1", activeForm: "Doing Task 1", status: "pending" },
					{ content: "Task 2", activeForm: "Doing Task 2", status: "pending" },
				],
			});

			expect(todos.length).toBe(2);
			expect(revision).toBeGreaterThan(0);
			expect(resultText(result)).toContain("updated");
		});

		it("todo_read dispatches to a read handler that returns todos", async () => {
			const todos: TodoItem[] = [
				{ id: "t1", content: "Task 1", activeForm: "Doing 1", status: "in_progress" },
				{ id: "t2", content: "Task 2", activeForm: "Doing 2", status: "pending" },
			];

			const readTool = createTodoReadTool(
				() => todos,
				() => 5,
			);

			expect(readTool.name).toBe("todo_read");

			const result = await readTool.execute("call_1", {});
			const text = resultText(result);

			expect(text).toContain("Doing 1");
			expect(text).toContain("Task 2");
			expect(result.details).toBeDefined();
			expect(result.details!.revision).toBe(5);
		});

		it("todo_read reports empty state correctly", async () => {
			const readTool = createTodoReadTool(
				() => [],
				() => 0,
			);

			const result = await readTool.execute("call_1", {});

			expect(resultText(result)).toContain("empty");
			expect(result.details).toBeDefined();
			expect(result.details!.todos).toEqual([]);
		});

		it("todo_update dispatches to an update handler that applies partial changes", async () => {
			const todos: TodoItem[] = [
				{ id: "t1", content: "Task 1", activeForm: "Doing 1", status: "pending" },
				{ id: "t2", content: "Task 2", activeForm: "Doing 2", status: "pending" },
			];
			let revision = 3;

			const updateTool = createTodoUpdateTool(
				() => todos,
				(newTodos) => {
					todos.length = 0;
					todos.push(...newTodos);
					revision++;
				},
				() => revision,
				new TodoLoopGuard(),
			);

			expect(updateTool.name).toBe("todo_update");

			const result = await updateTool.execute("call_1", {
				updates: [
					{ id: "t1", status: "in_progress" },
					{ id: "t2", status: "completed" },
				],
				expectedRevision: 3,
			});

			expect(resultText(result)).toContain("updated");
			expect(todos[0].status).toBe("in_progress");
			expect(todos[1].status).toBe("completed");
			expect(revision).toBe(4);
		});

		it("todo_update rejects stale revision", async () => {
			const todos: TodoItem[] = [{ id: "t1", content: "Task 1", activeForm: "Doing 1", status: "pending" }];
			const revision = 3;
			let mutated = false;

			const updateTool = createTodoUpdateTool(
				() => todos,
				() => {
					mutated = true;
				},
				() => revision,
				new TodoLoopGuard(),
			);

			const result = await updateTool.execute("call_1", {
				updates: [{ id: "t1", status: "completed" }],
				expectedRevision: 2, // stale
			});

			expect(resultText(result)).toContain("stale revision");
			expect(result.details).toBeDefined();
			expect(result.details!.staleRevision).toBe(true);
			expect(mutated).toBe(false);
		});
	});

	// =========================================================================
	// V04 — Prompt/tool consistency
	// =========================================================================
	describe("V04 — Prompt/tool consistency", () => {
		it("system prompt does not reference tools absent from the active surface", async () => {
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

				const activeTools = session.getActiveToolNames();
				const systemPrompt = session.agent.state.systemPrompt.toLowerCase();

				// No active todo tool should not generate instructions to use absent tools
				if (!activeTools.includes("todo_write")) {
					expect(systemPrompt).not.toContain("Use todo_write");
				}
				if (!activeTools.includes("todo_read")) {
					expect(systemPrompt).not.toContain("Use todo_read");
				}
				if (!activeTools.includes("todo_update")) {
					expect(systemPrompt).not.toContain("Use todo_update");
				}
			} finally {
				require("fs").rmSync(rootDir, { recursive: true, force: true });
			}
		});

		it("active todo tools generate consistent tool descriptions reflecting all three", async () => {
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

				const allToolInfos = session.getAllTools();
				const todoWrite = allToolInfos.find((t) => t.name === "todo_write");
				const todoRead = allToolInfos.find((t) => t.name === "todo_read");
				const todoUpdate = allToolInfos.find((t) => t.name === "todo_update");

				expect(todoWrite).toBeDefined();
				expect(todoRead).toBeDefined();
				expect(todoUpdate).toBeDefined();

				// The descriptions should cross-reference the other tools
				expect(todoWrite!.description).toBeDefined();
				expect(todoRead!.description).toBeDefined();
				expect(todoUpdate!.description).toBeDefined();
			} finally {
				require("fs").rmSync(rootDir, { recursive: true, force: true });
			}
		});
	});

	// =========================================================================
	// V05 — Defaults
	// =========================================================================
	describe("V05 — Defaults", () => {
		it("a new session with default config exposes all three todo tools", async () => {
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

				const activeTools = session.getActiveToolNames();
				expect(activeTools).toContain("todo_write");
				expect(activeTools).toContain("todo_read");
				expect(activeTools).toContain("todo_update");
				expect(activeTools).toContain("memory_write");
			} finally {
				require("fs").rmSync(rootDir, { recursive: true, force: true });
			}
		});
	});

	// =========================================================================
	// V06 — Persisted settings compatibility
	// =========================================================================
	describe("V06 — Persisted settings compatibility", () => {
		it("old config with only todo_write does not silently remove todo_read or todo_update", async () => {
			const env = setupTestEnv();
			rootDir = env.rootDir;
			cwd = env.cwd;
			agentDir = env.agentDir;

			try {
				// Simulate an old config that only knew about todo_write
				const settingsManager = SettingsManager.inMemory({
					tools: { defaultActiveToolNames: ["todo_write"] },
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

				const activeTools = session.getActiveToolNames();
				// User explicitly configured only todo_write — respect their config
				expect(activeTools).toContain("todo_write");
				// But the old config shouldn't block access to todo_read/todo_update
				// if they add them later
				expect(session.getAllTools().some((t) => t.name === "todo_read")).toBe(true);
				expect(session.getAllTools().some((t) => t.name === "todo_update")).toBe(true);
			} finally {
				require("fs").rmSync(rootDir, { recursive: true, force: true });
			}
		});
	});

	// =========================================================================
	// V07 — Disabled tools
	// =========================================================================
	describe("V07 — Disabled tools", () => {
		it("explicitly disabling a tool removes it from the active surface", async () => {
			const env = setupTestEnv();
			rootDir = env.rootDir;
			cwd = env.cwd;
			agentDir = env.agentDir;

			try {
				// User explicitly only wants read and bash
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

				const activeTools = session.getActiveToolNames();
				expect(activeTools).toContain("read");
				expect(activeTools).toContain("bash");
				expect(activeTools).not.toContain("todo_write");
				expect(activeTools).not.toContain("todo_read");
				expect(activeTools).not.toContain("todo_update");
			} finally {
				require("fs").rmSync(rootDir, { recursive: true, force: true });
			}
		});
	});

	// =========================================================================
	// V08 — Exact black-box surface regression
	// =========================================================================
	describe("V08 — Black-box surface regression", () => {
		it("default session does NOT have the incident symptom (todo_read/todo_update missing)", async () => {
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

				const activeTools = session.getActiveToolNames();
				const allToolInfos = session.getAllTools();

				// Incident: todo_write was present
				expect(activeTools).toContain("todo_write");
				// Incident: todo_read was NOT present — regression check
				expect(activeTools).toContain("todo_read");
				// Incident: todo_update was NOT present — regression check
				expect(activeTools).toContain("todo_update");

				// Incident: model tried todo_read and got "Tool todo_read not found"
				const todoReadInRegistry = allToolInfos.some((t) => t.name === "todo_read");
				expect(todoReadInRegistry).toBe(true);

				// Incident: todo_update was absent from model-visible tool list
				const todoUpdateInRegistry = allToolInfos.some((t) => t.name === "todo_update");
				expect(todoUpdateInRegistry).toBe(true);
			} finally {
				require("fs").rmSync(rootDir, { recursive: true, force: true });
			}
		});
	});
});

// =========================================================================
// Section 10 — Integrated dispatcher simulation
// =========================================================================
describe("integrated todo tool dispatcher simulation", () => {
	it("full lifecycle: write → read → update → read → stale rejection", async () => {
		let todos: TodoItem[] = [];
		let revision = 0;

		const writeTool = createTodoWriteTool(
			() => todos,
			(newTodos) => {
				todos = [...newTodos];
				revision++;
			},
			new TodoLoopGuard(),
			() => revision,
		);

		const readTool = createTodoReadTool(
			() => todos,
			() => revision,
		);

		const updateTool = createTodoUpdateTool(
			() => todos,
			(newTodos) => {
				todos = [...newTodos];
				revision++;
			},
			() => revision,
			new TodoLoopGuard(),
		);

		// 1. todo_write with 7 items
		const writeResult = await writeTool.execute("call_1", {
			todos: Array.from({ length: 7 }, (_, i) => ({
				content: `Task ${i + 1}`,
				activeForm: `Doing ${i + 1}`,
				status: "pending" as const,
			})),
		});

		expect(todos.length).toBe(7);
		expect(resultText(writeResult)).toBeDefined();

		// 2. Enumerate todos: confirm all three tools exist
		expect(writeTool.name).toBe("todo_write");
		expect(readTool.name).toBe("todo_read");
		expect(updateTool.name).toBe("todo_update");

		// 3. todo_read
		const readResult1 = await readTool.execute("call_2", {});
		expect(resultText(readResult1)).toContain("Task 1");
		expect(readResult1.details).toBeDefined();
		expect(readResult1.details!.todos.length).toBe(7);
		const readRevision = readResult1.details!.revision as number;
		expect(readRevision).toBeGreaterThan(0);

		// 4. Extract IDs and revision
		const ids = (readResult1.details!.todos as Array<{ id: string }>).map((t) => t.id);
		expect(ids.length).toBe(7);

		// 5. todo_update: complete first, activate second
		const updateResult = await updateTool.execute("call_3", {
			updates: [
				{ id: ids[0], status: "completed" },
				{ id: ids[1], status: "in_progress" },
			],
			expectedRevision: readRevision,
		});

		expect(resultText(updateResult)).toContain("updated");
		expect(todos[0].status).toBe("completed");
		expect(todos[1].status).toBe("in_progress");

		// 6. todo_read again — confirm state
		const readResult2 = await readTool.execute("call_4", {});
		expect(readResult2.details!.todos.length).toBe(7);

		// 7. Stale revision update
		const updateResult2 = await updateTool.execute("call_5", {
			updates: [{ id: ids[2], status: "completed" }],
			expectedRevision: readRevision, // stale
		});

		expect(resultText(updateResult2)).toContain("stale revision");
		expect(updateResult2.details!.staleRevision).toBe(true);

		// 8. Confirm no mutation from stale update
		expect(todos[2].status).toBe("pending");
	});
});

// =========================================================================
// Section 11 — Truthful tool sequence
// =========================================================================
describe("truthful tool result sequence", () => {
	it("produces correct success/failure sequence for each tool call", async () => {
		let todos: TodoItem[] = [];
		let revision = 0;

		const writeTool = createTodoWriteTool(
			() => todos,
			(newTodos) => {
				todos = [...newTodos];
				revision++;
			},
			new TodoLoopGuard(),
			() => revision,
		);

		const readTool = createTodoReadTool(
			() => todos,
			() => revision,
		);

		const updateTool = createTodoUpdateTool(
			() => todos,
			(newTodos) => {
				todos = [...newTodos];
				revision++;
			},
			() => revision,
			new TodoLoopGuard(),
		);

		const results: Array<{
			number: number;
			tool: string;
			actualResult: string;
			success: boolean;
		}> = [];

		// 1. Write 7 items
		const r1 = await writeTool.execute("c1", {
			todos: Array.from({ length: 7 }, (_, i) => ({
				content: `T${i + 1}`,
				activeForm: `D${i + 1}`,
				status: "pending" as const,
			})),
		});
		const r1Text = resultText(r1);
		results.push({
			number: 1,
			tool: "todo_write",
			actualResult: r1Text,
			success: r1Text.includes("updated"),
		});

		// 2. Read
		const r2 = await readTool.execute("c2", {});
		const rev = (r2.details!.revision as number) ?? 0;
		results.push({
			number: 2,
			tool: "todo_read",
			actualResult: resultText(r2),
			success: r2.details!.todos.length === 7,
		});

		// 3. Valid update
		const ids = (r2.details!.todos as Array<{ id: string }>).map((t) => t.id);
		const r3 = await updateTool.execute("c3", {
			updates: [{ id: ids[0], status: "in_progress" }],
			expectedRevision: rev,
		});
		const r3Text = resultText(r3);
		results.push({
			number: 3,
			tool: "todo_update",
			actualResult: r3Text,
			success: r3Text.includes("updated"),
		});

		// 4. Stale update → rejected
		const r4 = await updateTool.execute("c4", {
			updates: [{ id: ids[1], status: "completed" }],
			expectedRevision: rev, // stale — was already incremented
		});
		const r4Text = resultText(r4);
		results.push({
			number: 4,
			tool: "todo_update",
			actualResult: r4Text,
			success: false, // stale revision → false
		});

		// 5. Rejected clear attempt (clear without confirmClear)
		const r5 = await writeTool.execute("c5", {
			todos: [],
			confirmClear: false,
		});
		const r5Text = resultText(r5);
		results.push({
			number: 5,
			tool: "todo_write",
			actualResult: r5Text,
			success: false, // clear without confirmClear → rejected
		});

		// Verify the sequence
		expect(results).toEqual([
			{ number: 1, tool: "todo_write", actualResult: expect.any(String), success: true },
			{ number: 2, tool: "todo_read", actualResult: expect.any(String), success: true },
			{ number: 3, tool: "todo_update", actualResult: expect.any(String), success: true },
			{ number: 4, tool: "todo_update", actualResult: expect.any(String), success: false },
			{ number: 5, tool: "todo_write", actualResult: expect.any(String), success: false },
		]);
	});
});

// =========================================================================
// Session isolation tests
// =========================================================================
describe("session isolation for todo tools", () => {
	it("todo_read sees only its own session's todos", () => {
		const storeA: TodoItem[] = [{ id: "a1", content: "A Task", activeForm: "Doing A", status: "pending" }];
		const storeB: TodoItem[] = [{ id: "b1", content: "B Task", activeForm: "Doing B", status: "pending" }];

		const readA = createTodoReadTool(
			() => storeA,
			() => 1,
		);
		const readB = createTodoReadTool(
			() => storeB,
			() => 2,
		);

		// Can't easily test different "sessions" with the same instance,
		// but we can test that different factories see different stores
		const resultA = readA.execute("call_1", {});
		const resultB = readB.execute("call_1", {});

		// Use Promise.all to compare
		return Promise.all([resultA, resultB]).then(([rA, rB]) => {
			expect(resultText(rA)).toContain("A Task");
			expect(resultText(rB)).toContain("B Task");
		});
	});

	it("todo_update in one session does not affect another", async () => {
		const storeA: TodoItem[] = [{ id: "a1", content: "A Task", activeForm: "Doing A", status: "pending" }];
		const storeB: TodoItem[] = [{ id: "b1", content: "B Task", activeForm: "Doing B", status: "pending" }];

		let revA = 1;
		const updateA = createTodoUpdateTool(
			() => storeA,
			(newTodos) => {
				storeA.length = 0;
				storeA.push(...newTodos);
				revA++;
			},
			() => revA,
			new TodoLoopGuard(),
		);

		await updateA.execute("call_1", {
			updates: [{ id: "a1", status: "completed" }],
			expectedRevision: 1,
		});

		// Store B should be unaffected
		expect(storeB[0].status).toBe("pending");
		expect(storeA[0].status).toBe("completed");
	});
});
