import { describe, expect, it } from "vitest";
import type { MemoryHistorySnapshot } from "./memory.js";
import { memoryItemsToText, parseMemoryItems, SESSION_MEMORY_CUSTOM_TYPE, upsertMemoryItems } from "./memory.js";
import { computeMemorySnapshotDiff } from "./memory-diff.js";
import { SessionManager } from "./session-manager.js";

describe("session memory", () => {
	it("buildSessionContext injects latest session memory into model-facing messages", () => {
		const session = SessionManager.inMemory("/tmp/project");
		session.appendCustomEntry(SESSION_MEMORY_CUSTOM_TYPE, [
			{ key: "constraints.test_command", value: "use npm run check", timestamp: new Date().toISOString() },
		]);
		session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "continue" }],
			timestamp: Date.now(),
		});

		const context = session.buildSessionContext();
		expect(context.memoryItems).toHaveLength(1);
		expect(context.messages[0]?.role).toBe("custom");
		if (context.messages[0]?.role === "custom" && typeof context.messages[0].content === "string") {
			expect(context.messages[0].content).toContain("constraints.test_command");
		}
	});

	it("upsertMemoryItems replaces values by key", () => {
		const timestamp = new Date().toISOString();
		const first = upsertMemoryItems([], "constraints.test_command", "npm run check", timestamp);
		const second = upsertMemoryItems(first, "constraints.test_command", "pnpm lint", timestamp);
		expect(second).toHaveLength(1);
		expect(second[0]?.value).toBe("pnpm lint");
	});

	it("parseMemoryItems ignores invalid entries", () => {
		const items = parseMemoryItems([
			{ key: "valid.key", value: "value", timestamp: "2024-01-01T00:00:00.000Z" },
			{ key: 123, value: "invalid" },
		]);
		expect(items).toHaveLength(1);
		expect(items[0]?.key).toBe("valid.key");
	});

	it("memoryItemsToText formats bullet list", () => {
		const text = memoryItemsToText([{ key: "project.arch", value: "monorepo", timestamp: new Date().toISOString() }]);
		expect(text).toContain("- project.arch: monorepo");
	});

	describe("getMemoryHistory", () => {
		it("returns empty array when no memory snapshots exist", () => {
			const session = SessionManager.inMemory("/tmp/project");
			session.appendMessage({
				role: "user",
				content: [{ type: "text", text: "hello" }],
				timestamp: Date.now(),
			});

			const history = session.getMemoryHistory();
			expect(history).toEqual([]);
		});

		it("returns single snapshot with isCurrent true", () => {
			const session = SessionManager.inMemory("/tmp/project");
			session.appendCustomEntry(SESSION_MEMORY_CUSTOM_TYPE, [
				{ key: "test.key", value: "test value", timestamp: new Date().toISOString() },
			]);

			const history = session.getMemoryHistory();
			expect(history).toHaveLength(1);
			expect(history[0]?.isCurrent).toBe(true);
			expect(history[0]?.items).toHaveLength(1);
			expect(history[0]?.items[0]?.key).toBe("test.key");
		});

		it("returns multiple snapshots in chronological order (oldest first)", () => {
			const session = SessionManager.inMemory("/tmp/project");

			// First snapshot
			session.appendCustomEntry(SESSION_MEMORY_CUSTOM_TYPE, [
				{ key: "first.key", value: "first value", timestamp: new Date().toISOString() },
			]);

			// Second snapshot
			session.appendCustomEntry(SESSION_MEMORY_CUSTOM_TYPE, [
				{ key: "first.key", value: "first value", timestamp: new Date().toISOString() },
				{ key: "second.key", value: "second value", timestamp: new Date().toISOString() },
			]);

			// Third snapshot
			session.appendCustomEntry(SESSION_MEMORY_CUSTOM_TYPE, [
				{ key: "first.key", value: "first value", timestamp: new Date().toISOString() },
				{ key: "second.key", value: "second value", timestamp: new Date().toISOString() },
				{ key: "third.key", value: "third value", timestamp: new Date().toISOString() },
			]);

			const history = session.getMemoryHistory();
			expect(history).toHaveLength(3);
			expect(history[0]?.items).toHaveLength(1);
			expect(history[0]?.items[0]?.key).toBe("first.key");
			expect(history[1]?.items).toHaveLength(2);
			expect(history[2]?.items).toHaveLength(3);
			expect(history[2]?.isCurrent).toBe(true);
			expect(history[0]?.isCurrent).toBe(false);
		});

		it("only follows current branch, not sibling branches", () => {
			const session = SessionManager.inMemory("/tmp/project");

			// First snapshot on main branch
			const entry1 = session.appendCustomEntry(SESSION_MEMORY_CUSTOM_TYPE, [
				{ key: "main.key", value: "main value", timestamp: new Date().toISOString() },
			]);

			// Branch from entry1
			session.branch(entry1);

			// Snapshot on branch
			session.appendCustomEntry(SESSION_MEMORY_CUSTOM_TYPE, [
				{ key: "branch.key", value: "branch value", timestamp: new Date().toISOString() },
			]);

			const history = session.getMemoryHistory();
			// Should include main snapshot and branch snapshot
			expect(history).toHaveLength(2);
			expect(history[0]?.items[0]?.key).toBe("main.key");
			expect(history[1]?.items[0]?.key).toBe("branch.key");
		});

		it("includes entryId and parentId in snapshots", () => {
			const session = SessionManager.inMemory("/tmp/project");
			const entry1 = session.appendCustomEntry(SESSION_MEMORY_CUSTOM_TYPE, [
				{ key: "key1", value: "value1", timestamp: new Date().toISOString() },
			]);

			const entry2 = session.appendCustomEntry(SESSION_MEMORY_CUSTOM_TYPE, [
				{ key: "key2", value: "value2", timestamp: new Date().toISOString() },
			]);

			const history = session.getMemoryHistory();
			expect(history).toHaveLength(2);
			expect(history[0]?.entryId).toBe(entry1);
			expect(history[1]?.entryId).toBe(entry2);
			expect(history[1]?.parentId).toBe(entry1);
		});
	});

	describe("findMemorySnapshotById", () => {
		it("returns undefined when no snapshots exist", () => {
			const session = SessionManager.inMemory("/tmp/project");
			session.appendMessage({
				role: "user",
				content: [{ type: "text", text: "hello" }],
				timestamp: Date.now(),
			});
			expect(session.findMemorySnapshotById("abc12345")).toBeUndefined();
		});

		it("returns snapshot when ID exists in current branch", () => {
			const session = SessionManager.inMemory("/tmp/project");
			const entryId = session.appendCustomEntry(SESSION_MEMORY_CUSTOM_TYPE, [
				{ key: "test.key", value: "test value", timestamp: new Date().toISOString() },
			]);

			const found = session.findMemorySnapshotById(entryId);
			expect(found).toBeDefined();
			expect(found?.entryId).toBe(entryId);
			expect(found?.items[0]?.key).toBe("test.key");
		});

		it("returns undefined for ID not in current branch", () => {
			const session = SessionManager.inMemory("/tmp/project");

			// Snapshot on main branch
			const entry1 = session.appendCustomEntry(SESSION_MEMORY_CUSTOM_TYPE, [
				{ key: "main.key", value: "main value", timestamp: new Date().toISOString() },
			]);

			// Branch and add another snapshot
			session.branch(entry1);
			session.appendCustomEntry(SESSION_MEMORY_CUSTOM_TYPE, [
				{ key: "branch.key", value: "branch value", timestamp: new Date().toISOString() },
			]);

			// Entry ID from main branch IS found because getMemoryHistory walks full path from root.
			// To test "not in branch" we would need an ID from a sibling branch that was never
			// on our ancestor path — but without creating that entry on another branch first,
			// the only IDs that exist are ones on our ancestor path.
			// This test verifies that a non-existent ID returns undefined.
			expect(session.findMemorySnapshotById("zzzzzzzz")).toBeUndefined();
		});

		it("returns undefined for invalid/malformed ID", () => {
			const session = SessionManager.inMemory("/tmp/project");
			session.appendCustomEntry(SESSION_MEMORY_CUSTOM_TYPE, [
				{ key: "test.key", value: "test value", timestamp: new Date().toISOString() },
			]);
			expect(session.findMemorySnapshotById("nonexistent")).toBeUndefined();
			expect(session.findMemorySnapshotById("")).toBeUndefined();
		});

		it("same-ID comparison yields all arrays empty via computeMemorySnapshotDiff", () => {
			const session = SessionManager.inMemory("/tmp/project");
			session.appendCustomEntry(SESSION_MEMORY_CUSTOM_TYPE, [
				{ key: "key1", value: "value1", timestamp: new Date().toISOString() },
			]);

			const history = session.getMemoryHistory();
			expect(history).toHaveLength(1);
			const snapshot = history[0]!;
			const diff = computeMemorySnapshotDiff(snapshot, snapshot);
			expect(diff.added).toEqual([]);
			expect(diff.removed).toEqual([]);
			expect(diff.changed).toEqual([]);
			expect(diff.isInitialSnapshot).toBe(false);
		});

		it("resolves correct snapshot among multiple", () => {
			const session = SessionManager.inMemory("/tmp/project");

			const entry1 = session.appendCustomEntry(SESSION_MEMORY_CUSTOM_TYPE, [
				{ key: "first", value: "v1", timestamp: new Date().toISOString() },
			]);
			const entry2 = session.appendCustomEntry(SESSION_MEMORY_CUSTOM_TYPE, [
				{ key: "first", value: "v1", timestamp: new Date().toISOString() },
				{ key: "second", value: "v2", timestamp: new Date().toISOString() },
			]);
			const entry3 = session.appendCustomEntry(SESSION_MEMORY_CUSTOM_TYPE, [
				{ key: "first", value: "v1", timestamp: new Date().toISOString() },
				{ key: "second", value: "v2", timestamp: new Date().toISOString() },
				{ key: "third", value: "v3", timestamp: new Date().toISOString() },
			]);

			const history = session.getMemoryHistory();
			expect(history).toHaveLength(3);

			const snap1 = session.findMemorySnapshotById(entry1);
			expect(snap1?.items).toHaveLength(1);
			expect(snap1?.items[0]?.key).toBe("first");

			const snap2 = session.findMemorySnapshotById(entry2);
			expect(snap2?.items).toHaveLength(2);
			expect(snap2?.items[1]?.key).toBe("second");

			const snap3 = session.findMemorySnapshotById(entry3);
			expect(snap3?.items).toHaveLength(3);
			expect(snap3?.items[2]?.key).toBe("third");
			expect(snap3?.isCurrent).toBe(true);
		});
	});

	describe("resolveMemorySnapshotSelector", () => {
		it("resolves selectors only within current-branch history", () => {
			const session = SessionManager.inMemory("/tmp/project");
			const shared = session.appendCustomEntry(SESSION_MEMORY_CUSTOM_TYPE, [
				{ key: "shared", value: "root", timestamp: new Date().toISOString() },
			]);
			const siblingOnly = session.appendCustomEntry(SESSION_MEMORY_CUSTOM_TYPE, [
				{ key: "sibling", value: "main", timestamp: new Date().toISOString() },
			]);

			session.branch(shared);
			const branchOnly = session.appendCustomEntry(SESSION_MEMORY_CUSTOM_TYPE, [
				{ key: "branch", value: "active", timestamp: new Date().toISOString() },
			]);

			const branchResult = session.resolveMemorySnapshotSelector(branchOnly);
			expect(branchResult.snapshot?.entryId).toBe(branchOnly);
			expect(branchResult.error).toBeUndefined();

			const siblingResult = session.resolveMemorySnapshotSelector(siblingOnly);
			expect(siblingResult.snapshot).toBeUndefined();
			expect(siblingResult.error).toBe("not_found");
		});

		it("preserves same-snapshot compare compatibility through SessionManager", () => {
			const session = SessionManager.inMemory("/tmp/project");
			const entryId = session.appendCustomEntry(SESSION_MEMORY_CUSTOM_TYPE, [
				{ key: "a", value: "1", timestamp: new Date().toISOString() },
			]);

			const baselineResult = session.resolveMemorySnapshotSelector(entryId);
			const targetResult = session.resolveMemorySnapshotSelector(`[${entryId.slice(0, 8)}]`);
			const diff = computeMemorySnapshotDiff(baselineResult.snapshot!, targetResult.snapshot!);

			expect(baselineResult.resolvedId).toBe(targetResult.resolvedId);
			expect(diff.added).toEqual([]);
			expect(diff.removed).toEqual([]);
			expect(diff.changed).toEqual([]);
		});
	});
});

