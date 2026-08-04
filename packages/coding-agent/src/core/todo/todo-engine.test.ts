/**
 * Unit tests for the durable TODO engine:
 *   revision/hash, deterministic rebase, idempotency, status transitions,
 *   and progress-aware loop detection.
 */
import { describe, expect, it } from "vitest";
import { allowedTransitions, computeStateHash, hashIntent, TodoEngine, validateTransition } from "./todo-engine.js";

const item = (id: string, content = id, status: "pending" | "in_progress" | "completed" = "pending") => ({
	id,
	content,
	activeForm: `Working on ${content}`,
	status,
});

describe("state hash and revision", () => {
	it("computeStateHash is deterministic and order-independent", () => {
		const a = [item("a"), item("b")];
		const b = [item("b"), item("a")];
		expect(computeStateHash(a)).toBe(computeStateHash(b));
		expect(computeStateHash([item("a"), item("b")])).not.toBe(computeStateHash([item("a"), item("c")]));
	});

	it("same hash implies same content; different content -> different hash", () => {
		expect(computeStateHash([item("a")])).toBe(computeStateHash([item("a")]));
		expect(computeStateHash([item("a")])).not.toBe(computeStateHash([item("a", "other")]));
	});
});

describe("status transitions", () => {
	it("allows forward transitions and forbids terminal reopen", () => {
		expect(validateTransition("pending", "in_progress").ok).toBe(true);
		expect(validateTransition("in_progress", "completed").ok).toBe(true);
		expect(validateTransition("completed", "pending").ok).toBe(false);
		expect(validateTransition("cancelled", "in_progress").ok).toBe(false);
	});

	it("repeating current status is idempotent", () => {
		expect(validateTransition("completed", "completed").ok).toBe(true);
		expect(validateTransition("pending", "pending").ok).toBe(true);
	});

	it("exposes allowed transitions", () => {
		expect(allowedTransitions("pending").has("blocked")).toBe(true);
		expect(allowedTransitions("completed").has("pending")).toBe(false);
	});
});

describe("deterministic rebase", () => {
	const engine = () => new TodoEngine("s");

	it("rebases when the intent targets a different item than the concurrent change", () => {
		const e = engine();
		const base = [item("a"), item("b")];
		e.recordReadSnapshot(1, base);
		// concurrent: item b changed
		const current = [item("a"), { ...item("b"), content: "b2" }];
		const r = e.rebase(1, 2, current, [{ id: "a", status: "completed" }]);
		expect(r.status).toBe("rebased");
		expect(r.conflictItemIds).toEqual([]);
		expect(r.preservedConcurrentChanges).toEqual([]);
	});

	it("rebases when a new item was created concurrently", () => {
		const e = engine();
		const base = [item("a")];
		e.recordReadSnapshot(1, base);
		const current = [item("a"), item("z")];
		const r = e.rebase(1, 2, current, [{ id: "a", status: "completed" }]);
		expect(r.status).toBe("rebased");
		expect(r.conflictItemIds).toEqual([]);
	});

	it("treats repeated completion as idempotent", () => {
		const e = engine();
		const base = [item("a", "A", "completed")];
		e.recordReadSnapshot(1, base);
		const current = [item("a", "A", "completed")];
		const r = e.rebase(1, 1, current, [{ id: "a", status: "completed" }]);
		expect(r.status).toBe("already_applied");
		expect(r.conflictItemIds).toEqual([]);
	});

	it("conflicts when the same content was edited differently", () => {
		const e = engine();
		const base = [item("a", "original")];
		e.recordReadSnapshot(1, base);
		const current = [item("a", "concurrent-edit")];
		const r = e.rebase(1, 2, current, [{ id: "a", content: "model-edit" }]);
		expect(r.status).toBe("conflict");
		expect(r.conflictItemIds).toContain("a");
	});

	it("conflicts when the item was removed concurrently", () => {
		const e = engine();
		const base = [item("a"), item("b")];
		e.recordReadSnapshot(1, base);
		const current = [item("b")];
		const r = e.rebase(1, 2, current, [{ id: "a", status: "completed" }]);
		expect(r.status).toBe("conflict");
		expect(r.conflictItemIds).toContain("a");
	});

	it("conflicts when reopening a terminal item", () => {
		const e = engine();
		const base = [item("a", "A", "completed")];
		e.recordReadSnapshot(1, base);
		const current = [item("a", "A", "completed")];
		const r = e.rebase(1, 1, current, [{ id: "a", status: "in_progress" }]);
		expect(r.status).toBe("conflict");
		expect(r.conflictItemIds).toContain("a");
	});
});

describe("idempotency", () => {
	it("records and detects an exact retry", () => {
		const e = new TodoEngine("s");
		const key = `${e.scopeId}|${hashIntent([{ id: "a", status: "completed" }])}|3`;
		expect(e.lookupApplied(key)).toBe(false);
		e.recordApplied(key, 4);
		expect(e.lookupApplied(key)).toBe(true);
	});

	it("is bounded (does not grow unboundedly)", () => {
		const e = new TodoEngine("s", { maxLedger: 3 });
		for (let i = 0; i < 10; i++) {
			e.recordApplied(`k${i}`, i);
		}
		expect(e.getDiagnostics().ledgerCount).toBeLessThanOrEqual(3);
	});
});

describe("progress-aware loop detection", () => {
	it("blocks after 3 identical consecutive no-progress failures", () => {
		const e = new TodoEngine("s", { maxNoProgressFailures: 3 });
		const fp = { scopeId: "s", errorCode: "TODO_X", intentHash: "h", requestedRevision: 1, currentRevision: 1 };
		expect(e.registerFailure(fp).blocked).toBe(false);
		expect(e.registerFailure(fp).blocked).toBe(false);
		const third = e.registerFailure(fp);
		expect(third.blocked).toBe(true);
		expect(third.consecutive).toBe(3);
	});

	it("intervening progress resets the chain", () => {
		const e = new TodoEngine("s", { maxNoProgressFailures: 3 });
		const fp = { scopeId: "s", errorCode: "TODO_X", intentHash: "h", requestedRevision: 1, currentRevision: 1 };
		e.registerFailure(fp);
		e.registerFailure(fp);
		e.recordProgress();
		const again = e.registerFailure(fp);
		expect(again.blocked).toBe(false);
		expect(again.consecutive).toBe(1);
	});

	it("a newer todo read resets the chain", () => {
		const e = new TodoEngine("s");
		const fp = { scopeId: "s", errorCode: "TODO_X", intentHash: "h", requestedRevision: 1, currentRevision: 1 };
		e.registerFailure(fp);
		e.registerFailure(fp);
		e.recordTodoRead(2); // newer revision -> progress
		expect(e.registerFailure(fp).consecutive).toBe(1);
	});

	it("an identical (non-newer) todo read does NOT reset the chain", () => {
		const e = new TodoEngine("s");
		e.recordTodoRead(1); // baseline read at revision 1
		const fp = { scopeId: "s", errorCode: "TODO_X", intentHash: "h", requestedRevision: 1, currentRevision: 1 };
		e.registerFailure(fp);
		e.registerFailure(fp);
		e.recordTodoRead(1); // same revision as baseline -> no progress
		expect(e.registerFailure(fp).consecutive).toBe(3);
	});
});
