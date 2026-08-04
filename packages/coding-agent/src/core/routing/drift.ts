/**
 * Deterministic bounded drift detection.
 *
 * Detectors are deterministic and bounded; drift never automatically changes
 * the active policy. Drift generates evaluation recommendations. Safety drift
 * is high priority. Minimum sample counts are enforced and no unsupported
 * statistical certainty is claimed.
 */

import { appendDriftSample, appendEvent, readDriftSamples } from "./store.js";
import type { DriftConfig, DriftResult } from "./types.js";

export type DriftDimension =
	| "quality"
	| "cost"
	| "latency"
	| "failure_cluster"
	| "retrieval"
	| "task_distribution"
	| "flakiness"
	| "policy_selection";

const DEFAULT_CONFIG: Record<DriftDimension, DriftConfig> = {
	quality: { method: "fixed_threshold", windowSize: 30, minSampleCount: 10, threshold: 0.15, enabled: true },
	cost: { method: "fixed_threshold", windowSize: 30, minSampleCount: 10, threshold: 0.25, enabled: true },
	latency: { method: "fixed_threshold", windowSize: 30, minSampleCount: 10, threshold: 0.3, enabled: true },
	failure_cluster: { method: "fixed_threshold", windowSize: 30, minSampleCount: 10, threshold: 0.2, enabled: true },
	retrieval: { method: "fixed_threshold", windowSize: 30, minSampleCount: 10, threshold: 0.2, enabled: true },
	task_distribution: { method: "fixed_threshold", windowSize: 30, minSampleCount: 10, threshold: 0.25, enabled: true },
	flakiness: { method: "fixed_threshold", windowSize: 30, minSampleCount: 10, threshold: 0.15, enabled: true },
	policy_selection: { method: "fixed_threshold", windowSize: 30, minSampleCount: 10, threshold: 0.2, enabled: true },
};

export interface DriftHealth {
	ok: boolean;
	reasons: string[];
}

/** Check drift detector health (read-only). */
export function checkDriftHealth(): DriftHealth {
	const reasons: string[] = [];
	for (const [dim, cfg] of Object.entries(DEFAULT_CONFIG)) {
		if (!cfg.enabled) continue;
		if (cfg.windowSize < cfg.minSampleCount) reasons.push(`${dim}: window < min samples`);
		if (cfg.threshold <= 0) reasons.push(`${dim}: threshold must be > 0`);
	}
	return { ok: reasons.length === 0, reasons };
}

/**
 * Record a sample for a dimension and detect drift over the trailing window.
 * Compares the last half of the window against the first half using a simple
 * deterministic mean-delta detector (documented as such).
 */
export function detectDrift(dimension: DriftDimension, value: number, config: Partial<DriftConfig> = {}): DriftResult {
	const cfg: DriftConfig = { ...DEFAULT_CONFIG[dimension], ...config };
	appendDriftSample(dimension, value);
	const samples = readDriftSamples(dimension).slice(-cfg.windowSize);
	return computeDrift(dimension, samples, cfg);
}

/**
 * Pure deterministic drift computation over an explicit sample window. This is
 * the unit of testing: it never reads persistent storage, so results are fully
 * reproducible and do not depend on previously recorded samples.
 */
export function computeDrift(
	dimension: DriftDimension,
	samples: { t: number; v: number }[],
	config: Partial<DriftConfig> = {},
): DriftResult {
	const cfg: DriftConfig = { ...DEFAULT_CONFIG[dimension], ...config };
	const sampleCount = samples.length;
	const observedAt = new Date().toISOString();

	if (sampleCount < cfg.minSampleCount) {
		return {
			detectorId: `detector-${dimension}`,
			method: cfg.method,
			dimension,
			sampleWindow: cfg.windowSize,
			minSampleCount: cfg.minSampleCount,
			sampleCount,
			driftDetected: false,
			measure: 0,
			threshold: cfg.threshold,
			severity: "low",
			observedAt,
			recommendation: ["insufficient samples; collecting more"],
		};
	}

	const half = Math.floor(sampleCount / 2);
	const early = samples.slice(0, half);
	const late = samples.slice(half);
	const mean = (arr: { v: number }[]): number => (arr.length ? arr.reduce((s, x) => s + x.v, 0) / arr.length : 0);
	const earlyMean = mean(early);
	const lateMean = mean(late);
	const measure = Math.abs(lateMean - earlyMean);

	const driftDetected = measure > cfg.threshold;

	// Severity: safety/quality drift is higher priority.
	let severity: DriftResult["severity"] = "low";
	if (driftDetected)
		severity = dimension === "quality" ? "high" : dimension === "cost" || dimension === "latency" ? "medium" : "low";

	const recommendation = driftDetected
		? ["re-evaluate routing policy", "schedule evaluation pack re-run for this dimension"]
		: [];

	if (driftDetected) {
		appendEvent({
			type: "ROUTING_DRIFT_DETECTED",
			payload: { dimension, driftDetected, observedAt },
		});
	}
	return {
		detectorId: `detector-${dimension}`,
		method: cfg.method,
		dimension,
		sampleWindow: cfg.windowSize,
		minSampleCount: cfg.minSampleCount,
		sampleCount,
		driftDetected,
		measure: Number(measure.toFixed(4)),
		threshold: cfg.threshold,
		severity,
		observedAt,
		recommendation,
	};
}

export { DEFAULT_CONFIG as DRIFT_DEFAULT_CONFIG };