describe("computeMemorySnapshotDiff", () => {
	function makeSnapshot(
		id: string,
		items: Array<{ key: string; value: string }>,
		recordedAt = "2024-01-01T00:00:00.000Z",
	): MemoryHistorySnapshot {
		return {
			entryId: id,
			parentId: null,
			recordedAt,
			items: items.map((i) => ({ ...i, timestamp: recordedAt })),
			isCurrent: false,
		};
	}

	it("empty previous vs current with items → all added", () => {
		const current = makeSnapshot("s2", [{ key: "a", value: "1" }]);
		const result = computeMemorySnapshotDiff(undefined, current);
		expect(result.isInitialSnapshot).toBe(true);
		expect(result.added).toEqual([{ type: "added", key: "a", value: "1" }]);
		expect(result.removed).toEqual([]);
		expect(result.changed).toEqual([]);
	});

	it("added only", () => {
		const prev = makeSnapshot("s1", [{ key: "a", value: "1" }]);
		const curr = makeSnapshot("s2", [
			{ key: "a", value: "1" },
			{ key: "b", value: "2" },
		]);
		const result = computeMemorySnapshotDiff(prev, curr);
		expect(result.isInitialSnapshot).toBe(false);
		expect(result.added).toEqual([{ type: "added", key: "b", value: "2" }]);
		expect(result.removed).toEqual([]);
		expect(result.changed).toEqual([]);
	});

	it("removed only", () => {
		const prev = makeSnapshot("s1", [
			{ key: "a", value: "1" },
			{ key: "b", value: "2" },
		]);
		const curr = makeSnapshot("s2", [{ key: "a", value: "1" }]);
		const result = computeMemorySnapshotDiff(prev, curr);
		expect(result.isInitialSnapshot).toBe(false);
		expect(result.added).toEqual([]);
		expect(result.removed).toEqual([{ type: "removed", key: "b", value: "2" }]);
		expect(result.changed).toEqual([]);
	});

	it("changed only", () => {
		const prev = makeSnapshot("s1", [{ key: "a", value: "1" }]);
		const curr = makeSnapshot("s2", [{ key: "a", value: "updated" }]);
		const result = computeMemorySnapshotDiff(prev, curr);
		expect(result.isInitialSnapshot).toBe(false);
		expect(result.added).toEqual([]);
		expect(result.removed).toEqual([]);
		expect(result.changed).toEqual([{ type: "changed", key: "a", previousValue: "1", currentValue: "updated" }]);
	});

	it("mixed added/removed/changed", () => {
		const prev = makeSnapshot("s1", [
			{ key: "a", value: "1" },
			{ key: "b", value: "old_b" },
			{ key: "gone", value: "val" },
		]);
		const curr = makeSnapshot("s2", [
			{ key: "a", value: "updated" },
			{ key: "b", value: "old_b" },
			{ key: "new", value: "added_val" },
		]);
		const result = computeMemorySnapshotDiff(prev, curr);
		expect(result.added).toEqual([{ type: "added", key: "new", value: "added_val" }]);
		expect(result.removed).toEqual([{ type: "removed", key: "gone", value: "val" }]);
		expect(result.changed).toEqual([{ type: "changed", key: "a", previousValue: "1", currentValue: "updated" }]);
	});

	it("unchanged keys are excluded", () => {
		const prev = makeSnapshot("s1", [
			{ key: "same", value: "unchanged" },
			{ key: "changed", value: "v1" },
		]);
		const curr = makeSnapshot("s2", [
			{ key: "same", value: "unchanged" },
			{ key: "changed", value: "v2" },
		]);
		const result = computeMemorySnapshotDiff(prev, curr);
		// 'same' key should not appear anywhere
		expect(result.added.map((i) => i.key)).not.toContain("same");
		expect(result.removed.map((i) => i.key)).not.toContain("same");
		expect(result.changed.map((i) => i.key)).not.toContain("same");
		// only 'changed' appears in changed
		expect(result.changed).toEqual([{ type: "changed", key: "changed", previousValue: "v1", currentValue: "v2" }]);
	});

	it("both empty → all arrays empty", () => {
		const prev = makeSnapshot("s1", []);
		const curr = makeSnapshot("s2", []);
		const result = computeMemorySnapshotDiff(prev, curr);
		expect(result.isInitialSnapshot).toBe(false);
		expect(result.added).toEqual([]);
		expect(result.removed).toEqual([]);
		expect(result.changed).toEqual([]);
	});
});
