import { describe, expect, it } from "vitest";
import { convertToLlm } from "./messages.js";
import { TodoLoopGuard } from "./tools/todo-loop-guard.js";
import { createTodoReadTool } from "./tools/todo-read.js";
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

		expect(persisted).toEqual(items2);
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
			content: [{ type: "toolCall", name: "todo_write", arguments: { todos: [], snapshotOmitted: true } }],
		});
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
		expect(readRes.details).toEqual({ todos: persisted });

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
		expect(res.details).toEqual({
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
});
