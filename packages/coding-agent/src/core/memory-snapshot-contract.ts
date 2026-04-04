import type { MemoryHistorySnapshot } from "./memory.js";
import { computeMemorySnapshotDiff } from "./memory-diff.js";
import { MEMORY_SNAPSHOT_SHORT_ID_LENGTH, type SnapshotResolution } from "./snapshot-selector-resolver.js";

export interface StructuredMemorySnapshot {
	entryId: string;
	shortId: string;
	parentId: string | null;
	recordedAt: string;
	items: MemoryHistorySnapshot["items"];
	itemCount: number;
	isCurrent: boolean;
}

export interface StructuredResolvedSnapshotSelector {
	input: string;
	matchedInput: string;
	resolvedId: string;
}

export interface StructuredSnapshotSelectorCandidate {
	entryId: string;
	shortId: string;
}

export interface StructuredSnapshotSelectorIssue {
	label: "baseline" | "target";
	input: string;
	matchedInput: string;
	error: NonNullable<SnapshotResolution["error"]>;
	candidates: StructuredSnapshotSelectorCandidate[];
}

export interface StructuredMemoryHistoryData {
	branchScope: "current";
	historyModel: "snapshot";
	snapshots: StructuredMemorySnapshot[];
}

export interface StructuredMemoryCompareEmptyHistoryData {
	branchScope: "current";
	historyModel: "snapshot";
	status: "empty_history";
	snapshotCount: 0;
}

export interface StructuredMemoryCompareInitialSnapshotData {
	branchScope: "current";
	historyModel: "snapshot";
	status: "initial_snapshot";
	compareMode: "adjacent";
	target: StructuredMemorySnapshot;
	diff: ReturnType<typeof computeMemorySnapshotDiff>;
}

export interface StructuredMemoryCompareSelectorResolutionFailedData {
	branchScope: "current";
	historyModel: "snapshot";
	status: "selector_resolution_failed";
	compareMode: "explicit";
	snapshotCount: number;
	issues: StructuredSnapshotSelectorIssue[];
}

export interface StructuredMemoryCompareOkData {
	branchScope: "current";
	historyModel: "snapshot";
	status: "ok";
	compareMode: "adjacent" | "explicit";
	baseline: StructuredMemorySnapshot;
	target: StructuredMemorySnapshot;
	diff: ReturnType<typeof computeMemorySnapshotDiff>;
	sameSnapshot: boolean;
	selectors?: {
		baseline: StructuredResolvedSnapshotSelector;
		target: StructuredResolvedSnapshotSelector;
	};
}

export type StructuredMemoryCompareData =
	| StructuredMemoryCompareEmptyHistoryData
	| StructuredMemoryCompareInitialSnapshotData
	| StructuredMemoryCompareSelectorResolutionFailedData
	| StructuredMemoryCompareOkData;

export interface MemorySnapshotContractContext {
	getMemoryHistory(): readonly MemoryHistorySnapshot[];
	resolveMemorySnapshotSelector(input: string): SnapshotResolution;
}

const MEMORY_HISTORY_BRANCH_SCOPE = "current" as const;
const MEMORY_HISTORY_MODEL = "snapshot" as const;

function toShortId(entryId: string): string {
	return entryId.slice(0, MEMORY_SNAPSHOT_SHORT_ID_LENGTH);
}

function toStructuredMemorySnapshot(snapshot: MemoryHistorySnapshot): StructuredMemorySnapshot {
	return {
		entryId: snapshot.entryId,
		shortId: toShortId(snapshot.entryId),
		parentId: snapshot.parentId,
		recordedAt: snapshot.recordedAt,
		items: [...snapshot.items],
		itemCount: snapshot.items.length,
		isCurrent: snapshot.isCurrent,
	};
}

function toResolvedSelector(input: string, resolution: SnapshotResolution): StructuredResolvedSnapshotSelector {
	return {
		input,
		matchedInput: resolution.matchedInput,
		resolvedId: resolution.resolvedId!,
	};
}

