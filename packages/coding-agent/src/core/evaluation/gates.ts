import { verifyArtifact } from "./artifacts.js";
import { compareRegressionRules } from "./comparison.js";
import type { EvaluationArtifact, EvaluationGateResult, EvaluationReleaseGate } from "./types.js";

export function checkReleaseGate(
	gate: EvaluationReleaseGate,
	artifacts: EvaluationArtifact[],
	baselineArtifacts: EvaluationArtifact[],
): EvaluationGateResult {
	const checks: EvaluationGateResult["checks"] = [];
	const artifactIds = artifacts.map((artifact) => artifact.artifactHash);
	const baselineByScenario = new Map(baselineArtifacts.map((artifact) => [artifact.scenario.scenarioId, artifact]));
	for (const requiredScenario of gate.requiredScenarioPasses) {
		const artifact = artifacts.find((candidate) => candidate.scenario.scenarioId === requiredScenario);
		checks.push({
			checkId: `required:${requiredScenario}`,
			passed: artifact !== undefined && verifyArtifact(artifact) && artifact.verdict === "pass",
			reason: artifact ? artifact.verdict : "missing artifact",
		});
	}
	const critical = artifacts.reduce(
		(count, artifact) =>
			count +
			artifact.assertions.filter((assertion) => assertion.severity === "critical" && assertion.status === "fail")
				.length,
		0,
	);
	const high = artifacts.reduce(
		(count, artifact) =>
			count +
			artifact.assertions.filter((assertion) => assertion.severity === "high" && assertion.status === "fail").length,
		0,
	);
	checks.push({
		checkId: "critical-safety",
		passed: critical <= gate.maximumCriticalSafetyFailures,
		reason: `${critical} critical failures`,
	});
	checks.push({
		checkId: "high-safety",
		passed: high <= gate.maximumHighSafetyFailures,
		reason: `${high} high failures`,
	});
	for (const artifact of artifacts) {
		const baseline = baselineByScenario.get(artifact.scenario.scenarioId);
		if (baseline)
			for (const regression of compareRegressionRules(baseline, artifact, gate.forbiddenRegressions))
				checks.push({ checkId: `regression:${artifact.scenario.scenarioId}`, passed: false, reason: regression });
	}
	for (const artifact of artifacts) {
		if (artifact.stability?.classification === "flaky" && gate.flakinessPolicy.rejectNewFlakiness)
			checks.push({ checkId: `flaky:${artifact.scenario.scenarioId}`, passed: false, reason: "flaky result" });
		if (artifact.stability && artifact.stability.repetitions < gate.flakinessPolicy.minimumRepetitions)
			checks.push({
				checkId: `samples:${artifact.scenario.scenarioId}`,
				passed: false,
				reason: "insufficient repetitions",
			});
	}
	const passed = checks.length > 0 && checks.every((check) => check.passed);
	return { gateId: gate.gateId, passed, checks, artifactIds, verdict: passed ? "pass" : "fail" };
}
