/**
 * Controlled runtime escalation and de-escalation.
 *
 * Escalation moves to a stronger (more capable / more budgeted) candidate.
 * De-escalation moves to a cheaper/faster candidate. Both are governed by an
 * explicit transition policy, bounded by maximum transitions, and never exceed
 * the operator budget. Configured and resolved model stay distinct; no hidden
 * model substitution occurs.
 */

import { appendEvent } from "./store.js";
import type { OrchestrationCandidate } from "./types.js";

export interface EscalationSignal {
	reasonCode: string;
	/** 0..1 severity / confidence that escalation is warranted. */
	strength: number;
}

export interface EscalationPolicy {
	/** Maximum escalating transitions per run (hard bound). */
	maxEscalations: number;
	/** Maximum de-escalating transitions per run. */
	maxDeescalations: number;
	/** Model escalation cannot exceed this provider/model capability tier. */
	maxModelTier: number;
	/** Budget cannot exceed operator ceiling (checked by caller). */
}

export const DEFAULT_ESCALATION_POLICY: EscalationPolicy = {
	maxEscalations: 3,
	maxDeescalations: 3,
	maxModelTier: 5,
};

export interface TransitionResult {
	kind: "escalate" | "deescalate" | "stay";
	nextCandidate?: OrchestrationCandidate;
	reasonCode: string;
	remainingEscalations: number;
	remainingDeescalations: number;
	durEvent: { type: "ORCHESTRATION_ESCALATION_APPLIED" | "ORCHESTRATION_DEESCALATION_APPLIED"; reasonCode: string };
}

const ESCALATE_SIGNALS = new Set([
	"repeated_structured_output_failure",
	"uncertainty_above_threshold",
	"stall_detected",
	"failed_focused_validation",
	"retrieval_confidence_too_low",
	"reviewer_found_critical_defect",
	"provider_capability_mismatch",
]);

const DEESCALATE_SIGNALS = new Set([
	"simple_remaining_phase",
	"resolved_uncertainty",
	"read_only_synthesis",
	"budget_pressure",
	"repetitive_deterministic_work",
]);

/** Decide whether to escalate, de-escalate, or stay, given signals and bounds. */
export function decideTransition(
	signals: EscalationSignal[],
	currentCandidate: OrchestrationCandidate,
	candidatesByModelTier: Map<string, OrchestrationCandidate[]>,
	tierOf: (candidateId: string) => number,
	policy: EscalationPolicy = DEFAULT_ESCALATION_POLICY,
	runtime: { escalationsUsed: number; deescalationsUsed: number; budgetRemainingReserve: boolean },
): TransitionResult {
	const escalateSignal = signals.find((s) => ESCALATE_SIGNALS.has(s.reasonCode) && s.strength >= 0.5);
	const deescalateSignal = signals.find((s) => DEESCALATE_SIGNALS.has(s.reasonCode) && s.strength >= 0.5);

	// De-escalation can never remove a required reviewer/validation: only allow
	// de-escalation to topologies that retain review when the current one has one.
	function preservesRequired(constraint: OrchestrationCandidate): boolean {
		if (currentCandidate.executionTopology === "single_agent_with_reviewer") {
			return constraint.executionTopology === "single_agent_with_reviewer";
		}
		return true;
	}

	if (escalateSignal && runtime.escalationsUsed < policy.maxEscalations && runtime.budgetRemainingReserve) {
		const currentTier = tierOf(currentCandidate.candidateId);
		if (currentTier < policy.maxModelTier) {
			const stronger = pickStronger(currentCandidate, candidatesByModelTier, tierOf);
			if (stronger) {
				appendEvent({
					type: "ORCHESTRATION_ESCALATION_APPLIED",
					runId: undefined,
					candidateId: stronger.candidateId,
					payload: { reasonCode: escalateSignal.reasonCode, from: currentCandidate.candidateId },
				});
				return {
					kind: "escalate",
					nextCandidate: stronger,
					reasonCode: escalateSignal.reasonCode,
					remainingEscalations: policy.maxEscalations - runtime.escalationsUsed - 1,
					remainingDeescalations: policy.maxDeescalations - runtime.deescalationsUsed,
					durEvent: { type: "ORCHESTRATION_ESCALATION_APPLIED", reasonCode: escalateSignal.reasonCode },
				};
			}
		}
	}

	if (deescalateSignal && runtime.deescalationsUsed < policy.maxDeescalations) {
		const cheaper = pickCheaper(currentCandidate, candidatesByModelTier, tierOf, preservesRequired);
		if (cheaper) {
			appendEvent({
				type: "ORCHESTRATION_DEESCALATION_APPLIED",
				runId: undefined,
				candidateId: cheaper.candidateId,
				payload: { reasonCode: deescalateSignal.reasonCode, from: currentCandidate.candidateId },
			});
			return {
				kind: "deescalate",
				nextCandidate: cheaper,
				reasonCode: deescalateSignal.reasonCode,
				remainingEscalations: policy.maxEscalations - runtime.escalationsUsed,
				remainingDeescalations: policy.maxDeescalations - runtime.deescalationsUsed - 1,
				durEvent: { type: "ORCHESTRATION_DEESCALATION_APPLIED", reasonCode: deescalateSignal.reasonCode },
			};
		}
	}

	return {
		kind: "stay",
		reasonCode: "no_transition_warranted",
		remainingEscalations: policy.maxEscalations - runtime.escalationsUsed,
		remainingDeescalations: policy.maxDeescalations - runtime.deescalationsUsed,
		durEvent: { type: "ORCHESTRATION_ESCALATION_APPLIED", reasonCode: "no_transition_warranted" },
	};
}

function pickStronger(
	current: OrchestrationCandidate,
	byTier: Map<string, OrchestrationCandidate[]>,
	tierOf: (id: string) => number,
): OrchestrationCandidate | undefined {
	const curTier = tierOf(current.candidateId);
	let best: OrchestrationCandidate | undefined;
	for (const [tier, cands] of byTier) {
		const t = Number(tier);
		if (t > curTier) {
			for (const c of cands) {
				if (!best || c.candidateId.localeCompare(best.candidateId) < 0) best = c;
			}
		}
	}
	return best;
}

function pickCheaper(
	current: OrchestrationCandidate,
	byTier: Map<string, OrchestrationCandidate[]>,
	tierOf: (id: string) => number,
	preservesRequired: (c: OrchestrationCandidate) => boolean,
): OrchestrationCandidate | undefined {
	const curTier = tierOf(current.candidateId);
	let best: OrchestrationCandidate | undefined;
	for (const [tier, cands] of byTier) {
		const t = Number(tier);
		if (t < curTier) {
			for (const c of cands) {
				if (!preservesRequired(c)) continue;
				if (!best || c.candidateId.localeCompare(best.candidateId) < 0) best = c;
			}
		}
	}
	return best;
}
