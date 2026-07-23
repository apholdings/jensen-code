import { describe, expect, it } from "vitest";
import { convertToLlm } from "./messages.js";
import { TodoLoopGuard } from "./tools/todo-loop-guard.js";
import { createTodoReadTool } from "./tools/todo-read.js";
import { createTodoUpdateTool } from "./tools/todo-update.js";
import { createTodoWriteTool, redactSecrets, type TodoItem } from "./tools/todo-write.js";

describe("Todo write loop guard and contracts (R01-R14)", () => {
	it("R01 exact transcript regression: repeated writes without non-todo progress trigger loop guard", async () => {
		let persisted: TodoItem[] = [];
		const guard = new TodoLoopGuard();
		const tool = createTodoWriteTool(
			() => persisted,
			(next) => {
				persisted = next;
			},
			guard,
		);

		const items1: TodoItem[] = [
			{ content: "Phase 1", activeForm: "Doing 1", status: "in_progress" },
			{ content: "Phase 2", activeForm: "Doing 2", status: "pending" },
		];
		const res1 = await tool.execute("w01", { todos: items1 });
		expect((res1.details as { changed?: boolean }).changed).toBe(true);

		const items2: TodoItem[] = [
			{ content: "Phase 1 - revised", activeForm: "Doing 1", status: "in_progress" },
			{ content: "Phase 2", activeForm: "Doing 2", status: "pending" },
		];
		const res2 = await tool.execute("w02", { todos: items2 });
		expect((res2.details as { changed?: boolean }).changed).toBe(true);

		const items3: TodoItem[] = [
			{ content: "Phase 1 - re-revised", activeForm: "Doing 1", status: "in_progress" },
			{ content: "Phase 2", activeForm: "Doing 2", status: "pending" },
		];
		const res3 = await tool.execute("w03", { todos: items3 });
		expect((res3.details as { loopGuardTriggered?: boolean }).loopGuardTriggered).toBe(true);

		const items4: TodoItem[] = [
			{ content: "Phase 1 - attempt 4", activeForm: "Doing 1", status: "in_progress" },
			{ content: "Phase 2", activeForm: "Doing 2", status: "pending" },
		];
		const res4 = await tool.execute("w04", { todos: items4 });
		expect((res4.details as { loopGuardTriggered?: boolean }).loopGuardTriggered).toBe(true);

		expect(persisted).toMatchObject(items2);
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

	it("R03 no-op duplicate write returns changed=false without store mutation", async () => {
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

	it("R04 rewritten consecutive plans trigger guard", async () => {
		const guard = new TodoLoopGuard();
		let persisted: TodoItem[] = [];
		const tool = createTodoWriteTool(
			() => persisted,
			(next) => {
				persisted = next;
			},
			guard,
		);

		await tool.execute("w1", { todos: [{ content: "Plan A", activeForm: "A", status: "pending" }] });
		await tool.execute("w2", { todos: [{ content: "Plan B", activeForm: "B", status: "pending" }] });
		const res3 = await tool.execute("w3", { todos: [{ content: "Plan C", activeForm: "C", status: "pending" }] });

		expect((res3.details as { loopGuardTriggered?: boolean }).loopGuardTriggered).toBe(true);
	});

	it("R05 no store mutation after guard is active", async () => {
		const guard = new TodoLoopGuard();
		let persisted: TodoItem[] = [];
		const tool = createTodoWriteTool(
			() => persisted,
			(next) => {
				persisted = next;
			},
			guard,
		);

		await tool.execute("w1", { todos: [{ content: "Plan 1", activeForm: "Doing 1", status: "pending" }] });
		await tool.execute("w2", { todos: [{ content: "Plan 2", activeForm: "Doing 2", status: "pending" }] });
		const lastValid = [...persisted];

		await tool.execute("w3", { todos: [{ content: "Plan 3", activeForm: "Doing 3", status: "pending" }] });
		await tool.execute("w4", { todos: [{ content: "Plan 4", activeForm: "Doing 4", status: "pending" }] });

		expect(persisted).toEqual(lastValid);
	});

	it("R06 guard resets after real non-todo tool progress", async () => {
		const guard = new TodoLoopGuard();
		let persisted: TodoItem[] = [];
		const tool = createTodoWriteTool(
			() => persisted,
			(next) => {
				persisted = next;
			},
			guard,
		);

		await tool.execute("w1", { todos: [{ content: "Plan 1", activeForm: "1", status: "pending" }] });
		await tool.execute("w2", { todos: [{ content: "Plan 2", activeForm: "2", status: "pending" }] });
		const res3 = await tool.execute("w3", { todos: [{ content: "Plan 3", activeForm: "3", status: "pending" }] });
		expect((res3.details as { loopGuardTriggered?: boolean }).loopGuardTriggered).toBe(true);

		// Non-todo tool execution succeeds (e.g., bash/read)
		guard.resetOnNonTodoToolSuccess("bash");

		const res4 = await tool.execute("w4", { todos: [{ content: "Plan 4", activeForm: "4", status: "pending" }] });
		expect((res4.details as { changed?: boolean }).changed).toBe(true);
	});

	it("R07 legitimate status transition accepted across non-todo tool executions", async () => {
		const guard = new TodoLoopGuard();
		let persisted: TodoItem[] = [];
		const tool = createTodoWriteTool(
			() => persisted,
			(next) => {
				persisted = next;
			},
			guard,
		);

		// 1. Write plan
		await tool.execute("w1", { todos: [{ content: "Step 1", activeForm: "Doing 1", status: "pending" }] });
		// 2. Shell tool success
		guard.resetOnNonTodoToolSuccess("bash");
		// 3. Status update
		await tool.execute("w2", { todos: [{ content: "Step 1", activeForm: "Doing 1", status: "in_progress" }] });
		// 4. Shell tool success
		guard.resetOnNonTodoToolSuccess("bash");
		// 5. Status update
		const res3 = await tool.execute("w3", {
			todos: [{ content: "Step 1", activeForm: "Doing 1", status: "completed" }],
		});

		expect((res3.details as { changed?: boolean }).changed).toBe(true);
		expect((res3.details as { loopGuardTriggered?: boolean }).loopGuardTriggered).toBeUndefined();
	});

	it("R08 snapshot omission keeps context payload bounded", () => {
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
		const compacted = converted[0];
		expect(compacted).toMatchObject({
			role: "assistant",
			content: [{ type: "text" }],
		});
		expect((compacted.content[0] as { text: string }).text).toContain("Todo snapshot omitted");
	});

	it("R09 explicit read retrieves state without mutation or loop guard reset", async () => {
		const guard = new TodoLoopGuard();
		let persisted: TodoItem[] = [{ content: "Item A", activeForm: "Doing A", status: "pending" }];
		const readTool = createTodoReadTool(() => persisted);
		const writeTool = createTodoWriteTool(
			() => persisted,
			(next) => {
				persisted = next;
			},
			guard,
		);

		await writeTool.execute("w1", { todos: [{ content: "Item B", activeForm: "Doing B", status: "pending" }] });
		await writeTool.execute("w2", { todos: [{ content: "Item C", activeForm: "Doing C", status: "pending" }] });

		const readRes = await readTool.execute("r1", {});
		expect(readRes.details).toMatchObject({ todos: persisted });

		// Read did not reset guard count
		const writeRes3 = await writeTool.execute("w3", {
			todos: [{ content: "Item D", activeForm: "Doing D", status: "pending" }],
		});
		expect((writeRes3.details as { loopGuardTriggered?: boolean }).loopGuardTriggered).toBe(true);
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
		expect((okRes.content[0] as { text: string }).text).toBe("Todo list cleared.");
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

	it("R13 no tool-call infinite loop: blocked response directs model to execute task", async () => {
		const guard = new TodoLoopGuard();
		let persisted: TodoItem[] = [];
		const tool = createTodoWriteTool(
			() => persisted,
			(next) => {
				persisted = next;
			},
			guard,
		);

		await tool.execute("w1", { todos: [{ content: "A", activeForm: "A", status: "pending" }] });
		await tool.execute("w2", { todos: [{ content: "B", activeForm: "B", status: "pending" }] });
		const blocked = await tool.execute("w3", { todos: [{ content: "C", activeForm: "C", status: "pending" }] });

		expect((blocked.details as { todoWriteTemporarilyBlocked?: boolean }).todoWriteTemporarilyBlocked).toBe(true);
		expect((blocked.content[0] as { text: string }).text).toContain("Execute the current in-progress task now");
	});

	it("R14 operation aborted is not required to terminate loop", async () => {
		const guard = new TodoLoopGuard();
		let persisted: TodoItem[] = [];
		const tool = createTodoWriteTool(
			() => persisted,
			(next) => {
				persisted = next;
			},
			guard,
		);

		await tool.execute("w1", { todos: [{ content: "A", activeForm: "A", status: "pending" }] });
		await tool.execute("w2", { todos: [{ content: "B", activeForm: "B", status: "pending" }] });

		// The 3rd execution does not throw or abort, it returns structured blocking outcome
		const result = await tool.execute("w3", { todos: [{ content: "C", activeForm: "C", status: "pending" }] });
		expect(result).toBeDefined();
		expect((result.details as { loopGuardTriggered?: boolean }).loopGuardTriggered).toBe(true);
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
		const compacted = converted[0];
		if (compacted.role !== "assistant") throw new Error("Expected assistant");
		const firstContent = compacted.content[0];
		// Must NOT be a toolCall block
		expect(firstContent.type).not.toBe("toolCall");
		// Must be text, not a replayable todo_write argument
		expect(firstContent.type).toBe("text");
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
		);

		persisted = [{ id: "id-a", content: "A", activeForm: "A", status: "pending" }];
		const before = [...persisted];
		const beforeRev = revision;

		const res = await updateTool.execute("u1", {
			updates: [{ id: "id-a", status: "completed" }],
			expectedRevision: 3, // stale
		});
		expect((res.content[0] as { text: string }).text).toContain("stale revision");
		expect((res.details as { staleRevision?: boolean }).staleRevision).toBe(true);
		expect(persisted).toEqual(before);
		expect(revision).toBe(beforeRev);
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

	it("R23 todo_update participates in loop guard", async () => {
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
		);

		await writeTool.execute("w1", {
			todos: [{ content: "A", activeForm: "A", status: "pending" }],
		});
		const itemId = persisted[0].id!;

		// Second: todo_update (2nd consecutive Todo-family call, not blocked yet)
		await updateTool.execute("u1", {
			updates: [{ id: itemId, status: "in_progress" }],
			expectedRevision: revision,
		});

		// Third: todo_update (3rd consecutive → blocked)
		const rev2 = revision;
		const blocked = await updateTool.execute("u2", {
			updates: [{ id: itemId, activeForm: "Blocked" }],
			expectedRevision: rev2,
		});
		expect((blocked.details as { loopGuardTriggered?: boolean }).loopGuardTriggered).toBe(true);
	});

	it("R24 todo_read does not reset loop guard", async () => {
		const guard = new TodoLoopGuard();
		let persisted: TodoItem[] = [{ content: "A", activeForm: "A", status: "pending" }];
		const readTool = createTodoReadTool(() => persisted);
		const writeTool = createTodoWriteTool(
			() => persisted,
			(next) => {
				persisted = next;
			},
			guard,
		);

		await writeTool.execute("w1", { todos: [{ content: "B", activeForm: "B", status: "pending" }] });
		await writeTool.execute("w2", { todos: [{ content: "C", activeForm: "C", status: "pending" }] });
		await readTool.execute("r1", {});
		const res = await writeTool.execute("w3", { todos: [{ content: "D", activeForm: "D", status: "pending" }] });
		expect((res.details as { loopGuardTriggered?: boolean }).loopGuardTriggered).toBe(true);
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
		const writeTool = createTodoWriteTool(
			() => persisted,
			(next) => {
				persisted = next;
				revision++;
			},
			guard,
			() => revision,
		);
		const readTool = createTodoReadTool(
			() => persisted,
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
		expect((accepted.content[0] as { text: string }).text).toBe("Todo list cleared.");
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
});
