/**
 * Execution ownership + fencing tests (2.7.0).
 *
 * Deterministic, clock-injected tests for the local file-backed execution
 * lease: monotonic fencing, stale-owner rejection, lease renewal/expiry,
 * conservative recovery, terminal-result safety, corrupt-lease failure, and
 * durable-child/session integration. These use a single OS process (multiple
 * store instances) with fake clocks; true cross-process races are covered by
 * cross-process-ownership.test.ts and the multiprocess stress harness.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DurableMissionDelegator } from "../../src/core/durable-delegation/index.js";
import {
	createDurableMissionRecord,
	createMissionHandle,
	createMissionRequest,
	createMissionResult,
	DurableMissionCoordinator,
	type DurableMissionRecord,
	type ExecutionLease,
	ExecutionOwnershipError,
	type MissionExecutor,
	type MissionHandle,
	type MissionRequest,
	type MissionResult,
	newChildSessionId,
} from "../../src/core/mission-domain/index.js";
import { FileDurableMissionStore } from "../../src/core/mission-durable/index.js";

function makeRoot(): string {
	return mkdtempSync(path.join(tmpdir(), "execution-lease-"));
}

function request(
	missionId: string,
	parent?: { missionId: string; depth: number },
	childSessionId?: string,
): MissionRequest {
	return createMissionRequest({
		missionId,
		parent,
		objective: `objective of ${missionId}`,
		agent: "worker",
		executionMode: "execute",
		acceptanceCriteria: [],
		childSessionId,
	});
}

function leaseOf(
	ownerId: string,
	leaseId: string,
	fencingToken: number,
	now: number,
	durationMs: number,
): ExecutionLease {
	return {
		ownerId,
		leaseId,
		fencingToken,
		acquiredAtMs: now,
		renewedAtMs: now,
		expiresAtMs: now + durationMs,
	};
}

class CountingExecutor implements MissionExecutor {
	readonly executorId = "test";
	launchCount = 0;

	async launch(req: MissionRequest): Promise<MissionHandle> {
		this.launchCount += 1;
		return createMissionHandle({
			missionId: req.missionId,
			parentMissionId: req.parentMissionId,
			depth: req.depth,
			executionId: `exec_${this.launchCount}`,
			state: "RUNNING",
			createdAtMs: req.createdAtMs,
			startedAtMs: Date.now(),
			cancel: async () => undefined,
		});
	}

	async awaitResult(handle: MissionHandle): Promise<MissionResult> {
		return createMissionResult({
			missionId: handle.missionId,
			parentMissionId: handle.parentMissionId,
			depth: handle.depth,
			state: "SUCCEEDED",
			executionOutcome: "COMPLETED",
			verification: { status: "verified" },
			completionDecision: "accepted",
			failures: [],
			executorDiagnostics: { executorId: this.executorId, processExitCode: 0 },
			startedAtMs: handle.startedAtMs ?? Date.now(),
			finishedAtMs: Date.now(),
		});
	}

	async cancel(): Promise<void> {}
}

function runningWithLease(req: MissionRequest, lease: ExecutionLease, now: number): DurableMissionRecord {
	return {
		schemaVersion: 1,
		missionId: req.missionId,
		parentMissionId: req.parentMissionId,
		depth: req.depth,
		request: req,
		state: "RUNNING",
		currentAttemptId: "attempt_B",
		currentExecutionId: "exec_B",
		createdAtMs: req.createdAtMs,
		updatedAtMs: now,
		startedAtMs: now,
		transitions: [
			{ seq: 0, from: "CREATED", to: "QUEUED", atMs: now },
			{ seq: 1, from: "QUEUED", to: "LAUNCHING", atMs: now, attemptId: "attempt_B" },
			{ seq: 2, from: "LAUNCHING", to: "RUNNING", atMs: now, executionId: "exec_B" },
		],
		attempts: [{ attemptId: "attempt_B", executionId: "exec_B", startedAtMs: now }],
		fencingToken: lease.fencingToken,
		lease,
		revision: 4,
	};
}

let root: string;
let store: FileDurableMissionStore;

beforeEach(() => {
	root = makeRoot();
	store = new FileDurableMissionStore({ root });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("TEST C — monotonic fencing across release/recover/reacquire", () => {
	it("new acquisition always gets a strictly greater fencing token", async () => {
		await store.create(createDurableMissionRecord({ request: request("mission_fence"), now: 0 }));

		const a = new DurableMissionCoordinator(store, new CountingExecutor(), {
			now: () => 1000,
			leaseDurationMs: 10_000,
			leaseIdFactory: () => "lease_a",
		});
		const first = await a.acquireOwnership("mission_fence");
		expect(first.lease.fencingToken).toBe(1);

		await a.releaseOwnership(
			"mission_fence",
			{ leaseId: first.lease.leaseId, fencingToken: first.lease.fencingToken },
			{ now: 1100 },
		);
		const released = await a.getMission("mission_fence");
		expect(released?.state).toBe("INTERRUPTED");
		expect(released?.lease).toBeUndefined();
		expect(released?.fencingToken).toBe(1);

		const b = new DurableMissionCoordinator(store, new CountingExecutor(), {
			now: () => 2000,
			leaseDurationMs: 10_000,
			leaseIdFactory: () => "lease_b",
		});
		const second = await b.acquireOwnership("mission_fence");
		expect(second.lease.fencingToken).toBe(2);
		expect(second.lease.fencingToken).toBeGreaterThan(first.lease.fencingToken);
	});
});

describe("TEST F — lease renewal", () => {
	it("renews expiry without changing the fencing token", async () => {
		await store.create(createDurableMissionRecord({ request: request("mission_renew"), now: 0 }));
		const coordinator = new DurableMissionCoordinator(store, new CountingExecutor(), {
			now: () => 1000,
			leaseDurationMs: 10_000,
			leaseIdFactory: () => "lease_r",
		});

		const acquired = await coordinator.acquireOwnership("mission_renew");
		expect(acquired.lease.expiresAtMs).toBe(11_000);

		const renewed = await coordinator.renewOwnership(
			"mission_renew",
			{ leaseId: acquired.lease.leaseId, fencingToken: acquired.lease.fencingToken },
			{ now: 5000 },
		);
		expect(renewed.lease.fencingToken).toBe(acquired.lease.fencingToken);
		expect(renewed.lease.renewedAtMs).toBe(5000);
		expect(renewed.lease.expiresAtMs).toBe(15_000);
	});
});

describe("TEST G — stale renewal", () => {
	it("an old owner cannot renew after a newer owner took over", async () => {
		await store.create(createDurableMissionRecord({ request: request("mission_stale_renew"), now: 0 }));

		const a = new DurableMissionCoordinator(store, new CountingExecutor(), {
			now: () => 1000,
			leaseDurationMs: 1000,
			leaseIdFactory: () => "lease_a",
		});
		const first = await a.acquireOwnership("mission_stale_renew");
		expect(first.lease.fencingToken).toBe(1);

		// B takes over after A's lease expired + recovery reconciled it.
		await new DurableMissionCoordinator(store, new CountingExecutor(), { now: () => 2500 }).recover();
		const b = new DurableMissionCoordinator(store, new CountingExecutor(), {
			now: () => 3000,
			leaseDurationMs: 1000,
			leaseIdFactory: () => "lease_b",
		});
		const second = await b.acquireOwnership("mission_stale_renew");
		expect(second.lease.fencingToken).toBe(3);
		expect(second.lease.fencingToken).toBeGreaterThan(first.lease.fencingToken);

		await expect(
			a.renewOwnership(
				"mission_stale_renew",
				{ leaseId: first.lease.leaseId, fencingToken: first.lease.fencingToken },
				{ now: 3000 },
			),
		).rejects.toMatchObject({ code: "STALE_EXECUTION_OWNER" });
	});
});

describe("TEST H — lease expiry", () => {
	it("an expired lease no longer authorizes renewal and recovery takes over", async () => {
		await store.create(createDurableMissionRecord({ request: request("mission_expiry"), now: 0 }));
		const a = new DurableMissionCoordinator(store, new CountingExecutor(), {
			now: () => 1000,
			leaseDurationMs: 1000,
			leaseIdFactory: () => "lease_a",
		});
		const acquired = await a.acquireOwnership("mission_expiry");

		await expect(
			a.renewOwnership(
				"mission_expiry",
				{ leaseId: acquired.lease.leaseId, fencingToken: acquired.lease.fencingToken },
				{ now: 2500 },
			),
		).rejects.toMatchObject({ code: "LEASE_EXPIRED" });

		const report = await new DurableMissionCoordinator(store, new CountingExecutor(), { now: () => 3000 }).recover();
		expect(report.reconciled).toEqual(["mission_expiry"]);
		const record = await a.getMission("mission_expiry");
		expect(record?.state).toBe("INTERRUPTED");
		expect(record?.lease).toBeUndefined();
	});
});

describe("TEST I/J — conservative recovery and explicit reacquire", () => {
	it("recovery revokes only the expired lease, never auto-runs, and resume acquires a new epoch", async () => {
		const executor = new CountingExecutor();
		const coordinator = new DurableMissionCoordinator(store, executor, {
			now: () => 1000,
			leaseDurationMs: 1000,
			leaseIdFactory: () => "lease_a",
		});
		await coordinator.createMission(request("mission_recover"));
		const acquired = await coordinator.acquireOwnership("mission_recover");
		expect(acquired.lease.fencingToken).toBe(1);

		const report = await new DurableMissionCoordinator(store, new CountingExecutor(), { now: () => 3000 }).recover();
		expect(report.reconciled).toEqual(["mission_recover"]);
		expect(executor.launchCount).toBe(0);

		const interrupted = await coordinator.getMission("mission_recover");
		expect(interrupted?.state).toBe("INTERRUPTED");
		expect(interrupted?.fencingToken).toBe(2);

		// Re-acquire through an explicit resume with a fresh clock.
		const resumed = await new DurableMissionCoordinator(store, executor, {
			now: () => 4000,
			leaseDurationMs: 10_000,
			leaseIdFactory: () => "lease_b",
		}).resume("mission_recover");
		expect(resumed.state).toBe("SUCCEEDED");
		expect(resumed.fencingToken).toBeGreaterThanOrEqual(3);
		expect(resumed.attempts).toHaveLength(1);
	});
});

describe("TEST D/E/N — stale owner and terminal result rejection", () => {
	it("a stale owner cannot mutate state, including a terminal result", async () => {
		const req = request("mission_terminal_fence");
		// Current owner B holds fence 2.
		await store.create(runningWithLease(req, leaseOf("owner_b", "lease_b", 2, 5000, 60_000), 5000));

		const record = await store.load("mission_terminal_fence");
		expect(record.status).toBe("ok");
		if (record.status !== "ok") return;

		// Old owner A (fence 1) attempts a SUCCEEDED terminal write.
		const atMs = record.record.updatedAtMs + 1;
		const result = createMissionResult({
			missionId: req.missionId,
			parentMissionId: req.parentMissionId,
			depth: req.depth,
			state: "SUCCEEDED",
			executionOutcome: "COMPLETED",
			verification: { status: "verified" },
			completionDecision: "accepted",
			failures: [],
			executorDiagnostics: { executorId: "stale", processExitCode: 0 },
			startedAtMs: record.record.startedAtMs ?? atMs,
			finishedAtMs: atMs,
		});
		const staleTerminal: DurableMissionRecord = {
			...record.record,
			state: "SUCCEEDED",
			result,
			resultExecutionId: "exec_stale",
			finishedAtMs: atMs,
			currentAttemptId: undefined,
			currentExecutionId: undefined,
			lease: undefined,
			updatedAtMs: atMs,
			transitions: [
				...record.record.transitions,
				{
					seq: record.record.transitions.length,
					from: "RUNNING",
					to: "SUCCEEDED" as const,
					atMs,
					executionId: "exec_stale",
				},
			],
			revision: record.record.revision + 1,
		};

		const saved = await store.save(staleTerminal, {
			expectedRevision: record.record.revision,
			leaseProof: { leaseId: "lease_a", fencingToken: 1 },
		});
		expect(saved).toMatchObject({ status: "stale_owner", fencingToken: 2 });

		// Canonical state is unchanged: still RUNNING, still owned by B.
		const after = await store.load("mission_terminal_fence");
		expect(after.status).toBe("ok");
		if (after.status === "ok") {
			expect(after.record.state).toBe("RUNNING");
			expect(after.record.result).toBeUndefined();
			expect(after.record.lease?.fencingToken).toBe(2);
		}
	});

	it("a fenced old owner cannot overwrite a CANCELLED terminal mission with success", async () => {
		const req = request("mission_cancel_fence");
		const cancelled: DurableMissionRecord = {
			...createDurableMissionRecord({ request: req, now: 1 }),
			state: "CANCELLED",
			updatedAtMs: 10,
			finishedAtMs: 10,
			result: createMissionResult({
				missionId: req.missionId,
				depth: 0,
				state: "CANCELLED",
				executionOutcome: "CANCELLED",
				verification: { status: "unverified" },
				completionDecision: "unavailable",
				failures: [{ category: "CANCELLED", message: "cancelled" }],
				executorDiagnostics: { executorId: "test", signal: "SIGTERM" },
				startedAtMs: 1,
				finishedAtMs: 10,
			}),
			resultExecutionId: "exec_cancel",
			transitions: [{ seq: 0, from: "RUNNING", to: "CANCELLED", atMs: 10, executionId: "exec_cancel" }],
			attempts: [
				{
					attemptId: "attempt_c",
					executionId: "exec_cancel",
					startedAtMs: 1,
					finishedAtMs: 10,
					endReason: "CANCELLED",
				},
			],
			fencingToken: 1,
			revision: 3,
		};
		await store.create(cancelled);

		const loaded = await store.load("mission_cancel_fence");
		if (loaded.status !== "ok") return;
		const staleSuccess: DurableMissionRecord = {
			...loaded.record,
			state: "SUCCEEDED",
		};
		const saved = await store.save(staleSuccess, {
			expectedRevision: loaded.record.revision,
			leaseProof: { leaseId: "lease_dead", fencingToken: 1 },
		});
		expect(saved.status).toBe("lease_not_found");

		const after = await store.load("mission_cancel_fence");
		if (after.status === "ok") expect(after.record.state).toBe("CANCELLED");
	});
});

describe("TEST O — terminal mission cannot reacquire", () => {
	it("SUCCEEDED mission rejects lease acquisition", async () => {
		const executor = new CountingExecutor();
		const coordinator = new DurableMissionCoordinator(store, executor, { now: () => 1000, leaseDurationMs: 10_000 });
		await coordinator.createMission(request("mission_terminal_no_reacquire"));
		await coordinator.resume("mission_terminal_no_reacquire");

		await expect(coordinator.acquireOwnership("mission_terminal_no_reacquire")).rejects.toThrow(/terminal mission/u);
	});
});

describe("TEST S — corrupt lease fails closed", () => {
	it("a mismatched or malformed lease never grants ownership", async () => {
		const req = request("mission_corrupt_lease");
		const base = createDurableMissionRecord({ request: req, now: 1 });
		// lease.fencingToken != record.fencingToken → corrupt.
		const bad = {
			...base,
			fencingToken: 3,
			lease: leaseOf("owner_x", "lease_x", 1, 1, 1000),
		};
		await store.save(bad);
		const loaded = await store.load("mission_corrupt_lease");
		expect(loaded.status).toBe("corrupt");
	});
});

describe("TEST T — process restart preserves fence/lease", () => {
	it("reopening the store keeps the fencing token and lease", async () => {
		await store.create(createDurableMissionRecord({ request: request("mission_restart"), now: 0 }));
		const coordinator = new DurableMissionCoordinator(store, new CountingExecutor(), {
			now: () => 1000,
			leaseDurationMs: 10_000,
			leaseIdFactory: () => "lease_restart",
		});
		const acquired = await coordinator.acquireOwnership("mission_restart");
		expect(acquired.lease.fencingToken).toBe(1);

		const reopened = new FileDurableMissionStore({ root });
		const loaded = await reopened.load("mission_restart");
		expect(loaded.status).toBe("ok");
		if (loaded.status === "ok") {
			expect(loaded.record.fencingToken).toBe(1);
			expect(loaded.record.lease?.leaseId).toBe("lease_restart");
			expect(loaded.record.lease?.fencingToken).toBe(1);
		}
	});
});

describe("TEST L/M — durable child session identity and attempt history with fencing", () => {
	it("winning resume preserves childMissionId + childSessionId and allocates a new attempt/execution with a new fence", async () => {
		const childSessionId = newChildSessionId();
		const req = request("mission_child_owned", { missionId: "mission_root", depth: 0 }, childSessionId);
		const now = Date.now();
		const running: DurableMissionRecord = {
			schemaVersion: 1,
			missionId: req.missionId,
			parentMissionId: req.parentMissionId,
			depth: req.depth,
			request: req,
			state: "RUNNING",
			currentAttemptId: "attempt_first",
			currentExecutionId: "exec_first",
			createdAtMs: req.createdAtMs,
			updatedAtMs: now,
			startedAtMs: now - 1000,
			transitions: [
				{ seq: 0, from: "CREATED", to: "QUEUED", atMs: now - 1000 },
				{ seq: 1, from: "QUEUED", to: "LAUNCHING", atMs: now - 1000, attemptId: "attempt_first" },
				{ seq: 2, from: "LAUNCHING", to: "RUNNING", atMs: now - 1000, executionId: "exec_first" },
			],
			attempts: [{ attemptId: "attempt_first", executionId: "exec_first", startedAtMs: now - 1000 }],
			fencingToken: 0,
			revision: 3,
		};
		await store.create(running);

		const delegator = new DurableMissionDelegator({ store });
		await delegator.recover({ now: now + 500 });

		const executor = new CountingExecutor();
		const outcome = await delegator.resumeMission("mission_child_owned", executor);

		expect(outcome.missionId).toBe("mission_child_owned");
		expect(outcome.record.request.childSessionId).toBe(childSessionId);
		expect(outcome.attemptId).not.toBe("attempt_first");
		expect(outcome.executionId).not.toBe("exec_first");
		expect(outcome.fencingToken).toBeGreaterThanOrEqual(1);
		expect(outcome.record.attempts).toHaveLength(2);
		expect(outcome.record.attempts[0].attemptId).toBe("attempt_first");
		expect(outcome.record.attempts[0].endReason).toBe("INTERRUPTED");
		expect(outcome.record.attempts[1].attemptId).toBe(outcome.attemptId);
	});
});

describe("error model", () => {
	it("exposes structured ownership error codes without string matching", async () => {
		await store.create(createDurableMissionRecord({ request: request("mission_owned_err"), now: 0 }));
		const a = new DurableMissionCoordinator(store, new CountingExecutor(), {
			now: () => 1000,
			leaseDurationMs: 60_000,
		});
		await a.acquireOwnership("mission_owned_err");

		const b = new DurableMissionCoordinator(store, new CountingExecutor(), {
			now: () => 1100,
			leaseDurationMs: 60_000,
		});
		const error = await b.acquireOwnership("mission_owned_err").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ExecutionOwnershipError);
		expect((error as ExecutionOwnershipError).code).toBe("MISSION_OWNED");
	});
});
