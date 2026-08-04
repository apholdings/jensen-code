import type { EvaluationArtifact } from "./types.js";

export interface EvaluationDashboardProjection {
	readonly scenarioPacks: string[];
	readonly recentRuns: Array<{ runId: string; scenarioId: string; status: string; verdict: string }>;
	readonly assertionFailures: number;
	readonly safetyFailures: number;
	readonly flakyRuns: number;
	readonly artifactStoreHealth: "healthy" | "degraded" | "failed";
}

export function projectEvaluationDashboard(
	artifacts: EvaluationArtifact[],
	storeHealth: "pass" | "warn" | "fail",
): EvaluationDashboardProjection {
	return {
		scenarioPacks: [
			...new Set(
				artifacts.map((artifact) => artifact.scenario.packId).filter((pack): pack is string => pack !== undefined),
			),
		].sort(),
		recentRuns: artifacts.slice(-50).map((artifact) => ({
			runId: artifact.run.evaluationRunId,
			scenarioId: artifact.scenario.scenarioId,
			status: artifact.run.status,
			verdict: artifact.verdict,
		})),
		assertionFailures: artifacts.reduce(
			(count, artifact) => count + artifact.assertions.filter((assertion) => assertion.status === "fail").length,
			0,
		),
		safetyFailures: artifacts.reduce(
			(count, artifact) =>
				count +
				artifact.assertions.filter(
					(assertion) =>
						(assertion.severity === "critical" || assertion.severity === "high") && assertion.status !== "pass",
				).length,
			0,
		),
		flakyRuns: artifacts.filter((artifact) => artifact.stability?.classification === "flaky").length,
		artifactStoreHealth: storeHealth === "pass" ? "healthy" : storeHealth === "warn" ? "degraded" : "failed",
	};
}
