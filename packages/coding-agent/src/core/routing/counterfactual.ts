/**
 * Counterfactual evaluation.
 *
 * Estimates whether another candidate may have performed better using
 * evaluation scenarios, replays, or comparable historical runs. Results are
 * clearly labeled as estimates, carry explicit uncertainty, identify the
 * off-policy estimator, and never retroactively change completed-run authority.
 */

import type { CandidateEvidence } from "./types.js";

export type CounterfactualMode = "direct_paired" | "replay_compatible" | "matched_historical" | "unsupported";

export interface CounterfactualEstimate {
	decisionId: string;
	productionCandidateId?: string;
	counterfactualCandidateId?: string;
	mode: CounterfactualMode;
	estimator: "direct" | "doubly_robust" | "importance_sampling" | "none";
	estimatedWouldHaveImproved: boolean;
	effectSize: number;
	uncertainty: number;
	supported: boolean;
	reasonCodes: string[];
}

export interface CounterfactualInput {
	decisionId: string;
	productionCandidateId?: string;
	counterfactualCandidateId?: string;
	productionEvidence?: CandidateEvidence;
	counterfactualEvidence?: CandidateEvidence;
	/** Environment/task compatibility flags. */
	compatible: { task: boolean; environment: boolean; scenario: boolean; identity: boolean };
}

/**
 * Produce a counterfactual estimate. Only produces a supported numeric estimate
 * when evidence for both candidates exists and identities are compatible.
 * Otherwise it reports an explicit "unsupported" mode with no causal claim.
 */
export function evaluateCounterfactual(input: CounterfactualInput): CounterfactualEstimate {
	const compat = input.compatible;
	const identCompatible = compat.task && compat.environment && compat.scenario && compat.identity;

	if (!identCompatible || !input.productionEvidence || !input.counterfactualEvidence) {
		return {
			decisionId: input.decisionId,
			productionCandidateId: input.productionCandidateId,
			counterfactualCandidateId: input.counterfactualCandidateId,
			mode: identCompatible ? "matched_historical" : "unsupported",
			estimator: "none",
			estimatedWouldHaveImproved: false,
			effectSize: 0,
			uncertainty: 1,
			supported: false,
			reasonCodes: ["incompatible_identity", "missing_evidence"],
		};
	}

	const prod = input.productionEvidence;
	const cf = input.counterfactualEvidence;

	const prodScore =
		(prod.correctnessRate ?? 0) * 0.5 + (prod.reliabilityRate ?? 0) * 0.3 + (prod.safetyRate ?? 0) * 0.2;
	const cfScore = (cf.correctnessRate ?? 0) * 0.5 + (cf.reliabilityRate ?? 0) * 0.3 + (cf.safetyRate ?? 0) * 0.2;
	const effectSize = cfScore - prodScore;
	const uncertainty = 0.5 + Math.max(0, 1 - Math.min(1, Math.min(prod.sampleCount, cf.sampleCount) / 20)) * 0.4;

	return {
		decisionId: input.decisionId,
		productionCandidateId: input.productionCandidateId,
		counterfactualCandidateId: input.counterfactualCandidateId,
		mode: "matched_historical",
		estimator: "direct",
		estimatedWouldHaveImproved: effectSize > 0,
		effectSize: Number(effectSize.toFixed(4)),
		uncertainty: Number(uncertainty.toFixed(4)),
		supported: true,
		reasonCodes: ["direct_paired_estimate", "uncertainty_explicit"],
	};
}
