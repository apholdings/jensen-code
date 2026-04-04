import { visibleWidth } from "@apholdings/jensen-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { MemoryItem } from "../../../core/memory.js";
import { initTheme } from "../theme/theme.js";
import { type MemoryEditorCallbacks, MemoryEditorComponent } from "./memory-editor.js";

// Initialize theme before all tests (required by theme.ts)
beforeAll(() => {
	initTheme("dark");
});

const WIDTH = 80;

function makeCallbacks(overrides?: Partial<MemoryEditorCallbacks>): MemoryEditorCallbacks {
	return {
		getMemoryItems: () => [],
		getMemoryHistory: () => [],
		setMemoryItem: vi.fn().mockReturnValue([]),
		deleteMemoryItem: vi.fn().mockReturnValue([]),
		clearMemory: vi.fn().mockReturnValue([]),
		requestRender: vi.fn(),
		...overrides,
	};
}

function makeItem(key: string, value: string, daysAgo = 0): MemoryItem {
	const timestamp = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
	return { key, value, timestamp };
}

function makeSnapshot(
	id: string,
	items: Array<{ key: string; value: string }>,
	recordedAt = "2024-01-01T00:00:00.000Z",
	isCurrent = false,
): import("../../../core/memory.js").MemoryHistorySnapshot {
	return {
		entryId: id,
		parentId: null,
		recordedAt,
		items: items.map((i) => ({ ...i, timestamp: recordedAt })),
		isCurrent,
	};
}

