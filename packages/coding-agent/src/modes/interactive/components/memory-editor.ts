/**
 * Dedicated interactive memory editor UI component.
 * Displays session memory items with navigation, editing, and review capabilities.
 */

import {
	Container,
	type Focusable,
	getEditorKeybindings,
	Input,
	truncateToWidth,
	visibleWidth,
} from "@apholdings/jensen-tui";
import type { MemoryHistorySnapshot, MemoryItem } from "../../../core/memory.js";
import { computeMemorySnapshotDiff } from "../../../core/memory-diff.js";
import { MEMORY_STALE_AFTER_DAYS, type MemoryReviewItem, reviewMemoryItems } from "../../../core/memory-review.js";
import { theme } from "../theme/theme.js";
import { keyHint, rawKeyHint } from "./keybinding-hints.js";

type EditorMode =
	| "list"
	| "add_key"
	| "add_value"
	| "edit_key"
	| "edit_value"
	| "confirm_delete"
	| "confirm_clear"
	| "review"
	| "history"
	| "history_detail"
	| "history_diff";

/** Section of the review view */
type ReviewSection = "stale" | "fresh";

export interface MemoryEditorCallbacks {
	getMemoryItems(): readonly MemoryItem[];
	getMemoryHistory(): readonly MemoryHistorySnapshot[];
	setMemoryItem(key: string, value: string): MemoryItem[];
	deleteMemoryItem(key: string): MemoryItem[];
	clearMemory(): MemoryItem[];
	requestRender(): void;
}

export class MemoryEditorComponent extends Container implements Focusable {
	private mode: EditorMode = "list";
	private selectedIndex = 0;
	private reviewSection: ReviewSection = "stale";

	// Input state
	private keyInput = new Input();
	private valueInput = new Input();
	private editingItemKey: string | null = null;

	private callbacks: MemoryEditorCallbacks;
	private requestRender: () => void;

	private readonly maxVisible = 12;
	private readonly maxValuePreview = 40;

	/** Index of the base snapshot for diff mode (the earlier snapshot in the pair) */
	private diffBaseIndex: number | null = null;

	/** Index (in original chronological order) of the explicitly armed baseline snapshot */
	private armedBaselineIndex: number | null = null;

	/**
	 * Tracks the explicit two-step compare chooser flow.
	 * - "none": no compare chooser active
	 * - "target_picking": baseline is armed; operator is selecting a target snapshot
	 */
	private compareStep: "none" | "target_picking" = "none";

