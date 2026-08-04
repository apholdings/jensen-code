import type {
	CavecrewComparisonResult,
	EvaluationArtifact,
	EvaluationPruneManifest,
	ReleaseConvergenceState,
} from "./types.js";

export interface EvaluationDashboardProjection {
	readonly scenarioPacks: string[];
	readonly recentRuns: Array<{ runId: string; scenarioId: string; status: string; verdict: string; stale: boolean }>;
	readonly activeRuns: Array<{ runId: string; scenarioId: string; status: string }>;
	readonly assertionFailures: number;
	readonly safetyFailures: number;
	readonly semanticResults: EvaluationArtifact["semanticResults"];
	readonly retrievalMetrics: EvaluationArtifact["metrics"];
	readonly costAndLatency: { costUsd: number; wallTimeMs: number };
	readonly flakyRuns: number;
	readonly failureClusters: string[];
	readonly comparisons: CavecrewComparisonResult[];
	readonly releaseGate: ReleaseConvergenceState | undefined;
	readonly retention: { policyVersion?: number; preview?: EvaluationPruneManifest; diskBytes?: number };
	readonly artifactStoreHealth: "healthy" | "degraded" | "failed";
	readonly pagination: { offset: number; limit: number; total: number; hasMore: boolean };
}

export interface EvaluationDashboardProjectionOptions {
	offset?: number;
	limit?: number;
	comparisons?: CavecrewComparisonResult[];
	releaseGate?: ReleaseConvergenceState;
	retention?: EvaluationDashboardProjection["retention"];
	storeHealth?: "pass" | "warn" | "fail";
	now?: number;
}

export function projectEvaluationDashboard(
	artifacts: EvaluationArtifact[],
	storeHealthOrOptions: "pass" | "warn" | "fail" | EvaluationDashboardProjectionOptions = "pass",
): EvaluationDashboardProjection {
	const options: EvaluationDashboardProjectionOptions =
		typeof storeHealthOrOptions === "string" ? { storeHealth: storeHealthOrOptions } : storeHealthOrOptions;
	const offset = Math.max(0, options.offset ?? 0);
	const limit = Math.min(100, Math.max(1, options.limit ?? 50));
	const now = options.now ?? Date.now();
	const sorted = [...artifacts].sort((left, right) => left.run.startedAt.localeCompare(right.run.startedAt));
	const page = sorted.slice(offset, offset + limit);
	const recentRuns = page.map((artifact) => ({
		runId: artifact.run.evaluationRunId,
		scenarioId: artifact.scenario.scenarioId,
		status: artifact.run.status,
		verdict: artifact.verdict,
		stale: artifact.run.completedAt ? now - Date.parse(artifact.run.completedAt) > 86_400_000 : false,
	}));
	const cost = artifacts.reduce(
		(total, artifact) => total + (artifact.usage?.providerReportedCostUsd ?? artifact.usage?.estimatedCostUsd ?? 0),
		0,
	);
	const wallTimeMs = artifacts.reduce((total, artifact) => {
		if (!artifact.run.completedAt) return total;
		return total + Math.max(0, Date.parse(artifact.run.completedAt) - Date.parse(artifact.run.startedAt));
	}, 0);
	return {
		scenarioPacks: [
			...new Set(
				artifacts.map((artifact) => artifact.scenario.packId).filter((pack): pack is string => pack !== undefined),
			),
		].sort(),
		recentRuns,
		activeRuns: artifacts
			.filter(
				(artifact) =>
					artifact.run.status === "running" ||
					artifact.run.status === "preparing" ||
					artifact.run.status === "evaluating",
			)
			.map((artifact) => ({
				runId: artifact.run.evaluationRunId,
				scenarioId: artifact.scenario.scenarioId,
				status: artifact.run.status,
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
		semanticResults: artifacts.flatMap((artifact) => artifact.semanticResults),
		retrievalMetrics: artifacts.flatMap((artifact) =>
			artifact.metrics.filter((metric) => metric.metricId.includes("retrieval")),
		),
		costAndLatency: { costUsd: cost, wallTimeMs },
		flakyRuns: artifacts.filter((artifact) => artifact.stability?.classification === "flaky").length,
		failureClusters: [
			...new Set(
				artifacts.flatMap((artifact) =>
					artifact.assertions
						.filter((assertion) => assertion.status !== "pass")
						.map((assertion) => assertion.reasonCode),
				),
			),
		].sort(),
		comparisons: options.comparisons ?? [],
		releaseGate: options.releaseGate,
		retention: options.retention ?? {},
		artifactStoreHealth:
			options.storeHealth === "fail" ? "failed" : options.storeHealth === "warn" ? "degraded" : "healthy",
		pagination: { offset, limit, total: sorted.length, hasMore: offset + page.length < sorted.length },
	};
}
