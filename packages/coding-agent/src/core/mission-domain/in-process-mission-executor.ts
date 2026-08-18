/**
 * In-Process Mission Executor (2.16.0).
 *
 * The real, in-process executor for the first-class mission contract. Where
 * `ProcessMissionExecutor` is the transitional adapter that drives a spawned
 * CLI, this executor drives a mission through the normal `createAgentSession()`
 * session path: a real agent session with a real model (e.g. the local Qwen
 * operator model), real tools, and the normal session stream. No child
 * process, no PID: the mission's structured identity (`missionId` +
 * `childSessionId`) is the only identity involved.
 *
 * Contract (same invariants as the rest of the domain):
 *   - A clean completion is NEVER classified SUCCEEDED without a verifier.
 *     Without one it is PARTIAL ("execution completed but unverified").
 *   - The handle exposes `executionId` and `cancel`, never an AgentSession.
 *   - `cancel` is idempotent and aborts the underlying session.
 *
 * Real-path configuration mirrors `QwenPlannerAdapter` (cwd/agentDir/auth/
 * registry/stream seams). The model is resolved from
 * `MissionRequest.modelPolicy` — verified, never defaulted: a mission without
 * a model policy, or whose policy is not registered, is a hard error. Tools
 * follow the execution mode (`execute` → coding tools, otherwise read-only
 * tools) and are narrowed by `MissionRequest.capabilities` when present.
 *
 * A `runner` seam replaces the whole session path for deterministic tests,
 * mirroring the `harness` seam of `ProcessMissionExecutor`.
 */

import { randomUUID } from "node:crypto";
import type { StreamFn } from "@apholdings/jensen-agent-core";
import type { AssistantMessage, Model, TextContent } from "@apholdings/jensen-ai";
import { getAgentDir } from "../../config.js";
import type { AgentSession } from "../agent-session.js";
import { AuthStorage } from "../auth-storage.js";
import { defaultChildSessionDir } from "../durable-child-session/index.js";
import { governancePolicyFromEnv, resolveGovernanceModel } from "../governance/evaluator.js";
import type { GovernanceService } from "../governance/service.js";
import { ModelRegistry } from "../model-registry.js";
import { createAgentSession } from "../sdk.js";
import { SessionManager } from "../session-manager.js";
import { createCodingTools, createReadOnlyTools, type Tool } from "../tools/index.js";
import type { MissionExecutor, MissionLaunchOptions } from "./mission-executor.js";
import { createMissionHandle, type MissionHandle } from "./mission-handle.js";
import { type MissionRequest, validateMissionRequest } from "./mission-request.js";
import {
	classifyExecutorOutcome,
	createMissionResult,
	type ExecutorDiagnostics,
	type ExecutorOutcome,
	type MissionResult,
	type StructuredFailure,
} from "./mission-result.js";
import { MissionStateTracker } from "./mission-state.js";

// =============================================================================
// Runner seam
// =============================================================================

/**
 * Plain-data outcome of one in-process session run. Mirrors
 * `ExecutorOutcome` (no session object leaks) and adds presentation text and
 * the session-level error message.
 */
export interface InProcessMissionOutcome extends ExecutorOutcome {
	/** Final assistant text (presentation only, never the authority). */
	outputText?: string;
	/** Session-level error message when the run failed. */
	sessionError?: string;
}

/**
 * Executes one mission in-process and resolves to its plain-data outcome.
 * The default runner drives a real agent session; tests may inject a
 * deterministic runner.
 */
export type InProcessMissionRunner = (
	request: MissionRequest,
	signal?: AbortSignal,
	executionId?: string,
	correlation?: { assignmentId?: string; sessionId?: string },
) => Promise<InProcessMissionOutcome>;

// =============================================================================
// Verifier
// =============================================================================

export interface InProcessMissionVerifierInput {
	request: MissionRequest;
	outcome: InProcessMissionOutcome;
}

export interface InProcessMissionVerification {
	verified: boolean;
	summary?: string;
	criterionIds?: string[];
}

/** Optional verifier that may promote a clean completion to verified SUCCEEDED. */
export type InProcessMissionVerifier = (input: InProcessMissionVerifierInput) => Promise<InProcessMissionVerification>;

// =============================================================================
// Prompt
// =============================================================================

/**
 * Deterministic execution prompt for a mission: identity, objective,
 * constraints, and acceptance criteria. Never PID- or process-derived.
 */