function toSelectorIssue(
	label: "baseline" | "target",
	input: string,
	resolution: SnapshotResolution,
): StructuredSnapshotSelectorIssue {
	return {
		label,
		input,
		matchedInput: resolution.matchedInput,
		error: resolution.error!,
		candidates: resolution.candidates.map((entryId) => ({
			entryId,
			shortId: toShortId(entryId),
		})),
	};
}

export function buildStructuredMemoryHistoryData(
	context: Pick<MemorySnapshotContractContext, "getMemoryHistory">,
): StructuredMemoryHistoryData {
	const snapshots = context.getMemoryHistory();
	return {
		branchScope: MEMORY_HISTORY_BRANCH_SCOPE,
		historyModel: MEMORY_HISTORY_MODEL,
		snapshots: snapshots.map(toStructuredMemorySnapshot),
	};
}

export function buildStructuredMemoryCompareData(
	context: MemorySnapshotContractContext,
	selectors?: { baseline: string; target: string },
): StructuredMemoryCompareData {
	const snapshots = context.getMemoryHistory();
	if (snapshots.length === 0) {
		return {
			branchScope: MEMORY_HISTORY_BRANCH_SCOPE,
			historyModel: MEMORY_HISTORY_MODEL,
			status: "empty_history",
			snapshotCount: 0,
		};
	}

	if (selectors) {
		const baselineResolution = context.resolveMemorySnapshotSelector(selectors.baseline);
		const targetResolution = context.resolveMemorySnapshotSelector(selectors.target);
		const issues: StructuredSnapshotSelectorIssue[] = [];

		if (baselineResolution.error !== undefined) {
			issues.push(toSelectorIssue("baseline", selectors.baseline, baselineResolution));
		}
		if (targetResolution.error !== undefined) {
			issues.push(toSelectorIssue("target", selectors.target, targetResolution));
		}

		if (issues.length > 0) {
			return {
				branchScope: MEMORY_HISTORY_BRANCH_SCOPE,
				historyModel: MEMORY_HISTORY_MODEL,
				status: "selector_resolution_failed",
				compareMode: "explicit",
				snapshotCount: snapshots.length,
				issues,
			};
		}

		const baselineSnapshot = baselineResolution.snapshot!;
		const targetSnapshot = targetResolution.snapshot!;
		return {
			branchScope: MEMORY_HISTORY_BRANCH_SCOPE,
			historyModel: MEMORY_HISTORY_MODEL,
			status: "ok",
			compareMode: "explicit",
			baseline: toStructuredMemorySnapshot(baselineSnapshot),
			target: toStructuredMemorySnapshot(targetSnapshot),
			diff: computeMemorySnapshotDiff(baselineSnapshot, targetSnapshot),
			sameSnapshot: baselineSnapshot.entryId === targetSnapshot.entryId,
			selectors: {
				baseline: toResolvedSelector(selectors.baseline, baselineResolution),
				target: toResolvedSelector(selectors.target, targetResolution),
			},
		};
	}

	const targetSnapshot = snapshots[snapshots.length - 1]!;
	const baselineSnapshot = snapshots.length >= 2 ? snapshots[snapshots.length - 2]! : undefined;
	const diff = computeMemorySnapshotDiff(baselineSnapshot, targetSnapshot);

	if (!baselineSnapshot) {
		return {
			branchScope: MEMORY_HISTORY_BRANCH_SCOPE,
			historyModel: MEMORY_HISTORY_MODEL,
			status: "initial_snapshot",
			compareMode: "adjacent",
			target: toStructuredMemorySnapshot(targetSnapshot),
			diff,
		};
	}

	return {
		branchScope: MEMORY_HISTORY_BRANCH_SCOPE,
		historyModel: MEMORY_HISTORY_MODEL,
		status: "ok",
		compareMode: "adjacent",
		baseline: toStructuredMemorySnapshot(baselineSnapshot),
		target: toStructuredMemorySnapshot(targetSnapshot),
		diff,
		sameSnapshot: baselineSnapshot.entryId === targetSnapshot.entryId,
	};
}
