/**
 * Structured progress model.
 *
 * Progress is authoritative only when it corresponds to a verifiable structured
 * state change (new verified evidence, new source, new file-content hash, new
 * test result, new phase, resolved blocker, reduced failing-test count, ...).
 * Model prose, repeated identical reads/searches/commands, and reformatting are
 * NOT progress. Progress weights are deterministic and configurable — never
 * invented turn-by-turn by the model.
 */

import type { ProgressObservation } from "./types.js";

/** Progress categories and their deterministic default weights. */
export const PROGRESS_CATEGORY_WEIGHTS: Record<string, number> = {
	new_verified_evidence: 3,
	new_source_fetched: 2,
	new_file_content_hash: 2,
	new_transaction_confirmed: 3,
	new_test_result: 2,
	new_diagnostics_delta: 1,
	new_job_state: 1,
	new_long_horizon_phase: 2,
	resolved_blocker: 3,
	reduced_failing_test_count: 3,
	completed_acceptance_criterion: 3,
};

/** Categories that never constitute progress on their own. */
export const NON_PROGRESS_CATEGORIES: ReadonlySet<string> = new Set([
	"model_prose",
	"repeated_search",
	"repeated_file_read",
	"repeated_failing_command",
	"reformatted_explanation",
	"job_poll_no_state_change",
]);

export interface ProgressParams {
	category: string;
	previousStateHash?: string;
	currentStateHash?: string;
	evidenceIds: string[];
	weights?: Record<string, number>;
}

export interface ProgressResult {
	observation: ProgressObservation | null;
	isProgress: boolean;
	reason: string;
	weight: number;
}

export interface ProgressAccumulator {
	runId: string;
	observations: readonly ProgressObservation[];
}

export function createProgressAccumulator(runId: string): ProgressAccumulator {
	return { runId, observations: Object.freeze([]) };
}

export function accumulatorWeight(acc: ProgressAccumulator): number {
	return acc.observations.reduce((sum, o) => sum + o.progressWeight, 0);
}

/**
 * Evaluate a progress signal deterministically. Returns `null` observation when
 * the signal is not authoritative progress (prose, duplicate, no state change).
 */
export function observeProgress(acc: ProgressAccumulator, params: ProgressParams, recordedAt: string): ProgressResult {
	const weights = params.weights ?? PROGRESS_CATEGORY_WEIGHTS;

	if (NON_PROGRESS_CATEGORIES.has(params.category)) {
		return { observation: null, isProgress: false, reason: `NON_PROGRESS_CATEGORY:${params.category}`, weight: 0 };
	}

	const weight = weights[params.category];
	if (weight === undefined || weight <= 0) {
		return { observation: null, isProgress: false, reason: `UNKNOWN_OR_ZERO_WEIGHT:${params.category}`, weight: 0 };
	}

	// A state change must be present and must differ from the previous state.
	if (!params.currentStateHash) {
		return { observation: null, isProgress: false, reason: "NO_STATE_HASH", weight: 0 };
	}
	if (params.previousStateHash && params.previousStateHash === params.currentStateHash && weight <= 1) {
		return { observation: null, isProgress: false, reason: "NO_STATE_CHANGE", weight: 0 };
	}

	// Deduplicate identical evidence-backed observations for the same state.
	for (const o of acc.observations) {
		if (o.category === params.category && o.currentStateHash === params.currentStateHash && o.phaseId === undefined) {
			return { observation: null, isProgress: false, reason: `DUPLICATE_PROGRESS:${params.category}`, weight: 0 };
		}
	}

	const observationId = `obs-${acc.observations.length + 1}-${recordedAt.length}-${params.category}`;
	const observation: ProgressObservation = Object.freeze({
		observationId,
		runId: acc.runId,
		category: params.category,
		previousStateHash: params.previousStateHash,
		currentStateHash: params.currentStateHash,
		evidenceIds: Object.freeze([...params.evidenceIds]),
		progressWeight: weight,
		recordedAt,
	});
	return { observation, isProgress: true, reason: "STRUCTURED_PROGRESS", weight };
}

export function appendObservation(
	acc: ProgressAccumulator,
	observation: ProgressObservation | null,
): ProgressAccumulator {
	if (!observation) return acc;
	return { runId: acc.runId, observations: Object.freeze([...acc.observations, observation]) };
}

/** Compute a short deterministic file-content state hash surrogate. */
export function fileContentHash(content: string): string {
	let hash = 5381;
	for (let i = 0; i < content.length; i += 1) {
		hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0;
	}
	return `h${Math.abs(hash).toString(16)}`;
}