export function buildInProcessMissionPrompt(request: MissionRequest): string {
	const lines: string[] = [
		`You are executing mission ${request.missionId} as agent "${request.agent}" (execution mode: ${request.executionMode}).`,
	];
	if (request.parentMissionId) lines.push(`Parent mission: ${request.parentMissionId} (depth ${request.depth}).`);
	lines.push("", "Objective:", request.objective);
	if (request.constraints && request.constraints.length > 0)
		lines.push("", "Constraints:", ...request.constraints.map((constraint) => `- ${constraint}`));
	if (request.acceptanceCriteria.length > 0)
		lines.push(
			"",
			"Acceptance criteria:",
			...request.acceptanceCriteria.map((criterion) => `- [${criterion.id}] ${criterion.description}`),
		);
	lines.push(
		"",
		"Work autonomously within the stated objective and constraints. Finish when the objective is complete.",
	);
	return lines.join("\n");
}

// =============================================================================
// Real session path
// =============================================================================

/** Tools for a mission: mode-based set, narrowed by declared capabilities. */
function toolsForRequest(request: MissionRequest, cwd: string): Tool[] {
	const base = request.executionMode === "execute" ? createCodingTools(cwd) : createReadOnlyTools(cwd);
	if (!request.capabilities || request.capabilities.length === 0) return base;
	const allowed = new Set(request.capabilities);
	return base.filter((tool) => allowed.has(tool.name));
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join(" ");
}

function lastAssistantMessage(messages: readonly unknown[]): AssistantMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message && (message as { role?: unknown }).role === "assistant") return message as AssistantMessage;
	}
	return undefined;
}

/**
 * Build the default runner: real agent session over the normal
 * `createAgentSession()` path. The model comes from `MissionRequest.modelPolicy`
 * (verified, never defaulted); the session is bound to the mission's durable
 * `childSessionId` when present (explicit resume restores that exact session).
 */
export function createInProcessMissionRunner(options: {
	cwd?: string;
	agentDir?: string;
	authStorage?: AuthStorage;
	modelRegistry?: ModelRegistry;
	sessionDir?: string;
	/** Existing durable session resolved by the worker for this child. */
	sessionManager?: SessionManager;
	streamFn?: StreamFn;
	/** Durable Governance observer for actual model transitions. */
	governance?: GovernanceService;
}): InProcessMissionRunner {
	const cwd = options.cwd ?? process.cwd();
	const agentDir = options.agentDir ?? getAgentDir();
	const authStorage = options.authStorage ?? AuthStorage.create(`${agentDir}/auth.json`);
	const modelRegistry = options.modelRegistry ?? new ModelRegistry(authStorage, `${agentDir}/models.json`);
	const sessionDir = options.sessionDir ?? defaultChildSessionDir(agentDir);
	const resolvedSessionManager = options.sessionManager;

	return async (request, signal, executionId, correlation) => {
		if (signal?.aborted) return { exitCode: null, cancelled: true };

		const policy = request.modelPolicy;
		if (!policy)
			throw new Error(`MISSION_MODEL_POLICY_REQUIRED: mission ${request.missionId} declares no model policy`);
		const governancePolicy = governancePolicyFromEnv();
		const resolvedPolicy = resolveGovernanceModel(governancePolicy, policy);
		const model: Model<any> | undefined = modelRegistry.find(
			resolvedPolicy.selected.provider,
			resolvedPolicy.selected.model,
		);
		if (!model)
			throw new Error(
				`MISSION_MODEL_UNAVAILABLE: ${resolvedPolicy.selected.provider}/${resolvedPolicy.selected.model} is not registered in the model registry`,
			);

		const missionCwd = request.workspaceScope?.cwd ?? cwd;
		const sessionManager =
			resolvedSessionManager ??
			(request.childSessionId
				? SessionManager.createWithId(missionCwd, sessionDir, request.childSessionId)
				: SessionManager.inMemory(missionCwd));
		if (request.childSessionId && sessionManager.getSessionId() !== request.childSessionId)
			throw new Error(
				`CHILD_SESSION_ID_MISMATCH: expected ${request.childSessionId}, got ${sessionManager.getSessionId()}`,
			);

		let session: AgentSession | undefined;
		const onAbort = () => {
			void session?.abort();
		};
		if (signal) signal.addEventListener("abort", onAbort, { once: true });
		try {
			const created = await createAgentSession({
				cwd: missionCwd,
				agentDir,
				authStorage,
				modelRegistry,
				model,
				tools: toolsForRequest(request, missionCwd),
				sessionManager,
				streamFn: options.streamFn,
				missionId: request.missionId,
				assignmentId: correlation?.assignmentId ?? (request.context?.assignmentId as string | undefined),
				executionId,
			});
			session = created.session;
			await created.session.prompt(buildInProcessMissionPrompt(request), { expandPromptTemplates: false });
		} catch (error) {
			if (signal?.aborted) return { exitCode: null, cancelled: true };
			return { exitCode: 1, sessionError: error instanceof Error ? error.message : String(error) };
		} finally {
			if (signal) signal.removeEventListener("abort", onAbort);
		}
		if (!session) return { exitCode: 1, sessionError: "session was not created" };
		const finalMessage = lastAssistantMessage(session.messages);
		if (!finalMessage) return { exitCode: 1, sessionError: "session produced no assistant message" };
		const outputText = assistantText(finalMessage);
		if (finalMessage.stopReason === "aborted") return { exitCode: null, cancelled: true, outputText };
		if (finalMessage.stopReason === "error")
			return { exitCode: 1, sessionError: finalMessage.errorMessage ?? "inference error", outputText };
		return { exitCode: 0, outputText };
	};
}

