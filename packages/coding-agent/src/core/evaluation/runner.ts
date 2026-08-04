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
import { type EvaluationCandidateLauncher, resolveCandidateLauncher } from "./launcher.js";
import {
	createLiveProviderExecutor,
	type EvaluationProviderClient,
	type EvaluationProviderProfile,
	preflightLiveEvaluation,
	resolveProviderProfile,
} from "./live-provider.js";
import { calculateMetrics } from "./metrics.js";
import { createEvaluationSandbox } from "./sandbox.js";
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
	usage?: {
		inputTokens?: number;
		outputTokens?: number;
		modelCalls?: number;
		estimatedCostUsd?: number;
		providerReportedCostUsd?: number;
	};
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
	confirmLive?: boolean;
	budget?: EvaluationBudget;
	signal?: AbortSignal;
	liveProvider?: { profile: EvaluationProviderProfile; client: EvaluationProviderClient };
	launcher?: EvaluationCandidateLauncher;
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
		!hasExplicitLiveOptIn({
			mode: options.mode,
			live: options.live,
			confirmed: options.confirmLive,
			budget: options.budget,
		})
	)
		throw new Error(
			"live evaluation requires JENSEN_EVAL_LIVE=1 or --confirm-live plus positive cost, model-call, and wall-time budgets",
		);
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
	let sandbox: Awaited<ReturnType<typeof createEvaluationSandbox>> | undefined;
	let failed = false;
	let artifact: EvaluationArtifact | undefined;
	let launcher = options.launcher;
	try {
		if (options.mode === "sandbox" || options.mode === "live") {
			if (!launcher) launcher = await resolveCandidateLauncher();
			sandbox = await createEvaluationSandbox({
				evaluationRunId: run.evaluationRunId,
				fixture: scenario.fixture,
				policy: scenario.candidatePolicy,
				retainOnFailure: options.retainFailedWorkspace,
				signal: options.signal,
				launcher,
			});
			run.sandboxIdentity = sandbox.identity;
		} else if (options.mode === "fixture") {
			fixture = await materializeFixture(scenario.fixture, { retainOnFailure: options.retainFailedWorkspace });
		}
		let executor = options.executor;
		if (options.mode === "live") {
			const profile =
				options.liveProvider?.profile ??
				resolveProviderProfile({
					profileId: candidate.providerProfile,
					configuredModel: candidate.configuredModel,
					resolvedModel: candidate.resolvedModel,
					provider: candidate.provider,
				});
			preflightLiveEvaluation({
				profile,
				budget: options.budget,
				confirmed: options.confirmLive === true || process.env.JENSEN_EVAL_LIVE === "1",
			});
			if (!executor)
				executor = createLiveProviderExecutor(
					profile,
					options.liveProvider?.client ?? {
						complete: async () => {
							throw new Error("live provider client is not configured");
						},
					},
					options.budget ?? {},
					options.signal,
				);
		}
		const execution = executor
			? await executor.execute({ scenario, mode: options.mode, workspaceRoot: sandbox?.root ?? fixture?.root })
			: sandbox
				? await executeSandboxCandidate(sandbox, scenario, options.signal)
				: defaultExecution(scenario, options.mode);
		run.environmentIdentity = createEnvironmentIdentity(
			sandbox?.identity.fixtureHash ?? fixture?.fixtureHash ?? "offline",
			{
				gitCommit: candidate.gitCommit,
			},
		);
		const events = [...(sandbox?.events ?? []), ...execution.events];
		const metrics = calculateMetrics({
			run: { ...run, completedAt: new Date().toISOString() },
			events,
			specs: scenario.metrics,
			benchmarkReport: execution.benchmarkReport,
		});
		const assertionResults = await evaluateAssertions(scenario.assertions, {
			workspaceRoot: execution.workspaceRoot ?? fixture?.root,
			events: execution.events,
			metrics: Object.fromEntries(metrics.map((metric) => [metric.metricId, metric.value])),
			evidenceIds: new Set(events.map((event) => event.eventId)),
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
		artifact = createArtifact({
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
			events,
			usage: execution.usage,
			verdict: hasInvalid ? "invalid" : safetyFailure || !deterministicPass ? "fail" : "pass",
			evidenceIds: assertionResults.flatMap((assertion) => assertion.evidenceIds),
			provenance: {
				createdAt: completedAt,
				sourceRunIds: [run.evaluationRunId],
				evaluatorVersion: EVALUATOR_VERSION,
			},
		});
	} catch (error) {
		failed = true;
		const completedAt = new Date().toISOString();
		const cancelled = options.signal?.aborted === true;
		artifact = createArtifact({
			run: { ...run, completedAt, status: cancelled ? "cancelled" : "failed" },
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
			verdict: cancelled ? "cancelled" : "invalid",
			evidenceIds: [],
			provenance: {
				createdAt: completedAt,
				sourceRunIds: [run.evaluationRunId],
				evaluatorVersion: EVALUATOR_VERSION,
			},
		});
	} finally {
		if (sandbox) {
			if (failed && options.retainFailedWorkspace) await sandbox.retain().catch(() => undefined);
			await sandbox.cleanup();
		} else if (fixture) await cleanupFixture(fixture);
		if (artifact && sandbox) {
			const { artifactHash: _artifactHash, ...unsigned } = artifact;
			const events = [...(artifact.events ?? []), ...sandbox.events].filter(
				(event, index, all) => all.findIndex((candidate) => candidate.eventId === event.eventId) === index,
			);
			artifact = createArtifact({
				...unsigned,
				run: { ...artifact.run, sandboxIdentity: sandbox.identity, eventCount: events.length },
				events,
			});
		}
	}
	return artifact!;
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

async function executeSandboxCandidate(
	sandbox: Awaited<ReturnType<typeof createEvaluationSandbox>>,
	scenario: EvaluationScenario,
	signal?: AbortSignal,
): Promise<EvaluationExecutionResult> {
	const launcher = sandbox.policy.authorizedLauncher;
	if (!launcher) throw new Error("sandbox candidate requires an authorized launcher");
	const args = [...launcher.invocationPrefix];
	const processResult = await sandbox.runProcess(launcher.executablePath, args, { signal });
	const fixtureEvents = defaultExecution(scenario, "sandbox").events;
	return {
		events: [
			...fixtureEvents,
			{
				eventId: randomUUID(),
				type: "candidate.process",
				timestamp: new Date().toISOString(),
				details: {
					exitCode: processResult.exitCode ?? -1,
					outputBytes: Buffer.byteLength(processResult.stdout),
					launcher: launcher.executableIdentity,
				},
			},
		],
		workspaceRoot: sandbox.root,
	};
}
