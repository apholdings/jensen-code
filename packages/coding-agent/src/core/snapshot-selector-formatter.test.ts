import { describe, expect, it } from "vitest";
import type { MemoryHistorySnapshot } from "./memory.js";
import {
	formatAdjacentDiffHeader,
	formatExplicitDiffHeader,
	formatResolvedSnapshotId,
	formatSnapshotSelectorAcceptedForms,
	formatSnapshotSelectorHistoryGuidance,
	formatSnapshotSelectorIssues,
	formatSnapshotSelectorResolutionFailure,
	formatSnapshotShortId,
} from "./snapshot-selector-formatter.js";
import type { SnapshotResolution } from "./snapshot-selector-resolver.js";
import { MEMORY_SNAPSHOT_SHORT_ID_LENGTH } from "./snapshot-selector-resolver.js";

function makeSnapshot(entryId: string, recordedAt = "2026-04-01T00:00:00.000Z"): MemoryHistorySnapshot {
	return {
		entryId,
		parentId: null,
		recordedAt,
		items: [],
		isCurrent: false,
	};
}

function makeResolution(overrides: Partial<SnapshotResolution>): SnapshotResolution {
	return {
		snapshot: undefined,
		matchedInput: "",
		resolvedId: undefined,
		error: undefined,
		candidates: [],
		...overrides,
	};
}

describe("snapshot selector formatter", () => {
	it("formats empty selector issues", () => {
		const lines = formatSnapshotSelectorIssues([
			{ label: "Baseline", resolution: makeResolution({ error: "empty" }) },
		]);

		expect(lines).toEqual(["Baseline selector is empty."]);
	});

	it("formats not-found selector issues", () => {
		const lines = formatSnapshotSelectorIssues([
			{ label: "Target", resolution: makeResolution({ error: "not_found", matchedInput: "abc12345" }) },
		]);

		expect(lines).toEqual(["Target ID not found: abc12345"]);
	});

	it("formats ambiguous selector issues with candidate IDs", () => {
		const lines = formatSnapshotSelectorIssues([
			{
				label: "Baseline",
				resolution: makeResolution({
					error: "ambiguous",
					matchedInput: "abc",
					candidates: ["abc00001-1111", "abc00002-2222"],
				}),
			},
		]);

		expect(lines).toEqual([
			"Baseline ID is ambiguous: abc",
			"  [abc00001] abc00001-1111",
			"  [abc00002] abc00002-2222",
		]);
	});

	it("combines failure header, issue details, and accepted forms guidance", () => {
		const lines = formatSnapshotSelectorResolutionFailure([
			{ label: "Baseline", resolution: makeResolution({ error: "empty" }) },
			{ label: "Target", resolution: makeResolution({ error: "not_found", matchedInput: "deadbeef" }) },
		]);

		expect(lines).toEqual([
			"Snapshot resolution failed in current branch history.",
			"",
			"Baseline selector is empty.",
			"Target ID not found: deadbeef",
			"",
			"Run /memory history to see available snapshot IDs (shown in brackets after each age label).",
			formatSnapshotSelectorAcceptedForms(),
		]);
	});

	it("returns empty failure output when no issues are present", () => {
		expect(
			formatSnapshotSelectorResolutionFailure([
				{
					label: "Baseline",
					resolution: makeResolution({ snapshot: makeSnapshot("abc12345-1111"), resolvedId: "abc12345-1111" }),
				},
			]),
		).toEqual([]);
	});

	it("formats history guidance lines deterministically", () => {
		expect(formatSnapshotSelectorHistoryGuidance()).toEqual([
			"Use /memory diff <baselineId> <targetId> to compare any two snapshots.",
			"IDs shown in brackets ([xxxxxxxx]) can be copied directly; brackets are optional.",
			"Accepted: full entryId, 8-char short ID, or strict unique prefix.",
		]);
	});

	it("formats short IDs and resolved IDs", () => {
		expect(formatSnapshotShortId("abc12345-1111")).toBe("[abc12345]");
		expect(formatResolvedSnapshotId("abc12345-1111")).toBe("[abc12345] abc12345-1111");
	});

	it("formats explicit diff header with resolved IDs", () => {
		const lines = formatExplicitDiffHeader({
			baselineSnapshot: makeSnapshot("baseline01-1111", "2026-04-01T10:00:00.000Z"),
			targetSnapshot: makeSnapshot("target001-2222", "2026-04-01T12:00:00.000Z"),
			getRelativeAgeLabel: () => "2h ago",
		});

		expect(lines).toEqual([
			"Baseline: 2h ago — 4/1/2026, 10:00:00 AM",
			"        ID: [baseline] baseline01-1111",
			"Target:   2h ago — 4/1/2026, 12:00:00 PM",
			"        ID: [target00] target001-2222",
			"(snapshot comparison · not an event log)",
			"",
		]);
	});

	it("formats adjacent diff header", () => {
		const lines = formatAdjacentDiffHeader({
			baselineSnapshot: makeSnapshot("baseline01-1111", "2026-04-01T10:00:00.000Z"),
			targetSnapshot: makeSnapshot("target001-2222", "2026-04-01T12:00:00.000Z"),
			getRelativeAgeLabel: () => "2h ago",
		});

		expect(lines).toEqual([
			"Comparing: 2h ago → 2h ago",
			"4/1/2026, 10:00:00 AM → 4/1/2026, 12:00:00 PM",
			"(snapshot comparison · not an event log)",
			"",
		]);
	});

	it("respects custom short ID length where applicable", () => {
		expect(formatSnapshotShortId("abc12345-1111", 4)).toBe("[abc1]");
		expect(formatResolvedSnapshotId("abc12345-1111", 4)).toBe("[abc1] abc12345-1111");
		expect(formatSnapshotSelectorAcceptedForms(6)).toContain("6 chars");
		expect(formatSnapshotSelectorHistoryGuidance(6)[1]).toBe(
			"IDs shown in brackets ([xxxxxx]) can be copied directly; brackets are optional.",
		);
		expect(MEMORY_SNAPSHOT_SHORT_ID_LENGTH).toBe(8);
	});
});