// =============================================================================
// Executor
// =============================================================================

export interface InProcessMissionExecutorOptions {
	executorId?: string;
	/** Deterministic seam replacing the whole session path (mirrors the process executor's harness). */
	runner?: InProcessMissionRunner;
	/** Optional verifier that may promote a clean completion to SUCCEEDED. */
	verifier?: InProcessMissionVerifier;
	/** Execution id factory (default: UUID). Never a process id. */
	executionIdFactory?: (request: MissionRequest) => string;
	/** Working directory default for the real session path. Default: process.cwd() */
	cwd?: string;
	/** Global config directory for the real session path. Default: getAgentDir() */
	agentDir?: string;
	/** Auth storage for the real session path. Default: AuthStorage.create(agentDir/auth.json) */
	authStorage?: AuthStorage;
	/** Model registry for the real session path. Default: new ModelRegistry(authStorage, agentDir/models.json) */
	modelRegistry?: ModelRegistry;
	/** Session dir for durable child sessions. Default: defaultChildSessionDir(agentDir) */
	sessionDir?: string;
	/** Existing durable session resolved by the worker for this child. */
	sessionManager?: SessionManager;
	/** Stream seam for the real session path (default: normal provider stream). */
	streamFn?: StreamFn;
}

interface ActiveMission {
	request: MissionRequest;
	executionId: string;
	tracker: MissionStateTracker;
	startedAtMs: number;
	finishedAtMs?: number;
	controller: AbortController;
	outcomePromise: Promise<InProcessMissionOutcome>;
	cancelled: boolean;
}

export class InProcessMissionExecutor implements MissionExecutor {
	readonly executorId: string;
	private readonly _runner: InProcessMissionRunner;
	private readonly _verifier?: InProcessMissionVerifier;
	private readonly _executionIdFactory: (request: MissionRequest) => string;
	private readonly _active = new Map<string, ActiveMission>();

	constructor(options: InProcessMissionExecutorOptions = {}) {
		this.executorId = options.executorId ?? "in-process";
		this._verifier = options.verifier;
		this._executionIdFactory = options.executionIdFactory ?? (() => `exec_${randomUUID()}`);
		this._runner =
			options.runner ??
			createInProcessMissionRunner({
				cwd: options.cwd,
				agentDir: options.agentDir,
				authStorage: options.authStorage,
				modelRegistry: options.modelRegistry,
				sessionDir: options.sessionDir,
				sessionManager: options.sessionManager,
				streamFn: options.streamFn,
			});
	}

	async launch(request: MissionRequest, options: MissionLaunchOptions = {}): Promise<MissionHandle> {
		const validation = validateMissionRequest(request);
		if (!validation.valid) {
			throw new Error(`Invalid MissionRequest: ${validation.errors.join(", ")}`);
		}

		const executionId = options.executionId ?? this._executionIdFactory(request);
		const controller = new AbortController();
		if (options.signal) {
			if (options.signal.aborted) controller.abort();
			else options.signal.addEventListener("abort", () => controller.abort(), { once: true });
		}

		const tracker = new MissionStateTracker("CREATED");
		tracker.transition("QUEUED");
		tracker.transition("RUNNING");

		const active: ActiveMission = {
			request,
			executionId,
			tracker,
			startedAtMs: Date.now(),
			controller,
			outcomePromise: this._run(request, controller.signal, executionId, {
				assignmentId: options.assignmentId,
				sessionId: options.sessionId ?? request.childSessionId,
			}),
			cancelled: false,
		};
		this._active.set(request.missionId, active);

		return createMissionHandle({
			missionId: request.missionId,
			parentMissionId: request.parentMissionId,
			depth: request.depth,
			executionId,
			state: tracker.state,
			createdAtMs: request.createdAtMs,
			startedAtMs: active.startedAtMs,
			cancel: (reason) => this._cancelActive(active, reason),
		});
	}

