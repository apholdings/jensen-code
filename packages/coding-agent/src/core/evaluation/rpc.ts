import { join } from "node:path";
import { compareAgents } from "./compare-agents.js";
import {
	aggregateStability,
	checkReleaseGate,
	clusterFailure,
	compareArtifacts,
	createBaseline,
	discoverEvaluationPacks,
	inspectArtifactStore,
	listArtifacts,
	listBaselines,
	mergeFailureClusters,
	pruneEvaluationStore,
	readArtifact,
	replayArtifact,
	rescoreArtifact,
	runEvaluation,
	verifyArtifact,
	verifyBaseline,
	writeArtifact,
} from "./index.js";
import { createPruneManifest } from "./retention.js";
import type { EvaluationExecutor } from "./runner.js";
import type {
	EvaluationArtifact,
	EvaluationMode,
	EvaluationPruneManifest,
	EvaluationReleaseGate,
	EvaluationScenario,
} from "./types.js";

export const EVALUATION_RPC_VERSION = 2 as const;
export const EVALUATION_RPC_OPERATIONS = [
	"eval.packs",
	"eval.scenarios",
	"eval.inspect",
	"eval.validate",
	"eval.run",
	"eval.cancel",
	"eval.status",
	"eval.results",
	"eval.report",
	"eval.compare",
	"eval.compareAgents",
	"eval.replay",
	"eval.rescore",
	"eval.stability",
	"eval.baselines",
	"eval.baselineCreate",
	"eval.baselinePromote",
	"eval.baselineVerify",
	"eval.gateCheck",
	"eval.gateExplain",
	"eval.failures",
	"eval.failureInspect",
	"eval.prunePreview",
	"eval.pruneExecute",
	"eval.doctor",
] as const;

export type EvaluationRpcOperation = (typeof EVALUATION_RPC_OPERATIONS)[number];

export interface EvaluationRpcRequest {
	version: typeof EVALUATION_RPC_VERSION;
	requestId: string;
	operation: EvaluationRpcOperation;
	parameters?: Record<string, string | number | boolean | string[] | Record<string, unknown>>;
}

export interface EvaluationRpcError {
	code:
		| "INVALID_REQUEST"
		| "UNSUPPORTED_OPERATION"
		| "NOT_FOUND"
		| "CONFLICT"
		| "PRECONDITION_FAILED"
		| "INTERNAL_ERROR"
		| "CANCELLED";
	message: string;
}

export interface EvaluationRpcResponse {
	version: typeof EVALUATION_RPC_VERSION;
	requestId: string;
	operation: EvaluationRpcOperation;
	data?: unknown;
	error?: EvaluationRpcError;
}

export interface EvaluationRpcServiceOptions {
	root?: string;
	executor?: EvaluationRpcExecutor;
}

export interface EvaluationRpcExecutor {
	createExecutor(input: {
		scenario: EvaluationScenario;
		mode: EvaluationMode;
		candidateId: string;
	}): EvaluationExecutor | undefined;
}

export class EvaluationRpcService {
	readonly root: string;
	private readonly jobs = new Map<
		string,
		{ status: "running" | "completed" | "failed" | "cancelled"; abort: AbortController; artifactIds: string[] }
	>();
	private readonly executor?: EvaluationRpcExecutor;

	constructor(options: EvaluationRpcServiceOptions = {}) {
		this.root = options.root ?? join(process.cwd(), ".jensen", "evaluations");
		this.executor = options.executor;
	}

	async handle(request: EvaluationRpcRequest): Promise<EvaluationRpcResponse> {
		const validationError = validateEvaluationRpcRequest(request);
		if (validationError)
			return {
				version: EVALUATION_RPC_VERSION,
				requestId: request?.requestId ?? "",
				operation: request?.operation as EvaluationRpcOperation,
				error: validationError,
			};
		try {
			return {
				version: EVALUATION_RPC_VERSION,
				requestId: request.requestId,
				operation: request.operation,
				data: await this.dispatch(request),
			};
		} catch (error) {
			const code =
				error instanceof Error && error.message.includes("precondition")
					? "PRECONDITION_FAILED"
					: error instanceof Error && error.message.includes("not found")
						? "NOT_FOUND"
						: "INTERNAL_ERROR";
			return {
				version: EVALUATION_RPC_VERSION,
				requestId: request.requestId,
				operation: request.operation,
				error: { code, message: error instanceof Error ? error.message : String(error) },
			};
		}
	}

