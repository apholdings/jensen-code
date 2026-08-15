/**
 * Cross-process store worker (fixture).
 *
 * This is a standalone TypeScript worker executed with `tsx` by the
 * cross-process ownership tests. It performs a single store/ownership mutation
 * against a shared FileDurableMissionStore and prints a single JSON line to
 * stdout. Exit code 0 means the operation completed (success or a structured
 * rejection); only unexpected crashes produce a non-zero exit.
 */

import { appendFileSync } from "node:fs";
import * as path from "node:path";
import lockfile from "proper-lockfile";
import { DurableMissionDelegator } from "../../../src/core/durable-delegation/index.js";
import {
	createMissionResult,
	type DurableMissionRecord,
	ExecutionOwnershipError,
} from "../../../src/core/mission-domain/index.js";
import { FileDurableMissionStore } from "../../../src/core/mission-durable/index.js";

function emit(value: unknown): never {
	process.stdout.write(`${JSON.stringify(value)}\n`);
	process.exit(0);
}

function fail(message: string): never {
	process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
	process.exit(0);
}

function arg(name: string): string | undefined {
	const argv = process.argv;
	const index = argv.indexOf(name);
	return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
}

function numberArg(name: string): number | undefined {
	const value = arg(name);
	if (value === undefined) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

async function main(): Promise<void> {
	const root = arg("--root");
	const op = arg("--op");
	const missionId = arg("--missionId");
	if (!root || !op || !missionId) fail("missing --root/--op/--missionId");

	const store = new FileDurableMissionStore({ root });

	if (op === "cas") {
		const expectedRevision = numberArg("--expectedRevision");
		if (expectedRevision === undefined) fail("missing --expectedRevision");

		const loaded = await store.load(missionId);
		if (loaded.status !== "ok") fail(`load failed: ${loaded.status}`);
		const next: DurableMissionRecord = {
			...loaded.record,
			state: "QUEUED",
			updatedAtMs: loaded.record.updatedAtMs + 1,
			transitions: [
				...loaded.record.transitions,
				{
					seq: loaded.record.transitions.length,
					from: loaded.record.state,
					to: "QUEUED" as const,
					atMs: loaded.record.updatedAtMs + 1,
					reason: "cross-process cas",
				},
			],
			revision: loaded.record.revision + 1,
		};
		const result = await store.save(next, { expectedRevision });
		emit({ status: result.status, actualRevision: result.status === "stale" ? result.actualRevision : undefined });
		return;
	}

	if (op === "acquire") {
		const ownerId = arg("--ownerId");
		const delegator = new DurableMissionDelegator({ store, ownerId });
		try {
			const acquired = await delegator.acquireOwnership(missionId);
			emit({
				status: "acquired",
				fencingToken: acquired.lease.fencingToken,
				leaseId: acquired.lease.leaseId,
				ownerId: acquired.lease.ownerId,
				state: acquired.record.state,
			});
		} catch (error) {
			if (error instanceof ExecutionOwnershipError) {
				emit({ status: "error", code: error.code, message: error.message });
			} else {
				emit({ status: "error", code: "ERROR", message: error instanceof Error ? error.message : String(error) });
			}
		}
		return;
	}

	if (op === "renew") {
		const leaseId = arg("--leaseId");
		const fencingToken = numberArg("--fencingToken");
		if (!leaseId || fencingToken === undefined) fail("missing --leaseId/--fencingToken");
		const delegator = new DurableMissionDelegator({ store });
		try {
			const renewed = await delegator.renewOwnership(missionId, { leaseId, fencingToken });
			emit({ status: "renewed", fencingToken: renewed.lease.fencingToken, expiresAtMs: renewed.lease.expiresAtMs });
		} catch (error) {
			if (error instanceof ExecutionOwnershipError) {
				emit({ status: "error", code: error.code, message: error.message });
			} else {
				emit({ status: "error", code: "ERROR", message: error instanceof Error ? error.message : String(error) });
			}
		}
		return;
	}

	if (op === "release") {
		const leaseId = arg("--leaseId");
		const fencingToken = numberArg("--fencingToken");
		if (!leaseId || fencingToken === undefined) fail("missing --leaseId/--fencingToken");
		const delegator = new DurableMissionDelegator({ store });
		try {
			const record = await delegator.releaseOwnership(missionId, { leaseId, fencingToken });
			emit({ status: "released", state: record.state, fencingToken: record.fencingToken });
		} catch (error) {
			if (error instanceof ExecutionOwnershipError) {
				emit({ status: "error", code: error.code, message: error.message });
			} else {
				emit({ status: "error", code: "ERROR", message: error instanceof Error ? error.message : String(error) });
			}
		}
		return;
	}

	if (op === "stress") {
		const iterations = numberArg("--iterations") ?? 10;
		const logFile = arg("--log");
		if (!logFile) fail("missing --log");
		const delegator = new DurableMissionDelegator({ store });
		for (let i = 0; i < iterations; i += 1) {
			try {
				const acquired = await delegator.acquireOwnership(missionId);
				appendFileSync(logFile, `${acquired.lease.fencingToken}\t${acquired.lease.leaseId}\n`, "utf8");
				if (i % 3 === 0) {
					await delegator.renewOwnership(missionId, {
						leaseId: acquired.lease.leaseId,
						fencingToken: acquired.lease.fencingToken,
					});
				}
				await delegator.releaseOwnership(missionId, {
					leaseId: acquired.lease.leaseId,
					fencingToken: acquired.lease.fencingToken,
				});
			} catch {
				// Lost an ownership race; retry on the next iteration.
			}
		}
		emit({ status: "done", iterations });
		return;
	}

	if (op === "hold-lock") {
		const target = path.join(root, `${missionId}.mission.json`);
		// Acquire the real cross-process lock and then die without releasing it.
		// The parent observes the crash and must recover the stale lock safely.
		await lockfile.lock(target, { realpath: false, stale: 5000 });
		process.stdout.write(`${JSON.stringify({ status: "locked" })}\n`);
		process.kill(process.pid, "SIGKILL");
		return;
	}

	if (op === "fenced-terminal") {
		const leaseId = arg("--leaseId");
		const fencingToken = numberArg("--fencingToken");
		if (!leaseId || fencingToken === undefined) fail("missing --leaseId/--fencingToken");

		const loaded = await store.load(missionId);
		if (loaded.status !== "ok") fail(`load failed: ${loaded.status}`);
		const current = loaded.record;
		const atMs = current.updatedAtMs + 1;
		const result = createMissionResult({
			missionId: current.missionId,
			parentMissionId: current.parentMissionId,
			depth: current.depth,
			state: "SUCCEEDED",
			executionOutcome: "COMPLETED",
			verification: { status: "verified" },
			completionDecision: "accepted",
			failures: [],
			executorDiagnostics: { executorId: "stale-worker", processExitCode: 0 },
			startedAtMs: current.startedAtMs ?? atMs,
			finishedAtMs: atMs,
		});
		const next: DurableMissionRecord = {
			...current,
			state: "SUCCEEDED",
			result,
			resultExecutionId: "exec_stale",
			finishedAtMs: atMs,
			currentAttemptId: undefined,
			currentExecutionId: undefined,
			lease: undefined,
			updatedAtMs: atMs,
			transitions: [
				...current.transitions,
				{
					seq: current.transitions.length,
					from: current.state,
					to: "SUCCEEDED" as const,
					atMs,
					executionId: "exec_stale",
				},
			],
			revision: current.revision + 1,
		};
		const saveResult = await store.save(next, {
			expectedRevision: current.revision,
			leaseProof: { leaseId, fencingToken },
		});
		emit({ status: saveResult.status });
		return;
	}

	fail(`unknown op: ${op}`);
}

void main();
