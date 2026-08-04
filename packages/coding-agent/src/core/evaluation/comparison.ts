import { comparePairedResults } from "./statistics.js";
import type { EvaluationArtifact, EvaluationRegressionRule, PairwiseEvaluationResult } from "./types.js";

export function compareArtifacts(
	baseline: EvaluationArtifact,
	candidate: EvaluationArtifact,
): PairwiseEvaluationResult {
	if (
		baseline.scenario.scenarioId !== candidate.scenario.scenarioId ||
		baseline.scenario.scenarioVersion !== candidate.scenario.scenarioVersion ||
		baseline.scenario.scenarioContentHash !== candidate.scenario.scenarioContentHash
	)
		throw new Error("paired comparison requires matching scenario identity");
	const baselinePassed = baseline.verdict === "pass" && !hasSafetyFailure(baseline);
	const candidatePassed = candidate.verdict === "pass" && !hasSafetyFailure(candidate);
	const baselineMetrics = new Map(baseline.metrics.map((metric) => [metric.metricId, metric.value]));
	const metricDeltas: Record<string, number | undefined> = {};
	for (const metric of candidate.metrics) {
		const baselineValue = baselineMetrics.get(metric.metricId);
		metricDeltas[metric.metricId] =
			baselineValue === undefined || metric.value === undefined ? undefined : metric.value - baselineValue;
	}
	return {
		scenarioId: candidate.scenario.scenarioId,
		baselineRunId: baseline.run.evaluationRunId,
		candidateRunId: candidate.run.evaluationRunId,
		deterministicComparison: { baselinePassed, candidatePassed },
		metricDeltas,
	};
}

export function compareRegressionRules(
	baseline: EvaluationArtifact,
	candidate: EvaluationArtifact,
	rules: EvaluationRegressionRule[],
): string[] {
	const baselineMetrics = new Map(baseline.metrics.map((metric) => [metric.metricId, metric.value]));
	const candidateMetrics = new Map(candidate.metrics.map((metric) => [metric.metricId, metric.value]));
	const regressions: string[] = [];
	for (const rule of rules) {
		const before = baselineMetrics.get(rule.metricId);
		const after = candidateMetrics.get(rule.metricId);
		if (before === undefined || after === undefined) continue;
		if (
			rule.maximumRelativeIncrease !== undefined &&
			before !== 0 &&
			(after - before) / Math.abs(before) > rule.maximumRelativeIncrease
		)
			regressions.push(`${rule.metricId}: relative increase ${(after - before) / Math.abs(before)}`);
		if (rule.minimumAbsoluteDecrease !== undefined && before - after > rule.minimumAbsoluteDecrease)
			regressions.push(`${rule.metricId}: decrease ${before - after}`);
	}
	if (baselinePassed(baseline) && !candidatePassed(candidate))
		regressions.push("correctness: candidate no longer passes");
	if (!hasSafetyFailure(baseline) && hasSafetyFailure(candidate))
		regressions.push("safety: new critical or high failure");
	return regressions;
}

export function aggregatePairwise(comparisons: PairwiseEvaluationResult[]) {
	return comparePairedResults(comparisons);
}

function baselinePassed(artifact: EvaluationArtifact): boolean {
	return artifact.verdict === "pass" && !hasSafetyFailure(artifact);
}

function candidatePassed(artifact: EvaluationArtifact): boolean {
	return artifact.verdict === "pass" && !hasSafetyFailure(artifact);
}

function hasSafetyFailure(artifact: EvaluationArtifact): boolean {
	return artifact.assertions.some(
		(assertion) =>
			(assertion.severity === "critical" || assertion.severity === "high") && assertion.status !== "pass",
	);
}
