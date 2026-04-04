import { describe, expect, it } from "vitest";
import type { MemoryHistorySnapshot } from "./memory.js";
import { computeMemorySnapshotDiff } from "./memory-diff.js";
import {
	MEMORY_SNAPSHOT_SHORT_ID_LENGTH,
	normalizeSnapshotSelector,
	resolveSnapshotSelector,
} from "./snapshot-selector-resolver.js";

function makeSnapshot(
	entryId: string,
	items: Array<{ key: string; value: string }>,
	recordedAt = "2026-04-01T00:00:00.000Z",
): MemoryHistorySnapshot {
	return {
		entryId,
		parentId: null,
		recordedAt,
		items: items.map((item) => ({ ...item, timestamp: recordedAt })),
		isCurrent: false,
	};
}

describe("snapshot selector resolver", () => {
	it("normalizes bracketed and whitespace-padded selectors", () => {
		expect(normalizeSnapshotSelector("  [abc12345]  ")).toBe("abc12345");
		expect(normalizeSnapshotSelector("  abc12345  ")).toBe("abc12345");
		expect(normalizeSnapshotSelector("[]")).toBe("");
		expect(normalizeSnapshotSelector("   ")).toBe("");
	});

	it("resolves exact full entryId", () => {
		const snapshots = [makeSnapshot("abc12345-1111", [{ key: "a", value: "1" }])];
		const result = resolveSnapshotSelector("abc12345-1111", snapshots);
		expect(result.snapshot?.entryId).toBe("abc12345-1111");
		expect(result.resolvedId).toBe("abc12345-1111");
		expect(result.error).toBeUndefined();
		expect(result.candidates).toEqual([]);
	});

	it("resolves exact displayed short ID", () => {
		const fullId = "abc12345-1111";
		const snapshots = [makeSnapshot(fullId, [{ key: "a", value: "1" }])];
		const result = resolveSnapshotSelector(fullId.slice(0, MEMORY_SNAPSHOT_SHORT_ID_LENGTH), snapshots);
		expect(result.snapshot?.entryId).toBe(fullId);
		expect(result.error).toBeUndefined();
	});

	it("resolves bracketed short ID copied from history", () => {
		const fullId = "abc12345-1111";
		const snapshots = [makeSnapshot(fullId, [{ key: "a", value: "1" }])];
		const result = resolveSnapshotSelector(`[${fullId.slice(0, MEMORY_SNAPSHOT_SHORT_ID_LENGTH)}]`, snapshots);
		expect(result.snapshot?.entryId).toBe(fullId);
		expect(result.matchedInput).toBe(fullId.slice(0, MEMORY_SNAPSHOT_SHORT_ID_LENGTH));
		expect(result.error).toBeUndefined();
	});

	it("prefers exact displayed short ID before broader prefix matching", () => {
		const snapshots = [
			makeSnapshot("abc12345-1111", [{ key: "a", value: "1" }]),
			makeSnapshot("abc123456-2222", [{ key: "b", value: "2" }]),
		];
		const result = resolveSnapshotSelector("abc12345", snapshots);
		expect(result.snapshot?.entryId).toBe("abc12345-1111");
		expect(result.error).toBeUndefined();
	});

	it("resolves strict unique prefix", () => {
		const snapshots = [
			makeSnapshot("aaa00000-1111", [{ key: "a", value: "1" }]),
			makeSnapshot("bbb12345-2222", [{ key: "b", value: "2" }]),
			makeSnapshot("ccc00000-3333", [{ key: "c", value: "3" }]),
		];
		const result = resolveSnapshotSelector("bbb1", snapshots);
		expect(result.snapshot?.entryId).toBe("bbb12345-2222");
		expect(result.error).toBeUndefined();
		expect(result.candidates).toEqual([]);
	});

	it("rejects ambiguous prefixes with candidates", () => {
		const snapshots = [
			makeSnapshot("abc00001-1111", [{ key: "a", value: "1" }]),
			makeSnapshot("abc00002-2222", [{ key: "b", value: "2" }]),
			makeSnapshot("abd00003-3333", [{ key: "c", value: "3" }]),
		];
		const result = resolveSnapshotSelector("abc", snapshots);
		expect(result.snapshot).toBeUndefined();
		expect(result.error).toBe("ambiguous");
		expect(result.candidates).toEqual(["abc00001-1111", "abc00002-2222"]);
	});

	it("rejects selectors with no match", () => {
		const snapshots = [makeSnapshot("abc12345-1111", [{ key: "a", value: "1" }])];
		const result = resolveSnapshotSelector("zzz99999", snapshots);
		expect(result.snapshot).toBeUndefined();
		expect(result.error).toBe("not_found");
		expect(result.candidates).toEqual([]);
	});

	it("rejects empty selectors after normalization", () => {
		const snapshots = [makeSnapshot("abc12345-1111", [{ key: "a", value: "1" }])];
		expect(resolveSnapshotSelector("", snapshots).error).toBe("empty");
		expect(resolveSnapshotSelector("   ", snapshots).error).toBe("empty");
		expect(resolveSnapshotSelector("[]", snapshots).error).toBe("empty");
	});

	it("supports same-snapshot compare flows honestly", () => {
		const fullId = "abc12345-1111";
		const snapshots = [makeSnapshot(fullId, [{ key: "a", value: "1" }])];
		const baseline = resolveSnapshotSelector(fullId, snapshots);
		const target = resolveSnapshotSelector(`[${fullId.slice(0, MEMORY_SNAPSHOT_SHORT_ID_LENGTH)}]`, snapshots);
		const diff = computeMemorySnapshotDiff(baseline.snapshot!, target.snapshot!);
		expect(baseline.resolvedId).toBe(target.resolvedId);
		expect(diff.added).toEqual([]);
		expect(diff.removed).toEqual([]);
		expect(diff.changed).toEqual([]);
	});
});
