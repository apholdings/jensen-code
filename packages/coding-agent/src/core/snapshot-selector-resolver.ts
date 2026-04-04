import type { MemoryHistorySnapshot } from "./memory.js";

/** Displayed short ID length used in /memory history output. */
export const MEMORY_SNAPSHOT_SHORT_ID_LENGTH = 8;

/** Machine-readable error codes for snapshot selector resolution. */
export type SnapshotResolutionError = "empty" | "not_found" | "ambiguous";

/**
 * Result of strict snapshot selector resolution.
 *
 * Contract:
 * - `matchedInput` is always the normalized selector actually evaluated
 * - `resolvedId` is the full `entryId` when resolution succeeds
 * - `candidates` is populated only for ambiguous-prefix failures
 */
export interface SnapshotResolution {
	snapshot: MemoryHistorySnapshot | undefined;
	matchedInput: string;
	resolvedId: string | undefined;
	error: SnapshotResolutionError | undefined;
	candidates: string[];
}

/**
 * Normalize a raw snapshot selector typed or pasted by the operator.
 *
 * Accepted normalization rules:
 * - trim surrounding whitespace
 * - strip one pair of surrounding brackets copied from `/memory history`
 * - treat `[]` as empty input
 */
export function normalizeSnapshotSelector(input: string): string {
	const trimmed = input.trim();
	if (trimmed === "[]") {
		return "";
	}

	return trimmed.replace(/^\[([^\]]+)\]$/, "$1").trim();
}

/** Resolve a snapshot selector against a provided current-branch snapshot list. */
export function resolveSnapshotSelector(
	selector: string,
	snapshots: readonly MemoryHistorySnapshot[],
): SnapshotResolution {
	const matchedInput = normalizeSnapshotSelector(selector);
	if (!matchedInput) {
		return {
			snapshot: undefined,
			matchedInput,
			resolvedId: undefined,
			error: "empty",
			candidates: [],
		};
	}

	const exactFullMatch = snapshots.find((snapshot) => snapshot.entryId === matchedInput);
	if (exactFullMatch) {
		return {
			snapshot: exactFullMatch,
			matchedInput,
			resolvedId: exactFullMatch.entryId,
			error: undefined,
			candidates: [],
		};
	}

	const exactShortMatch = snapshots.find(
		(snapshot) => snapshot.entryId.slice(0, MEMORY_SNAPSHOT_SHORT_ID_LENGTH) === matchedInput,
	);
	if (exactShortMatch) {
		return {
			snapshot: exactShortMatch,
			matchedInput,
			resolvedId: exactShortMatch.entryId,
			error: undefined,
			candidates: [],
		};
	}

	const prefixMatches = snapshots.filter((snapshot) => snapshot.entryId.startsWith(matchedInput));
	if (prefixMatches.length === 1) {
		const uniquePrefixMatch = prefixMatches[0]!;
		return {
			snapshot: uniquePrefixMatch,
			matchedInput,
			resolvedId: uniquePrefixMatch.entryId,
			error: undefined,
			candidates: [],
		};
	}

	if (prefixMatches.length > 1) {
		return {
			snapshot: undefined,
			matchedInput,
			resolvedId: undefined,
			error: "ambiguous",
			candidates: prefixMatches.map((snapshot) => snapshot.entryId),
		};
	}

	return {
		snapshot: undefined,
		matchedInput,
		resolvedId: undefined,
		error: "not_found",
		candidates: [],
	};
}