	private async dispatch(request: EvaluationRpcRequest): Promise<unknown> {
		const params = request.parameters ?? {};
		const discovered = await discoverEvaluationPacks(this.root);
		switch (request.operation) {
			case "eval.packs":
				return discovered.packs;
			case "eval.scenarios":
				return discovered.scenarios;
			case "eval.inspect":
				return readArtifact(this.root, String(params.artifactId ?? ""));
			case "eval.validate":
				return { valid: discovered.errors.length === 0, errors: discovered.errors };
			case "eval.run": {
				const scenario = selectScenario(discovered.scenarios, discovered.packs, String(params.target ?? ""));
				const mode = String(params.mode ?? "fixture") as EvaluationMode;
				const jobId = `eval-job-${Date.now()}-${Math.random().toString(16).slice(2)}`;
				const abort = new AbortController();
				this.jobs.set(jobId, { status: "running", abort, artifactIds: [] });
				try {
					const artifact = await runEvaluation(scenario, {
						mode,
						confirmLive: params.confirmLive === true,
						live: params.live === true || params.confirmLive === true,
						budget: {
							maximumCostUsd: numberParameter(params.maximumCostUsd),
							maximumModelCalls: numberParameter(params.maximumModelCalls),
							maximumWallTimeMs: numberParameter(params.maximumWallTimeMs),
						},
						candidate: {
							providerProfile: String(params.providerProfile ?? "fixture"),
							provider: String(params.provider ?? "fixture"),
							configuredModel: String(params.model ?? "deterministic-fixture"),
						},
						executor: this.executor?.createExecutor({ scenario, mode, candidateId: jobId }),
						signal: abort.signal,
					});
					await writeArtifact(this.root, artifact);
					this.jobs.set(jobId, {
						status: artifact.verdict === "cancelled" ? "cancelled" : "completed",
						abort,
						artifactIds: [artifact.artifactHash],
					});
					return { jobId, artifactId: artifact.artifactHash, status: artifact.run.status };
				} catch (error) {
					this.jobs.set(jobId, { status: abort.signal.aborted ? "cancelled" : "failed", abort, artifactIds: [] });
					throw error;
				}
			}
			case "eval.cancel": {
				const job = this.jobs.get(String(params.jobId ?? ""));
				if (!job) throw new Error("evaluation job not found");
				job.abort.abort();
				job.status = "cancelled";
				return { jobId: String(params.jobId), status: job.status };
			}
			case "eval.status": {
				const job = this.jobs.get(String(params.jobId ?? ""));
				if (!job) throw new Error("evaluation job not found");
				return { jobId: String(params.jobId), status: job.status, artifactIds: job.artifactIds };
			}
			case "eval.results": {
				const artifacts = await listArtifacts(this.root);
				const offset = Math.max(0, numberParameter(params.offset) ?? 0);
				const limit = Math.min(100, Math.max(1, numberParameter(params.limit) ?? 50));
				return {
					items: artifacts.slice(offset, offset + limit),
					offset,
					limit,
					total: artifacts.length,
					hasMore: offset + limit < artifacts.length,
				};
			}
			case "eval.report":
				return { artifacts: await listArtifacts(this.root), store: await inspectArtifactStore(this.root) };
			case "eval.compare":
				return compareArtifacts(
					await readArtifact(this.root, String(params.baselineId ?? "")),
					await readArtifact(this.root, String(params.candidateId ?? "")),
				);
			case "eval.compareAgents": {
				const scenario = selectScenario(discovered.scenarios, discovered.packs, String(params.target ?? ""));
				const mode = String(params.mode ?? "fixture") as "fixture" | "sandbox" | "live";
				const singleAgent = this.executor?.createExecutor({ scenario, mode, candidateId: "single-agent" });
				const cavecrew = this.executor?.createExecutor({ scenario, mode, candidateId: "cavecrew" });
				if (!singleAgent || !cavecrew)
					throw new Error("eval.compareAgents requires registered production executors");
				const result = await compareAgents({
					scenario,
					singleAgent,
					cavecrew,
					mode,
					orderSeed: numberParameter(params.orderSeed),
				});
				await writeArtifact(this.root, result.singleAgent);
				await writeArtifact(this.root, result.cavecrew);
				return result.comparison;
			}
			case "eval.replay": {
				const artifact = await readArtifact(this.root, String(params.artifactId ?? ""));
				const replay = replayArtifact(artifact);
				await writeArtifact(this.root, replay);
				return { artifactId: replay.artifactHash, sourceArtifactId: artifact.artifactHash };
			}
			case "eval.rescore": {
				const artifact = await readArtifact(this.root, String(params.artifactId ?? ""));
				const rescored = rescoreArtifact(artifact, String(params.evaluatorVersion ?? "2.0.0"));
				await writeArtifact(this.root, rescored);
				return { artifactId: rescored.artifactHash, sourceArtifactId: artifact.artifactHash };
			}
			case "eval.stability":
				return aggregateStability([await readArtifact(this.root, String(params.artifactId ?? ""))]);
			case "eval.baselines":
				return listBaselines(join(this.root, "baselines"));
			case "eval.baselineCreate": {
				const ids = arrayParameter(params.artifactIds);
				const artifacts = await Promise.all(ids.map((id) => readArtifact(this.root, id)));
				const first = artifacts[0];
				if (!first) throw new Error("baseline create requires artifact ids");
				return createBaseline(
					join(this.root, "baselines"),
					{
						artifactIds: ids,
						createdAt: new Date().toISOString(),
						candidate: first.candidate,
						packId: String(params.packId ?? "custom"),
						packVersion: String(params.packVersion ?? "1"),
					},
					artifacts,
				);
			}
			case "eval.baselinePromote":
				return { promoted: false, reason: "baseline promotion requires explicit authority" };
			case "eval.baselineVerify":
				return {
					baselineId: String(params.baselineId ?? ""),
					valid: await verifyBaseline(join(this.root, "baselines"), String(params.baselineId ?? "")),
				};
			case "eval.gateCheck": {
				const artifacts = await Promise.all(
					arrayParameter(params.artifactIds).map((id) => readArtifact(this.root, id)),
				);
				if (artifacts.some((artifact) => !verifyArtifact(artifact))) throw new Error("invalid evaluation artifact");
				return checkReleaseGate(defaultGate(artifacts), artifacts, artifacts);
			}
			case "eval.gateExplain":
				return {
					gateId: "functional-evaluation",
					explanation: "Deterministic assertions, safety failures, and flakiness are authoritative.",
				};
			case "eval.failures":
				return mergeFailureClusters(
					(await listArtifacts(this.root)).flatMap((artifact) => {
						const cluster = clusterFailure(artifact);
						return cluster ? [cluster] : [];
					}),
				);
			case "eval.failureInspect":
				return (
					(await listArtifacts(this.root)).find(
						(artifact) => artifact.artifactHash === String(params.artifactId ?? ""),
					) ??
					(() => {
						throw new Error("failure artifact not found");
					})()
				);
			case "eval.prunePreview":
				return createPruneManifest(this.root);
			case "eval.pruneExecute":
				return pruneEvaluationStore(
					this.root,
					true,
					undefined,
					params.manifest as unknown as EvaluationPruneManifest,
				);
			case "eval.doctor":
				return { packs: discovered, store: await inspectArtifactStore(this.root) };
		}
	}
}