	async awaitResult(handle: MissionHandle): Promise<MissionResult> {
		const active = this._active.get(handle.missionId);
		if (!active) {
			throw new Error(`Unknown mission: ${handle.missionId}`);
		}

		const outcome = await active.outcomePromise;
		active.finishedAtMs = Date.now();

		const diagnostics: ExecutorDiagnostics = {
			executorId: this.executorId,
			processExitCode: outcome.exitCode ?? undefined,
			timedOut: outcome.timedOut,
			launchError: outcome.launchError,
			stderr: outcome.sessionError ? outcome.sessionError.slice(0, 16_000) : undefined,
		};

		const { state, executionOutcome, failure, verification, completionDecision, outputText } = await this._classify(
			active,
			outcome,
		);

		const failures: StructuredFailure[] = [];
		if (failure) failures.push(failure);

		return createMissionResult({
			missionId: active.request.missionId,
			parentMissionId: active.request.parentMissionId,
			depth: active.request.depth,
			state,
			executionOutcome,
			outputText,
			evidenceRefs: [],
			verification,
			completionDecision,
			failures,
			executorDiagnostics: diagnostics,
			startedAtMs: active.startedAtMs,
			finishedAtMs: active.finishedAtMs ?? Date.now(),
		});
	}

	async cancel(handle: MissionHandle, reason?: string): Promise<void> {
		const active = this._active.get(handle.missionId);
		if (!active) return;
		await this._cancelActive(active, reason);
	}

	private _run(
		request: MissionRequest,
		signal: AbortSignal,
		executionId: string,
		correlation: { assignmentId?: string; sessionId?: string },
	): Promise<InProcessMissionOutcome> {
		// A failing runner (session creation, model resolution, stream error)
		// is a launch failure, never an unhandled rejection.
		return this._runner(request, signal, executionId, correlation).catch((error) => ({
			exitCode: null,
			launchError: error instanceof Error ? error.message : String(error),
		}));
	}

	private async _cancelActive(active: ActiveMission, reason?: string): Promise<void> {
		active.cancelled = true;
		active.tracker.transition("CANCELLED");
		active.controller.abort(reason);
	}

	private async _classify(
		active: ActiveMission,
		outcome: InProcessMissionOutcome,
	): Promise<{
		state: MissionResult["state"];
		executionOutcome: MissionResult["executionOutcome"];
		failure?: StructuredFailure;
		verification: MissionResult["verification"];
		completionDecision: MissionResult["completionDecision"];
		outputText?: string;
	}> {
		const outputText = outcome.outputText?.trim().slice(0, 16_000) || undefined;

		if (active.cancelled) {
			return {
				state: "CANCELLED",
				executionOutcome: "CANCELLED",
				failure: { category: "CANCELLED", message: "mission cancelled by operator" },
				verification: { status: "unverified" },
				completionDecision: "unavailable",
				outputText,
			};
		}

		const base = classifyExecutorOutcome(outcome, { verified: false });

		// A verifier can promote a clean completion to verified SUCCEEDED.
		if (base.state === "PARTIAL" && this._verifier) {
			const verificationResult = await this._verifier({ request: active.request, outcome });
			if (verificationResult.verified) {
				active.tracker.transition("SUCCEEDED");
				return {
					state: "SUCCEEDED",
					executionOutcome: "COMPLETED",
					verification: {
						status: "verified",
						summary: verificationResult.summary,
						criterionIds: verificationResult.criterionIds,
					},
					completionDecision: "accepted",
					outputText,
				};
			}
			return {
				state: "FAILED",
				executionOutcome: "COMPLETED",
				failure: {
					category: "VERIFICATION",
					message: verificationResult.summary ?? "verification failed",
				},
				verification: { status: "failed", summary: verificationResult.summary },
				completionDecision: "rejected",
				outputText,
			};
		}

		active.tracker.transition(base.state);

		return {
			state: base.state,
			executionOutcome: base.executionOutcome,
			failure: base.failure,
			verification: { status: "unverified", summary: base.reason },
			completionDecision: base.state === "SUCCEEDED" ? "accepted" : "unavailable",
			outputText,
		};
	}
}

/** Build an `InProcessMissionExecutor`. */
export function createInProcessMissionExecutor(
	options: InProcessMissionExecutorOptions = {},
): InProcessMissionExecutor {
	return new InProcessMissionExecutor(options);
}
