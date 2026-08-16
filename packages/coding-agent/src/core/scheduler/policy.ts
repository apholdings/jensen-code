/**
 * Scheduler Foundation — deterministic policy (2.12.0).
 *
 * Pure, side-effect-free executor selection. There is no scoring, ranking, or
 * random tie-breaking: candidates are total-ordered by `executorId`, and intents
 * are total-ordered by `priority` (descending), then `enqueuedAtMs` (FIFO), then
 * `intentId`. Identical scheduler state always yields an identical decision.
 */

import type { AssignabilityResult } from "../assignment/assignment-types.js";
import type { ExecutorLivenessStatus } from "../executor-registry/executor-registry-types.js";
import type { SchedulingIntentRecord, SchedulingPolicyMode } from "./scheduler-types.js";

/** One executor considered for a single intent, with its liveness observation. */
export interface ExecutorCandidate {
	executorId: string;
	status: ExecutorLivenessStatus;
	assignability: AssignabilityResult;
	/** Number of current (designation) assignments already held by this executor. */
	currentAssignmentCount: number;
}

/** Deterministic intent processing order. */
export function orderPendingIntents(records: readonly SchedulingIntentRecord[]): SchedulingIntentRecord[] {
	return [...records].sort((a, b) => {
		if (b.priority !== a.priority) return b.priority - a.priority;
		if (a.enqueuedAtMs !== b.enqueuedAtMs) return a.enqueuedAtMs - b.enqueuedAtMs;
		if (a.intentId !== b.intentId) return a.intentId < b.intentId ? -1 : 1;
		return 0;
	});
}

/** Deterministic candidate ordering: ascending executorId. */
export function sortExecutorCandidates(candidates: readonly ExecutorCandidate[]): ExecutorCandidate[] {
	return [...candidates].sort((a, b) => (a.executorId < b.executorId ? -1 : a.executorId > b.executorId ? 1 : 0));
}

/**
 * Choose one executor deterministically.
 *
 * - `first-fit`: the first assignable executor by ascending executorId.
 * - `least-assigned`: the assignable executor with the fewest current
 *   assignments, tie-broken by ascending executorId.
 */
export function chooseExecutor(
	candidates: readonly ExecutorCandidate[],
	mode: SchedulingPolicyMode,
): ExecutorCandidate | undefined {
	const sorted = sortExecutorCandidates(candidates);
	if (sorted.length === 0) return undefined;
	if (mode === "least-assigned") {
		let best = sorted[0];
		for (const candidate of sorted) {
			if (candidate.currentAssignmentCount < best.currentAssignmentCount) best = candidate;
		}
		return best;
	}
	return sorted[0];
}
