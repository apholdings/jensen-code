import type { ConsistencyIssue, NumericVerification, TemporalResolution } from "./types.js";

/**
 * Final consistency gate. Detects when prose conclusions contradict the
 * report's own structured facts.
 *
 * Checks:
 * - ranked recommendations against computed metrics
 * - "best/current/meta" claims against newer equipment in the same run
 * - conclusions based on historical values when current values are available
 * - claims of superiority that depend on unmodeled mechanics
 */

export interface RankedOption {
	id: string;
	label: string;
	computedMetric: number | undefined;
}

export interface ConsistencyGateInput {
	rankedRecommendations?: RankedOption[];
	computedMetrics?: RankedOption[];
	temporalResolutions?: TemporalResolution[];
	numericVerifications?: NumericVerification[];
	currentValues?: string[];
}

export class ConsistencyGate {
	/**
	 * Raise an issue when a recommendation rank disagrees with the ordering of
	 * the report's own computed metrics.
	 */
	checkRecommendationOrdering(input: ConsistencyGateInput): ConsistencyIssue[] {
		const issues: ConsistencyIssue[] = [];
		const recs = input.rankedRecommendations ?? [];
		const metrics = input.computedMetrics ?? [];
		for (const rec of recs) {
			const metric = metrics.find((m) => m.id === rec.id)?.computedMetric;
			if (metric === undefined) {
				issues.push({
					kind: "unmodeled_mechanics",
					severity: "warning",
					message: `Recommendation "${rec.label}" has no computed metric.`,
					recommendation: "Qualify the recommendation or add a computed metric before ranking.",
				});
				continue;
			}
			// Ensure every higher-ranked option has a metric >= this one.
			const rank = recs.findIndex((r) => r.id === rec.id);
			for (let i = 0; i < rank; i++) {
				const higher = recs[i];
				const higherMetric = metrics.find((m) => m.id === higher.id)?.computedMetric;
				if (higherMetric !== undefined && higherMetric < metric) {
					issues.push({
						kind: "rank_contradicts_metric",
						severity: "error",
						message: `"${higher.label}" is ranked above "${rec.label}" but its computed metric (${higherMetric}) is below (${metric}).`,
						recommendation: "Re-rank recommendations to match the computed metrics or qualify the claim.",
					});
				}
			}
		}
		return issues;
	}

	/**
	 * Raise an issue when a temporal resolution leaves a contradiction but the
	 * synthesis still asserts a definite current value.
	 */
	checkUnresolvedTemporal(input: ConsistencyGateInput): ConsistencyIssue[] {
		const issues: ConsistencyIssue[] = [];
		const unresolved = (input.temporalResolutions ?? []).filter(
			(t) => t.class === "contradiction" || t.class === "uncertain_current",
		);
		for (const t of unresolved) {
			issues.push({
				kind: "unresolved_temporal",
				severity: "warning",
				message: `Value ${String(t.value)} at ${t.sourceUrl} is unresolved (${t.class}).`,
				recommendation: "Do not state a definite current value; present it as a conditional scenario.",
			});
		}
		return issues;
	}

	/**
	 * Raise an issue when a "best/meta" recommendation is based on a historical
	 * value while a current value exists.
	 */
	checkHistoricalRecommendation(input: ConsistencyGateInput): ConsistencyIssue[] {
		const issues: ConsistencyIssue[] = [];
		const currentValues = input.currentValues ?? [];
		const historical = (input.temporalResolutions ?? []).filter(
			(t) => t.class === "historical" || t.class === "superseded",
		);
		for (const t of historical) {
			if (currentValues.includes(String(t.value))) {
				issues.push({
					kind: "historical_recommendation",
					severity: "warning",
					message: `Recommendation relies on historical value ${String(t.value)}; a current value exists.`,
					recommendation: "Base 'best/current/meta' recommendations on current values.",
				});
			}
		}
		return issues;
	}

	run(input: ConsistencyGateInput): ConsistencyIssue[] {
		return [
			...this.checkRecommendationOrdering(input),
			...this.checkUnresolvedTemporal(input),
			...this.checkHistoricalRecommendation(input),
		];
	}
}