function selectScenario(
	scenarios: EvaluationScenario[],
	packs: Array<{ packId: string; scenarios: string[] }>,
	target: string,
): EvaluationScenario {
	const scenarioId = packs.find((pack) => pack.packId === target)?.scenarios[0] ?? target;
	const scenario = scenarios.find((candidate) => candidate.scenarioId === scenarioId);
	if (!scenario) throw new Error(`evaluation scenario not found: ${target}`);
	return scenario;
}

function numberParameter(
	value: string | number | boolean | string[] | Record<string, unknown> | undefined,
): number | undefined {
	if (typeof value !== "number" && typeof value !== "string") return undefined;
	const result = Number(value);
	return Number.isFinite(result) ? result : undefined;
}

function arrayParameter(value: string | number | boolean | string[] | Record<string, unknown> | undefined): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function defaultGate(artifacts: EvaluationArtifact[]): EvaluationReleaseGate {
	return {
		gateId: "functional-evaluation",
		scenarioPack: "built-in",
		baselineId: "required",
		requiredScenarioPasses: artifacts.map((artifact) => artifact.scenario.scenarioId),
		forbiddenRegressions: [],
		maximumCriticalSafetyFailures: 0,
		maximumHighSafetyFailures: 0,
		flakinessPolicy: { rejectNewFlakiness: true, minimumRepetitions: 1 },
	};
}

export function validateEvaluationRpcRequest(request: unknown): EvaluationRpcError | undefined {
	if (!request || typeof request !== "object")
		return { code: "INVALID_REQUEST", message: "request must be an object" };
	const candidate = request as Partial<EvaluationRpcRequest>;
	if (candidate.version !== EVALUATION_RPC_VERSION || typeof candidate.requestId !== "string" || !candidate.requestId)
		return { code: "INVALID_REQUEST", message: "version and requestId are required" };
	if (!EVALUATION_RPC_OPERATIONS.includes(candidate.operation as EvaluationRpcOperation))
		return {
			code: "UNSUPPORTED_OPERATION",
			message: `unsupported evaluation operation: ${String(candidate.operation)}`,
		};
	return undefined;
}
