import { describe, expect, it } from "vitest";
import type { MemoryHistorySnapshot } from "../../core/memory.js";
import { SESSION_MEMORY_CUSTOM_TYPE } from "../../core/memory.js";
import { SessionManager } from "../../core/session-manager.js";
import { resolveSnapshotSelector } from "../../core/snapshot-selector-resolver.js";
import { serializeJsonLine } from "./jsonl.js";
import { buildRpcMemoryCompareData, buildRpcMemoryHistoryData } from "./rpc-memory.js";

function makeSnapshot(
	entryId: string,
	items: Array<{ key: string; value: string }>,
	recordedAt = "2026-04-01T12:00:00.000Z",
	isCurrent = false,
	parentId: string | null = null,
): MemoryHistorySnapshot {
	return {
		entryId,
		parentId,
		recordedAt,
		items: items.map((item) => ({ ...item, timestamp: recordedAt })),
		isCurrent,
	};
}

function makeContext(snapshots: readonly MemoryHistorySnapshot[]) {
	return {
		getMemoryHistory: () => snapshots,
		resolveMemorySnapshotSelector: (input: string) => resolveSnapshotSelector(input, snapshots),
	};
}

describe("buildRpcMemoryHistoryData", () => {
	it("returns current-branch snapshot history with explicit snapshot framing", () => {
		const snapshots = [
			makeSnapshot("baseline01-1111", [{ key: "alpha", value: "first" }], "2026-04-01T10:00:00.000Z"),
			makeSnapshot(
				"target001-2222",
				[{ key: "beta", value: "second" }],
				"2026-04-01T12:00:00.000Z",
				true,
				"baseline01-1111",
			),
		];

		const data = buildRpcMemoryHistoryData(makeContext(snapshots));

		expect(data.branchScope).toBe("current");
		expect(data.historyModel).toBe("snapshot");
		expect(data.snapshots).toHaveLength(2);
		expect(data.snapshots[0]).toMatchObject({
			entryId: "baseline01-1111",
			shortId: "baseline",
			itemCount: 1,
			isCurrent: false,
		});
		expect(data.snapshots[1]).toMatchObject({
			entryId: "target001-2222",
			shortId: "target00",
			parentId: "baseline01-1111",
			itemCount: 1,
			isCurrent: true,
		});
	});
});

