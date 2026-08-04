import type { EvaluationArtifact, PairwiseEvaluationResult, StatisticalComparison } from "./types.js";

export function comparePairedResults(results: PairwiseEvaluationResult[]): StatisticalComparison {
	const valid = results.filter(
		(result) => result.deterministicComparison.baselinePassed || result.deterministicComparison.candidatePassed,
	);
	if (valid.length === 0)
		return {
			sampleSize: 0,
			confidenceLevel: 0.95,
			method: "paired_win_tie_loss",
			winRate: undefined,
			tieRate: undefined,
			lossRate: undefined,
			adequateSample: false,
		};
	let wins = 0;
	let losses = 0;
	let ties = 0;
	for (const result of valid) {
		if (
			result.semanticPreference === "candidate" ||
			(!result.semanticPreference &&
				result.deterministicComparison.candidatePassed &&
				!result.deterministicComparison.baselinePassed)
		)
			wins++;
		else if (
			result.semanticPreference === "baseline" ||
			(!result.semanticPreference &&
				result.deterministicComparison.baselinePassed &&
				!result.deterministicComparison.candidatePassed)
		)
			losses++;
		else ties++;
	}
	return {
		sampleSize: valid.length,
		confidenceLevel: 0.95,
		method: "paired_win_tie_loss",
		winRate: wins / valid.length,
		tieRate: ties / valid.length,
		lossRate: losses / valid.length,
		confidenceInterval: wilsonInterval(wins, valid.length, 0.95),
		adequateSample: valid.length >= 10,
	};
}

export function bootstrapPercentile(
	values: number[],
	seed = 17,
	samples = 1000,
): { estimate: number | undefined; lower: number | undefined; upper: number | undefined; sampleSize: number } {
	if (values.length === 0) return { estimate: undefined, lower: undefined, upper: undefined, sampleSize: 0 };
	const random = seededRandom(seed);
	const means: number[] = [];
	for (let sample = 0; sample < samples; sample++) {
		let total = 0;
		for (let index = 0; index < values.length; index++) total += values[Math.floor(random() * values.length)]!;
		means.push(total / values.length);
	}
	means.sort((left, right) => left - right);
	return {
		estimate: mean(values),
		lower: means[Math.floor(samples * 0.025)],
		upper: means[Math.floor(samples * 0.975)],
		sampleSize: values.length,
	};
}

export function artifactMetricValues(artifacts: EvaluationArtifact[], metricId: string): number[] {
	return artifacts.flatMap((artifact) =>
		artifact.metrics
			.filter((metric) => metric.metricId === metricId && metric.value !== undefined)
			.map((metric) => metric.value!),
	);
}

function mean(values: number[]): number {
	return values.reduce((total, value) => total + value, 0) / values.length;
}

function wilsonInterval(successes: number, total: number, confidence: number): { lower: number; upper: number } {
	const z = confidence === 0.95 ? 1.96 : 1.645;
	const p = successes / total;
	const denominator = 1 + (z * z) / total;
	const center = (p + (z * z) / (2 * total)) / denominator;
	const margin = (z / denominator) * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
	return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (1664525 * state + 1013904223) >>> 0;
		return state / 0x100000000;
	};
}