	// Focusable implementation
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		if (this.mode === "add_key" || this.mode === "edit_key") {
			this.keyInput.focused = value;
		} else if (this.mode === "add_value" || this.mode === "edit_value") {
			this.valueInput.focused = value;
		}
	}

	constructor(callbacks: MemoryEditorCallbacks, requestRender: () => void) {
		super();
		this.callbacks = callbacks;
		this.requestRender = requestRender;

		this.keyInput.onSubmit = () => this.onKeyInputSubmit();
		this.valueInput.onSubmit = () => this.onValueInputSubmit();
	}

	// -------------------------------------------------------------------------
	// Public API
	// -------------------------------------------------------------------------

	/** Refresh the displayed list from current backend state */
	refresh(): void {
		const items = this.callbacks.getMemoryItems();
		if (this.selectedIndex >= items.length) {
			this.selectedIndex = Math.max(0, items.length - 1);
		}
		// In review mode, switch section if current one is empty
		if (this.mode === "review") {
			this.syncReviewSection();
		}
		// In history mode, sync selection if snapshots changed
		if (this.mode === "history" || this.mode === "history_detail" || this.mode === "history_diff") {
			this.syncHistorySelection();
		}
		// In history_diff, clamp diffBaseIndex to valid range
		if (this.mode === "history_diff" && this.diffBaseIndex !== null) {
			const snapshots = this.callbacks.getMemoryHistory();
			this.diffBaseIndex = Math.min(this.diffBaseIndex, Math.max(0, snapshots.length - 1));
			this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, snapshots.length - 1));
		}
		// Clamp armed baseline to valid range
		if (this.armedBaselineIndex !== null) {
			const snapshots = this.callbacks.getMemoryHistory();
			if (this.armedBaselineIndex >= snapshots.length) {
				this.armedBaselineIndex = snapshots.length > 0 ? snapshots.length - 1 : null;
			}
		}
		// When in compare chooser, exit cleanly if no snapshots
		if (this.compareStep === "target_picking") {
			const snapshots = this.callbacks.getMemoryHistory();
			if (snapshots.length === 0) {
				this.compareStep = "none";
			}
		}
	}

	// -------------------------------------------------------------------------
	// Rendering
	// -------------------------------------------------------------------------

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];

		if (
			this.mode === "list" ||
			this.mode === "review" ||
			this.mode === "history" ||
			this.mode === "history_detail" ||
			this.mode === "history_diff" ||
			this.mode === "confirm_delete" ||
			this.mode === "confirm_clear"
		) {
			return this.renderListMode(width);
		} else if (
			this.mode === "add_key" ||
			this.mode === "edit_key" ||
			this.mode === "add_value" ||
			this.mode === "edit_value"
		) {
			return this.renderInputMode(width);
		}

		return lines;
	}

	private renderListMode(width: number): string[] {
		const lines: string[] = [];

		// Title bar
		lines.push(...this.renderTitleBar(width));

		if (this.mode === "review") {
			lines.push(...this.renderReviewMode(width));
		} else if (this.mode === "history") {
			lines.push(...this.renderHistoryMode(width));
		} else if (this.mode === "history_detail") {
			lines.push(...this.renderHistoryDetailMode(width));
		} else if (this.mode === "history_diff") {
			lines.push(...this.renderHistoryDiffMode(width));
		} else if (this.mode === "confirm_delete" || this.mode === "confirm_clear") {
			lines.push(...this.renderConfirmMode(width));
		} else {
			lines.push(...this.renderItemList(width));
		}

		return lines;
	}

	private renderTitleBar(width: number): string[] {
		const lines: string[] = [];
		const titleText =
			this.mode === "review"
				? "Session Memory — Review"
				: this.mode === "history"
					? "Memory History — Snapshots"
					: this.mode === "history_detail"
						? "Memory History — Snapshot Detail"
						: this.mode === "history_diff"
							? "Memory History — Snapshot Diff"
							: this.mode === "confirm_delete"
								? "Session Memory — Confirm Delete"
								: this.mode === "confirm_clear"
									? "Session Memory — Confirm Clear"
									: "Session Memory";

		const left = theme.bold(theme.fg("accent", titleText));
		const freshnessNote =
			this.mode === "history" || this.mode === "history_detail" || this.mode === "history_diff"
				? theme.fg("muted", "  (snapshot timeline · not event log)")
				: theme.fg("muted", `  (freshness is heuristic · ${MEMORY_STALE_AFTER_DAYS}d threshold)`);
		const right = freshnessNote;
		const rightWidth = visibleWidth(right);
		const availableLeft = Math.max(0, width - rightWidth - 1);
		const leftTruncated = truncateToWidth(left, availableLeft, "…");
		const spacing = Math.max(1, width - visibleWidth(leftTruncated) - rightWidth);
		lines.push(`${leftTruncated}${" ".repeat(spacing)}${right}`);

		// Subtitle
		const items = this.callbacks.getMemoryItems();
		const reviewed = reviewMemoryItems([...items]);
		const staleCount = reviewed.filter((r) => r.reviewRecommended).length;
		const subtitleParts: string[] = [];

		if (this.mode === "history") {
			// History shows snapshot count, newest first
			const snapshots = this.callbacks.getMemoryHistory();
			if (snapshots.length === 0) {
				subtitleParts.push(theme.fg("dim", "No snapshots"));
			} else {
				const currentCount = snapshots.filter((s) => s.isCurrent).length;
				if (this.compareStep === "target_picking") {
					// Show baseline → target annotation during explicit chooser
					// In history mode, selectedIndex is reversed display order.
					// Convert to chronological for snapshot access.
					const targetChronologicalIndex = snapshots.length - 1 - this.selectedIndex;
					const baseline = snapshots[this.armedBaselineIndex!]!;
					const targetSnapshot = snapshots[targetChronologicalIndex]!;
					const baselineDate = new Date(baseline.recordedAt);
					const targetDate = new Date(targetSnapshot.recordedAt);
					const baselineLabel = this.getRelativeAgeLabel(baselineDate);
					const targetLabel = this.getRelativeAgeLabel(targetDate);
					subtitleParts.push(
						theme.fg("warning", `[baseline: ${baselineLabel}]`),
						" ",
						theme.fg("accent", `[selecting target: ${targetLabel}]`),
					);
					if (this.armedBaselineIndex === targetChronologicalIndex) {
						subtitleParts.push(" ", theme.fg("dim", "(same snapshot)"));
					}
				} else {
					subtitleParts.push(`${snapshots.length} snapshot${snapshots.length === 1 ? "" : "s"}`);
					if (currentCount > 0) {
						subtitleParts.push(theme.fg("accent", "[current]"));
					}
					if (this.armedBaselineIndex !== null && this.armedBaselineIndex < snapshots.length) {
						const baseline = snapshots[this.armedBaselineIndex]!;
						const baselineDate = new Date(baseline.recordedAt);
						const baselineLabel = this.getRelativeAgeLabel(baselineDate);
						const baselineDisplayIndex = snapshots.length - this.armedBaselineIndex;
						subtitleParts.push(
							theme.fg("warning", `[baseline: ${baselineLabel} · snap ${baselineDisplayIndex}]`),
						);
					}
				}
			}
		} else if (this.mode === "history_detail") {
			// History detail shows selected snapshot info
			const snapshots = this.callbacks.getMemoryHistory();
			if (snapshots.length > 0) {
				const selected = snapshots[this.selectedIndex];
				if (selected) {
					const date = new Date(selected.recordedAt);
					if (this.compareStep === "target_picking") {
						// Show baseline → target annotation during explicit chooser
						const baseline = snapshots[this.armedBaselineIndex!]!;
						const baselineDate = new Date(baseline.recordedAt);
						const targetDate = new Date(selected.recordedAt);
						const baselineLabel = this.getRelativeAgeLabel(baselineDate);
						const targetLabel = this.getRelativeAgeLabel(targetDate);
						subtitleParts.push(
							theme.fg("warning", `[baseline: ${baselineLabel}]`),
							" ",
							theme.fg("accent", `[selecting target: ${targetLabel}]`),
						);
						if (this.armedBaselineIndex === this.selectedIndex) {
							subtitleParts.push(" ", theme.fg("dim", "(same snapshot)"));
						}
					} else {
						subtitleParts.push(
							theme.fg("dim", `Snapshot ${this.selectedIndex + 1}/${snapshots.length}`),
							` · ${date.toLocaleString()}`,
						);
						if (selected.isCurrent) {
							subtitleParts.push(` ${theme.fg("accent", "[current]")}`);
						}
					}
				}
			}
		} else if (this.mode === "history_diff") {
			// History diff shows the compared snapshots
			const snapshots = this.callbacks.getMemoryHistory();
			if (snapshots.length > 0 && this.diffBaseIndex !== null) {
				const base = snapshots[this.diffBaseIndex];
				const target = snapshots[this.selectedIndex];
				if (base && target) {
					const baseDate = new Date(base.recordedAt);
					const targetDate = new Date(target.recordedAt);
					const baseLabel = this.getRelativeAgeLabel(baseDate);
					const targetLabel = this.getRelativeAgeLabel(targetDate);
					subtitleParts.push(theme.fg("dim", `${baseLabel} → ${targetLabel}`));
					if (this.diffBaseIndex === snapshots.length - 1) {
						subtitleParts.push(theme.fg("accent", " [current→prev]"));
					} else {
						subtitleParts.push(
							theme.fg("dim", ` (snapshots ${this.diffBaseIndex + 1} → ${this.selectedIndex + 1})`),
						);
					}
				}
			}
		} else if (this.mode !== "review") {
			if (items.length === 0) {
				subtitleParts.push(theme.fg("muted", "No items"));
			} else {
				subtitleParts.push(`${items.length} item${items.length === 1 ? "" : "s"}`);
				if (staleCount > 0) {
					subtitleParts.push(theme.fg("warning", `${staleCount} need${staleCount === 1 ? "s" : ""} review`));
				}
			}
		} else {
			// Review section tabs
			const staleItems = reviewed.filter((r) => r.reviewRecommended);
			const freshItems = reviewed.filter((r) => !r.reviewRecommended);
			const tabStale = this.reviewSection === "stale" ? theme.fg("accent", "◉ Stale") : theme.fg("dim", "○ Stale");
			const tabFresh = this.reviewSection === "fresh" ? theme.fg("accent", "◉ Fresh") : theme.fg("dim", "○ Fresh");
			const countStale = theme.fg("warning", `(${staleItems.length})`);
			const countFresh = theme.fg("success", `(${freshItems.length})`);
			subtitleParts.push(`${tabStale} ${countStale}  ${tabFresh} ${countFresh}`);
		}

		if (subtitleParts.length > 0) {
			lines.push(theme.fg("muted", truncateToWidth(subtitleParts.join(""), width, "…")));
		}

		lines.push(theme.fg("dim", "─".repeat(width)));
		return lines;
	}

	private renderItemList(width: number): string[] {
		const lines: string[] = [];
		const items = this.callbacks.getMemoryItems();
		const reviewed = reviewMemoryItems([...items]);

		if (items.length === 0) {
			lines.push(theme.fg("muted", truncateToWidth("  (no memory items — use a to add)", width, "…")));
		} else {
			// Calculate visible range with selection-centered scrolling
			const startIndex = Math.max(
				0,
				Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), items.length - this.maxVisible),
			);
			const endIndex = Math.min(startIndex + this.maxVisible, items.length);

			for (let i = startIndex; i < endIndex; i++) {
				const entry = reviewed[i]!;
				lines.push(this.renderItemLine(entry, i === this.selectedIndex, width));
			}

			if (startIndex > 0 || endIndex < items.length) {
				lines.push(theme.fg("muted", `  (${this.selectedIndex + 1}/${items.length})`));
			}
		}

		// Action hints
		lines.push(theme.fg("dim", "─".repeat(width)));
		lines.push(...this.renderActionHints(width));

		return lines;
	}

	private renderItemLine(entry: MemoryReviewItem, isSelected: boolean, width: number): string {
		const { item, label, reviewRecommended } = entry;
		const cursor = isSelected ? theme.fg("accent", "› ") : "  ";

		// Status indicator
		const status = reviewRecommended ? theme.fg("warning", "⚠") : theme.fg("success", "✓");

		// Age label
		const ageText = theme.fg("dim", `· ${label}`);

		// Stale marker
		const staleMarker = reviewRecommended ? ` ${theme.fg("warning", "review")}` : "";

		// Value preview
		const valuePreview =
			item.value.length > this.maxValuePreview ? `${item.value.slice(0, this.maxValuePreview)}…` : item.value;

		// Assemble: cursor + status + key + value + age + stale
		const keyText = theme.bold(theme.fg("text", item.key));
		const valueText = theme.fg("muted", valuePreview);
		const parts = [`${cursor}${status}`, keyText, ":", valueText, ageText, staleMarker];
		const rawLine = parts.join(" ");
		const truncated = truncateToWidth(rawLine, width, "…");
		return isSelected ? theme.bg("selectedBg", truncated) : truncated;
	}

	private renderReviewMode(width: number): string[] {
		const lines: string[] = [];
		const items = this.callbacks.getMemoryItems();
		const reviewed = reviewMemoryItems([...items]);

		const targetEntries =
			this.reviewSection === "stale"
				? reviewed.filter((r) => r.reviewRecommended)
				: reviewed.filter((r) => !r.reviewRecommended);

		if (targetEntries.length === 0) {
			const msg =
				this.reviewSection === "stale"
					? theme.fg("success", "  No stale items")
					: theme.fg("muted", "  No fresh items");
			lines.push(truncateToWidth(msg, width, "…"));
		} else {
			const startIndex = Math.max(
				0,
				Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), targetEntries.length - this.maxVisible),
			);
			const endIndex = Math.min(startIndex + this.maxVisible, targetEntries.length);

			for (let i = startIndex; i < endIndex; i++) {
				const entry = targetEntries[i]!;
				const isSelected = i === this.selectedIndex;
				lines.push(this.renderReviewItemLine(entry, isSelected, width));
			}

			if (startIndex > 0 || endIndex < targetEntries.length) {
				lines.push(theme.fg("muted", `  (${this.selectedIndex + 1}/${targetEntries.length})`));
			}
		}

		// Freshness disclaimer
		lines.push(theme.fg("dim", "─".repeat(width)));
		lines.push(
			theme.fg(
				"muted",
				truncateToWidth(
					`Freshness is heuristic. Items older than ${MEMORY_STALE_AFTER_DAYS} days may be outdated.`,
					width,
					"…",
				),
			),
		);

		// Navigation hints for review
		lines.push(theme.fg("dim", "─".repeat(width)));
		lines.push(
			truncateToWidth(
				[rawKeyHint("←→", "switch section"), "  ", keyHint("selectCancel", "back to list")].join(""),
				width,
				"…",
			),
		);

		return lines;
	}

	private renderReviewItemLine(entry: MemoryReviewItem, isSelected: boolean, width: number): string {
		const { item, label, note } = entry;
		const cursor = isSelected ? theme.fg("accent", "› ") : "  ";

		const ageText = theme.fg("dim", `(${label})`);
		const keyText = theme.bold(theme.fg("text", item.key));
		const valueText = theme.fg("muted", truncateToWidth(item.value, this.maxValuePreview * 2, "…"));
		const parts = [`${cursor}${keyText}`, ":", valueText, ageText];
		const rawLine = parts.join(" ");
		const truncated = truncateToWidth(rawLine, width, "…");
		let line = isSelected ? theme.bg("selectedBg", truncated) : truncated;

		// Add note on selected stale items
		if (isSelected && note) {
			line += `\n${theme.fg("warning", truncateToWidth(`  ${note}`, width, "…"))}`;
		}

		return line;
	}

	/**
	 * Format a date as a relative age label.
	 */
	private getRelativeAgeLabel(date: Date): string {
		const now = Date.now();
		const diffMs = now - date.getTime();
		const diffSecs = Math.floor(diffMs / 1000);
		const diffMins = Math.floor(diffSecs / 60);
		const diffHours = Math.floor(diffMins / 60);
		const diffDays = Math.floor(diffHours / 24);

		if (diffSecs < 60) return "just now";
		if (diffMins < 60) return `${diffMins}m ago`;
		if (diffHours < 24) return `${diffHours}h ago`;
		if (diffDays < 30) return `${diffDays}d ago`;
		const diffMonths = Math.floor(diffDays / 30);
		if (diffMonths < 12) return `${diffMonths}mo ago`;
		const diffYears = Math.floor(diffMonths / 12);
		return `${diffYears}y ago`;
	}

	private renderHistoryMode(width: number): string[] {
		const lines: string[] = [];
		const snapshots = this.callbacks.getMemoryHistory();

		if (snapshots.length === 0) {
			lines.push(theme.fg("muted", truncateToWidth("  No memory snapshots in current branch.", width, "…")));
		} else {
			// Show newest first (current state most relevant)
			// But we need to calculate indices for selection
			const reversedSnapshots = [...snapshots].reverse();
			const maxVisible = this.maxVisible;
			const startIndex = Math.max(
				0,
				Math.min(this.selectedIndex - Math.floor(maxVisible / 2), reversedSnapshots.length - maxVisible),
			);
			const endIndex = Math.min(startIndex + maxVisible, reversedSnapshots.length);

			for (let i = startIndex; i < endIndex; i++) {
				const snapshot = reversedSnapshots[i]!;
				const isSelected = i === this.selectedIndex;
				const chronologicalIndex = snapshots.length - 1 - i;
				lines.push(this.renderHistorySnapshotLine(snapshot, isSelected, width, chronologicalIndex));
			}

			if (startIndex > 0 || endIndex < reversedSnapshots.length) {
				// Convert selectedIndex back to 1-based for display (oldest = 1)
				const displayIndex = reversedSnapshots.length - this.selectedIndex;
				lines.push(theme.fg("muted", `  (${displayIndex}/${snapshots.length} · newest first)`));
			}
		}

		lines.push(theme.fg("dim", "─".repeat(width)));
		lines.push(...this.renderHistoryActionHints(width));

		return lines;
	}

	private renderHistorySnapshotLine(
		snapshot: MemoryHistorySnapshot,
		isSelected: boolean,
		width: number,
		chronologicalIndex: number,
	): string {
		const cursor = isSelected ? theme.fg("accent", "› ") : "  ";
		const date = new Date(snapshot.recordedAt);
		const ageLabel = this.getRelativeAgeLabel(date);
		const itemCount = snapshot.items.length;
		const itemLabel = itemCount === 1 ? "item" : "items";
		const currentMarker = snapshot.isCurrent ? ` ${theme.fg("accent", "[current]")}` : "";
		const baselineMarker =
			this.armedBaselineIndex === chronologicalIndex && this.compareStep !== "target_picking"
				? ` ${theme.fg("warning", "[baseline]")}`
				: "";
		const targetMarker =
			this.compareStep === "target_picking" && isSelected && this.armedBaselineIndex !== chronologicalIndex
				? ` ${theme.fg("accent", "[target]")}`
				: "";

		const cursorOrIndicator = snapshot.isCurrent ? theme.fg("success", "●") : "○";
		const ageText = theme.bold(theme.fg("text", ageLabel));
		const dateText = theme.fg("dim", date.toLocaleDateString());

		const rawLine = `${cursor}${cursorOrIndicator} ${ageText}${currentMarker}${baselineMarker}${targetMarker} · ${itemCount} ${itemLabel} · ${dateText}`;
		const truncated = truncateToWidth(rawLine, width, "…");
		return isSelected ? theme.bg("selectedBg", truncated) : truncated;
	}

	private renderHistoryDetailMode(width: number): string[] {
		const lines: string[] = [];
		const snapshots = this.callbacks.getMemoryHistory();

		if (snapshots.length === 0) {
			lines.push(theme.fg("muted", truncateToWidth("  No snapshots available.", width, "…")));
		} else {
			const snapshot = snapshots[this.selectedIndex];
			if (!snapshot) {
				lines.push(theme.fg("error", truncateToWidth("  Invalid snapshot selection.", width, "…")));
			} else {
				const date = new Date(snapshot.recordedAt);
				const ageLabel = this.getRelativeAgeLabel(date);

				const isBaseline = this.armedBaselineIndex === this.selectedIndex;
				const baselineMarker = isBaseline ? ` ${theme.fg("warning", "[baseline]")}` : "";
				lines.push(
					`${theme.bold(theme.fg("text", ageLabel))}${snapshot.isCurrent ? ` ${theme.fg("accent", "[current]")}` : ""}${baselineMarker}`,
				);
				lines.push(theme.fg("dim", `  ${date.toLocaleString()}`));
				lines.push(
					theme.fg(
						"dim",
						`  ${snapshot.items.length} item${snapshot.items.length === 1 ? "" : "s"} at this point`,
					),
				);
				lines.push("");

				// Show all items in this snapshot
				if (snapshot.items.length === 0) {
					lines.push(theme.fg("dim", "  (empty)"));
				} else {
					for (const item of snapshot.items) {
						const keyText = theme.bold(theme.fg("text", item.key));
						const valuePreview =
							item.value.length > this.maxValuePreview * 2
								? `${item.value.slice(0, this.maxValuePreview * 2)}…`
								: item.value;
						const valueText = theme.fg("muted", valuePreview);
						lines.push(truncateToWidth(`  ${keyText}: ${valueText}`, width, "…"));
					}
				}

				if (snapshot.isCurrent) {
					lines.push("");
					lines.push(theme.fg("dim", "  Note: This is a snapshot of the current memory state."));
				}
			}
		}

		lines.push(theme.fg("dim", "─".repeat(width)));
		lines.push(...this.renderHistoryDetailActionHints(width));

		return lines;
	}

	private renderHistoryActionHints(width: number): string[] {
		const snapshots = this.callbacks.getMemoryHistory();
		const hasSnapshots = snapshots.length > 0;
		const hints: string[] = [];

		if (this.compareStep === "target_picking") {
			// Explicit target-picking step: confirm target or cancel
			hints.push(rawKeyHint("↑↓", "select target"));
			hints.push(rawKeyHint("Enter", "confirm target → diff"));
			hints.push(rawKeyHint("c", "clear baseline"));
			hints.push(keyHint("selectCancel", "cancel picking"));
		} else {
			hints.push(rawKeyHint("↑↓", "navigate snapshots"));
			if (hasSnapshots) {
				hints.push(rawKeyHint("Enter", "view detail"));
			}
			if (this.armedBaselineIndex === null) {
				hints.push(rawKeyHint("b", "arm baseline"));
			} else {
				hints.push(rawKeyHint("c", "clear baseline"));
				hints.push(rawKeyHint("d", "pick target → diff"));
			}
			hints.push(keyHint("selectCancel", "back to list"));
		}

		return [truncateToWidth(hints.join("  "), width, "…")];
	}

	private renderHistoryDetailActionHints(width: number): string[] {
		const snapshots = this.callbacks.getMemoryHistory();
		const hasMultiple = snapshots.length > 1;
		const hasBaseline = this.armedBaselineIndex !== null;
		const hints: string[] = [];

		if (this.compareStep === "target_picking") {
			// Explicit target-picking step: confirm target or cancel
			hints.push(rawKeyHint("↑↓", "select target"));
			hints.push(rawKeyHint("Enter", "confirm target → diff"));
			hints.push(rawKeyHint("c", "clear baseline"));
			hints.push(keyHint("selectCancel", "cancel picking"));
		} else {
			hints.push(rawKeyHint("↑↓", "switch snapshot"));
			if (hasMultiple) {
				hints.push(rawKeyHint("←→", "prev/next snapshot"));
			}
			hints.push(rawKeyHint("b", "arm baseline"));
			if (hasBaseline) {
				hints.push(rawKeyHint("c", "clear baseline"));
				hints.push(rawKeyHint("d", "pick target → diff"));
			} else {
				hints.push(rawKeyHint("d", "diff vs previous"));
			}
			hints.push(keyHint("selectCancel", "back to history"));
		}

		return [truncateToWidth(hints.join("  "), width, "…")];
	}

	private renderHistoryDiffMode(width: number): string[] {
		const lines: string[] = [];
		const snapshots = this.callbacks.getMemoryHistory();

		if (snapshots.length === 0 || this.diffBaseIndex === null) {
			lines.push(theme.fg("muted", truncateToWidth("  No snapshots available.", width, "…")));
		} else {
			const baseSnapshot = snapshots[this.diffBaseIndex];
			const targetSnapshot = snapshots[this.selectedIndex];

			if (!baseSnapshot || !targetSnapshot) {
				lines.push(theme.fg("error", truncateToWidth("  Invalid snapshot selection.", width, "…")));
			} else {
				// Header: identify both snapshots being compared
				const baseDate = new Date(baseSnapshot.recordedAt);
				const targetDate = new Date(targetSnapshot.recordedAt);
				const isExplicitBaseline = this.armedBaselineIndex !== null;
				lines.push(
					`  ${theme.bold(theme.fg("text", isExplicitBaseline ? "Baseline:" : "Base:"))} ${this.getRelativeAgeLabel(baseDate)} — ${theme.fg("dim", baseDate.toLocaleString())}`,
				);
				lines.push(
					`  ${theme.bold(theme.fg("text", "Target:"))} ${this.getRelativeAgeLabel(targetDate)} — ${theme.fg("dim", targetDate.toLocaleString())}`,
				);
				lines.push(theme.fg("dim", `  (snapshot comparison · not an event log)`));
				lines.push(theme.fg("dim", "─".repeat(width)));

				// Compute diff
				const diff = computeMemorySnapshotDiff(baseSnapshot, targetSnapshot);

				if (diff.added.length > 0) {
					lines.push(theme.bold(theme.fg("success", `  + Added (${diff.added.length})`)));
					for (const item of diff.added.slice(0, this.maxVisible)) {
						const preview =
							item.value.length > this.maxValuePreview * 2
								? `${item.value.slice(0, this.maxValuePreview * 2)}…`
								: item.value;
						lines.push(
							truncateToWidth(
								`  ${theme.fg("success", "+")} ${theme.fg("accent", item.key)}: ${theme.fg("muted", preview)}`,
								width,
								"…",
							),
						);
					}
					if (diff.added.length > this.maxVisible) {
						lines.push(theme.fg("dim", `  … and ${diff.added.length - this.maxVisible} more`));
					}
					lines.push(theme.fg("dim", "─".repeat(width)));
				}

				if (diff.removed.length > 0) {
					lines.push(theme.bold(theme.fg("error", `  - Removed (${diff.removed.length})`)));
					for (const item of diff.removed.slice(0, this.maxVisible)) {
						const preview =
							item.value.length > this.maxValuePreview * 2
								? `${item.value.slice(0, this.maxValuePreview * 2)}…`
								: item.value;
						lines.push(
							truncateToWidth(
								`  ${theme.fg("error", "-")} ${theme.fg("accent", item.key)}: ${theme.fg("muted", preview)}`,
								width,
								"…",
							),
						);
					}
					if (diff.removed.length > this.maxVisible) {
						lines.push(theme.fg("dim", `  … and ${diff.removed.length - this.maxVisible} more`));
					}
					lines.push(theme.fg("dim", "─".repeat(width)));
				}

				if (diff.changed.length > 0) {
					lines.push(theme.bold(theme.fg("warning", `  ~ Changed (${diff.changed.length})`)));
					for (const item of diff.changed.slice(0, this.maxVisible)) {
						const prevPreview =
							item.previousValue.length > this.maxValuePreview
								? `${item.previousValue.slice(0, this.maxValuePreview)}…`
								: item.previousValue;
						const currPreview =
							item.currentValue.length > this.maxValuePreview
								? `${item.currentValue.slice(0, this.maxValuePreview)}…`
								: item.currentValue;
						lines.push(
							truncateToWidth(`  ${theme.fg("warning", "~")} ${theme.fg("accent", item.key)}:`, width, "…"),
						);
						lines.push(
							truncateToWidth(
								`    ${theme.fg("dim", prevPreview)} → ${theme.fg("text", currPreview)}`,
								width,
								"…",
							),
						);
					}
					if (diff.changed.length > this.maxVisible) {
						lines.push(theme.fg("dim", `  … and ${diff.changed.length - this.maxVisible} more`));
					}
					lines.push(theme.fg("dim", "─".repeat(width)));
				}

				if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
					lines.push(theme.fg("dim", "  No changes between snapshots."));
					lines.push(theme.fg("dim", "─".repeat(width)));
				}
			}
		}

		lines.push(...this.renderHistoryDiffActionHints(width));

		return lines;
	}

	private renderHistoryDiffActionHints(width: number): string[] {
		const hints: string[] = [];
		hints.push(rawKeyHint("↑↓", "navigate snapshots"));
		if (this.armedBaselineIndex !== null) {
			hints.push(rawKeyHint("c", "clear baseline"));
		}
		hints.push(keyHint("selectCancel", "back to detail"));
		return [truncateToWidth(hints.join("  "), width, "…")];
	}

	private renderConfirmMode(width: number): string[] {
		const lines: string[] = [];
		const isDelete = this.mode === "confirm_delete";
		const itemKey = this.editingItemKey;

		const itemText = isDelete && itemKey ? ` "${itemKey}"` : "";
		const actionText = isDelete ? "delete" : "clear all";
		const color: "error" | "warning" = "error";

		lines.push("");
		lines.push(theme.fg(color, truncateToWidth(`  Confirm ${actionText}${itemText}?`, width, "…")));
		lines.push(theme.fg("muted", truncateToWidth("  This action cannot be undone.", width, "…")));
		lines.push("");
		lines.push(
			truncateToWidth(
				[keyHint("selectConfirm", "confirm"), "  ", keyHint("selectCancel", "cancel")].join(""),
				width,
				"…",
			),
		);

		return lines;
	}

	private renderInputMode(width: number): string[] {
		const lines: string[] = [];
		const isAdd = this.mode === "add_key" || this.mode === "add_value";
		const isValue = this.mode === "add_value" || this.mode === "edit_value";
		const actionLabel = isAdd ? "Add" : "Edit";

		// Title
		const title = isValue ? `${actionLabel} Value` : `${actionLabel} Key`;
		lines.push(theme.bold(theme.fg("accent", title)));
		lines.push(theme.fg("dim", "─".repeat(width)));

		if (isValue && this.editingItemKey) {
			// Show current key while editing value
			const keyLabel = theme.fg("muted", "Key:");
			const keyValue = theme.fg("text", this.editingItemKey);
			lines.push(truncateToWidth(`${keyLabel} ${keyValue}`, width, "…"));
			lines.push(theme.fg("dim", "─".repeat(width)));
		}

		if (!isValue) {
			lines.push(...this.keyInput.render(width));
		} else {
			lines.push(...this.valueInput.render(width));
		}

		lines.push(theme.fg("dim", "─".repeat(width)));
		lines.push(
			truncateToWidth(
				[keyHint("selectConfirm", "save"), "  ", keyHint("selectCancel", "cancel")].join(""),
				width,
				"…",
			),
		);

		return lines;
	}

	private renderActionHints(width: number): string[] {
		const items = this.callbacks.getMemoryItems();
		const hasSelection = items.length > 0;
		const hints: string[] = [];

		if (this.mode === "list") {
			hints.push(rawKeyHint("↑↓", "navigate"));
			if (hasSelection) {
				hints.push(rawKeyHint("Enter", "edit"));
				hints.push(rawKeyHint("Ctrl+D", "delete"));
			}
			hints.push(rawKeyHint("a", "add"));
			hints.push(rawKeyHint("r", "review"));
			hints.push(rawKeyHint("h", "history"));
			if (hasSelection) {
				hints.push(rawKeyHint("Ctrl+Shift+C", "clear all"));
			}
			hints.push(keyHint("selectCancel", "close"));
		} else if (this.mode === "review") {
			// No additional hints - navigation hints are inline in review mode
		}

		return [truncateToWidth(hints.join("  "), width, "…")];
	}

	// -------------------------------------------------------------------------
	// Keyboard handling
	// -------------------------------------------------------------------------

	handleInput(keyData: string): void {
		const kb = getEditorKeybindings();

		if (this.mode === "add_key" || this.mode === "edit_key") {
			if (kb.matches(keyData, "selectConfirm")) {
				this.onKeyInputSubmit();
			} else if (kb.matches(keyData, "selectCancel")) {
				this.cancelInput();
			} else {
				this.keyInput.handleInput(keyData);
			}
			return;
		}

		if (this.mode === "add_value" || this.mode === "edit_value") {
			if (kb.matches(keyData, "selectConfirm")) {
				this.onValueInputSubmit();
			} else if (kb.matches(keyData, "selectCancel")) {
				this.cancelInput();
			} else {
				this.valueInput.handleInput(keyData);
			}
			return;
		}

		if (this.mode === "confirm_delete" || this.mode === "confirm_clear") {
			if (kb.matches(keyData, "selectConfirm")) {
				this.confirmDestructiveAction();
			} else if (kb.matches(keyData, "selectCancel")) {
				this.mode = "list";
				this.editingItemKey = null;
				this.requestRender();
			}
			return;
		}

		if (this.mode === "review") {
			this.handleReviewInput(keyData);
			return;
		}

		if (this.mode === "history") {
			this.handleHistoryInput(keyData);
			return;
		}

		if (this.mode === "history_detail") {
			this.handleHistoryDetailInput(keyData);
			return;
		}

		if (this.mode === "history_diff") {
			this.handleHistoryDiffInput(keyData);
			return;
		}

		// List mode
		this.handleListInput(keyData);
	}

	private handleListInput(keyData: string): void {
		const kb = getEditorKeybindings();
		const items = this.callbacks.getMemoryItems();

		// Navigation
		if (kb.matches(keyData, "selectUp") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.requestRender();
			return;
		}
		if (kb.matches(keyData, "selectDown") || keyData === "j") {
			this.selectedIndex = Math.min(items.length - 1, this.selectedIndex + 1);
			this.requestRender();
			return;
		}
		if (kb.matches(keyData, "selectPageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
			this.requestRender();
			return;
		}
		if (kb.matches(keyData, "selectPageDown")) {
			this.selectedIndex = Math.min(items.length - 1, this.selectedIndex + this.maxVisible);
			this.requestRender();
			return;
		}

		// Enter: edit selected item
		if (kb.matches(keyData, "selectConfirm") || keyData === "\n") {
			if (items.length > 0) {
				const item = items[this.selectedIndex]!;
				this.startEdit(item);
			}
			return;
		}

		// Ctrl+D: delete selected item
		if (kb.matches(keyData, "deleteSession")) {
			if (items.length > 0) {
				const item = items[this.selectedIndex]!;
				this.startDelete(item.key);
			}
			return;
		}

		// Ctrl+Shift+C: clear all
		if (this.matchesCtrlShiftC(keyData)) {
			if (items.length > 0) {
				this.startClearAll();
			}
			return;
		}

		// a: add new item
		if (keyData === "a") {
			this.startAdd();
			return;
		}

		// r: review mode
		if (keyData === "r") {
			this.enterReviewMode();
			return;
		}

		// h: history mode
		if (keyData === "h") {
			this.enterHistoryMode();
			return;
		}

		// Escape: close
		if (kb.matches(keyData, "selectCancel")) {
			this.requestRender(); // Will be dismissed by parent
			return;
		}
	}

	private handleReviewInput(keyData: string): void {
		const kb = getEditorKeybindings();
		const items = this.callbacks.getMemoryItems();
		const reviewed = reviewMemoryItems([...items]);
		const targetEntries =
			this.reviewSection === "stale"
				? reviewed.filter((r) => r.reviewRecommended)
				: reviewed.filter((r) => !r.reviewRecommended);

		// Arrow left/right: switch section
		if (keyData === "\u001b[D]" /* left arrow */ || keyData === "\u001b[C]" /* right arrow */) {
			this.reviewSection = this.reviewSection === "stale" ? "fresh" : "stale";
			this.selectedIndex = 0;
			this.requestRender();
			return;
		}

		// Navigation within current section
		if (kb.matches(keyData, "selectUp") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.requestRender();
			return;
		}
		if (kb.matches(keyData, "selectDown") || keyData === "j") {
			this.selectedIndex = Math.min(targetEntries.length - 1, this.selectedIndex + 1);
			this.requestRender();
			return;
		}
		if (kb.matches(keyData, "selectPageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
			this.requestRender();
			return;
		}
		if (kb.matches(keyData, "selectPageDown")) {
			this.selectedIndex = Math.min(targetEntries.length - 1, this.selectedIndex + this.maxVisible);
			this.requestRender();
			return;
		}

		// Escape: back to list
		if (kb.matches(keyData, "selectCancel")) {
			this.mode = "list";
			this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, items.length - 1));
			this.requestRender();
			return;
		}
	}

	private handleHistoryInput(keyData: string): void {
		const kb = getEditorKeybindings();
		const snapshots = this.callbacks.getMemoryHistory();
		// Snapshots are displayed newest first
		const reversedSnapshots = [...snapshots].reverse();

		// Handle target-picking step
		if (this.compareStep === "target_picking") {
			// Navigation — allowed in target-picking
			if (kb.matches(keyData, "selectUp") || keyData === "k") {
				this.selectedIndex = Math.max(0, this.selectedIndex - 1);
				this.requestRender();
				return;
			}
			if (kb.matches(keyData, "selectDown") || keyData === "j") {
				this.selectedIndex = Math.min(reversedSnapshots.length - 1, this.selectedIndex + 1);
				this.requestRender();
				return;
			}
			if (kb.matches(keyData, "selectPageUp")) {
				this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
				this.requestRender();
				return;
			}
			if (kb.matches(keyData, "selectPageDown")) {
				this.selectedIndex = Math.min(reversedSnapshots.length - 1, this.selectedIndex + this.maxVisible);
				this.requestRender();
				return;
			}

			// Enter: confirm target and open diff
			if (kb.matches(keyData, "selectConfirm") || keyData === "\n") {
				if (snapshots.length > 0 && this.armedBaselineIndex !== null) {
					this.diffBaseIndex = this.armedBaselineIndex;
					// Convert reversed display index to chronological before entering diff mode
					this.selectedIndex = snapshots.length - 1 - this.selectedIndex;
					this.compareStep = "none";
					this.mode = "history_diff";
					this.requestRender();
				}
				return;
			}

			// 'd': same as Enter — confirm target and open diff
			if (keyData === "d") {
				if (snapshots.length > 0 && this.armedBaselineIndex !== null) {
					this.diffBaseIndex = this.armedBaselineIndex;
					// Convert reversed display index to chronological before entering diff mode
					this.selectedIndex = snapshots.length - 1 - this.selectedIndex;
					this.compareStep = "none";
					this.mode = "history_diff";
					this.requestRender();
				}
				return;
			}

			// 'c': clear baseline and exit target-picking
			if (keyData === "c") {
				this.armedBaselineIndex = null;
				this.compareStep = "none";
				this.requestRender();
				return;
			}

			// Escape: exit target-picking, keep baseline armed
			if (kb.matches(keyData, "selectCancel")) {
				this.compareStep = "none";
				this.requestRender();
				return;
			}

			return;
		}

		// Baseline-armed state (not in target-picking): d enters target-picking

		// Navigation
		if (kb.matches(keyData, "selectUp") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.requestRender();
			return;
		}
		if (kb.matches(keyData, "selectDown") || keyData === "j") {
			this.selectedIndex = Math.min(reversedSnapshots.length - 1, this.selectedIndex + 1);
			this.requestRender();
			return;
		}
		if (kb.matches(keyData, "selectPageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
			this.requestRender();
			return;
		}
		if (kb.matches(keyData, "selectPageDown")) {
			this.selectedIndex = Math.min(reversedSnapshots.length - 1, this.selectedIndex + this.maxVisible);
			this.requestRender();
			return;
		}

		// Enter: view snapshot detail
		if (kb.matches(keyData, "selectConfirm") || keyData === "\n") {
			if (snapshots.length > 0) {
				// Convert from reversed index to original index
				const originalIndex = snapshots.length - 1 - this.selectedIndex;
				this.selectedIndex = originalIndex;
				this.mode = "history_detail";
				this.requestRender();
			}
			return;
		}

		// 'b': arm current snapshot as baseline
		if (keyData === "b") {
			if (snapshots.length > 0) {
				const originalIndex = snapshots.length - 1 - this.selectedIndex;
				this.armedBaselineIndex = originalIndex;
				this.requestRender();
			}
			return;
		}

		// 'd': if baseline armed, enter explicit target-picking; otherwise adjacent diff
		if (keyData === "d") {
			if (snapshots.length < 2 && this.armedBaselineIndex === null) {
				this.requestRender();
				return;
			}
			if (this.armedBaselineIndex !== null) {
				// Enter explicit target-picking step
				this.compareStep = "target_picking";
				this.requestRender();
				return;
			}
			// No baseline: adjacent diff immediately (quick default)
			const targetChronologicalIndex = snapshots.length - 1 - this.selectedIndex;
			this.diffBaseIndex = targetChronologicalIndex > 0 ? targetChronologicalIndex - 1 : 0;
			this.mode = "history_diff";
			this.requestRender();
			return;
		}

		// 'c': clear armed baseline
		if (keyData === "c") {
			this.clearBaseline();
			this.requestRender();
			return;
		}

		// Escape: back to list
		if (kb.matches(keyData, "selectCancel")) {
			this.mode = "list";
			this.syncHistorySelection();
			this.requestRender();
			return;
		}
	}

	private handleHistoryDetailInput(keyData: string): void {
		const kb = getEditorKeybindings();
		const snapshots = this.callbacks.getMemoryHistory();

		// Handle target-picking step
		if (this.compareStep === "target_picking") {
			// Navigation — allowed in target-picking
			if (keyData === "\u001b[D]" /* left arrow */) {
				if (this.selectedIndex > 0) {
					this.selectedIndex--;
					this.requestRender();
				}
				return;
			}
			if (keyData === "\u001b[C]" /* right arrow */) {
				if (this.selectedIndex < snapshots.length - 1) {
					this.selectedIndex++;
					this.requestRender();
				}
				return;
			}
			if (kb.matches(keyData, "selectUp") || keyData === "k") {
				this.selectedIndex = Math.max(0, this.selectedIndex - 1);
				this.requestRender();
				return;
			}
			if (kb.matches(keyData, "selectDown") || keyData === "j") {
				this.selectedIndex = Math.min(snapshots.length - 1, this.selectedIndex + 1);
				this.requestRender();
				return;
			}
			if (kb.matches(keyData, "selectPageUp")) {
				this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
				this.requestRender();
				return;
			}
			if (kb.matches(keyData, "selectPageDown")) {
				this.selectedIndex = Math.min(snapshots.length - 1, this.selectedIndex + this.maxVisible);
				this.requestRender();
				return;
			}

			// Enter: confirm target and open diff
			if (kb.matches(keyData, "selectConfirm") || keyData === "\n") {
				if (this.armedBaselineIndex !== null) {
					this.diffBaseIndex = this.armedBaselineIndex;
					this.compareStep = "none";
					this.mode = "history_diff";
					this.requestRender();
				}
				return;
			}

			// 'd': same as Enter — confirm target and open diff
			if (keyData === "d") {
				if (this.armedBaselineIndex !== null) {
					this.diffBaseIndex = this.armedBaselineIndex;
					this.compareStep = "none";
					this.mode = "history_diff";
					this.requestRender();
				}
				return;
			}

			// 'c': clear baseline and exit target-picking
			if (keyData === "c") {
				this.armedBaselineIndex = null;
				this.compareStep = "none";
				this.requestRender();
				return;
			}

			// Escape: exit target-picking, keep baseline armed
			if (kb.matches(keyData, "selectCancel")) {
				this.compareStep = "none";
				this.requestRender();
				return;
			}

			return;
		}

		// Baseline-armed state (not in target-picking): d enters target-picking

		// Arrow left: previous snapshot
		if (keyData === "\u001b[D]" /* left arrow */) {
			if (this.selectedIndex > 0) {
				this.selectedIndex--;
				this.requestRender();
			}
			return;
		}

		// Arrow right: next snapshot
		if (keyData === "\u001b[C]" /* right arrow */) {
			if (this.selectedIndex < snapshots.length - 1) {
				this.selectedIndex++;
				this.requestRender();
			}
			return;
		}

		// Navigation
		if (kb.matches(keyData, "selectUp") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.requestRender();
			return;
		}
		if (kb.matches(keyData, "selectDown") || keyData === "j") {
			this.selectedIndex = Math.min(snapshots.length - 1, this.selectedIndex + 1);
			this.requestRender();
			return;
		}
		if (kb.matches(keyData, "selectPageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
			this.requestRender();
			return;
		}
		if (kb.matches(keyData, "selectPageDown")) {
			this.selectedIndex = Math.min(snapshots.length - 1, this.selectedIndex + this.maxVisible);
			this.requestRender();
			return;
		}

		// 'd': if baseline armed, enter explicit target-picking; otherwise adjacent diff
		if (keyData === "d") {
			if (snapshots.length < 2 && this.armedBaselineIndex === null) {
				this.requestRender();
				return;
			}
			if (this.armedBaselineIndex !== null) {
				// Enter explicit target-picking step
				this.compareStep = "target_picking";
				this.requestRender();
				return;
			}
			// No baseline: adjacent diff immediately (quick default)
			this.diffBaseIndex = this.selectedIndex > 0 ? this.selectedIndex - 1 : 0;
			this.mode = "history_diff";
			this.requestRender();
			return;
		}

		// 'b': arm current snapshot as baseline
		if (keyData === "b") {
			if (snapshots.length > 0) {
				this.armBaseline();
				this.requestRender();
			}
			return;
		}

		// 'c': clear armed baseline
		if (keyData === "c") {
			this.clearBaseline();
			this.requestRender();
			return;
		}

		// Escape: back to history list
		if (kb.matches(keyData, "selectCancel")) {
			this.mode = "history";
			this.syncHistorySelection();
			this.requestRender();
			return;
		}
	}

	private handleHistoryDiffInput(keyData: string): void {
		const kb = getEditorKeybindings();
		const snapshots = this.callbacks.getMemoryHistory();

		// Navigate to different target snapshot
		if (kb.matches(keyData, "selectUp") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.requestRender();
			return;
		}
		if (kb.matches(keyData, "selectDown") || keyData === "j") {
			this.selectedIndex = Math.min(snapshots.length - 1, this.selectedIndex + 1);
			this.requestRender();
			return;
		}
		if (kb.matches(keyData, "selectPageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
			this.requestRender();
			return;
		}
		if (kb.matches(keyData, "selectPageDown")) {
			this.selectedIndex = Math.min(snapshots.length - 1, this.selectedIndex + this.maxVisible);
			this.requestRender();
			return;
		}

		// 'c': clear armed baseline
		if (keyData === "c") {
			this.clearBaseline();
			this.requestRender();
			return;
		}

		// Escape: back to history detail
		if (kb.matches(keyData, "selectCancel")) {
			this.mode = "history_detail";
			this.diffBaseIndex = null;
			// Keep armed baseline active so operator can resume comparison
			this.requestRender();
			return;
		}
	}

	private matchesCtrlShiftC(keyData: string): boolean {
		// Ctrl+Shift+C in Kitty/xterm-256color sends "\x1b[68;6u"
		// Ctrl+Shift+D sends "\x1b[67;6u" (used for clear all)
		return keyData === "\x1b[68;6u" || keyData === "\x1b[67;6u";
	}

	// -------------------------------------------------------------------------
	// Actions
	// -------------------------------------------------------------------------

	private startAdd(): void {
		this.mode = "add_key";
		this.keyInput.setValue("");
		this.editingItemKey = null;
		this.keyInput.focused = true;
		this.requestRender();
	}

	private startEdit(item: MemoryItem): void {
		this.mode = "edit_key";
		this.keyInput.setValue(item.key);
		this.editingItemKey = item.key;
		this.valueInput.setValue(item.value);
		this.keyInput.focused = true;
		this.requestRender();
	}

	private startDelete(key: string): void {
		this.mode = "confirm_delete";
		this.editingItemKey = key;
		this.requestRender();
	}

	private startClearAll(): void {
		this.mode = "confirm_clear";
		this.requestRender();
	}

	private onKeyInputSubmit(): void {
		const key = this.keyInput.getValue().trim();
		if (!key) {
			this.cancelInput();
			return;
		}

		// Check for duplicate key in add mode
		const existingItems = this.callbacks.getMemoryItems();
		if (this.mode === "add_key" && existingItems.some((item) => item.key === key)) {
			// Show error by briefly flashing the key input - just proceed to value input
		}

		if (this.mode === "add_key") {
			this.mode = "add_value";
			this.valueInput.setValue("");
			this.valueInput.focused = true;
		} else {
			this.mode = "edit_value";
			this.valueInput.focused = true;
		}
		this.requestRender();
	}

	private onValueInputSubmit(): void {
		const key = this.keyInput.getValue().trim();
		const value = this.valueInput.getValue();

		if (!key) {
			this.cancelInput();
			return;
		}

		this.callbacks.setMemoryItem(key, value);
		this.refresh();
		this.mode = "list";
		this.keyInput.setValue("");
		this.valueInput.setValue("");
		this.editingItemKey = null;
		this.requestRender();
	}

	private cancelInput(): void {
		this.mode = "list";
		this.keyInput.setValue("");
		this.valueInput.setValue("");
		this.editingItemKey = null;
		this.requestRender();
	}

	private confirmDestructiveAction(): void {
		if (this.mode === "confirm_delete") {
			const key = this.editingItemKey;
			if (key) {
				this.callbacks.deleteMemoryItem(key);
			}
		} else if (this.mode === "confirm_clear") {
			this.callbacks.clearMemory();
		}

		this.refresh();
		this.mode = "list";
		this.editingItemKey = null;
		this.requestRender();
	}

	private enterReviewMode(): void {
		this.mode = "review";
		this.selectedIndex = 0;
		this.syncReviewSection();
		this.requestRender();
	}

	private syncReviewSection(): void {
		const items = this.callbacks.getMemoryItems();
		const reviewed = reviewMemoryItems([...items]);
		const staleCount = reviewed.filter((r) => r.reviewRecommended).length;
		const freshCount = reviewed.length - staleCount;

		if (this.reviewSection === "stale" && staleCount === 0) {
			this.reviewSection = "fresh";
		} else if (this.reviewSection === "fresh" && freshCount === 0) {
			this.reviewSection = "stale";
		}
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, reviewed.length - 1));
	}

	private enterHistoryMode(): void {
		this.mode = "history";
		this.selectedIndex = 0;
		// Sync selection to the current snapshot (last one in original order, first in reversed)
		const snapshots = this.callbacks.getMemoryHistory();
		if (snapshots.length > 0) {
			// Start at the most recent snapshot (index 0 in reversed display)
			this.selectedIndex = 0;
		}
		this.requestRender();
	}

	/**
	 * Sync selectedIndex when entering history list mode from detail or returning to list.
	 * Resets to show the current/most recent snapshot.
	 */
	private syncHistorySelection(): void {
		const snapshots = this.callbacks.getMemoryHistory();
		if (snapshots.length === 0) {
			this.selectedIndex = 0;
			return;
		}
		// In history list mode, we display newest first.
		// Find the index of the most recent snapshot (last in original order = index 0 in reversed)
		// If we have a valid selectedIndex from detail mode, keep it.
		// Otherwise, default to the most recent (index 0 in reversed).
		this.selectedIndex = Math.min(this.selectedIndex, snapshots.length - 1);
	}

	/**
	 * Arm the currently selected snapshot as the explicit baseline.
	 * Uses the current selectedIndex (in original chronological order).
	 */
	private armBaseline(): void {
		this.armedBaselineIndex = this.selectedIndex;
	}

	/**
	 * Clear the armed baseline and exit any active compare chooser step.
	 */
	private clearBaseline(): void {
		this.armedBaselineIndex = null;
		this.compareStep = "none";
	}
}
