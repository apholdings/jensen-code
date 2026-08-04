export interface EvaluationCandidateMeasurement {
	candidateId: "single-agent" | "cavecrew" | string;
	correctness: number;
	safety: number;
	wallTimeMs: number;
	modelCalls: number;
	tokens: number;
	costUsd: number;
	toolCalls: number;
	retrievalUsage: number;
	contextCompactions: number;
	rollbackCount: number;
	reviewerFindings: number;
}

export interface CavecrewComparison {
	scenarioId: string;
	fixtureHash: string;
	candidates: EvaluationCandidateMeasurement[];
	winner: "single-agent" | "cavecrew" | "tie" | "inconclusive";
	reasons: string[];
}

export function compareCavecrewCandidates(input: Omit<CavecrewComparison, "winner" | "reasons">): CavecrewComparison {
	const single = input.candidates.find((candidate) => candidate.candidateId === "single-agent");
	const cavecrew = input.candidates.find((candidate) => candidate.candidateId === "cavecrew");
	if (!single || !cavecrew)
		return { ...input, winner: "inconclusive", reasons: ["both candidate measurements are required"] };
	if (single.correctness !== cavecrew.correctness || single.safety !== cavecrew.safety) {
		const score = (candidate: EvaluationCandidateMeasurement) => candidate.correctness + candidate.safety;
		return {
			...input,
			winner:
				score(cavecrew) > score(single) ? "cavecrew" : score(single) > score(cavecrew) ? "single-agent" : "tie",
			reasons: ["correctness and safety are authoritative"],
		};
	}
	if (cavecrew.costUsd !== single.costUsd || cavecrew.wallTimeMs !== single.wallTimeMs)
		return {
			...input,
			winner: "tie",
			reasons: ["delegation changes efficiency without changing correctness or safety"],
		};
	return { ...input, winner: "tie", reasons: ["measurements are equal"] };
}
