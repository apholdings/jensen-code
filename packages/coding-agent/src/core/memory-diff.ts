/**
 * Shared snapshot diff computation for session memory history.
 *
 * Compare two MemoryHistorySnapshot states to derive what changed between them.
 * Because persistence is snapshot-based (not event-sourced), each snapshot
 * represents the complete memory state at that point in time.
 *
 * This diff is derived from adjacent real persisted snapshots and is NOT
 * a true operation log — it cannot tell you which specific add/update/delete
 * operation produced a given change.
 */

import type { MemoryHistorySnapshot, MemoryItem } from "./memory.js";

/** A key present only in the current snapshot (added) */
export interface DiffAdded {
	type: "added";
	key: string;
	value: string;
}

/** A key present only in the previous snapshot (removed) */
export interface DiffRemoved {
	type: "removed";
	key: string;
	value: string;
}

/** A key present in both snapshots, but with different values */
export interface DiffChanged {
	type: "changed";
	key: string;
	previousValue: string;
	currentValue: string;
}

/** Result of comparing two memory snapshots */
export interface MemorySnapshotDiff {
	/** Keys that exist only in the current snapshot */
	added: DiffAdded[];
	/** Keys that exist only in the previous snapshot */
	removed: DiffRemoved[];
	/** Keys that exist in both snapshots but have different values */
	changed: DiffChanged[];
	/** True when previous was undefined (current is the initial/earliest snapshot) */
	isInitialSnapshot: boolean;
}

/**
 * Build a lookup map from key → value string for efficient diffing.
 */
function buildKeyMap(items: MemoryItem[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const item of items) {
		map.set(item.key, item.value);
	}
	return map;
}

/**
 * Compute the diff between two memory snapshots.
 *
 * Semantics:
 * - `added`: key only in current (not in previous)
 * - `removed`: key only in previous (not in current)
 * - `changed`: key in both, value strings differ
 * - Unchanged keys are omitted from the result
 *
 * If `previous` is undefined (initial snapshot / nothing to diff against),
 * all current keys are treated as added and `isInitialSnapshot` is set to true.
 *
 * @param previous - The earlier snapshot (or undefined for initial state)
 * @param current  - The later snapshot
 */
export function computeMemorySnapshotDiff(
	previous: MemoryHistorySnapshot | undefined,
	current: MemoryHistorySnapshot,
): MemorySnapshotDiff {
	const added: DiffAdded[] = [];
	const removed: DiffRemoved[] = [];
	const changed: DiffChanged[] = [];

	const prevMap = buildKeyMap(previous?.items ?? []);
	const currMap = buildKeyMap(current.items);

	// Find added and changed keys (present in current)
	for (const [key, currentValue] of currMap) {
		const previousValue = prevMap.get(key);
		if (previousValue === undefined) {
			// Key only in current → added
			added.push({ type: "added", key, value: currentValue });
		} else if (previousValue !== currentValue) {
			// Key in both but value differs → changed
			changed.push({ type: "changed", key, previousValue, currentValue });
		}
		// else: key in both with same value → unchanged, omitted
	}

	// Find removed keys (present only in previous)
	if (previous !== undefined) {
		for (const [key, previousValue] of prevMap) {
			if (!currMap.has(key)) {
				// Key only in previous → removed
				removed.push({ type: "removed", key, value: previousValue });
			}
		}
	}

	return {
		added,
		removed,
		changed,
		isInitialSnapshot: previous === undefined,
	};
}
