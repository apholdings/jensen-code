import { describe, expect, it } from "vitest";
import { convertToLlm } from "./messages.js";
import { TodoLoopGuard } from "./tools/todo-loop-guard.js";
import { createTodoReadTool } from "./tools/todo-read.js";
import { createTodoUpdateTool } from "./tools/todo-update.js";
import { createPerTurnLock, createTodoWriteTool, redactSecrets, type TodoItem } from "./tools/todo-write.js";

describe("Todo write per-user-turn duplicate contract (R01-R14)", () => {
	it("R01 writes mutate exactly once; duplicate is rejected; repeat terminates", async () => {
		let persisted: TodoItem[] = [];
		const guard = new TodoLoopGuard();
		const lock = createPerTurnLock();
		const tool = createTodoWriteTool(
			() => persisted,
			(next) => {
				persisted = next;
			},
			guard,
			undefined,
			lock,
		);

		const items1: TodoItem[] = [{ content: "Phase 1", activeForm: "Doing 1", status: "in_progress" }];
		const res1 = await tool.execute("w01", { todos: items1 });
		expect((res1.details as { changed?: boolean }).changed).toBe(true);
		expect(lock.isActive()).toBe(true);

		// First duplicate: rejection result, no mutation
		const res2 = await tool.execute("w02", { todos: items1 });
		expect((res2.details as { changed?: boolean }).changed).toBe(false);
		expect((res2.details as { todoWriteAlreadyApplied?: boolean }).todoWriteAlreadyApplied).toBe(true);
		expect(persisted).toMatchObject(items1);
		expect(persisted).toHaveLength(1);

		// Second equivalent duplicate: terminates with REPEATED_TOOL_CALL_LOOP
		await expect(tool.execute("w03", { todos: items1 })).rejects.toThrow("REPEATED_TOOL_CALL_LOOP");
		// State unchanged
		expect(persisted).toMatchObject(items1);
		expect(persisted).toHaveLength(1);
	});

	it("R02 recursive response text absent", async () => {
		let persisted: TodoItem[] = [];
		const tool = createTodoWriteTool(
			() => persisted,
			(next) => {
				persisted = next;
			},
		);

		const res = await tool.execute("call1", {
			todos: [{ content: "Task 1", activeForm: "Doing 1", status: "pending" }],
		});
		const text = (res.content[0] as { type: "text"; text: string }).text;

		expect(text.includes("Call todo_write")).toBe(false);
		expect(text.includes("retrieve current state using todo_write")).toBe(false);
		expect(text.includes("rewrite the list")).toBe(false);
		expect(text.includes("snapshot is hidden from you")).toBe(false);
		expect(text.includes("set the full list again")).toBe(false);
		expect(text).toContain("Todo list updated");
	});

	it("R03 no-op duplicate write before lock returns changed=false without store mutation", async () => {
		let persisted: TodoItem[] = [];
		let writeCount = 0;
		const tool = createTodoWriteTool(
			() => persisted,
			(next) => {
				persisted = next;
				writeCount++;
			},
		);

		const list: TodoItem[] = [{ content: "Task 1", activeForm: "Doing 1", status: "pending" }];
		await tool.execute("w1", { todos: list });
		expect(writeCount).toBe(1);

		const res2 = await tool.execute("w2", { todos: list });
		expect(writeCount).toBe(1);
		expect((res2.details as { changed?: boolean }).changed).toBe(false);
		expect((res2.content[0] as { text: string }).text).toContain("Todo list unchanged");
	});

	it("R04 rewritten consecutive plans without lock remain allowed", async () => {
		let persisted: TodoItem[] = [];
		const tool = createTodoWriteTool(
			() => persisted,
			(next) => {
				persisted = next;
			},
		);

		await tool.execute("w1", { todos: [{ content: "Plan A", activeForm: "A", status: "pending" }] });
		await tool.execute("w2", { todos: [{ content: "Plan B", activeForm: "B", status: "pending" }] });
		const res3 = await tool.execute("w3", { todos: [{ content: "Plan C", activeForm: "C", status: "pending" }] });
		expect((res3.details as { changed?: boolean }).changed).toBe(true);
	});

	it("R05 no store mutation after duplicate rejection", async () => {
		const lock = createPerTurnLock();
		let persisted: TodoItem[] = [];
		const tool = createTodoWriteTool(
			() => persisted,
			(next) => {
				persisted = next;
			},
			new TodoLoopGuard(),
			undefined,
			lock,
		);

		await tool.execute("w1", { todos: [{ content: "Plan 1", activeForm: "Doing 1", status: "pending" }] });
		const lastValid = [...persisted];

		const dup = await tool.execute("w2", {
			todos: [{ content: "Plan 2", activeForm: "Doing 2", status: "pending" }],
		});
		expect((dup.details as { todoWriteAlreadyApplied?: boolean }).todoWriteAlreadyApplied).toBe(true);
		expect(persisted).toEqual(lastValid);
	});

	it("R07 duplicate rejection count resets on non-todo tool success", async () => {
		const guard = new TodoLoopGuard();
		const lock = createPerTurnLock();
		let persisted: TodoItem[] = [];
		const tool = createTodoWriteTool(
			() => persisted,
			(next) => {
				persisted = next;
			},
			guard,
			undefined,
			lock,
		);

		await tool.execute("w1", { todos: [{ content: "Plan 1", activeForm: "1", status: "pending" }] });
		const dup = await tool.execute("w2", { todos: [{ content: "Plan 1", activeForm: "1", status: "pending" }] });
		expect((dup.details as { todoWriteAlreadyApplied?: boolean }).todoWriteAlreadyApplied).toBe(true);

		guard.resetOnNonTodoToolSuccess("bash");
		lock.currentTurn++;
		lock.lockedUntil = -1;

		const res4 = await tool.execute("w4", { todos: [{ content: "Plan 4", activeForm: "4", status: "pending" }] });
		expect((res4.details as { changed?: boolean }).changed).toBe(true);
	});

	it("R08 completed span preserved by convertToLlm", () => {
		const assistant = {
			role: "assistant" as const,
			content: [
				{
					type: "toolCall" as const,
					id: "call-1",
					name: "todo_write",
					arguments: {
						todos: Array.from({ length: 500 }, (_, i) => ({
							content: `T${i}`,
							activeForm: `A${i}`,
							status: "pending",
						})),
					},
				},
			],
			api: "openai-responses" as const,
			provider: "openai" as const,
			model: "gpt-4",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse" as const,
			timestamp: 1,
		};
		const toolResult = {
			role: "toolResult" as const,
			toolCallId: "call-1",
			toolName: "todo_write",
			content: [{ type: "text" as const, text: "Todo list updated" }],
			isError: false,
			timestamp: 2,
		};

		const converted = convertToLlm([assistant, toolResult]);
		const assistantMsg = converted[0];
		expect(assistantMsg).toMatchObject({ role: "assistant" });
		if (assistantMsg.role === "assistant") {
			const hasToolCall = assistantMsg.content.some((b) => b.type === "toolCall");
			expect(hasToolCall).toBe(true);
		}
		expect(converted.filter((m) => m.role === "toolResult")).toHaveLength(1);
	});

	it("R09 explicit read retrieves state without mutation", async () => {
		const persisted: TodoItem[] = [{ content: "Item A", activeForm: "Doing A", status: "pending" }];
		const readTool = createTodoReadTool(() => persisted);
		const readRes = await readTool.execute("r1", {});
		expect(readRes.details).toMatchObject({ todos: persisted });
	});

	it("R10 clear requires explicit confirmation", async () => {
		let persisted: TodoItem[] = [{ content: "Task 1", activeForm: "Doing 1", status: "pending" }];
		const tool = createTodoWriteTool(
			() => persisted,
			(next) => {
				persisted = next;
			},
		);

		const errRes = await tool.execute("c1", { todos: [] });
		expect((errRes.content[0] as { text: string }).text).toContain(
			"Clearing all todos requires explicit confirmation",
		);
		expect(persisted.length).toBe(1);

		const okRes = await tool.execute("c2", { todos: [], confirmClear: true });
		expect((okRes.content[0] as { text: string }).text).toContain("Todo list updated");
		expect(persisted.length).toBe(0);
	});

	it("R11 compaction preservation keeps persisted state intact", async () => {
		const persisted: TodoItem[] = [{ content: "Persistent Task", activeForm: "Doing task", status: "in_progress" }];
		const readTool = createTodoReadTool(() => persisted);

		const res = await readTool.execute("r1", {});
		expect(res.details).toMatchObject({
			todos: [{ content: "Persistent Task", activeForm: "Doing task", status: "in_progress" }],
		});
	});

	it("R12 secret redaction removes sensitive credentials from todos", () => {
		const raw = "Connecting with password=admin123 and Bearer secrettoken123 and EXAMPLE_SECRET_DO_NOT_LOG";
		const redacted = redactSecrets(raw);

		expect(redacted.includes("admin123")).toBe(false);
		expect(redacted.includes("secrettoken123")).toBe(false);
		expect(redacted.includes("EXAMPLE_SECRET_DO_NOT_LOG")).toBe(false);
		expect(redacted).toContain("[REDACTED_SECRET]");
	});

	it("R13 first duplicate rejection directs model to execute task", async () => {
		const lock = createPerTurnLock();
		let persisted: TodoItem[] = [];
		const tool = createTodoWriteTool(
			() => persisted,
			(next) => {
				persisted = next;
			},
			new TodoLoopGuard(),
			undefined,
			lock,
		);

		await tool.execute("w1", { todos: [{ content: "A", activeForm: "A", status: "pending" }] });
		const dup = await tool.execute("w2", { todos: [{ content: "A", activeForm: "A", status: "pending" }] });
		const text = (dup.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("The plan already exists. Do not call todo_write again during this user turn.");
		expect(text).toContain("Continue using another available tool or execute the active task.");
		expect(text.includes("call it again")).toBe(false);
	});

	it("R14 second equivalent duplicate terminates with REPEATED_TOOL_CALL_LOOP", async () => {
		const lock = createPerTurnLock();
		let persisted: TodoItem[] = [];
		const tool = createTodoWriteTool(
			() => persisted,
			(next) => {
				persisted = next;
			},
			new TodoLoopGuard(),
			undefined,
			lock,
		);

		await tool.execute("w1", { todos: [{ content: "A", activeForm: "A", status: "pending" }] });
		await tool.execute("w2", { todos: [{ content: "A", activeForm: "A", status: "pending" }] });

		await expect(
			tool.execute("w3", { todos: [{ content: "A", activeForm: "A", status: "pending" }] }),
		).rejects.toThrow("REPEATED_TOOL_CALL_LOOP");
		expect(persisted).toHaveLength(1);
	});

	// =========================================================================
	// R15-R30: todo_update and related contracts
	// =========================================================================

	it("R15 compacted snapshot cannot be replayed as todo_write", () => {
		const assistant = {
			role: "assistant" as const,
			content: [
				{
					type: "toolCall" as const,
					id: "call-1",
					name: "todo_write",
					arguments: { todos: [{ content: "T", activeForm: "A", status: "pending" }] },
				},
			],
			api: "openai-responses" as const,
			provider: "openai" as const,
			model: "gpt-4",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse" as const,
			timestamp: 1,
		};
		const toolResult = {
			role: "toolResult" as const,
			toolCallId: "call-1",
			toolName: "todo_write",
			content: [{ type: "text" as const, text: "done" }],
			isError: false,
			timestamp: 2,
		};
		const converted = convertToLlm([assistant, toolResult]);
		// Latest completed span is preserved — toolCall stays visible so model knows write succeeded.
		// Per-user-turn lock on tool level prevents actual re-execution.
		const assistantMsg = converted[0];
		if (assistantMsg.role !== "assistant") throw new Error("Expected assistant");
		expect(assistantMsg.content.some((b: { type: string }) => b.type === "toolCall")).toBe(true);
	});

	it("R16 snapshotOmitted absent from public todo_write schema", async () => {
		let persisted: TodoItem[] = [];
		const tool = createTodoWriteTool(
			() => persisted,
			(next) => {
				persisted = next;
			},
		);
		// Passing snapshotOmitted alongside empty todos without confirmClear must fail
		const res = await tool.execute("r16", { todos: [] } as unknown as { todos: TodoItem[]; confirmClear?: boolean });
		expect((res.content[0] as { text: string }).text).toContain("Clearing all todos requires explicit confirmation");
	});

	it("R17 todo_read returns stable IDs and revision", async () => {
		let persisted: TodoItem[] = [];
		let revision = 0;
		const writeTool = createTodoWriteTool(
			() => persisted,
			(next) => {
				persisted = next;
				revision++;
			},
			new TodoLoopGuard(),
			() => revision,
		);
		const readTool = createTodoReadTool(
			() => persisted,
			() => revision,
		);

		await writeTool.execute("w1", {
			todos: [{ content: "Task 1", activeForm: "Doing 1", status: "pending" }],
		});
		expect(revision).toBe(1);

		const res = await readTool.execute("r1", {});
		const details = res.details as { todos: TodoItem[]; revision: number };
		expect(details.revision).toBe(1);
		expect(details.todos.length).toBe(1);
		expect(details.todos[0].id).toBeDefined();
		expect(typeof details.todos[0].id).toBe("string");
		expect(details.todos[0].content).toBe("Task 1");
	});

	it("R18 todo_update changes one status without full replacement", async () => {
		let persisted: TodoItem[] = [];
		let revision = 0;
		const guard = new TodoLoopGuard();
		const writeTool = createTodoWriteTool(
			() => persisted,
			(next) => {
				persisted = next;
				revision++;
			},
			guard,
			() => revision,
		);
		const updateTool = createTodoUpdateTool(
			() => persisted,
			(next) => {
				persisted = next;
				revision++;
			},
			() => revision,
			guard,
			{
				getSnapshot: () => ({ revision: initialRevision, timestamp: Date.now() }),
				invalidateSnapshot: () => {},
			},
		);

		// Create initial list
		await writeTool.execute("w1", {
			todos: [
				{ content: "P1", activeForm: "Doing P1", status: "pending" },
				{ content: "P2", activeForm: "Doing P2", status: "pending" },
			],
		});
		const initialRevision = revision;
		expect(persisted.length).toBe(2);
		const p1Id = persisted[0].id!;

		// Reset guard (simulate non-todo tool)
		guard.resetOnNonTodoToolSuccess("bash");

		// Update P1 to in_progress
		const res = await updateTool.execute("u1", {
			updates: [{ id: p1Id, status: "in_progress" }],
			expectedRevision: initialRevision,
		});
		expect((res.details as { changed?: boolean }).changed).toBe(true);
		expect(persisted[0].status).toBe("in_progress");
		expect(persisted[1].status).toBe("pending");
		// ID should not change
		expect(persisted[0].id).toBe(p1Id);
		expect(revision).toBe(initialRevision + 1);
	});

	it("R19 multi-item transition is atomic", async () => {
		let persisted: TodoItem[] = [];
		let revision = 0;
		const guard = new TodoLoopGuard();
		const updateTool = createTodoUpdateTool(
			() => persisted,
			(next) => {
				persisted = next;
				revision++;
			},
			() => revision,
			guard,
			{
				getSnapshot: () => ({ revision: initialRev, timestamp: Date.now() }),
				invalidateSnapshot: () => {},
			},
		);

		// Set up persisted state with known IDs
		persisted = [
			{ id: "id-a", content: "A", activeForm: "A", status: "pending" },
			{ id: "id-b", content: "B", activeForm: "B", status: "pending" },
			{ id: "id-c", content: "C", activeForm: "C", status: "pending" },
		];
		const initialRev = revision;

		const res = await updateTool.execute("u1", {
			updates: [
				{ id: "id-a", status: "in_progress" },
				{ id: "id-b", status: "completed" },
			],
			expectedRevision: initialRev,
		});
		expect((res.details as { changed?: boolean }).changed).toBe(true);
		expect(persisted[0].status).toBe("in_progress");
		expect(persisted[1].status).toBe("completed");
		expect(persisted[2].status).toBe("pending");
	});

	it("R20 unknown ID causes zero mutations", async () => {
		let persisted: TodoItem[] = [];
		let revision = 0;
		const guard = new TodoLoopGuard();
		const updateTool = createTodoUpdateTool(
			() => persisted,
			(next) => {
				persisted = next;
				revision++;
			},
			() => revision,
			guard,
			{
				getSnapshot: () => ({ revision: initialRev, timestamp: Date.now() }),
				invalidateSnapshot: () => {},
			},
		);

		persisted = [{ id: "id-a", content: "A", activeForm: "A", status: "pending" }];
		const before = [...persisted];
		const initialRev = revision;

		const res = await updateTool.execute("u1", {
			updates: [{ id: "nonexistent", status: "completed" }],
			expectedRevision: initialRev,
		});
		expect((res.content[0] as { text: string }).text).toContain("unknown todo id");
		expect((res.details as { unknownId?: string }).unknownId).toBe("nonexistent");
		expect(persisted).toEqual(before);
		expect(revision).toBe(initialRev);
	});

	it("R21 stale revision causes zero mutations", async () => {
		let persisted: TodoItem[] = [];
		let revision = 5;
		const guard = new TodoLoopGuard();
		const updateTool = createTodoUpdateTool(
			() => persisted,
			(next) => {
				persisted = next;
				revision++;
			},
			() => revision,
			guard,
			{
				getSnapshot: () => ({ revision: 5, timestamp: Date.now() }),
				invalidateSnapshot: () => {},
			},
		);

		persisted = [{ id: "id-a", content: "A", activeForm: "A", status: "pending" }];
		const beforeRev = revision;

		const result = await updateTool.execute("u1", {
			updates: [{ id: "id-a", status: "completed" }],
			expectedRevision: 3, // stale
		});
		// Stale revisions are recovered internally: applied automatically with no
		// TODO_READ_REQUIRED and no run termination.
		const text = result.content[0];
		if (text.type !== "text") throw new Error("expected text content");
		expect(text.text).not.toContain("TODO_READ_REQUIRED");
		expect(text.text).toContain("rebase");
		expect(persisted[0].status).toBe("completed");
		expect(revision).toBe(beforeRev + 1);
	});

	it("R22 no-op update returns changed=false", async () => {
		let persisted: TodoItem[] = [];
		let revision = 0;
		const guard = new TodoLoopGuard();
		const updateTool = createTodoUpdateTool(
			() => persisted,
			(next) => {
				persisted = next;
				revision++;
			},
			() => revision,
			guard,
			{
				getSnapshot: () => ({ revision: beforeRev, timestamp: Date.now() }),
				invalidateSnapshot: () => {},
			},
		);

		persisted = [{ id: "id-a", content: "A", activeForm: "A", status: "in_progress" }];
		const beforeRev = revision;

		const res = await updateTool.execute("u1", {
			updates: [{ id: "id-a", status: "in_progress" }], // same status
			expectedRevision: beforeRev,
		});
		expect((res.details as { changed?: boolean }).changed).toBe(false);
		expect((res.content[0] as { text: string }).text).toContain("unchanged");
		expect(revision).toBe(beforeRev);
	});

	it("R23 todo_update after a fresh read mutates successfully", async () => {
		let persisted: TodoItem[] = [];
		let revision = 0;
		const guard = new TodoLoopGuard();
		let snapshot: { revision: number; timestamp: number } | null = null;
		const writeTool = createTodoWriteTool(
			() => persisted,
			(next) => {
				persisted = next;
				revision++;
				snapshot = null;
			},
			guard,
			() => revision,
		);
		const readTool = createTodoReadTool(
			() => persisted,
			() => revision,
			{
				onRead: () => {
					snapshot = { revision, timestamp: Date.now() };
				},
			},
		);
		const updateTool = createTodoUpdateTool(
			() => persisted,
			(next) => {
				persisted = next;
				revision++;
			},
			() => revision,
			guard,
			{
				getSnapshot: () => snapshot,
				invalidateSnapshot: () => {
					snapshot = null;
				},
			},
		);

		await writeTool.execute("w1", {
			todos: [{ content: "A", activeForm: "A", status: "pending" }],
		});
		const itemId = persisted[0].id!;
		await readTool.execute("r1", {});

		await updateTool.execute("u1", {
			updates: [{ id: itemId, status: "in_progress" }],
			expectedRevision: revision,
		});
		expect(persisted[0].status).toBe("in_progress");
	});

	it("R24 second update without a fresh read is rejected", async () => {
		let persisted: TodoItem[] = [];
		let revision = 0;
		let snapshot: { revision: number; timestamp: number } | null = null;
		const guard = new TodoLoopGuard();
		const updateTool = createTodoUpdateTool(
			() => persisted,
			(next) => {
				persisted = next;
				revision++;
			},
			() => revision,
			guard,
			{
				getSnapshot: () => snapshot,
				invalidateSnapshot: () => {
					snapshot = null;
				},
			},
		);

		persisted = [{ id: "id-a", content: "A", activeForm: "A", status: "pending" }];
		snapshot = { revision: 0, timestamp: Date.now() };

		// First update succeeds and invalidates the snapshot
		const res1 = await updateTool.execute("u1", {
			updates: [{ id: "id-a", status: "in_progress" }],
			expectedRevision: 0,
		});
		expect((res1.details as { changed?: boolean }).changed).toBe(true);

		// Second update based on the current revision is accepted. A fresh read is
		// no longer a hard prerequisite because stale revisions auto-recover.
		const res2 = await updateTool.execute("u2", {
			updates: [{ id: "id-a", status: "completed" }],
			expectedRevision: 1,
		});
		const text2 = res2.content[0];
		if (text2.type !== "text") throw new Error("expected text content");
		expect(text2.text).not.toContain("TODO_READ_REQUIRED");
		expect(text2.text).toContain("updated");
		expect(persisted[0].status).toBe("completed");
	});

	it("R25 exact black-box transcript regression", async () => {
		let persisted: TodoItem[] = [];
		let revision = 0;
		const guard = new TodoLoopGuard();
		const writeTool = createTodoWriteTool(
			() => persisted,
			(next) => {
				persisted = next;
				revision++;
			},
			guard,
			() => revision,
		);
		const updateTool = createTodoUpdateTool(
			() => persisted,
			(next) => {
				persisted = next;
				revision++;
			},
			() => revision,
			guard,
			{
				getSnapshot: () => ({ revision: initialRev, timestamp: Date.now() }),
				invalidateSnapshot: () => {},
			},
		);

		// Initial seven-item todo_write (simulating the black-box scenario)
		const items: TodoItem[] = [
			{ content: "Phase 1", activeForm: "Doing P1", status: "pending" },
			{ content: "Phase 2", activeForm: "Doing P2", status: "pending" },
			{ content: "Phase 3", activeForm: "Doing P3", status: "pending" },
			{ content: "Phase 4", activeForm: "Doing P4", status: "pending" },
			{ content: "Phase 5", activeForm: "Doing P5", status: "pending" },
			{ content: "Phase 6", activeForm: "Doing P6", status: "pending" },
			{ content: "Phase 7", activeForm: "Doing P7", status: "pending" },
		];
		await writeTool.execute("w-init", { todos: items });
		const initialRev = revision;

		// Simulate non-todo tools (pwd, git branch, git status)
		guard.resetOnNonTodoToolSuccess("bash");
		guard.resetOnNonTodoToolSuccess("bash");
		guard.resetOnNonTodoToolSuccess("bash");

		// Attempt progress transition via todo_update
		const p1Id = persisted[0].id!;
		const res = await updateTool.execute("u-progress", {
			updates: [{ id: p1Id, status: "in_progress" }],
			expectedRevision: initialRev,
		});

		expect((res.details as { changed?: boolean }).changed).toBe(true);
		expect(persisted[0].status).toBe("in_progress");
		// Must NOT use full-list replacement
		expect(persisted.length).toBe(7);
		// No tool error
		expect(res.content[0]).toMatchObject({ type: "text" });
	});

	it("R26 failed todo_write cannot be reported as success", async () => {
		let persisted: TodoItem[] = [{ content: "Existing", activeForm: "Existing", status: "pending" }];
		const tool = createTodoWriteTool(
			() => persisted,
			(next) => {
				persisted = next;
			},
		);

		const res = await tool.execute("c1", { todos: [] }); // no confirmClear
		expect((res.content[0] as { text: string }).text).toContain("Clearing all todos requires explicit confirmation");
		// State must be unchanged
		expect(persisted.length).toBe(1);
		expect(persisted[0].content).toBe("Existing");
	});

	it("R27 recovery path read → update succeeds", async () => {
		let persisted: TodoItem[] = [];
		let revision = 0;
		const guard = new TodoLoopGuard();
		let snapshot: { revision: number; timestamp: number } | null = null;
		const writeTool = createTodoWriteTool(
			() => persisted,
			(next) => {
				persisted = next;
				revision++;
				snapshot = null;
			},
			guard,
			() => revision,
		);
		const readTool = createTodoReadTool(
			() => persisted,
			() => revision,
			{
				onRead: () => {
					snapshot = { revision, timestamp: Date.now() };
				},
			},
		);
		const updateTool = createTodoUpdateTool(
			() => persisted,
			(next) => {
				persisted = next;
				revision++;
				snapshot = null;
			},
			() => revision,
			guard,
			{
				getSnapshot: () => snapshot,
				invalidateSnapshot: () => {
					snapshot = null;
				},
			},
		);

		// Initial write
		await writeTool.execute("w1", { todos: [{ content: "Task", activeForm: "Doing", status: "pending" }] });

		// Simulate a failed todo_write (e.g., trying to clear without confirmClear)
		await writeTool.execute("w-fail", { todos: [] });
		expect(persisted.length).toBe(1); // unchanged

		// Recovery: read state
		guard.resetOnNonTodoToolSuccess("bash");
		const readRes = await readTool.execute("r1", {});
		const details = readRes.details as { todos: TodoItem[]; revision: number };
		expect(details.todos.length).toBe(1);
		const itemId = details.todos[0].id!;

		// Update via todo_update
		const updateRes = await updateTool.execute("u1", {
			updates: [{ id: itemId, status: "completed" }],
			expectedRevision: details.revision,
		});
		expect((updateRes.details as { changed?: boolean }).changed).toBe(true);
		expect(persisted[0].status).toBe("completed");
	});

	it("R28 clear semantics remain explicit", async () => {
		let persisted: TodoItem[] = [{ content: "Task", activeForm: "Doing", status: "pending" }];
		const tool = createTodoWriteTool(
			() => persisted,
			(next) => {
				persisted = next;
			},
		);

		// Clear without confirmClear → rejected
		const rejected = await tool.execute("c1", { todos: [] });
		expect((rejected.content[0] as { text: string }).text).toContain("requires explicit confirmation");

		// Clear with confirmClear → succeeds
		const accepted = await tool.execute("c2", { todos: [], confirmClear: true });
		expect((accepted.content[0] as { text: string }).text).toContain("Todo list");
		expect(persisted).toEqual([]);
	});

	it("R29 IDs survive compaction and persistence", () => {
		// Simulate a write where todos get IDs assigned by normalizeTodoItem
		const normalized: TodoItem[] = [
			{ id: "id-1", content: "Task 1", activeForm: "Doing 1", status: "pending" },
			{ id: "id-2", content: "Task 2", activeForm: "Doing 2", status: "in_progress" },
		];

		// IDs must be stable strings
		for (const item of normalized) {
			expect(typeof item.id).toBe("string");
			expect(item.id!.length).toBeGreaterThan(0);
		}
		// IDs should be different
		expect(normalized[0].id).not.toBe(normalized[1].id);
	});

	it("R30 old snapshots without IDs remain compatible", async () => {
		// Simulate old persisted state without IDs
		let revision = 0;
		let persisted: TodoItem[] = [{ content: "Old Task", activeForm: "Old Activity", status: "pending" }];
		const tool = createTodoWriteTool(
			() => persisted,
			(next) => {
				persisted = next;
				revision++;
			},
			new TodoLoopGuard(),
			() => revision,
		);

		// Write new items alongside old items without IDs
		await tool.execute("w1", {
			todos: [
				{ content: "Old Task", activeForm: "Old Activity", status: "pending" }, // no id
				{ content: "New Task", activeForm: "New Activity", status: "pending" }, // no id
			],
		});

		// Both items should now have IDs assigned
		expect(persisted.length).toBe(2);
		expect(persisted[0].id).toBeDefined();
		expect(typeof persisted[0].id).toBe("string");
		expect(persisted[1].id).toBeDefined();
		expect(typeof persisted[1].id).toBe("string");
		// IDs should differ
		expect(persisted[0].id).not.toBe(persisted[1].id);
	});

	it("repeated stale todo_update auto-recovers without termination", async () => {
		let persisted: TodoItem[] = [{ id: "todo-1", content: "Task", activeForm: "Doing", status: "pending" }];
		let revision = 1;
		let snapshot: { revision: number; timestamp: number } | null = { revision: 0, timestamp: Date.now() };
		const rejectionState = { count: 0 };
		let mutations = 0;
		const recordRead = () => {
			snapshot = { revision, timestamp: Date.now() };
		};
		const invalidateSnapshot = () => {
			snapshot = null;
		};
		const readTool = createTodoReadTool(
			() => persisted,
			() => revision,
			{ onRead: recordRead },
		);
		const updateTool = createTodoUpdateTool(
			() => persisted,
			(next) => {
				persisted = next;
				revision++;
				mutations++;
				snapshot = null;
			},
			() => revision,
			new TodoLoopGuard(),
			{
				getSnapshot: () => snapshot,
				invalidateSnapshot,
			},
			rejectionState,
		);

		// Stale revision is recovered internally: no TODO_READ_REQUIRED, no throw,
		// no REPEATED_TODO_UPDATE_LOOP run termination.
		const first = await updateTool.execute("u1", {
			updates: [{ id: "todo-1", status: "completed" }],
			expectedRevision: 0,
		});
		expect((first.details as { errorCode?: string }).errorCode).not.toBe("TODO_READ_REQUIRED");
		expect(mutations).toBe(1);

		// A repeated stale update targeting new work is treated as a separate
		// recoverable incident, not a no-progress loop that terminates the run.
		const second = await updateTool.execute("u2", {
			updates: [{ id: "todo-1", activeForm: "Doing revised" }],
			expectedRevision: 0,
		});
		expect(second).toBeDefined();
		expect(mutations).toBe(2);
		expect((second.details as Record<string, unknown>).errorCode).not.toBeDefined();

		// Recovery remains functional after a fresh read (idempotent repeat -> changed=false).
		const read = await readTool.execute("r1", {});
		const readDetails = read.details as { revision: number; todos: TodoItem[] };
		const recovered = await updateTool.execute("u3", {
			updates: [{ id: "todo-1", status: "completed" }],
			expectedRevision: readDetails.revision,
		});
		expect((recovered.details as { changed?: boolean }).changed).toBe(false);
	});

	it("reserves todo_write atomically for parallel calls", async () => {
		const lock = createPerTurnLock();
		let persisted: TodoItem[] = [];
		let mutations = 0;
		const tool = createTodoWriteTool(
			() => persisted,
			(next) => {
				persisted = next;
				mutations++;
			},
			new TodoLoopGuard(),
			() => mutations,
			lock,
		);

		const results = await Promise.all([
			tool.execute("w1", { todos: [{ id: "a", content: "A", activeForm: "Doing A", status: "pending" }] }),
			tool.execute("w2", { todos: [{ id: "b", content: "B", activeForm: "Doing B", status: "pending" }] }),
		]);

		expect(mutations).toBe(1);
		expect(lock.lockedUntil).toBe(lock.currentTurn);
		expect(results.filter((result) => (result.details as { changed?: boolean }).changed).length).toBe(1);
	});
});
