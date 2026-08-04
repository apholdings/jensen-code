/**
 * Production regression: the observed FALSE_POSITIVE_TODO_LOOP_TERMINATION
 * incident.
 *
 * Observed sequence (before this release):
 *   revision 7 -> stale todo_update(7) -> TODO_READ_REQUIRED
 *   -> productive work -> stale todo_update(8) -> REPEATED_TODO_UPDATE_LOOP
 *   -> active run TERMINATED
 *
 * After this release the two rejected updates are NOT a consecutive no-progress
 * loop: authoritative progress occurred between them, so they are two separate
 * recoverable incidents. Each stale update is recovered internally (read +
 * rebase) with no model-required todo_read and no run termination.
 */
import { describe, expect, it } from "vitest";
import { TodoEngine } from "./todo/index.js";
import { TodoLoopGuard } from "./tools/todo-loop-guard.js";
import { createTodoReadTool } from "./tools/todo-read.js";
import { createTodoUpdateTool } from "./tools/todo-update.js";
import type { TodoItem } from "./tools/todo-write.js";

function setup() {
	let items: TodoItem[] = [
		{ id: "a", content: "Task A", activeForm: "Working on A", status: "pending" },
		{ id: "b", content: "Task B", activeForm: "Working on B", status: "pending" },
		{ id: "c", content: "Task C", activeForm: "Working on C", status: "pending" },
	];
	let revision = 7;
	const engine = new TodoEngine("run-1");
	const getSessionTodos = () => items;
	const getRevision = () => revision;
	const setSessionTodos = (t: TodoItem[]) => {
		items = t;
		revision++;
	};
	const readTool = createTodoReadTool(getSessionTodos, getRevision, undefined, engine);
	const updateTool = createTodoUpdateTool(
		getSessionTodos,
		setSessionTodos,
		getRevision,
		new TodoLoopGuard(),
		undefined,
		undefined,
		engine,
	);
	/** Simulate an independent concurrent writer advancing the store. */
	const concurrent = (mutate?: (t: TodoItem[]) => void) => {
		const copy = items.map((t) => ({ ...t }));
		mutate?.(copy);
		items = copy;
		revision++;
	};
	return {
		readTool,
		updateTool,
		engine,
		concurrent,
		getItems: () => items,
		getRevision: () => revision,
	};
}

describe("observed false-positive loop no longer terminates the run", () => {
	it("two stale updates separated by productive progress are both recovered; run completes", async () => {
		const { readTool, updateTool, concurrent, engine, getRevision, getItems } = setup();

		// Step 1: model reads revision 7 (snapshot base for rebase).
		await readTool.execute("r1", {});
		expect(getRevision()).toBe(7);

		// Step 2: TODO store concurrently advances to revision 8 (unrelated item).
		concurrent();

		// Step 3: model submits an update based on revision 7 (definitely NOT a loop).
		const first = await updateTool.execute("tc-1", {
			updates: [{ id: "a", status: "completed" }],
			expectedRevision: 7,
		});
		const firstText = first.content[0];
		if (firstText.type !== "text") throw new Error("text");
		// Automatic internal recovery: no TODO_READ_REQUIRED forced on the model.
		expect(firstText.text).not.toContain("TODO_READ_REQUIRED");
		const firstDetails = first.details as Record<string, unknown>;
		expect(firstDetails.rebased ?? firstDetails.changed).toBe(true);
		expect(getRevision()).toBe(9); // 7 -> 8 (concurrent) -> 9 (this update)

		// Step 4: productive non-TODO progress occurs (docs read, file write, test).
		engine.recordProgress();

		// Step 5: store advances concurrently to revision 10.
		concurrent();

		// Step 6: model submits another update based on revision 9.
		const second = await updateTool.execute("tc-2", {
			updates: [{ id: "b", status: "completed" }],
			expectedRevision: 9,
		});
		const secondText = second.content[0];
		if (secondText.type !== "text") throw new Error("text");
		expect(secondText.text).not.toContain("REPEATED_TODO_UPDATE_LOOP");
		expect(secondText.text).not.toContain("TODO_READ_REQUIRED");
		const secondDetails = second.details as Record<string, unknown>;
		expect(secondDetails.rebased ?? secondDetails.changed).toBe(true);
		expect(getRevision()).toBe(11); // 9 -> 10 -> 11

		// Both intended changes applied; unrelated work preserved.
		const itemsNow = getItems();
		expect(itemsNow.find((t) => t.id === "a")?.status).toBe("completed");
		expect(itemsNow.find((t) => t.id === "b")?.status).toBe("completed");
		expect(itemsNow.find((t) => t.id === "c")?.status).toBe("pending");

		// Internal recovery was exercised (not a model-visible error, no run terminal).
		const events = engine.getEvents(50);
		expect(events.some((e) => e.type === "TODO_REVISION_STALE_DETECTED")).toBe(true);
		expect(events.some((e) => e.type === "TODO_REBASE_SUCCEEDED")).toBe(true);
		expect(events.some((e) => e.type === "TODO_MUTATION_REJECTED")).toBe(false);
	});

	it("an ambiguous (non-recoverable) first conflict is typed and nonfatal; a later independent update succeeds without inherited loop counter", async () => {
		const { readTool, updateTool, concurrent, engine, getRevision, getItems } = setup();

		await readTool.execute("r1", {});
		expect(getRevision()).toBe(7);

		// Concurrently change the SAME content the model will target (creates a conflict).
		concurrent((t) => {
			const a = t.find((x) => x.id === "a");
			if (a) a.content = "concurrent-edit";
		});
		// revision now 8

		// Model attempts to edit the same content based on stale revision 7 -> conflict.
		const conflicted = await updateTool.execute("tc-conflict", {
			updates: [{ id: "a", content: "model-edit" }],
			expectedRevision: 7,
		});
		const cText = conflicted.content[0];
		if (cText.type !== "text") throw new Error("text");
		expect(cText.text).toContain("TODO_REBASE_CONFLICT");
		// Nonfatal: run continues; store not corrupted.
		expect(getRevision()).toBe(8);
		expect(getItems().find((t) => t.id === "a")?.content).toBe("concurrent-edit");

		// Productive work between incidents resets any chain.
		engine.recordProgress();

		// A later INDEPENDENT (different-item) update is allowed with no inherited counter.
		const ok = await updateTool.execute("tc-independent", {
			updates: [{ id: "c", status: "in_progress" }],
			expectedRevision: 8,
		});
		const okText = ok.content[0];
		if (okText.type !== "text") throw new Error("text");
		expect(okText.text).not.toContain("REPEATED_TODO_UPDATE_LOOP");
		const okDetails = ok.details as Record<string, unknown>;
		expect(okDetails.changed).toBe(true);
		expect(getItems().find((t) => t.id === "c")?.status).toBe("in_progress");
	});
});
