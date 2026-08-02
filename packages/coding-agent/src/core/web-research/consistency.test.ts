import { describe, expect, it } from "vitest";
import { ConsistencyGate } from "./consistency.js";

describe("conclusion consistency gate", () => {
	it("flags a recommendation ranked above a clearly higher-computed option", () => {
		const gate = new ConsistencyGate();
		const issues = gate.checkRecommendationOrdering({
			rankedRecommendations: [
				{ id: "b", label: "Option B", computedMetric: 217 },
				{ id: "a", label: "Option A", computedMetric: 250 },
			],
			computedMetrics: [
				{ id: "b", label: "Option B", computedMetric: 217 },
				{ id: "a", label: "Option A", computedMetric: 250 },
			],
		});
		expect(issues.some((issue) => issue.kind === "rank_contradicts_metric")).toBe(true);
		expect(issues.some((issue) => issue.severity === "error")).toBe(true);
	});

	it("accepts ordering that matches the computed metrics", () => {
		const gate = new ConsistencyGate();
		const issues = gate.checkRecommendationOrdering({
			rankedRecommendations: [
				{ id: "a", label: "Option A", computedMetric: 250 },
				{ id: "b", label: "Option B", computedMetric: 217 },
			],
			computedMetrics: [
				{ id: "a", label: "Option A", computedMetric: 250 },
				{ id: "b", label: "Option B", computedMetric: 217 },
			],
		});
		expect(issues.filter((issue) => issue.kind === "rank_contradicts_metric")).toHaveLength(0);
	});

	it("warns about unresolved temporal state in a definite-current conclusion", () => {
		const gate = new ConsistencyGate();
		const issues = gate.checkUnresolvedTemporal({
			temporalResolutions: [{ sourceUrl: "u", evidenceId: "c1", class: "contradiction", value: 120, reasoning: [] }],
		});
		expect(issues.some((issue) => issue.kind === "unresolved_temporal")).toBe(true);
	});
});