describe("MemoryEditorComponent", () => {
	describe("render — list mode", () => {
		it("shows title and subtitle for empty state", () => {
			const cb = makeCallbacks({ getMemoryItems: () => [] });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			const lines = comp.render(WIDTH);
			expect(lines[0]).toContain("Session Memory");
			// Subtitle line should contain "(no memory items"
			expect(lines.find((l) => l.includes("(no memory items"))).toBeDefined();
		});

		it("shows stale indicator for old items", () => {
			const items = [makeItem("test", "hello", 10)];
			const cb = makeCallbacks({ getMemoryItems: () => items });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			const lines = comp.render(WIDTH);
			// Should contain the stale marker
			const staleLine = lines.find((l) => l.includes("test") && l.includes("⚠"));
			expect(staleLine).toBeDefined();
		});

		it("shows fresh indicator for recent items", () => {
			const items = [makeItem("test", "hello", 1)];
			const cb = makeCallbacks({ getMemoryItems: () => items });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			const lines = comp.render(WIDTH);
			// Should contain the fresh marker
			const freshLine = lines.find((l) => l.includes("test") && l.includes("✓"));
			expect(freshLine).toBeDefined();
		});

		it("shows selection cursor on selected item", () => {
			const items = [makeItem("first", "v1"), makeItem("second", "v2")];
			const cb = makeCallbacks({ getMemoryItems: () => items });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			// Default selectedIndex is 0
			const lines = comp.render(WIDTH);
			// First item should have cursor
			const selectedLine = lines.find((l) => l.includes("first") && l.includes("›"));
			expect(selectedLine).toBeDefined();
		});

		it("updates cursor when selectedIndex changes", () => {
			const items = [makeItem("first", "v1"), makeItem("second", "v2")];
			const cb = makeCallbacks({ getMemoryItems: () => items });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			comp.handleInput("j"); // Move down
			const lines = comp.render(WIDTH);
			const selectedLine = lines.find((l) => l.includes("second") && l.includes("›"));
			expect(selectedLine).toBeDefined();
		});

		it("truncates long value preview to terminal width", () => {
			const longValue = "a".repeat(100);
			const items = [makeItem("key", longValue)];
			const cb = makeCallbacks({ getMemoryItems: () => items });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			const lines = comp.render(WIDTH);
			const itemLine = lines.find((l) => l.includes("key"));
			expect(itemLine).toBeDefined();
			// Visible width must not exceed terminal width (ANSI codes add chars to .length)
			expect(visibleWidth(itemLine!)).toBeLessThanOrEqual(WIDTH);
		});
	});

	describe("render — input mode", () => {
		it("shows key prompt when adding", () => {
			const cb = makeCallbacks({ getMemoryItems: () => [] });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			comp.handleInput("a"); // start add
			const lines = comp.render(WIDTH);
			expect(lines[0]).toContain("Add Key");
		});

		it("shows value prompt after key entered", () => {
			const cb = makeCallbacks({ getMemoryItems: () => [] });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			comp.handleInput("a"); // start add
			comp.handleInput("k"); // type 'k'
			comp.handleInput("k"); // type 'k' (key: "kk")
			comp.handleInput("\r"); // submit key
			const lines = comp.render(WIDTH);
			expect(lines[0]).toContain("Add Value");
		});

		it("cancel reverts to list mode", () => {
			const cb = makeCallbacks({ getMemoryItems: () => [] });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			comp.handleInput("a"); // start add
			comp.handleInput("\x1b"); // cancel
			const lines = comp.render(WIDTH);
			expect(lines[0]).toContain("Session Memory");
			expect(lines[0]).not.toContain("Add");
		});
	});

	describe("render — confirm mode", () => {
		it("shows confirm delete prompt with key", () => {
			const items = [makeItem("mykey", "val")];
			const cb = makeCallbacks({ getMemoryItems: () => items });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			// Trigger delete mode directly
			(comp as any).mode = "confirm_delete";
			(comp as any).editingItemKey = "mykey";
			const lines = comp.render(WIDTH);
			expect(lines.find((l) => l.includes("Confirm Delete"))).toBeDefined();
			expect(lines.find((l) => l.includes("mykey"))).toBeDefined();
		});

		it("confirm delete calls backend", () => {
			const deleteMock = vi.fn().mockReturnValue([]);
			const items = [makeItem("todelete", "val")];
			const cb = makeCallbacks({ getMemoryItems: () => items, deleteMemoryItem: deleteMock });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			(comp as any).startDelete("todelete");
			comp.handleInput("\r"); // confirm
			expect(deleteMock).toHaveBeenCalledWith("todelete");
		});

		it("confirm clear calls backend", () => {
			const clearMock = vi.fn().mockReturnValue([]);
			const items = [makeItem("a", "b")];
			const cb = makeCallbacks({ getMemoryItems: () => items, clearMemory: clearMock });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			(comp as any).startClearAll();
			comp.handleInput("\r"); // confirm
			expect(clearMock).toHaveBeenCalled();
		});
	});

	describe("render — review mode", () => {
		it("shows review title", () => {
			const items = [makeItem("a", "b", 10)];
			const cb = makeCallbacks({ getMemoryItems: () => items });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			comp.handleInput("r"); // enter review mode
			const lines = comp.render(WIDTH);
			expect(lines[0]).toContain("Review");
		});

		it("shows stale section by default when items are stale", () => {
			const items = [makeItem("old", "v", 20)];
			const cb = makeCallbacks({ getMemoryItems: () => items });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			comp.handleInput("r");
			const lines = comp.render(WIDTH);
			// Should have stale tab selected
			expect(lines.find((l) => l.includes("◉ Stale"))).toBeDefined();
		});

		it("switches section on left/right arrow", () => {
			const items = [makeItem("old", "v", 20), makeItem("new", "v", 1)];
			const cb = makeCallbacks({ getMemoryItems: () => items });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			comp.handleInput("r"); // enter review
			comp.handleInput("\u001b[C]"); // right arrow
			const lines = comp.render(WIDTH);
			expect(lines.find((l) => l.includes("◉ Fresh"))).toBeDefined();
		});
	});

	describe("refresh()", () => {
		it("clamps selectedIndex to valid range", () => {
			const items = [makeItem("a", "b")];
			const cb = makeCallbacks({ getMemoryItems: () => items });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			// Select second item (index 1) when only one item exists
			(comp as any).selectedIndex = 5;
			comp.refresh();
			expect((comp as any).selectedIndex).toBe(0);
		});
	});

	describe("add flow", () => {
		it("saves new item through backend", () => {
			const setMock = vi.fn().mockReturnValue([makeItem("newkey", "newval")]);
			const cb = makeCallbacks({ getMemoryItems: () => [], setMemoryItem: setMock });
			const comp = new MemoryEditorComponent(cb, vi.fn());

			comp.handleInput("a"); // start add
			// Type key character by character
			comp.handleInput("n");
			comp.handleInput("e");
			comp.handleInput("w");
			comp.handleInput("k");
			comp.handleInput("e");
			comp.handleInput("y");
			comp.handleInput("\r"); // submit key

			// Type value
			comp.handleInput("n");
			comp.handleInput("e");
			comp.handleInput("w");
			comp.handleInput("v");
			comp.handleInput("a");
			comp.handleInput("l");
			comp.handleInput("\r"); // submit value

			expect(setMock).toHaveBeenCalledWith("newkey", "newval");
		});
	});

	describe("baseline picker — history list", () => {
		it("b key arms current snapshot as baseline", () => {
			const snapshots = [
				makeSnapshot("s0", [{ key: "old", value: "v" }], "2024-01-01T00:00:00.000Z", false),
				makeSnapshot("s1", [{ key: "mid", value: "v" }], "2024-01-02T00:00:00.000Z", false),
				makeSnapshot("s2", [{ key: "new", value: "v" }], "2024-01-03T00:00:00.000Z", true),
			];
			const cb = makeCallbacks({ getMemoryHistory: () => snapshots });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			comp.handleInput("h"); // enter history (selectedIndex=0, newest)
			comp.handleInput("b"); // arm as baseline
			expect((comp as any).armedBaselineIndex).toBe(2); // chronological index of s2
		});

		it("baseline marker visible in history list render output", () => {
			const snapshots = [
				makeSnapshot("s0", [{ key: "a", value: "v" }], "2024-01-01T00:00:00.000Z", false),
				makeSnapshot("s1", [{ key: "b", value: "v" }], "2024-01-02T00:00:00.000Z", true),
			];
			const cb = makeCallbacks({ getMemoryHistory: () => snapshots });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			comp.handleInput("h"); // enter history
			comp.handleInput("b"); // arm baseline (s1, chronological index 1)
			const lines = comp.render(WIDTH);
			// Should contain the baseline marker
			expect(lines.some((l) => l.includes("[baseline]"))).toBe(true);
		});

		it("re-arming baseline changes selected baseline", () => {
			const snapshots = [
				makeSnapshot("s0", [{ key: "a", value: "v" }], "2024-01-01T00:00:00.000Z", false),
				makeSnapshot("s1", [{ key: "b", value: "v" }], "2024-01-02T00:00:00.000Z", false),
				makeSnapshot("s2", [{ key: "c", value: "v" }], "2024-01-03T00:00:00.000Z", true),
			];
			const cb = makeCallbacks({ getMemoryHistory: () => snapshots });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			comp.handleInput("h"); // enter history (selectedIndex=0, s2 newest)
			comp.handleInput("b"); // arm s2 (chronological index 2)
			comp.handleInput("j"); // move down to s1 (selectedIndex=1, reversed)
			comp.handleInput("b"); // re-arm to s1 (chronological index 1)
			expect((comp as any).armedBaselineIndex).toBe(1);
		});
	});

	describe("baseline picker — history detail", () => {
		it("baseline marker shown in history detail when viewing armed snapshot", () => {
			const snapshots = [
				makeSnapshot("s0", [{ key: "a", value: "v" }], "2024-01-01T00:00:00.000Z", false),
				makeSnapshot("s1", [{ key: "b", value: "v" }], "2024-01-02T00:00:00.000Z", true),
			];
			const cb = makeCallbacks({ getMemoryHistory: () => snapshots });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			comp.handleInput("h"); // enter history
			comp.handleInput("b"); // arm baseline (s1)
			comp.handleInput("\r"); // enter detail
			const lines = comp.render(WIDTH);
			expect(lines.some((l) => l.includes("[baseline]"))).toBe(true);
		});

		it("b key arms current snapshot as baseline in detail mode", () => {
			const snapshots = [
				makeSnapshot("s0", [{ key: "a", value: "v" }], "2024-01-01T00:00:00.000Z", false),
				makeSnapshot("s1", [{ key: "b", value: "v" }], "2024-01-02T00:00:00.000Z", true),
			];
			const cb = makeCallbacks({ getMemoryHistory: () => snapshots });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			comp.handleInput("h"); // enter history
			comp.handleInput("\r"); // enter detail (on s1)
			comp.handleInput("b"); // arm s1 as baseline
			expect((comp as any).armedBaselineIndex).toBe(1);
		});

		it("c key clears armed baseline in detail mode", () => {
			const snapshots = [
				makeSnapshot("s0", [{ key: "a", value: "v" }], "2024-01-01T00:00:00.000Z", false),
				makeSnapshot("s1", [{ key: "b", value: "v" }], "2024-01-02T00:00:00.000Z", true),
			];
			const cb = makeCallbacks({ getMemoryHistory: () => snapshots });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			comp.handleInput("h");
			comp.handleInput("b"); // arm baseline
			comp.handleInput("\r");
			comp.handleInput("c"); // clear baseline
			expect((comp as any).armedBaselineIndex).toBeNull();
		});
	});

	describe("baseline picker — diff semantics", () => {
		it("d with explicit baseline enters target-picking, Enter opens diff", () => {
			const snapshots = [
				makeSnapshot("s0", [{ key: "a", value: "old" }], "2024-01-01T00:00:00.000Z", false),
				makeSnapshot("s1", [{ key: "a", value: "new" }], "2024-01-02T00:00:00.000Z", false),
				makeSnapshot("s2", [{ key: "a", value: "newer" }], "2024-01-03T00:00:00.000Z", true),
			];
			const cb = makeCallbacks({ getMemoryHistory: () => snapshots });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			comp.handleInput("h");
			comp.handleInput("b"); // arm s2 (index 2) as baseline
			comp.handleInput("\u001b[D]"); // go to s1 in history (prev snapshot, chronological index 1)
			comp.handleInput("d"); // enter target-picking
			expect((comp as any).compareStep).toBe("target_picking");
			expect((comp as any).mode).toBe("history"); // still in history mode
			comp.handleInput("\r"); // confirm target → open diff
			expect((comp as any).diffBaseIndex).toBe(2); // explicit baseline
			expect((comp as any).compareStep).toBe("none");
			expect((comp as any).mode).toBe("history_diff");
		});

		it("d without baseline still opens adjacent diff immediately", () => {
			const snapshots = [
				makeSnapshot("s0", [{ key: "a", value: "old" }], "2024-01-01T00:00:00.000Z", false),
				makeSnapshot("s1", [{ key: "a", value: "new" }], "2024-01-02T00:00:00.000Z", false),
				makeSnapshot("s2", [{ key: "a", value: "newer" }], "2024-01-03T00:00:00.000Z", true),
			];
			const cb = makeCallbacks({ getMemoryHistory: () => snapshots });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			comp.handleInput("h");
			// Enter detail on s2 (selectedIndex=2)
			comp.handleInput("\r");
			// Arrow left to s1 (selectedIndex=1)
			comp.handleInput("\u001b[D]");
			// d without baseline: adjacent diff immediately
			comp.handleInput("d");
			expect((comp as any).compareStep).toBe("none");
			expect((comp as any).diffBaseIndex).toBe(0); // adjacent previous
			expect((comp as any).mode).toBe("history_diff");
		});

		it("compare same snapshot to itself yields no changes", () => {
			const snapshots = [
				makeSnapshot("s0", [{ key: "a", value: "v" }], "2024-01-01T00:00:00.000Z", false),
				makeSnapshot("s1", [{ key: "a", value: "v" }], "2024-01-02T00:00:00.000Z", true),
			];
			const cb = makeCallbacks({ getMemoryHistory: () => snapshots });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			comp.handleInput("h");
			comp.handleInput("b"); // arm s1 as baseline
			comp.handleInput("j"); // move to s0 (selectedIndex=1 reversed = chron 0)
			comp.handleInput("d"); // enter target-picking
			expect((comp as any).compareStep).toBe("target_picking");
			comp.handleInput("\r"); // confirm target → open diff (s1 baseline → s0 target)
			expect((comp as any).diffBaseIndex).toBe(1); // s1 baseline
			expect((comp as any).selectedIndex).toBe(0); // s0 chronologically
			const lines = comp.render(WIDTH);
			// Should show "No changes between snapshots"
			expect(lines.some((l) => l.includes("No changes"))).toBe(true);
		});

		it("c key clears baseline in diff mode", () => {
			const snapshots = [
				makeSnapshot("s0", [{ key: "a", value: "old" }], "2024-01-01T00:00:00.000Z", false),
				makeSnapshot("s1", [{ key: "a", value: "new" }], "2024-01-02T00:00:00.000Z", false),
				makeSnapshot("s2", [{ key: "a", value: "newer" }], "2024-01-03T00:00:00.000Z", true),
			];
			const cb = makeCallbacks({ getMemoryHistory: () => snapshots });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			comp.handleInput("h");
			comp.handleInput("b"); // arm s2 as baseline
			comp.handleInput("\u001b[D]"); // go to s1
			comp.handleInput("d"); // enter target-picking
			comp.handleInput("\r"); // confirm → open diff
			expect((comp as any).armedBaselineIndex).toBe(2);
			expect((comp as any).compareStep).toBe("none");
			comp.handleInput("c"); // clear baseline
			expect((comp as any).armedBaselineIndex).toBeNull();
			// Should still be in diff mode
			expect((comp as any).mode).toBe("history_diff");
		});

		it("c key clears baseline in history list mode", () => {
			const snapshots = [
				makeSnapshot("s0", [{ key: "a", value: "v" }], "2024-01-01T00:00:00.000Z", false),
				makeSnapshot("s1", [{ key: "b", value: "v" }], "2024-01-02T00:00:00.000Z", true),
			];
			const cb = makeCallbacks({ getMemoryHistory: () => snapshots });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			comp.handleInput("h");
			comp.handleInput("b"); // arm baseline
			expect((comp as any).armedBaselineIndex).toBe(1);
			comp.handleInput("c"); // clear baseline
			expect((comp as any).armedBaselineIndex).toBeNull();
			const lines = comp.render(WIDTH);
			expect(lines.some((l) => l.includes("[baseline]"))).toBe(false);
		});
	});

	describe("two-step compare chooser", () => {
		it("d enters target-picking in history list when baseline armed", () => {
			const snapshots = [
				makeSnapshot("s0", [{ key: "a", value: "v" }], "2024-01-01T00:00:00.000Z", false),
				makeSnapshot("s1", [{ key: "b", value: "v" }], "2024-01-02T00:00:00.000Z", true),
			];
			const cb = makeCallbacks({ getMemoryHistory: () => snapshots });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			comp.handleInput("h");
			comp.handleInput("b"); // arm baseline (s1, index 1)
			expect((comp as any).compareStep).toBe("none");
			comp.handleInput("d"); // enter target-picking
			expect((comp as any).compareStep).toBe("target_picking");
			expect((comp as any).mode).toBe("history"); // stays in history mode
		});

		it("target-picking renders [selecting target] subtitle with baseline annotation", () => {
			const snapshots = [
				makeSnapshot("s0", [{ key: "a", value: "v" }], "2024-01-01T00:00:00.000Z", false),
				makeSnapshot("s1", [{ key: "b", value: "v" }], "2024-01-02T00:00:00.000Z", true),
			];
			const cb = makeCallbacks({ getMemoryHistory: () => snapshots });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			comp.handleInput("h");
			comp.handleInput("b"); // arm baseline
			comp.handleInput("d"); // enter target-picking
			const lines = comp.render(WIDTH);
			// Should show baseline and selecting target in subtitle
			expect(lines.some((l) => l.includes("[baseline:"))).toBe(true);
			expect(lines.some((l) => l.includes("[selecting target:"))).toBe(true);
		});

		it("target-picking shows [target] marker on selected line", () => {
			const snapshots = [
				makeSnapshot("s0", [{ key: "a", value: "v" }], "2024-01-01T00:00:00.000Z", false),
				makeSnapshot("s1", [{ key: "b", value: "v" }], "2024-01-02T00:00:00.000Z", true),
			];
			const cb = makeCallbacks({ getMemoryHistory: () => snapshots });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			comp.handleInput("h");
			comp.handleInput("b"); // arm s1 (selectedIndex=0 in reversed = index 1 chron)
			comp.handleInput("j"); // move to s0 (selectedIndex=1 in reversed = index 0 chron)
			comp.handleInput("d"); // enter target-picking
			const lines = comp.render(WIDTH);
			// Selected line (s0) should show [target] marker
			expect(lines.some((l) => l.includes("[target]"))).toBe(true);
		});

		it("Enter confirms target and opens diff", () => {
			const snapshots = [
				makeSnapshot("s0", [{ key: "a", value: "old" }], "2024-01-01T00:00:00.000Z", false),
				makeSnapshot("s1", [{ key: "b", value: "new" }], "2024-01-02T00:00:00.000Z", true),
			];
			const cb = makeCallbacks({ getMemoryHistory: () => snapshots });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			comp.handleInput("h");
			comp.handleInput("b"); // arm s1 as baseline (chron index 1)
			comp.handleInput("j"); // move to s0 (selectedIndex=1 reversed)
			comp.handleInput("d"); // enter target-picking
			comp.handleInput("\r"); // confirm target
			expect((comp as any).mode).toBe("history_diff");
			expect((comp as any).diffBaseIndex).toBe(1); // baseline s1
			expect((comp as any).compareStep).toBe("none");
		});

		it("d also confirms target and opens diff from target-picking", () => {
			const snapshots = [
				makeSnapshot("s0", [{ key: "a", value: "old" }], "2024-01-01T00:00:00.000Z", false),
				makeSnapshot("s1", [{ key: "b", value: "new" }], "2024-01-02T00:00:00.000Z", true),
			];
			const cb = makeCallbacks({ getMemoryHistory: () => snapshots });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			comp.handleInput("h");
			comp.handleInput("b"); // arm s1
			comp.handleInput("j"); // move to s0
			comp.handleInput("d"); // enter target-picking
			comp.handleInput("d"); // d also confirms target
			expect((comp as any).mode).toBe("history_diff");
			expect((comp as any).diffBaseIndex).toBe(1);
		});

		it("Escape exits target-picking and keeps baseline armed", () => {
			const snapshots = [
				makeSnapshot("s0", [{ key: "a", value: "v" }], "2024-01-01T00:00:00.000Z", false),
				makeSnapshot("s1", [{ key: "b", value: "v" }], "2024-01-02T00:00:00.000Z", true),
			];
			const cb = makeCallbacks({ getMemoryHistory: () => snapshots });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			comp.handleInput("h");
			comp.handleInput("b"); // arm s1
			comp.handleInput("d"); // enter target-picking
			expect((comp as any).compareStep).toBe("target_picking");
			expect((comp as any).armedBaselineIndex).toBe(1);
			comp.handleInput("\x1b"); // Escape — exit target-picking, keep baseline
			expect((comp as any).compareStep).toBe("none");
			expect((comp as any).armedBaselineIndex).toBe(1); // baseline preserved
		});

		it("c clears baseline and exits target-picking", () => {
			const snapshots = [
				makeSnapshot("s0", [{ key: "a", value: "v" }], "2024-01-01T00:00:00.000Z", false),
				makeSnapshot("s1", [{ key: "b", value: "v" }], "2024-01-02T00:00:00.000Z", true),
			];
			const cb = makeCallbacks({ getMemoryHistory: () => snapshots });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			comp.handleInput("h");
			comp.handleInput("b"); // arm s1
			comp.handleInput("d"); // enter target-picking
			expect((comp as any).compareStep).toBe("target_picking");
			comp.handleInput("c"); // clear baseline + exit target-picking
			expect((comp as any).armedBaselineIndex).toBeNull();
			expect((comp as any).compareStep).toBe("none");
		});

		it("same snapshot as baseline and target shows (same snapshot) in subtitle", () => {
			const snapshots = [
				makeSnapshot("s0", [{ key: "a", value: "v" }], "2024-01-01T00:00:00.000Z", false),
				makeSnapshot("s1", [{ key: "b", value: "v" }], "2024-01-02T00:00:00.000Z", true),
			];
			const cb = makeCallbacks({ getMemoryHistory: () => snapshots });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			comp.handleInput("h");
			comp.handleInput("b"); // arm s1 (selectedIndex=0 in reversed)
			comp.handleInput("d"); // enter target-picking, s1 is already selected as target
			const lines = comp.render(WIDTH);
			expect(lines.some((l) => l.includes("(same snapshot)"))).toBe(true);
		});

		it("baseline arming still works after target-picking is cancelled", () => {
			const snapshots = [
				makeSnapshot("s0", [{ key: "a", value: "v" }], "2024-01-01T00:00:00.000Z", false),
				makeSnapshot("s1", [{ key: "b", value: "v" }], "2024-01-02T00:00:00.000Z", true),
			];
			const cb = makeCallbacks({ getMemoryHistory: () => snapshots });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			comp.handleInput("h");
			comp.handleInput("b"); // arm s1
			comp.handleInput("d"); // enter target-picking
			comp.handleInput("\x1b"); // cancel — baseline kept
			expect((comp as any).armedBaselineIndex).toBe(1);
			// Can re-arm to a different snapshot
			comp.handleInput("j"); // move to s0
			comp.handleInput("b"); // re-arm to s0
			expect((comp as any).armedBaselineIndex).toBe(0);
		});

		it("d enters target-picking in history detail when baseline armed", () => {
			const snapshots = [
				makeSnapshot("s0", [{ key: "a", value: "v" }], "2024-01-01T00:00:00.000Z", false),
				makeSnapshot("s1", [{ key: "b", value: "v" }], "2024-01-02T00:00:00.000Z", true),
			];
			const cb = makeCallbacks({ getMemoryHistory: () => snapshots });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			comp.handleInput("h");
			comp.handleInput("\r"); // enter detail on s1
			comp.handleInput("b"); // arm baseline
			comp.handleInput("d"); // enter target-picking
			expect((comp as any).compareStep).toBe("target_picking");
			expect((comp as any).mode).toBe("history_detail"); // stays in detail mode
		});

		it("Enter confirms target from history detail and opens diff", () => {
			const snapshots = [
				makeSnapshot("s0", [{ key: "a", value: "old" }], "2024-01-01T00:00:00.000Z", false),
				makeSnapshot("s1", [{ key: "b", value: "new" }], "2024-01-02T00:00:00.000Z", true),
			];
			const cb = makeCallbacks({ getMemoryHistory: () => snapshots });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			comp.handleInput("h");
			comp.handleInput("b"); // arm s1 as baseline
			comp.handleInput("\r"); // enter detail
			comp.handleInput("\u001b[D]"); // go to s0
			comp.handleInput("d"); // enter target-picking
			comp.handleInput("\r"); // confirm target
			expect((comp as any).mode).toBe("history_diff");
			expect((comp as any).diffBaseIndex).toBe(1); // baseline s1
		});

		it("refresh exits target-picking when no snapshots remain", () => {
			const snapshots = [
				makeSnapshot("s0", [{ key: "a", value: "v" }], "2024-01-01T00:00:00.000Z", false),
				makeSnapshot("s1", [{ key: "b", value: "v" }], "2024-01-02T00:00:00.000Z", true),
			];
			const cb = makeCallbacks({ getMemoryHistory: () => snapshots });
			const comp = new MemoryEditorComponent(cb, vi.fn());
			comp.handleInput("h");
			comp.handleInput("b"); // arm baseline
			comp.handleInput("d"); // enter target-picking
			expect((comp as any).compareStep).toBe("target_picking");
			// Simulate snapshots becoming empty
			cb.getMemoryHistory = () => [];
			comp.refresh();
			expect((comp as any).compareStep).toBe("none");
		});
	});
});
