import { describe, expect, it } from "vitest";
import type { MemoryHistorySnapshot } from "./memory.js";
import { formatMemoryDiffOutput, formatMemoryHistoryOutput, formatRelativeAgeLabel } from "./memory-compare-output.js";
import { resolveSnapshotSelector } from "./snapshot-selector-resolver.js";

function makeSnapshot(
	entryId: string,
	items: Array<{ key: string; value: string }>,
	recordedAt = "2026-04-01T12:00:00.000Z",
	isCurrent = false,
): MemoryHistorySnapshot {
	return {
		entryId,
		parentId: null,
		recordedAt,
		items: items.map((item) => ({ ...item, timestamp: recordedAt })),
		isCurrent,
	};
}

describe("memory compare output", () => {
	it("formats history output with shared selector guidance and bracketed IDs", () => {
		const snapshots = [
			makeSnapshot("baseline01-1111", [{ key: "alpha", value: "first value" }], "2026-04-01T10:00:00.000Z"),
			makeSnapshot("target001-2222", [{ key: "beta", value: "second value" }], "2026-04-01T12:00:00.000Z", true),
		];

		const lines = formatMemoryHistoryOutput(snapshots, {
			getRelativeAgeLabel: () => "2h ago",
		});

		expect(lines).toContain("Use /memory diff <baselineId> <targetId> to compare any two snapshots.");
		expect(lines).toContain("Accepted: full entryId, 8-char short ID, or strict unique prefix.");
		expect(lines).toContain("2h ago [current] · 1 item · 4/1/2026, 12:00:00 PM · [target00]");
	});

	it("formats explicit diff output with shared resolved-ID header", () => {
		const snapshots = [
			makeSnapshot("baseline01-1111", [{ key: "alpha", value: "first" }], "2026-04-01T10:00:00.000Z"),
			makeSnapshot("target001-2222", [{ key: "alpha", value: "second" }], "2026-04-01T12:00:00.000Z", true),
		];

		const lines = formatMemoryDiffOutput(
			snapshots,
			{
				getRelativeAgeLabel: () => "2h ago",
				resolveSnapshotSelector: (input) => resolveSnapshotSelector(input, snapshots),
			},
			{ baseline: "[baseline]", target: "[target00]" },
		);

		expect(lines.slice(0, 5)).toEqual([
			"Baseline: 2h ago — 4/1/2026, 10:00:00 AM",
			"        ID: [baseline] baseline01-1111",
			"Target:   2h ago — 4/1/2026, 12:00:00 PM",
			"        ID: [target00] target001-2222",
			"(snapshot comparison · not an event log)",
		]);
		expect(lines).toContain("~ Changed (1)");
		expect(lines).toContain("  ~ alpha:");
	});

	it("formats selector resolution failures via the shared formatter path", () => {
		const snapshots = [
			makeSnapshot("baseline01-1111", [{ key: "alpha", value: "first" }], "2026-04-01T10:00:00.000Z", true),
		];

		const lines = formatMemoryDiffOutput(
			snapshots,
			{
				getRelativeAgeLabel: () => "2h ago",
				resolveSnapshotSelector: (input) => resolveSnapshotSelector(input, snapshots),
			},
			{ baseline: "[]", target: "missing" },
		);

		expect(lines).toEqual([
			"Snapshot resolution failed in current branch history.",
			"",
			"Baseline selector is empty.",
			"Target ID not found: missing",
			"",
			"Run /memory history to see available snapshot IDs (shown in brackets after each age label).",
			"Accepted forms: full entryId, short ID (8 chars), or strict unique prefix. Brackets are optional.",
		]);
	});

	it("formats same-snapshot comparisons honestly", () => {
		const snapshots = [
			makeSnapshot("baseline01-1111", [{ key: "alpha", value: "first" }], "2026-04-01T10:00:00.000Z", true),
		];

		const lines = formatMemoryDiffOutput(
			snapshots,
			{
				getRelativeAgeLabel: () => "2h ago",
				resolveSnapshotSelector: (input) => resolveSnapshotSelector(input, snapshots),
			},
			{ baseline: "baseline01-1111", target: "[baseline]" },
		);

		expect(lines.at(-1)).toBe("Baseline and target are the same snapshot — no changes to show.");
	});

	it("formats adjacent initial snapshots honestly", () => {
		const lines = formatMemoryDiffOutput(
			[makeSnapshot("baseline01-1111", [{ key: "alpha", value: "first" }], "2026-04-01T10:00:00.000Z", true)],
			{
				getRelativeAgeLabel: () => "2h ago",
				resolveSnapshotSelector: () => {
					throw new Error("not used");
				},
			},
		);

		expect(lines).toEqual([
			"Initial snapshot — 1 item(s)",
			"",
			"Recorded: 4/1/2026, 10:00:00 AM",
			"(snapshot comparison · not an event log)",
		]);
	});

	it("formats relative age labels deterministically around thresholds", () => {
		const originalNow = Date.now;
		Date.now = () => new Date("2026-04-01T12:00:00.000Z").getTime();
		try {
			expect(formatRelativeAgeLabel(new Date("2026-04-01T11:59:45.000Z"))).toBe("just now");
			expect(formatRelativeAgeLabel(new Date("2026-04-01T11:58:00.000Z"))).toBe("2m ago");
			expect(formatRelativeAgeLabel(new Date("2026-03-31T12:00:00.000Z"))).toBe("1d ago");
		} finally {
			Date.now = originalNow;
		}
	});
});
