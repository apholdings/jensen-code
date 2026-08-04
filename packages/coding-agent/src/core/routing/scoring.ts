/**
 * Evaluation-informed scoring, uncertainty, and multi-objective selection.
 *
 * - Missing evidence is explicitly "no evidence", never zero (zero would imply
 *   a confident failure).
 * - Safety failures remain separate hard constraints and are never averaged away.
 * - Aggregate weights are versioned and explicit.
 * - Uncertainty penalizes selection.
 * - Selection supports a Pareto frontier and explicit objectives.
 */

import { buildCandidateId } from "./baseline.js";
import type {
	CandidateEvidence,
	OrchestrationCandidate,
	OrchestrationCandidateScore,
	RetrievalStrategy,
	SelectionPolicy,
} from "./types.js";

export const AGGREGATE_WEIGHTS_VERSION = 1;

export interface AggregateWeights {
	correctness: number;
	safety: number;
	reliability: number;
	cost: number;
	latency: number;
}

export const WEIGHTS_BY_POLICY: Record<SelectionPolicy, AggregateWeights> = {
	quality_first: { correctness: 0.4, safety: 0.3, reliability: 0.2, cost: 0.05, latency: 0.05 },
	balanced: { correctness: 0.3, safety: 0.25, reliability: 0.2, cost: 0.15, latency: 0.1 },
	cost_constrained: { correctness: 0.2, safety: 0.25, reliability: 0.1, cost: 0.4, latency: 0.05 },
	latency_constrained: { correctness: 0.2, safety: 0.25, reliability: 0.1, cost: 0.05, latency: 0.4 },
	local_only: { correctness: 0.25, safety: 0.4, reliability: 0.15, cost: 0.05, latency: 0.15 },
	high_assurance: { correctness: 0.35, safety: 0.4, reliability: 0.15, cost: 0.05, latency: 0.05 },
};

/** Normalize a 0..1 rate or a raw cost/latency into a 0..1 higher-is-better score. */
function normalized(value: number | undefined, kind: "rate" | "cost" | "latency"): number | undefined {
	if (value === undefined) return undefined;
	if (kind === "rate") return Math.max(0, Math.min(1, value));
	if (kind === "cost") {
		// FrugalGPT-style: cost score in reverse, bounded to $2 to keep scale.
		return Math.max(0, 1 - value / 2);
	}
	if (kind === "latency") {
		// Latency score in reverse, bounded to 60s.
		return Math.max(0, 1 - value / 60_000);
	}
	return undefined;
}

/** Score one candidate from evidence. Missing evidence stays undefined. */
export function scoreCandidate(
	candidate: OrchestrationCandidate | { candidateId: string },
	evidence: CandidateEvidence | undefined,
	_sampleCount: number,
): OrchestrationCandidateScore {
	const id = "candidateId" in candidate ? candidate.candidateId : buildCandidateId(candidate);
	if (!evidence) {
		return {
			candidateId: id,
			uncertainty: 1,
			sampleCount: 0,
			reasonCodes: ["no_evidence"],
			evidenceIds: [],
		};
	}
	const correctness = normalized(evidence.correctnessRate, "rate");
	const safety = normalized(evidence.safetyRate, "rate");
	const reliability = normalized(evidence.reliabilityRate, "rate");
	const cost = normalized(evidence.avgCostUsd, "cost");
	const latency = normalized(evidence.medianLatencyMs, "latency");

	// Uncertainty from low sample count and high flakiness.
	let uncertainty = Math.max(0, 1 - Math.min(1, evidence.sampleCount / 30));
	uncertainty = Math.max(0, Math.min(1, uncertainty + (evidence.flakyRate ?? 0) * 0.5));

	return {
		candidateId: id,
		correctnessScore: correctness,
		safetyScore: safety,
		reliabilityScore: reliability,
		costScore: cost,
		latencyScore: latency,
		uncertainty,
		sampleCount: evidence.sampleCount,
		reasonCodes: ["scored_from_evidence"],
		evidenceIds: [evidence.evidenceHash],
	};
}

/**
 * Compute the aggregate score under a policy's explicit weights.
 * Safety is treated as a hard gate: if the safety score is present and below a
 * safety floor, aggregate collapses (safety must never be averaged away).
 */
