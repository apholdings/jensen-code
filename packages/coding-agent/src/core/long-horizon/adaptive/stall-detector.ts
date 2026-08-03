/**
 * Bounded stall detector.
 *
 * Detects no-progress at strategy/phase level using structured progress
 * observations (and call-level no-progress evidence from the 1.4.0 Tool Storm
 * Breaker). Proceeds through bounded stages:
 *
 *   none → warning → strategy_review → pivot_required → blocked
 *
 * It never permits infinite self-reflection. Legitimate waiting for a changing
 * external condition is not counted as stall when a bounded polling policy
 * exists.
 */

import type { ProgressAccumulator } from "./progress.js";
import { accumulatorWeight } from "./progress.js";
import type { StallLevel, StallState } from "./types.js";

export interface StallConfig {
	/** Turns without structured progress before a warning. */
	warningAfterNoProgressTurns: number;
	/** Calls without structured progress before a warning. */
	warningAfterNoProgressCalls: number;
	/** ... before strategy_review. */
	reviewAfterNoProgressTurns: number;
	reviewAfterNoProgressCalls: number;
	/** ... before pivot_required. */
	pivotAfterNoProgressTurns: number;
	pivotAfterNoProgressCalls: number;
	/** ... before blocked. */
	blockedAfterNoProgressTurns: number;
	blockedAfterNoProgressCalls: number;
}

export const DEFAULT_STALL_CONFIG: StallConfig = {
	warningAfterNoProgressTurns: 20,
	warningAfterNoProgressCalls: 40,
	reviewAfterNoProgressTurns: 40,
	reviewAfterNoProgressCalls: 80,
	pivotAfterNoProgressTurns: 60,
	pivotAfterNoProgressCalls: 120,
	blockedAfterNoProgressTurns: 90,
	blockedAfterNoProgressCalls: 180,
};

export interface StallInput {
	progress: ProgressAccumulator;
	noProgressTurns: number;
	noProgressToolCalls: number;
	repeatedFailureFingerprint?: string;
	evidenceIds?: string[];
	oscillationCount?: number;
	config?: StallConfig;
}

export interface StallEvaluation {
	state: StallState;
	previousLevel?: StallLevel;
}

/**
 * Deterministically evaluate stall level from no-progress counts and the
 * structured progress accumulator. The accumulator is the authority on progress:
 * prose never resets stall.
 */
export function evaluateStall(input: StallInput): StallEvaluation {
	const config = input.config ?? DEFAULT_STALL_CONFIG;
	const progressWeight = accumulatorWeight(input.progress);

	const effectiveNoProgressTurns =
		progressWeight > 0 ? Math.max(0, input.noProgressTurns - Math.floor(progressWeight / 3)) : input.noProgressTurns;

	const reasonCodes: string[] = [];
	let level: StallLevel = "none";

	if (input.oscillationCount && input.oscillationCount >= 2) {
		reasonCodes.push("STRATEGY_OSCILLATION");
	}
	if (input.repeatedFailureFingerprint) {
		reasonCodes.push("REPEATED_FAILURE_FINGERPRINT");
	}

	if (
		effectiveNoProgressTurns >= config.blockedAfterNoProgressTurns ||
		input.noProgressToolCalls >= config.blockedAfterNoProgressCalls
	) {
		level = "blocked";
		reasonCodes.push("NO_PROGRESS_BLOCKED");
	} else if (
		effectiveNoProgressTurns >= config.pivotAfterNoProgressTurns ||
		input.noProgressToolCalls >= config.pivotAfterNoProgressCalls
	) {
		level = "pivot_required";
		reasonCodes.push("NO_PROGRESS_PIVOT_REQUIRED");
	} else if (
		effectiveNoProgressTurns >= config.reviewAfterNoProgressTurns ||
		input.noProgressToolCalls >= config.reviewAfterNoProgressCalls
	) {
		level = "strategy_review";
		reasonCodes.push("NO_PROGRESS_STRATEGY_REVIEW");
	} else if (
		effectiveNoProgressTurns >= config.warningAfterNoProgressTurns ||
		input.noProgressToolCalls >= config.warningAfterNoProgressCalls
	) {
		level = "warning";
		reasonCodes.push("NO_PROGRESS_WARNING");
	}

	const state: StallState = {
		level,
		reasonCodes: Object.freeze([...new Set(reasonCodes)]),
		noProgressTurns: effectiveNoProgressTurns,
		noProgressToolCalls: input.noProgressToolCalls,
		repeatedFailureFingerprint: input.repeatedFailureFingerprint,
		evidenceIds: Object.freeze([...(input.evidenceIds ?? [])]),
	};
	return { state };
}

/**
 * Poll-gating helper: a bounded polling policy counts as legitimate waiting,
 * not stall, when the poll observes a state change.
 */
export function pollProgress(
	previousHash: string | undefined,
	currentHash: string | undefined,
	hasStructure: boolean,
): boolean {
	return hasStructure && Boolean(previousHash) && Boolean(currentHash) && previousHash !== currentHash;
}

/** Stage the next action after a stall level. */
export function stallNextAction(
	level: StallLevel,
): "continue" | "self_review" | "review" | "pivot" | "escalate" | "block" {
	switch (level) {
		case "none":
			return "continue";
		case "warning":
			return "self_review";
		case "strategy_review":
			return "review";
		case "pivot_required":
			return "pivot";
		case "blocked":
			return "block";
	}
}
