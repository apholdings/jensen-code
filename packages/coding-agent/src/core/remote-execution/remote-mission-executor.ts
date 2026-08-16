/**
 * Remote Mission Executor (2.14.0).
 *
 * A `MissionExecutor` whose child executes on a remote target while the
 * Bucephalus control plane keeps the durable authority. It is structurally the
 * same contract as `ProcessMissionExecutor` (launch → handle → awaitResult →
 * MissionResult), but the harness is a remote transport instead of local
 * `child_process.spawn`.
 *
 * Invariants:
 *   - A raw remote exit 0 without verification is PARTIAL, never SUCCEEDED.
 *   - Duplicate launch of one execution identity is rejected (idempotency).
 *   - Transport close without a terminal frame is never success.
 *   - Remote result is an observation; the durable coordinator accepts/rejects
 *     the terminal commit under the existing execution fence.
 */

import { randomUUID } from "node:crypto";
import type { MissionExecutor, MissionLaunchOptions } from "../mission-domain/mission-executor.js";
import { createMissionHandle, type MissionHandle } from "../mission-domain/mission-handle.js";
import type { MissionRequest } from "../mission-domain/mission-request.js";
import { validateMissionRequest } from "../mission-domain/mission-request.js";
import {
	classifyExecutorOutcome,
	createMissionResult,
	type ExecutorDiagnostics,
	type MissionResult,
	type StructuredFailure,
} from "../mission-domain/mission-result.js";
import { MissionStateTracker } from "../mission-domain/mission-state.js";
import type { ProcessMissionOutcome, ProcessMissionVerifier } from "../mission-domain/process-mission-executor.js";
import { RemoteExecutionError } from "./remote-execution-error.js";
import type { RemoteExecutionTarget } from "./remote-target-types.js";
import type { RemoteChildLaunch, RemoteCommandRunner, RemoteExecutionTransport } from "./remote-transport.js";
import { buildRemoteAcceptanceCriteriaVerifier } from "./remote-verification.js";

// =============================================================================
// Options
// =============================================================================

export interface RemoteMissionExecutorOptions {
	executorId?: string;
	target: RemoteExecutionTarget;
	transport: RemoteExecutionTransport & RemoteCommandRunner;
	/**
	 * Concrete remote child launch for this mission's resume. The closure is
	 * built by the caller (worker/resume path) and captures the resume prompt +
	 * child session id, exactly like `ProcessMissionExecutor.buildLaunch`. The
	 * resolved remote dirs are supplied so the launch can point `--session-dir`
	 * and the working directory at the execution-scoped workspace.
	 */
	buildRemoteLaunch: (input: {
		request: MissionRequest;
		workspaceDir: string;
		agentDir: string;
		sessionDir: string;
	}) => RemoteChildLaunch;
	/** Initial workspace files to materialise on the target (remote-relative). */
	workspaceFiles?: (request: MissionRequest) => { path: string; content: string }[];
	/** Materialised remote models.json content (ephemeral protected config). */
	modelsJson: string;
	/** Child session identity + file content to materialise on the target. */
	childSessionId?: string;
	sessionFileContent?: string;
	/** Absolute remote temp root for the execution-scoped workspace. */
	remoteTempRoot: string;
	/** Remote-relative files to hash before/after (location proof). */
	evidenceFiles?: string[];
	/** Optional verifier override (defaults to remote acceptance-criteria). */
	verifier?: ProcessMissionVerifier;
	/**
	 * Optional shared-inference admission wiring. When set, the remote child
	 * routes its shared-resource inference through the central scheduler via a
	 * reverse tunnel that lives exactly as long as this execution's SSH session.
	 * `tokenIssuer` is called with the concrete executionId so the token is
	 * execution-scoped (never persisted, never placed in argv).
	 */
	admission?: {
		localPort: number;
		remotePort: number;
		tokenIssuer: (executionId: string) => { token: string } | Promise<{ token: string }>;
	};
	executionIdFactory?: (request: MissionRequest) => string;
	launchIdFactory?: () => string;
	timeoutMs?: number;
	heartbeatMs?: number;
	now?: () => number;
}

interface ActiveMission {
	request: MissionRequest;
	executionId: string;
	launchId: string;
	workspaceDir: string;
	agentDir: string;
	tracker: MissionStateTracker;
	startedAtMs: number;
	finishedAtMs?: number;
	controller: AbortController;
	handle: import("./remote-transport.js").RemoteExecutionHandle;
	cancelled: boolean;
}