describe("buildRpcMemoryCompareData", () => {
	it("returns empty_history when no snapshots exist", () => {
		const data = buildRpcMemoryCompareData(makeContext([]));
		expect(data).toEqual({
			branchScope: "current",
			historyModel: "snapshot",
			status: "empty_history",
			snapshotCount: 0,
		});
	});

	it("returns initial_snapshot honestly for adjacent comparison with one snapshot", () => {
		const data = buildRpcMemoryCompareData(
			makeContext([
				makeSnapshot("baseline01-1111", [{ key: "alpha", value: "first" }], "2026-04-01T10:00:00.000Z", true),
			]),
		);

		expect(data.status).toBe("initial_snapshot");
		if (data.status === "initial_snapshot") {
			expect(data.compareMode).toBe("adjacent");
			expect(data.target.shortId).toBe("baseline");
			expect(data.diff.isInitialSnapshot).toBe(true);
			expect(data.diff.added).toEqual([{ type: "added", key: "alpha", value: "first" }]);
		}
	});

	it("returns adjacent comparison against latest and previous snapshots", () => {
		const snapshots = [
			makeSnapshot("baseline01-1111", [{ key: "alpha", value: "first" }], "2026-04-01T10:00:00.000Z"),
			makeSnapshot(
				"target001-2222",
				[
					{ key: "alpha", value: "updated" },
					{ key: "beta", value: "second" },
				],
				"2026-04-01T12:00:00.000Z",
				true,
				"baseline01-1111",
			),
		];

		const data = buildRpcMemoryCompareData(makeContext(snapshots));
		expect(data.status).toBe("ok");
		if (data.status === "ok") {
			expect(data.compareMode).toBe("adjacent");
			expect(data.sameSnapshot).toBe(false);
			expect(data.baseline.shortId).toBe("baseline");
			expect(data.target.shortId).toBe("target00");
			expect(data.diff.added).toEqual([{ type: "added", key: "beta", value: "second" }]);
			expect(data.diff.changed).toEqual([
				{ type: "changed", key: "alpha", previousValue: "first", currentValue: "updated" },
			]);
		}
	});

	it("reuses selector resolution and returns resolved selectors on explicit success", () => {
		const snapshots = [
			makeSnapshot("baseline01-1111", [{ key: "alpha", value: "first" }], "2026-04-01T10:00:00.000Z"),
			makeSnapshot("target001-2222", [{ key: "alpha", value: "second" }], "2026-04-01T12:00:00.000Z", true),
		];

		const data = buildRpcMemoryCompareData(makeContext(snapshots), {
			baseline: "[baseline]",
			target: "target00",
		});

		expect(data.status).toBe("ok");
		if (data.status === "ok") {
			expect(data.compareMode).toBe("explicit");
			expect(data.selectors).toEqual({
				baseline: {
					input: "[baseline]",
					matchedInput: "baseline",
					resolvedId: "baseline01-1111",
				},
				target: {
					input: "target00",
					matchedInput: "target00",
					resolvedId: "target001-2222",
				},
			});
		}
	});

	it("returns selector_resolution_failed with explicit issue structure", () => {
		const snapshots = [
			makeSnapshot("abc00001-1111", [{ key: "a", value: "1" }]),
			makeSnapshot("abc00002-2222", [{ key: "b", value: "2" }], "2026-04-01T12:00:00.000Z", true),
		];

		const data = buildRpcMemoryCompareData(makeContext(snapshots), {
			baseline: "[]",
			target: "abc",
		});

		expect(data.status).toBe("selector_resolution_failed");
		if (data.status === "selector_resolution_failed") {
			expect(data.compareMode).toBe("explicit");
			expect(data.issues).toEqual([
				{
					label: "baseline",
					input: "[]",
					matchedInput: "",
					error: "empty",
					candidates: [],
				},
				{
					label: "target",
					input: "abc",
					matchedInput: "abc",
					error: "ambiguous",
					candidates: [
						{ entryId: "abc00001-1111", shortId: "abc00001" },
						{ entryId: "abc00002-2222", shortId: "abc00002" },
					],
				},
			]);
		}
	});

	it("handles same-snapshot explicit comparison honestly", () => {
		const snapshots = [
			makeSnapshot("baseline01-1111", [{ key: "alpha", value: "first" }], "2026-04-01T10:00:00.000Z", true),
		];

		const data = buildRpcMemoryCompareData(makeContext(snapshots), {
			baseline: "baseline01-1111",
			target: "[baseline]",
		});

		expect(data.status).toBe("ok");
		if (data.status === "ok") {
			expect(data.sameSnapshot).toBe(true);
			expect(data.diff.added).toEqual([]);
			expect(data.diff.removed).toEqual([]);
			expect(data.diff.changed).toEqual([]);
		}
	});

	it("stays current-branch-only when backed by SessionManager", () => {
		const session = SessionManager.inMemory("/tmp/project");
		const shared = session.appendCustomEntry(SESSION_MEMORY_CUSTOM_TYPE, [
			{ key: "shared", value: "root", timestamp: new Date().toISOString() },
		]);
		const siblingOnly = session.appendCustomEntry(SESSION_MEMORY_CUSTOM_TYPE, [
			{ key: "sibling", value: "main", timestamp: new Date().toISOString() },
		]);

		session.branch(shared);
		session.appendCustomEntry(SESSION_MEMORY_CUSTOM_TYPE, [
			{ key: "branch", value: "active", timestamp: new Date().toISOString() },
		]);

		const history = buildRpcMemoryHistoryData({ getMemoryHistory: () => session.getMemoryHistory() });
		expect(history.snapshots).toHaveLength(2);
		expect(history.snapshots.map((snapshot) => snapshot.entryId)).not.toContain(siblingOnly);

		const compare = buildRpcMemoryCompareData(
			{
				getMemoryHistory: () => session.getMemoryHistory(),
				resolveMemorySnapshotSelector: (input: string) => session.resolveMemorySnapshotSelector(input),
			},
			{ baseline: siblingOnly, target: history.snapshots[1]!.entryId },
		);
		expect(compare.status).toBe("selector_resolution_failed");
	});
});

describe("RPC memory payloads", () => {
	it("remain JSON-serializable", () => {
		const payload = buildRpcMemoryCompareData(
			makeContext([
				makeSnapshot("baseline01-1111", [{ key: "alpha", value: "first" }]),
				makeSnapshot("target001-2222", [{ key: "alpha", value: "second" }], "2026-04-01T12:00:00.000Z", true),
			]),
			{ baseline: "baseline01-1111", target: "target001-2222" },
		);

		const serialized = serializeJsonLine(payload);
		expect(JSON.parse(serialized)).toEqual(payload);
	});
});
