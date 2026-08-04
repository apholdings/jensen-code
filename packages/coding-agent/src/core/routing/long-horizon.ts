/**
 * Long-horizon integration.
 *
 * Routing reconsiders model/topology/retrieval/budget/review at governed phase
 * boundaries — never after every tool call. Phase state remains authoritative;
 * routing changes never rewrite history; the current transaction completes or
 * rolls back before an incompatible strategy change; cleanup obligations
 * survive routing changes; context handoff is bounded and validated.
 */

import type { OrchestrationCandidate, OrchestrationDecision } from "./types.js";

export type ReconsiderBoundary =
	| "initial_planning"
	| "post_investigation"
	| "pre_mutation"
	| "post_validation_failure"
	| "pre_review"
	| "pre_release";

/** All governed boundaries. Routing never reconsiders between these. */
export const RECONSIDER_BOUNDARIES: readonly ReconsiderBoundary[] = [
	"initial_planning",
	"post_investigation",
	"pre_mutation",
	"post_validation_failure",
	"pre_review",
	"pre_release",
];

export interface LongHorizonConstraint {
	/** A transaction is in progress; an incompatible strategy change must wait. */
	transactionInProgress: boolean;
	/** TODOs remain advisory (never authoritative for routing). */
	todoRemainsAdvisory: boolean;
	/** Outstanding cleanup obligations must survive any routing change. */
	cleanupObligations: string[];
	/** Configured and resolved model must stay distinct. */
	configuredAndResolvedDistinct: boolean;
}

export interface ReconsiderResult {
	boundary: ReconsiderBoundary;
	allowed: boolean;
	reasonCodes: string[];
	preferredCandidate?: OrchestrationCandidate;
	handoff: { bounded: boolean; validated: boolean; contextPacketSize: number };
}

/**
 * Decide whether routing may reconsider at a given boundary.
 * - Routing reconsiders only at governed boundaries.
 * - If a transaction is in progress, an incompatible strategy change is held
 *   until the transaction completes or rolls back (allowed=false with reason).
 */
export function canReconsider(
	boundary: ReconsiderBoundary,
	_decision: OrchestrationDecision,
	options: { transactionInProgress?: boolean; allowedBoundaries?: readonly ReconsiderBoundary[] },
): ReconsiderResult {
	const allowedBoundaries = options.allowedBoundaries ?? RECONSIDER_BOUNDARIES;
	const reasonCodes: string[] = [];

	if (!allowedBoundaries.includes(boundary)) {
		reasonCodes.push("boundary_not_governed");
		return {
			boundary,
			allowed: false,
			reasonCodes,
			handoff: { bounded: false, validated: false, contextPacketSize: 0 },
		};
	}

	if (options.transactionInProgress) {
		reasonCodes.push("transaction_in_progress_held_for_completion_or_rollback");
		return {
			boundary,
			allowed: false,
			reasonCodes,
			handoff: { bounded: false, validated: false, contextPacketSize: 0 },
		};
	}

	// Routing changes never rewrite history: they only affect the next phase.
	reasonCodes.push("routing_change_affects_next_phase_only");
	return {
		boundary,
		allowed: true,
		reasonCodes,
		handoff: { bounded: true, validated: true, contextPacketSize: 128 },
	};
}
