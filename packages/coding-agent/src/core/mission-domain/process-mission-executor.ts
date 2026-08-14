/**
 * Process Mission Executor (2.3.0).
 *
 * The transitional executor that adapts the current spawned-CLI path to the
 * first-class mission contract. This is the ONLY mission-domain file allowed to
 * depend on process-spawn machinery (and it imports none of the domain's
 * provider/CLI/UI concerns). The default harness uses Node `child_process`;
 * callers may inject a harness for deterministic tests.
 *
 * Invariants:
 *   - A raw exit code of 0 is NEVER classified as SUCCEEDED. Without a verifier
 *     it is PARTIAL ("execution completed but unverified").
 *   - The handle exposes `executionId` and `cancel`, never a ChildProcess.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { MissionExecutor, MissionLaunchOptions } from "./mission-executor.js";
import { createMissionHandle, type MissionHandle } from "./mission-handle.js";
import type { MissionRequest } from "./mission-request.js";
import { validateMissionRequest } from "./mission-request.js";
import {
	classifyExecutorOutcome,
	createMissionResult,
	type ExecutorDiagnostics,
	type ExecutorOutcome,
	type MissionExecutionOutcome,
	type MissionResult,
	type StructuredFailure,
} from "./mission-result.js";
import { MissionStateTracker } from "./mission-state.js";

// =============================================================================
// Harness
// =============================================================================

export interface ProcessMissionLaunch {
	command: string;
	args: readonly string[];
	cwd: string;
	env?: Record<string, string | undefined>;
	callbacks?: {
		onStdout?: (chunk: string) => void;
		onStderr?: (chunk: string) => void;
	};
}

export interface ProcessMissionOutcome extends ExecutorOutcome {
	stdout: string;
	stderr: string;
}

export type ProcessMissionHarness = (
	launch: ProcessMissionLaunch,
	signal?: AbortSignal,
) => Promise<ProcessMissionOutcome>;

export interface ProcessMissionVerifierInput {
	request: MissionRequest;
	outcome: ProcessMissionOutcome;
}

export interface ProcessMissionVerification {
	verified: boolean;
	summary?: string;
	criterionIds?: string[];
}

export type ProcessMissionVerifier = (input: ProcessMissionVerifierInput) => Promise<ProcessMissionVerification>;

// =============================================================================
// Default harness (Node child_process)
// =============================================================================

const DEFAULT_TIMEOUT_MS = 600_000;

function createDefaultHarness(options: { timeoutMs?: number }): ProcessMissionHarness {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	return (launch, signal) =>
		new Promise<ProcessMissionOutcome>((resolve) => {
			const child = spawn(launch.command, [...launch.args], {
				cwd: launch.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, ...(launch.env ?? {}) },
				windowsHide: true,
			});

			let stdout = "";
			let stderr = "";
			let launchError: string | undefined;
			let timedOut = false;
			let settled = false;

			const finish = (outcome: ProcessMissionOutcome) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				resolve(outcome);
			};

			const timeout = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, timeoutMs);

			const killChild = () => {
				child.kill("SIGTERM");
				setTimeout(() => {
					if (!child.killed) child.kill("SIGKILL");
				}, 5000);
			};

			if (signal) {
				if (signal.aborted) {
					killChild();
				} else {
					signal.addEventListener("abort", killChild, { once: true });
				}
			}

			child.stdout.on("data", (data: Buffer) => {
				const chunk = data.toString();
				stdout += chunk;
				launch.callbacks?.onStdout?.(chunk);
			});
			child.stderr.on("data", (data: Buffer) => {
				const chunk = data.toString();
				stderr += chunk;
				launch.callbacks?.onStderr?.(chunk);
			});
			child.on("error", (error) => {
				launchError = error.message;
			});
			child.on("close", (code, closeSignal) => {
				if (signal) signal.removeEventListener("abort", killChild);
				finish({
					exitCode: code,
					signal: closeSignal ?? undefined,
					timedOut,
					launchError,
					stdout,
					stderr,
				});
			});
		});
}

// =============================================================================
// Executor
// =============================================================================

export interface ProcessMissionExecutorOptions {
	executorId?: string;
	/** Maps a MissionRequest to a concrete process launch (executor detail). */
	buildLaunch: (request: MissionRequest) => ProcessMissionLaunch;
	/** Spawn harness override (default: Node child_process). */
	harness?: ProcessMissionHarness;
	/** Optional verifier that may promote an exit-0 outcome to SUCCEEDED. */
	verifier?: ProcessMissionVerifier;
	timeoutMs?: number;
	/** Execution id factory (default: UUID). Never a process id. */
	executionIdFactory?: (request: MissionRequest) => string;
}

interface ActiveMission {
	request: MissionRequest;
	executionId: string;
	tracker: MissionStateTracker;
	startedAtMs: number;
	finishedAtMs?: number;
	controller: AbortController;
	outcomePromise: Promise<ProcessMissionOutcome>;
	cancelled: boolean;
}

export class ProcessMissionExecutor implements MissionExecutor {
	readonly executorId: string;
	private readonly _buildLaunch: (request: MissionRequest) => ProcessMissionLaunch;
	private readonly _harness: ProcessMissionHarness;
	private readonly _verifier?: ProcessMissionVerifier;
	private readonly _executionIdFactory: (request: MissionRequest) => string;
	private readonly _active = new Map<string, ActiveMission>();

	constructor(options: ProcessMissionExecutorOptions) {
		this.executorId = options.executorId ?? "process";
		this._buildLaunch = options.buildLaunch;
		this._harness = options.harness ?? createDefaultHarness({ timeoutMs: options.timeoutMs });
		this._verifier = options.verifier;
		this._executionIdFactory = options.executionIdFactory ?? (() => `exec_${randomUUID()}`);
	}

	async launch(request: MissionRequest, options: MissionLaunchOptions = {}): Promise<MissionHandle> {
		const validation = validateMissionRequest(request);
		if (!validation.valid) {
			throw new Error(`Invalid MissionRequest: ${validation.errors.join(", ")}`);
		}

		const executionId = this._executionIdFactory(request);
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
			outcomePromise: this._harness(this._buildLaunch(request), controller.signal),
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
			processExitCode: outcome.exitCode,
			signal: outcome.signal,
			timedOut: outcome.timedOut,
			launchError: outcome.launchError,
			stderr: outcome.stderr.slice(0, 16_000),
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

	private async _cancelActive(active: ActiveMission, reason?: string): Promise<void> {
		active.cancelled = true;
		active.tracker.transition("CANCELLED");
		active.controller.abort(reason);
	}

	private async _classify(
		active: ActiveMission,
		outcome: ProcessMissionOutcome,
	): Promise<{
		state: MissionResult["state"];
		executionOutcome: MissionExecutionOutcome;
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

		const base = classifyExecutorOutcome(outcome, { verified: false });

		// A verifier can promote a clean exit-0 execution to verified SUCCEEDED.
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