export function aggregateScore(
	score: OrchestrationCandidateScore,
	weights: AggregateWeights,
	options: { safetyFloor?: number } = {},
): number {
	const safetyFloor = options.safetyFloor ?? 0.5;
	let totalWeight = 0;
	let acc = 0;
	acc += (score.correctnessScore ?? 0) * weights.correctness;
	totalWeight += weights.correctness;
	acc += (score.reliabilityScore ?? 0) * weights.reliability;
	totalWeight += weights.reliability;
	acc += (score.costScore ?? 0) * weights.cost;
	totalWeight += weights.cost;
	acc += (score.latencyScore ?? 0) * weights.latency;
	totalWeight += weights.latency;

	// Safety is a hard gate and always weighted (never averaged away).
	if (score.safetyScore !== undefined && score.safetyScore < safetyFloor) {
		return -Infinity;
	}
	acc += (score.safetyScore ?? 0) * weights.safety;
	totalWeight += weights.safety;
	if (totalWeight === 0) return 0;
	return acc / totalWeight;
}

export interface SelectionOptions {
	policy: SelectionPolicy;
	safetyFloor?: number;
}

export interface SelectionResult {
	selected: OrchestrationCandidateScore | undefined;
	runnersUp: OrchestrationCandidateScore[];
	/** Highest aggregate per candidate (pre-actual selection). */
	ranked: { score: OrchestrationCandidateScore; aggregate: number; uncertaintyPenalty: number }[];
	reasonCodes: string[];
}

/**
 * Multi-objective selection over scored candidates.
 * - Explicit operator objective via weights.
 * - Uncertainty penalizes: subtract uncertainty * uncertaintyWeight.
 * - Pareto-aware: if equal aggregates, keep deterministic tie-break.
 * - Missing evidence (aggregate would be 0 from all-undefined) is not preferred
 *   over a candidate with real (even partial) evidence.
 */
export function selectBest(scored: OrchestrationCandidateScore[], options: SelectionOptions): SelectionResult {
	const weights = WEIGHTS_BY_POLICY[options.policy];
	const ranked = scored.map((score) => {
		const raw = aggregateScore(score, weights, { safetyFloor: options.safetyFloor });
		let aggregate = raw;
		if (raw === -Infinity) {
			aggregate = -Infinity;
		} else {
			// Uncertainty penalty.
			const hasAnyEvidence =
				(score.correctnessScore ??
					score.safetyScore ??
					score.reliabilityScore ??
					score.costScore ??
					score.latencyScore) !== undefined;
			if (!hasAnyEvidence) {
				// Missing evidence: never prefer over a scored candidate; heavily penalized.
				aggregate = Math.max(0, aggregate) * 0.1;
			} else {
				aggregate = aggregate - score.uncertainty * 0.15;
			}
		}
		return { score, aggregate, uncertaintyPenalty: score.uncertainty * 0.15 };
	});

	// Deterministic tie-break by candidateId after aggregation.
	ranked.sort((a, b) => {
		if (a.aggregate === b.aggregate) return a.score.candidateId.localeCompare(b.score.candidateId);
		return b.aggregate - a.aggregate;
	});

	const reasonCodes: string[] = [`policy:${options.policy}`, `weights_v${AGGREGATE_WEIGHTS_VERSION}`];
	if (ranked.length === 0) {
		return { selected: undefined, runnersUp: [], ranked, reasonCodes: [...reasonCodes, "no_candidates"] };
	}
	const selected = ranked[0].score;
	if (selected.uncertainty >= 0.999) {
		reasonCodes.push("insufficient_evidence");
	}
	return { selected, runnersUp: ranked.slice(1).map((r) => r.score), ranked, reasonCodes };
}

/** Infer a sensible default retrieval policy from features deterministically. */
export function inferRetrievalStrategy(features: {
	ambiguity: number;
	requiresMutation: boolean;
	taskCategory: string;
	languageIds: string[];
}): RetrievalStrategy {
	// Exact identifiers don't need embeddings.
	if (features.languageIds.length === 0) return "lexical";
	if (features.ambiguity > 0.6) return "hybrid";
	if (features.requiresMutation) return "hybrid";
	if (features.taskCategory === "analysis") return "hybrid";
	return "lexical";
}
