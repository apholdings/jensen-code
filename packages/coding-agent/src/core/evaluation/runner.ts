import { randomUUID } from "node:crypto";
import type { BenchmarkEvaluationResult } from "../benchmark/types.js";
import { createArtifact } from "./artifacts.js";
import { evaluateAssertions } from "./assertions.js";
import { cleanupFixture, materializeFixture } from "./fixtures.js";
import {
	createCandidateIdentity,
	createEnvironmentIdentity,
	hasExplicitLiveOptIn,
	scenarioContentHash,
} from "./identity.js";
import { calculateMetrics } from "./metrics.js";
import {
	EVALUATOR_VERSION,
	type EvaluationArtifact,
	type EvaluationBudget,
	type EvaluationEvent,
	type EvaluationMode,
	type EvaluationRun,
	type EvaluationScenario,
	type SemanticEvaluationResult,
} from "./types.js";

export interface EvaluationExecutionResult {
	events: EvaluationEvent[];
	workspaceRoot?: string;
	benchmarkReport?: BenchmarkEvaluationResult;
	semanticResults?: SemanticEvaluationResult[];
}

export interface EvaluationExecutor {
	execute(input: {
		scenario: EvaluationScenario;
		mode: EvaluationMode;
		workspaceRoot?: string;
	}): Promise<EvaluationExecutionResult>;
}

export interface EvaluationRunOptions {
	mode: EvaluationMode;
	candidate?: Partial<EvaluationRun["candidate"]>;
	executor?: EvaluationExecutor;
	retainFailedWorkspace?: boolean;
	live?: boolean;
	budget?: EvaluationBudget;
}

export async function runEvaluation(
	scenario: EvaluationScenario,
	options: EvaluationRunOptions,
): Promise<EvaluationArtifact> {
	if (!scenario.candidatePolicy.allowedModes.includes(options.mode))
		throw new Error(`scenario does not allow ${options.mode} mode`);
	if (options.mode === "live" && !scenario.candidatePolicy.allowLiveProvider)
		throw new Error("live provider evaluation is disabled by scenario policy");
	if (
		options.mode === "live" &&
		!hasExplicitLiveOptIn({ mode: options.mode, live: options.live, budget: options.budget })
	)
		throw new Error("live evaluation requires JENSEN_EVAL_LIVE=1, --live, and an explicit positive budget");
	const startedAt = new Date().toISOString();
	const candidate = createCandidateIdentity(options.candidate);
	const run: EvaluationRun = {
		evaluationRunId: randomUUID(),
		scenarioId: scenario.scenarioId,
		scenarioVersion: scenario.scenarioVersion,
		scenarioContentHash: scenarioContentHash(scenario),
		mode: options.mode,
		candidate,
		environmentIdentity: createEnvironmentIdentity("pending", { gitCommit: candidate.gitCommit }),
		startedAt,
		status: "running",
	};
	let fixture: Awaited<ReturnType<typeof materializeFixture>> | undefined;
	try {
		if (options.mode === "fixture" || options.mode === "sandbox" || options.mode === "live")
			fixture = await materializeFixture(scenario.fixture, { retainOnFailure: options.retainFailedWorkspace });
		const execution = options.executor
			? await options.executor.execute({ scenario, mode: options.mode, workspaceRoot: fixture?.root })
			: defaultExecution(scenario, options.mode);
		run.environmentIdentity = createEnvironmentIdentity(fixture?.fixtureHash ?? "offline", {
			gitCommit: candidate.gitCommit,
		});
		const metrics = calculateMetrics({
			run: { ...run, completedAt: new Date().toISOString() },
			events: execution.events,
			specs: scenario.metrics,
			benchmarkReport: execution.benchmarkReport,
		});
		const assertionResults = await evaluateAssertions(scenario.assertions, {
			workspaceRoot: execution.workspaceRoot ?? fixture?.root,
			events: execution.events,
			metrics: Object.fromEntries(metrics.map((metric) => [metric.metricId, metric.value])),
			evidenceIds: new Set(execution.events.map((event) => event.eventId)),
			timeoutMs: scenario.timeoutMs,
		});
		const hasInvalid = assertionResults.some(
			(assertion) => assertion.status === "invalid" || assertion.status === "not_evaluated",
		);
		const safetyFailure = assertionResults.some(
			(assertion) =>
				(assertion.severity === "critical" || assertion.severity === "high") && assertion.status !== "pass",
		);
		const deterministicPass =
			assertionResults.length > 0 && assertionResults.every((assertion) => assertion.status === "pass");
		const completedAt = new Date().toISOString();
		const completedRun = { ...run, completedAt, status: "completed" as const };
		return createArtifact({
			run: completedRun,
			scenario: {
				scenarioId: scenario.scenarioId,
				scenarioVersion: scenario.scenarioVersion,
				scenarioContentHash: run.scenarioContentHash,
			},
			candidate,
			assertions: assertionResults,
			metrics,
			semanticResults: execution.semanticResults ?? [],
			verdict: hasInvalid ? "invalid" : safetyFailure || !deterministicPass ? "fail" : "pass",
			evidenceIds: assertionResults.flatMap((assertion) => assertion.evidenceIds),
			provenance: {
				createdAt: completedAt,
				sourceRunIds: [run.evaluationRunId],
				evaluatorVersion: EVALUATOR_VERSION,
			},
		});
	} catch (error) {
		const completedAt = new Date().toISOString();
		return createArtifact({
			run: { ...run, completedAt, status: "failed" },
			scenario: {
				scenarioId: scenario.scenarioId,
				scenarioVersion: scenario.scenarioVersion,
				scenarioContentHash: run.scenarioContentHash,
			},
			candidate,
			assertions: [
				{
					assertionId: "runtime",
					status: "invalid",
					expected: true,
					observed: undefined,
					evidenceIds: [],
					reasonCode: error instanceof Error ? error.message : "execution_failed",
					severity: "high",
				},
			],
			metrics: [],
			semanticResults: [],
			verdict: "invalid",
			evidenceIds: [],
			provenance: {
				createdAt: completedAt,
				sourceRunIds: [run.evaluationRunId],
				evaluatorVersion: EVALUATOR_VERSION,
			},
		});
	} finally {
		if (fixture) await cleanupFixture(fixture);
	}
}

function defaultExecution(scenario: EvaluationScenario, mode: EvaluationMode): EvaluationExecutionResult {
	if (mode === "offline") return { events: [] };
	const now = new Date().toISOString();
	const events: EvaluationEvent[] = [];
	for (const assertion of scenario.assertions) {
		if (
			(assertion.kind === "event_present" || assertion.kind === "event_absent") &&
			assertion.pattern &&
			assertion.kind === "event_present"
		)
			events.push({ eventId: randomUUID(), type: assertion.pattern, timestamp: now, details: { status: "pass" } });
	}
	return { events };
}
