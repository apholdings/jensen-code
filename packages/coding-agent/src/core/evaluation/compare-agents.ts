import { randomUUID } from "node:crypto";
import { type EvaluationExecutor, runEvaluation } from "./runner.js";
import type { CavecrewComparisonResult, EvaluationArtifact, EvaluationScenario } from "./types.js";

export interface PairedAgentExecutionInput {
	scenario: EvaluationScenario;
	singleAgent: EvaluationExecutor;
	cavecrew: EvaluationExecutor;
	mode: "fixture" | "sandbox" | "live";
	orderSeed?: number;
	providerProfile?: string;
}

function metric(artifact: EvaluationArtifact, ids: string[]): number {
	return ids.reduce((total, id) => total + (artifact.metrics.find((item) => item.metricId === id)?.value ?? 0), 0);
}

function safety(artifact: EvaluationArtifact): number {
	return artifact.assertions.some(
		(assertion) =>
			(assertion.severity === "critical" || assertion.severity === "high") && assertion.status !== "pass",
	)
		? 0
		: 1;
}

function correctness(artifact: EvaluationArtifact): number {
	return artifact.verdict === "pass" ? 1 : 0;
}

export async function compareAgents(input: PairedAgentExecutionInput): Promise<{
	comparison: CavecrewComparisonResult;
	singleAgent: EvaluationArtifact;
	cavecrew: EvaluationArtifact;
}> {
	const reverse = (input.orderSeed ?? 0) % 2 === 1;
	const first = reverse ? "cavecrew" : "single-agent";
	const run = async (candidate: "single-agent" | "cavecrew") =>
		runEvaluation(input.scenario, {
			mode: input.mode,
			executor: candidate === "single-agent" ? input.singleAgent : input.cavecrew,
			candidate: {
				providerProfile: `${input.providerProfile ?? "fixture"}:${candidate}`,
				provider: candidate,
				configuredModel: candidate,
				resolvedModel: candidate,
				seed: input.orderSeed,
			},
		});
	const firstArtifact = await run(first);
	const secondArtifact = await run(first === "single-agent" ? "cavecrew" : "single-agent");
	const singleAgent = first === "single-agent" ? firstArtifact : secondArtifact;
	const cavecrew = first === "cavecrew" ? firstArtifact : secondArtifact;
	if (singleAgent.scenario.scenarioContentHash !== cavecrew.scenario.scenarioContentHash)
		throw new Error("paired execution scenario hashes differ");
	const correctnessDelta = correctness(cavecrew) - correctness(singleAgent);
	const safetyDelta = safety(cavecrew) - safety(singleAgent);
	const wallTimeDeltaMs = metric(cavecrew, ["wall_time_ms"]) - metric(singleAgent, ["wall_time_ms"]);
	const modelCallDelta = metric(cavecrew, ["model_calls"]) - metric(singleAgent, ["model_calls"]);
	const tokenDelta = metric(cavecrew, ["tokens", "total_tokens"]) - metric(singleAgent, ["tokens", "total_tokens"]);
	const toolCallDelta = metric(cavecrew, ["tool_calls"]) - metric(singleAgent, ["tool_calls"]);
	const retrievalDelta =
		metric(cavecrew, ["retrieval_relevance", "retrieval_usage"]) -
		metric(singleAgent, ["retrieval_relevance", "retrieval_usage"]);
	const rollbackDelta = metric(cavecrew, ["rollback_count"]) - metric(singleAgent, ["rollback_count"]);
	const deterministicWinner =
		safetyDelta < 0 || correctnessDelta < 0
			? "single_agent"
			: safetyDelta > 0 || correctnessDelta > 0
				? "cavecrew"
				: "tie";
	return {
		comparison: {
			comparisonId: `comparison-${randomUUID()}`,
			scenarioId: input.scenario.scenarioId,
			singleAgentRunId: singleAgent.run.evaluationRunId,
			cavecrewRunId: cavecrew.run.evaluationRunId,
			correctnessDelta,
			safetyDelta,
			wallTimeDeltaMs,
			modelCallDelta,
			tokenDelta,
			toolCallDelta,
			retrievalDelta,
			rollbackDelta,
			deterministicWinner,
		},
		singleAgent,
		cavecrew,
	};
}
