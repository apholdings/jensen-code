import type { EvaluationArtifact, EvaluationStabilityResult } from "./types.js";

function populationVariance(values: number[]): number {
	if (values.length < 2) return 0;
	const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
	return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
}

export function aggregateStability(artifacts: EvaluationArtifact[]): EvaluationStabilityResult {
	const passCount = artifacts.filter((artifact) => artifact.verdict === "pass").length;
	const failCount = artifacts.filter((artifact) => artifact.verdict === "fail").length;
	const invalidCount = artifacts.length - passCount - failCount;
	const verdicts = new Set(artifacts.map((artifact) => artifact.verdict));
	const metricIds = new Set(artifacts.flatMap((artifact) => artifact.metrics.map((metric) => metric.metricId)));
	const metricVariance: Record<string, number> = {};
	for (const metricId of [...metricIds].sort()) {
		const values = artifacts
			.map((artifact) => artifact.metrics.find((metric) => metric.metricId === metricId)?.value)
			.filter((value): value is number => value !== undefined);
		if (values.length === artifacts.length) metricVariance[metricId] = populationVariance(values);
	}
	const classification: EvaluationStabilityResult["classification"] =
		artifacts.length < 2
			? "insufficient_samples"
			: verdicts.size > 1 || invalidCount > 0
				? "flaky"
				: passCount === artifacts.length
					? "stable_pass"
					: failCount === artifacts.length
						? "stable_fail"
						: "insufficient_samples";
	return {
		repetitions: artifacts.length,
		passCount,
		failCount,
		invalidCount,
		outcomeVariance: verdicts.size > 1 ? 1 : 0,
		metricVariance,
		classification,
		seeds: artifacts.map((artifact, index) => artifact.candidate.seed ?? index),
	};
}