export class RemoteMissionExecutor implements MissionExecutor {
	readonly executorId: string;
	private readonly _target: RemoteExecutionTarget;
	private readonly _transport: RemoteExecutionTransport & RemoteCommandRunner;
	private readonly _buildRemoteLaunch: (input: {
		request: MissionRequest;
		workspaceDir: string;
		agentDir: string;
		sessionDir: string;
	}) => RemoteChildLaunch;
	private readonly _workspaceFiles?: (request: MissionRequest) => { path: string; content: string }[];
	private readonly _modelsJson: string;
	private readonly _childSessionId?: string;
	private readonly _sessionFileContent?: string;
	private readonly _remoteTempRoot: string;
	private readonly _evidenceFiles?: string[];
	private readonly _verifier?: ProcessMissionVerifier;
	private readonly _admission?: {
		localPort: number;
		remotePort: number;
		tokenIssuer: (executionId: string) => { token: string } | Promise<{ token: string }>;
	};
	private readonly _executionIdFactory: (request: MissionRequest) => string;
	private readonly _launchIdFactory: () => string;
	private readonly _timeoutMs?: number;
	private readonly _heartbeatMs?: number;
	private readonly _now: () => number;
	private readonly _active = new Map<string, ActiveMission>();
	private readonly _launchedIds = new Set<string>();

	constructor(options: RemoteMissionExecutorOptions) {
		this.executorId = options.executorId ?? "remote";
		this._target = options.target;
		this._transport = options.transport;
		this._buildRemoteLaunch = options.buildRemoteLaunch;
		this._workspaceFiles = options.workspaceFiles;
		this._modelsJson = options.modelsJson;
		this._childSessionId = options.childSessionId;
		this._sessionFileContent = options.sessionFileContent;
		this._remoteTempRoot = options.remoteTempRoot;
		this._evidenceFiles = options.evidenceFiles;
		this._verifier = options.verifier;
		this._admission = options.admission;
		this._executionIdFactory = options.executionIdFactory ?? (() => `exec_${randomUUID()}`);
		this._launchIdFactory = options.launchIdFactory ?? (() => `launch_${randomUUID()}`);
		this._timeoutMs = options.timeoutMs;
		this._heartbeatMs = options.heartbeatMs;
		this._now = options.now ?? (() => Date.now());
	}

