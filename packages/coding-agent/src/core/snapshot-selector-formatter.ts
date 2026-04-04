import type { MemoryHistorySnapshot } from "./memory.js";
import { MEMORY_SNAPSHOT_SHORT_ID_LENGTH, type SnapshotResolution } from "./snapshot-selector-resolver.js";

export interface SnapshotSelectorIssue {
	label: string;
	resolution: SnapshotResolution;
}

export interface SnapshotDiffHeaderContext {
	baselineSnapshot: MemoryHistorySnapshot;
	targetSnapshot: MemoryHistorySnapshot;
	getRelativeAgeLabel: (date: Date) => string;
}

export function formatSnapshotShortId(entryId: string, shortIdLength = MEMORY_SNAPSHOT_SHORT_ID_LENGTH): string {
	return `[${entryId.slice(0, shortIdLength)}]`;
}

export function formatResolvedSnapshotId(entryId: string, shortIdLength = MEMORY_SNAPSHOT_SHORT_ID_LENGTH): string {
	return `${formatSnapshotShortId(entryId, shortIdLength)} ${entryId}`;
}

export function formatSnapshotSelectorAcceptedForms(shortIdLength = MEMORY_SNAPSHOT_SHORT_ID_LENGTH): string {
	return `Accepted forms: full entryId, short ID (${shortIdLength} chars), or strict unique prefix. Brackets are optional.`;
}

export function formatSnapshotSelectorHistoryGuidance(shortIdLength = MEMORY_SNAPSHOT_SHORT_ID_LENGTH): string[] {
	return [
		"Use /memory diff <baselineId> <targetId> to compare any two snapshots.",
		`IDs shown in brackets (${formatSnapshotShortId("x".repeat(shortIdLength), shortIdLength)}) can be copied directly; brackets are optional.`,
		`Accepted: full entryId, ${shortIdLength}-char short ID, or strict unique prefix.`,
	];
}

export function formatSnapshotSelectorIssues(
	issues: readonly SnapshotSelectorIssue[],
	shortIdLength = MEMORY_SNAPSHOT_SHORT_ID_LENGTH,
): string[] {
	const lines: string[] = [];

	for (const issue of issues) {
		const { label, resolution } = issue;
		if (resolution.error === "empty") {
			lines.push(`${label} selector is empty.`);
			continue;
		}

		if (resolution.error === "not_found") {
			lines.push(`${label} ID not found: ${resolution.matchedInput}`);
			continue;
		}

		if (resolution.error === "ambiguous") {
			lines.push(`${label} ID is ambiguous: ${resolution.matchedInput}`);
			for (const candidate of resolution.candidates) {
				lines.push(`  ${formatResolvedSnapshotId(candidate, shortIdLength)}`);
			}
		}
	}

	return lines;
}

export function formatSnapshotSelectorResolutionFailure(
	issues: readonly SnapshotSelectorIssue[],
	shortIdLength = MEMORY_SNAPSHOT_SHORT_ID_LENGTH,
): string[] {
	const detailLines = formatSnapshotSelectorIssues(issues, shortIdLength);
	if (detailLines.length === 0) {
		return [];
	}

	return [
		"Snapshot resolution failed in current branch history.",
		"",
		...detailLines,
		"",
		"Run /memory history to see available snapshot IDs (shown in brackets after each age label).",
		formatSnapshotSelectorAcceptedForms(shortIdLength),
	];
}

export function formatExplicitDiffHeader(
	context: SnapshotDiffHeaderContext,
	shortIdLength = MEMORY_SNAPSHOT_SHORT_ID_LENGTH,
): string[] {
	const baselineDate = new Date(context.baselineSnapshot.recordedAt);
	const targetDate = new Date(context.targetSnapshot.recordedAt);

	return [
		`Baseline: ${context.getRelativeAgeLabel(baselineDate)} — ${baselineDate.toLocaleString()}`,
		`        ID: ${formatResolvedSnapshotId(context.baselineSnapshot.entryId, shortIdLength)}`,
		`Target:   ${context.getRelativeAgeLabel(targetDate)} — ${targetDate.toLocaleString()}`,
		`        ID: ${formatResolvedSnapshotId(context.targetSnapshot.entryId, shortIdLength)}`,
		"(snapshot comparison · not an event log)",
		"",
	];
}

export function formatAdjacentDiffHeader(context: SnapshotDiffHeaderContext): string[] {
	const baselineDate = new Date(context.baselineSnapshot.recordedAt);
	const targetDate = new Date(context.targetSnapshot.recordedAt);

	return [
		`Comparing: ${context.getRelativeAgeLabel(baselineDate)} → ${context.getRelativeAgeLabel(targetDate)}`,
		`${baselineDate.toLocaleString()} → ${targetDate.toLocaleString()}`,
		"(snapshot comparison · not an event log)",
		"",
	];
}
