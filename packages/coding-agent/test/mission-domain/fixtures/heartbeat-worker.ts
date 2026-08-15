/**
 * Cross-process heartbeat worker (fixture).
 *
 * Standalone tsx worker that runs a real DurableMissionCoordinator resume with
 * a long-running (never-completing) executor and an active lease heartbeat. It
 * periodically appends heartbeat telemetry to a log file and, if the resume
 * settles (authority loss or completion), appends a final `done` line and
 * exits. The parent kills it with SIGKILL for the liveness test; for the
 * stale-owner test it exits on its own after the heartbeat proves authority
 * loss and the executor is aborted.
 */

import { appendFileSync } from "node:fs";
import {
	createMissionHandle,
	createMissionResult,
	DurableMissionCoordinator,
	ExecutionAuthorityLostError,
	ExecutionOwnershipError,
	type MissionExecutor,
	type MissionHandle,
	type MissionRequest,
	type MissionResult,
} from "../../../src/core/mission-domain/index.js";
import { FileDurableMissionStore } from "../../../src/core/mission-durable/index.js";

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined;
}

function numberArg(name: string, fallback: number): number {
	const value = arg(name);
	if (value === undefined) return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

class LongRunningExecutor implements MissionExecutor {
	readonly executorId = "long-running";
	abortObserved = 0;
	cancelCount = 0;
	private resolveResult?: (result: MissionResult) => void;
	private resultPromise: Promise<MissionResult> = new Promise((resolve) => {
		this.resolveResult = resolve;
	});

	async launch(request: MissionRequest, options: { signal?: AbortSignal } = {}): Promise<MissionHandle> {
		if (options.signal) {
			options.signal.addEventListener(
				"abort",
				() => {
					this.abortObserved += 1;
					this.resolveResult?.(this.cancelled(request));
				},
				{ once: true },
			);
		}
		return createMissionHandle({
			missionId: request.missionId,
			parentMissionId: request.parentMissionId,
			depth: request.depth,
			executionId: "exec_long_running",
			state: "RUNNING",
			createdAtMs: request.createdAtMs,
			startedAtMs: Date.now(),
			cancel: async () => {
				this.cancelCount += 1;
			},
		});
	}

	async awaitResult(_handle: MissionHandle): Promise<MissionResult> {
		return this.resultPromise;
	}

	private cancelled(request: MissionRequest): MissionResult {
		return createMissionResult({
			missionId: request.missionId,
			parentMissionId: request.parentMissionId,
			depth: request.depth,
			state: "CANCELLED",
			executionOutcome: "CANCELLED",
			verification: { status: "unverified" },
			completionDecision: "unavailable",
			failures: [{ category: "CANCELLED", message: "execution authority lost" }],
			executorDiagnostics: { executorId: this.executorId, signal: "SIGTERM" },
			startedAtMs: request.createdAtMs,
			finishedAtMs: Date.now(),
		});
	}

	async cancel(): Promise<void> {
		this.cancelCount += 1;
	}
}

function errorCode(error: unknown): string {
	if (error instanceof ExecutionOwnershipError) return error.code;
	if (error instanceof ExecutionAuthorityLostError) return error.code;
	return "ERROR";
}

async function main(): Promise<void> {
	const root = arg("--root");
	const missionId = arg("--missionId");
	const log = arg("--log");
	if (!root || !missionId || !log) {
		process.stderr.write("missing --root/--missionId/--log\n");
		process.exit(1);
	}

	const leaseDurationMs = numberArg("--leaseDurationMs", 1500);
	const heartbeatIntervalMs = numberArg("--heartbeatIntervalMs", 500);
	const renewalSafetyMarginMs = numberArg("--renewalSafetyMarginMs", 500);
	const pollMs = numberArg("--pollMs", 200);

	const store = new FileDurableMissionStore({ root });
	const executor = new LongRunningExecutor();
	const coordinator = new DurableMissionCoordinator(store, executor, {
		leaseDurationMs,
		heartbeatIntervalMs,
		renewalSafetyMarginMs,
	});

	const poll = setInterval(() => {
		const telemetry = coordinator.heartbeatTelemetry(missionId);
		if (!telemetry) return;
		appendFileSync(
			log,
			`${JSON.stringify({
				t: "telemetry",
				renewalCount: telemetry.renewalCount,
				renewalFailureCount: telemetry.renewalFailureCount,
				heartbeatActive: telemetry.heartbeatActive,
				authorityLost: telemetry.authorityLost,
				authorityLostReason: telemetry.authorityLostReason,
				lastRenewalAt: telemetry.lastRenewalAt,
				leaseExpiresAt: telemetry.leaseExpiresAt,
			})}\n`,
			"utf8",
		);
	}, pollMs);

	try {
		const record = await coordinator.resume(missionId);
		appendFileSync(
			log,
			`${JSON.stringify({
				t: "done",
				ok: true,
				state: record.state,
				fencingToken: record.fencingToken,
				abortObserved: executor.abortObserved,
			})}\n`,
			"utf8",
		);
	} catch (error) {
		appendFileSync(
			log,
			`${JSON.stringify({
				t: "done",
				ok: false,
				code: errorCode(error),
				name: error instanceof Error ? error.name : undefined,
				message: error instanceof Error ? error.message : String(error),
				abortObserved: executor.abortObserved,
				cancelCount: executor.cancelCount,
			})}\n`,
			"utf8",
		);
	} finally {
		clearInterval(poll);
		process.exit(0);
	}
}

void main();