	async launch(request: MissionRequest, options: MissionLaunchOptions = {}): Promise<MissionHandle> {
		const validation = validateMissionRequest(request);
		if (!validation.valid) {
			throw new Error(`Invalid MissionRequest: ${validation.errors.join(", ")}`);
		}

		const executionId = this._executionIdFactory(request);
		const launchId = this._launchIdFactory();

		if (this._launchedIds.has(executionId)) {
			throw new RemoteExecutionError(
				"REMOTE_DUPLICATE_LAUNCH",
				`Execution ${executionId} was already launched remotely`,
				{ executionId },
			);
		}
		this._launchedIds.add(executionId);

		const workspaceDir = `${this._remoteTempRoot.replace(/[\\/]+$/, "")}\\jensen-remote-qa\\${executionId}`;
		const agentDir = `${workspaceDir}\\agent`;
		const sessionDir = `${agentDir}\\child-sessions`;

		const controller = new AbortController();
		if (options.signal) {
			if (options.signal.aborted) controller.abort();
			else options.signal.addEventListener("abort", () => controller.abort(), { once: true });
		}

		const tracker = new MissionStateTracker("CREATED");
		tracker.transition("QUEUED");
		tracker.transition("RUNNING");

		const remoteLaunch = this._buildRemoteLaunch({ request, workspaceDir, agentDir, sessionDir });

		// Shared-inference admission: issue an execution-scoped token and inject
		// the admission endpoint into the remote child env (never argv).
		let admissionEnv: Record<string, string> = {};
		if (this._admission) {
			const { token } = await this._admission.tokenIssuer(executionId);
			admissionEnv = {
				JENSEN_SHARED_INFERENCE_ADMISSION_URL: `http://127.0.0.1:${this._admission.remotePort}`,
				JENSEN_SHARED_INFERENCE_TOKEN: token,
				JENSEN_SHARED_INFERENCE_EXECUTION_ID: executionId,
			};
		}

		const workspaceFiles = (this._workspaceFiles?.(request) ?? []).map((file) => ({
			path: file.path,
			contentB64: Buffer.from(file.content, "utf8").toString("base64"),
		}));
		const handle = await this._transport.launch(
			this._target,
			{
				executionId,
				launchId,
				remoteTargetId: this._target.targetId,
				fencing: options.fencing,
				workspaceDir,
				agentDir,
				modelsJson: this._modelsJson,
				childSessionId: this._childSessionId,
				sessionFileContent: this._sessionFileContent,
				workspaceFiles,
				launch: {
					...remoteLaunch,
					cwd: workspaceDir,
					env: { ...(remoteLaunch.env ?? {}), ...admissionEnv },
				},
				heartbeatMs: this._heartbeatMs,
				timeoutMs: this._timeoutMs,
				evidenceFiles: this._evidenceFiles,
				admissionTunnel: this._admission
					? { localPort: this._admission.localPort, remotePort: this._admission.remotePort }
					: undefined,
			},
			{ signal: controller.signal },
		);

		const active: ActiveMission = {
			request,
			executionId,
			launchId,
			workspaceDir,
			agentDir,
			tracker,
			startedAtMs: this._now(),
			controller,
			handle,
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

		let outcome: ProcessMissionOutcome;
		let raw: import("./remote-transport.js").RemoteTransportOutcome | undefined;
		try {
			raw = await active.handle.outcomePromise;
			outcome = {
				exitCode: raw.exitCode,
				stdout: raw.stdout,
				stderr: raw.stderr,
				launchError: raw.launchError,
				timedOut: raw.timedOut,
			};
			active.finishedAtMs = this._now();
		} catch (error) {
			active.finishedAtMs = this._now();
			// A structured transport failure (duplicate/launch/lost/timeout) is a
			// hard executor failure, never a fabricated success.
			const diagnostics = this._diagnostics(undefined);
			const { failure, state } = this._failureFromTransport(error);
			const failures: StructuredFailure[] = [failure];
			return createMissionResult({
				missionId: active.request.missionId,
				parentMissionId: active.request.parentMissionId,
				depth: active.request.depth,
				state,
				executionOutcome: state === "CANCELLED" ? "CANCELLED" : "CRASHED",
				verification: { status: "unverified" },
				completionDecision: "unavailable",
				failures,
				executorDiagnostics: diagnostics,
				startedAtMs: active.startedAtMs,
				finishedAtMs: active.finishedAtMs ?? this._now(),
			});
		}

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
			executorDiagnostics: this._diagnostics(raw),
			startedAtMs: active.startedAtMs,
			finishedAtMs: active.finishedAtMs ?? this._now(),
		});
	}

	async cancel(handle: MissionHandle, reason?: string): Promise<void> {
		const active = this._active.get(handle.missionId);
		if (!active) return;
		await this._cancelActive(active, reason);
	}

	private async _cancelActive(active: ActiveMission, reason?: string): Promise<void> {
		active.cancelled = true;
		active.tracker.transition("CANCELLED");
		active.controller.abort(reason ?? "mission cancelled by operator");
		try {
			await active.handle.cancel(reason);
		} catch {
			// Best-effort; the fenced terminal write remains the authority.
		}
	}

	private _diagnostics(
		outcome: import("./remote-transport.js").RemoteTransportOutcome | undefined,
	): ExecutorDiagnostics {
		return {
			executorId: this.executorId,
			processExitCode: outcome?.exitCode ?? null,
			stderr: (outcome?.stderr ?? "").slice(0, 16_000),
			remoteLocation: outcome?.location,
			remoteEvidence: outcome?.evidence,
			remoteTargetId: this._target.targetId,
		};
	}

	private _failureFromTransport(error: unknown): { state: MissionResult["state"]; failure: StructuredFailure } {
		if (error instanceof RemoteExecutionError) {
			if (error.code === "REMOTE_DUPLICATE_LAUNCH") {
				return {
					state: "FAILED",
					failure: { category: "LAUNCH", message: error.message, code: error.code },
				};
			}
			if (error.code === "REMOTE_EXECUTION_LOST" || error.code === "REMOTE_HEARTBEAT_TIMEOUT") {
				return {
					state: "FAILED",
					failure: { category: "EXECUTION", message: error.message, code: error.code },
				};
			}
			return {
				state: "FAILED",
				failure: { category: "LAUNCH", message: error.message, code: error.code },
			};
		}
		const message = error instanceof Error ? error.message : String(error);
		return { state: "FAILED", failure: { category: "EXECUTION", message } };
	}

	private async _classify(
		active: ActiveMission,
		outcome: ProcessMissionOutcome,
	): Promise<{
		state: MissionResult["state"];
		executionOutcome: MissionResult["executionOutcome"];
		failure?: StructuredFailure;
		verification: MissionResult["verification"];
		completionDecision: MissionResult["completionDecision"];
		outputText?: string;
	}> {
		const outputText = outcome.stdout.trim().slice(0, 16_000) || undefined;

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

		const base = classifyExecutorOutcome(
			{ exitCode: outcome.exitCode, launchError: outcome.launchError, timedOut: outcome.timedOut },
			{ verified: false },
		);

		const verifier =
			this._verifier ??
			buildRemoteAcceptanceCriteriaVerifier(active.request, {
				runner: this._transport,
				target: this._target,
				cwd: active.workspaceDir,
			});

		if (base.state === "PARTIAL" && verifier) {
			const verificationResult = await verifier({ request: active.request, outcome });
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

		const state = base.state;
		if (state !== "PARTIAL") active.tracker.transition(state);
		else active.tracker.transition("PARTIAL");

		return {
			state,
			executionOutcome: base.executionOutcome,
			failure: base.failure,
			verification: { status: "unverified", summary: base.reason },
			completionDecision: state === "SUCCEEDED" ? "accepted" : "unavailable",
			outputText,
		};
	}
}
