import type { MemoryHistorySnapshot } from "./memory.js";
import { computeMemorySnapshotDiff } from "./memory-diff.js";
import {
	formatAdjacentDiffHeader,
	formatExplicitDiffHeader,
	formatSnapshotSelectorHistoryGuidance,
	formatSnapshotSelectorResolutionFailure,
	formatSnapshotShortId,
} from "./snapshot-selector-formatter.js";
import type { SnapshotResolution } from "./snapshot-selector-resolver.js";

export interface MemoryCompareOutputContext {
	getRelativeAgeLabel: (date: Date) => string;
	resolveSnapshotSelector: (input: string) => SnapshotResolution;
}

export function formatRelativeAgeLabel(date: Date): string {
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

export function formatMemoryHistoryOutput(
	snapshots: readonly MemoryHistorySnapshot[],
	context: Pick<MemoryCompareOutputContext, "getRelativeAgeLabel">,
): string[] {
	if (snapshots.length === 0) {
		return ["No memory snapshots found in current branch."];
	}

	const lines: string[] = [];
	lines.push(`Branch history · ${snapshots.length} snapshot${snapshots.length === 1 ? "" : "s"} · oldest first`);
	lines.push("Each snapshot is a complete memory state at that point (not individual changes).");
	lines.push("");
	lines.push(...formatSnapshotSelectorHistoryGuidance());
	lines.push("");

	for (let i = snapshots.length - 1; i >= 0; i--) {
		const snapshot = snapshots[i]!;
		const date = new Date(snapshot.recordedAt);
		const ageLabel = context.getRelativeAgeLabel(date);
		const currentMarker = snapshot.isCurrent ? " [current]" : "";
		const itemCount = snapshot.items.length;
		const itemLabel = itemCount === 1 ? "item" : "items";
		const shortId = formatSnapshotShortId(snapshot.entryId);

		lines.push(`${ageLabel}${currentMarker} · ${itemCount} ${itemLabel} · ${date.toLocaleString()} · ${shortId}`);

		if (snapshot.items.length > 0) {
			for (const item of snapshot.items.slice(0, 5)) {
				const valuePreview = item.value.length > 30 ? `${item.value.slice(0, 30)}…` : item.value;
				lines.push(`  ${item.key}: ${valuePreview}`);
			}
			if (snapshot.items.length > 5) {
				lines.push(`  … and ${snapshot.items.length - 5} more`);
			}
		} else {
			lines.push("  (empty)");
		}
		lines.push("");
	}

	return lines;
}

export function formatMemoryDiffOutput(
	snapshots: readonly MemoryHistorySnapshot[],
	context: MemoryCompareOutputContext,
	selectors?: {
		baseline?: string;
		target?: string;
	},
): string[] {
	if (snapshots.length === 0) {
		return ["No memory snapshots found. Nothing to diff against."];
	}

	const explicitBaselineId = selectors?.baseline;
	const explicitTargetId = selectors?.target;
	let baselineSnapshot: MemoryHistorySnapshot | undefined;
	let targetSnapshot: MemoryHistorySnapshot | undefined;
	let isExplicitIds = false;

	if (explicitBaselineId && explicitTargetId) {
		isExplicitIds = true;
		const baselineResult = context.resolveSnapshotSelector(explicitBaselineId);
		const targetResult = context.resolveSnapshotSelector(explicitTargetId);

		if (baselineResult.error !== undefined || targetResult.error !== undefined) {
			return formatSnapshotSelectorResolutionFailure([
				{ label: "Baseline", resolution: baselineResult },
				{ label: "Target", resolution: targetResult },
			]);
		}

		baselineSnapshot = baselineResult.snapshot;
		targetSnapshot = targetResult.snapshot;
	} else {
		targetSnapshot = snapshots[snapshots.length - 1];
		baselineSnapshot = snapshots.length >= 2 ? snapshots[snapshots.length - 2] : undefined;

		if (!baselineSnapshot) {
			return [
				`Initial snapshot — ${targetSnapshot!.items.length} item(s)`,
				"",
				`Recorded: ${new Date(targetSnapshot!.recordedAt).toLocaleString()}`,
				"(snapshot comparison · not an event log)",
			];
		}
	}

	const diff = computeMemorySnapshotDiff(baselineSnapshot!, targetSnapshot!);
	const lines = isExplicitIds
		? formatExplicitDiffHeader({
				baselineSnapshot: baselineSnapshot!,
				targetSnapshot: targetSnapshot!,
				getRelativeAgeLabel: context.getRelativeAgeLabel,
			})
		: formatAdjacentDiffHeader({
				baselineSnapshot: baselineSnapshot!,
				targetSnapshot: targetSnapshot!,
				getRelativeAgeLabel: context.getRelativeAgeLabel,
			});

	if (baselineSnapshot!.entryId === targetSnapshot!.entryId) {
		lines.push("Baseline and target are the same snapshot — no changes to show.");
		return lines;
	}

	if (diff.added.length > 0) {
		lines.push(`+ Added (${diff.added.length})`);
		for (const item of diff.added) {
			const preview = item.value.length > 50 ? `${item.value.slice(0, 50)}…` : item.value;
			lines.push(`  + ${item.key}: ${preview}`);
		}
		lines.push("");
	}

	if (diff.removed.length > 0) {
		lines.push(`- Removed (${diff.removed.length})`);
		for (const item of diff.removed) {
			const preview = item.value.length > 50 ? `${item.value.slice(0, 50)}…` : item.value;
			lines.push(`  - ${item.key}: ${preview}`);
		}
		lines.push("");
	}

	if (diff.changed.length > 0) {
		lines.push(`~ Changed (${diff.changed.length})`);
		for (const item of diff.changed) {
			const prevPreview =
				item.previousValue.length > 40 ? `${item.previousValue.slice(0, 40)}…` : item.previousValue;
			const currPreview = item.currentValue.length > 40 ? `${item.currentValue.slice(0, 40)}…` : item.currentValue;
			lines.push(`  ~ ${item.key}:`);
			lines.push(`    ${prevPreview}`);
			lines.push(`    ${currPreview}`);
		}
		lines.push("");
	}

	if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
		lines.push("No changes between snapshots.");
	}

	return lines;
}
