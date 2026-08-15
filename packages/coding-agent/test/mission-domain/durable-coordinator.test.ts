/**
 * Durable Mission Coordinator tests (2.4.0).
 *
 * TEST B — authoritative transition history
 * TEST C — running restart reconciliation
 * TEST D — resume creates new execution attempt
 * TEST J — no automatic re-execution
 * TEST K — explicit resume
 * TEST M — subagent durable integration
 * TEST N — reliability authority
 * LAUNCH-GAP-1/2/3 — crash after launch before RUNNING persistence
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createDurableMissionRecord,
	createMissionHandle,
	createMissionRequest,
	createMissionResult,
	DurableMissionCoordinator,
	type DurableMissionMutateResult,
	type DurableMissionMutation,
	type DurableMissionRecord,
	type DurableMissionSaveOptions,
	type DurableMissionSaveResult,
	type DurableMissionStore,
	type MissionExecutionOutcome,
	type MissionExecutor,
	type MissionHandle,
	type MissionRequest,
	type MissionResult,
	type MissionState,
} from "../../src/core/mission-domain/index.js";
import { FileDurableMissionStore } from "../../src/core/mission-durable/index.js";

interface PlannedOutcome {
	state: MissionState;
	executionOutcome: MissionExecutionOutcome;
}

class CountingExecutor implements MissionExecutor {
	readonly executorId = "test";
	launchCount = 0;
	outcomes: PlannedOutcome[] = [];
	private next = 0;

	async launch(request: MissionRequest): Promise<MissionHandle> {
		this.launchCount += 1;
		const executionId = `exec_test_${this.launchCount}`;
		return createMissionHandle({
			missionId: request.missionId,
			parentMissionId: request.parentMissionId,
			depth: request.depth,
			executionId,
			state: "RUNNING",
			createdAtMs: request.createdAtMs,
			startedAtMs: Date.now(),
			cancel: async () => undefined,
		});
	}

	async awaitResult(handle: MissionHandle): Promise<MissionResult> {
		const outcome = this.outcomes[this.next++] ?? { state: "PARTIAL", executionOutcome: "COMPLETED" };
		return createMissionResult({
			missionId: handle.missionId,
			parentMissionId: handle.parentMissionId,
			depth: handle.depth,
			state: outcome.state,
			executionOutcome: outcome.executionOutcome,
			verification: { status: outcome.state === "SUCCEEDED" ? "verified" : "unverified" },
			completionDecision: outcome.state === "SUCCEEDED" ? "accepted" : "unavailable",
			failures: [],
			executorDiagnostics: {
				executorId: this.executorId,
				processExitCode: outcome.executionOutcome === "COMPLETED" ? 0 : 1,
			},
			startedAtMs: handle.startedAtMs ?? Date.now(),
			finishedAtMs: Date.now(),
		});
	}

	async cancel(): Promise<void> {}
}

function makeRoot(): string {
	return mkdtempSync(path.join(tmpdir(), "durable-coordinator-"));
}

function request(missionId: string, parent?: { missionId: string; depth: number }): MissionRequest {
	return createMissionRequest({
		missionId,
		parent,
		objective: `objective of ${missionId}`,
		agent: "worker",
		executionMode: "execute",
		acceptanceCriteria: [],
	});
}

function runningRecord(request: MissionRequest, executionId: string, now: number): DurableMissionRecord {
	return {
		schemaVersion: 1,
		missionId: request.missionId,
		parentMissionId: request.parentMissionId,
		depth: request.depth,
		request,
		state: "RUNNING",
		currentAttemptId: "attempt_E1",
		currentExecutionId: executionId,
		createdAtMs: request.createdAtMs,
		updatedAtMs: now,
		startedAtMs: now,
		transitions: [
			{ seq: 0, from: "CREATED", to: "QUEUED", atMs: now },
			{ seq: 1, from: "QUEUED", to: "LAUNCHING", atMs: now, attemptId: "attempt_E1" },
			{ seq: 2, from: "LAUNCHING", to: "RUNNING", atMs: now, executionId },
		],
		attempts: [{ attemptId: "attempt_E1", executionId, startedAtMs: now }],
		fencingToken: 0,
		revision: 4,
	};
}

let root: string;

beforeEach(() => {
	root = makeRoot();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("TEST B — authoritative transition history", () => {
	it("B1 persists CREATED → QUEUED → RUNNING → SUCCEEDED and reopens in order", async () => {
		const executor = new CountingExecutor();
		executor.outcomes.push({ state: "SUCCEEDED", executionOutcome: "COMPLETED" });
		const coordinator = new DurableMissionCoordinator(new FileDurableMissionStore({ root }), executor);

		await coordinator.createMission(request("mission_b"));
		const final = await coordinator.resume("mission_b");

		const expected = ["CREATED->QUEUED", "QUEUED->LAUNCHING", "LAUNCHING->RUNNING", "RUNNING->SUCCEEDED"];
		expect(final.transitions.map((t) => `${t.from}->${t.to}`)).toEqual(expected);
		expect(final.transitions.map((t) => t.seq)).toEqual([0, 1, 2, 3]);

		// Reopen over the same root: the exact ordered history survives.
		const reopened = new DurableMissionCoordinator(new FileDurableMissionStore({ root }), new CountingExecutor());
		const record = await reopened.getMission("mission_b");
		expect(record?.transitions.map((t) => `${t.from}->${t.to}`)).toEqual(expected);
	});
});

describe("TEST C + J — running restart reconciliation without re-execution", () => {
	it("C1 persisted RUNNING is not trusted after restart; it becomes INTERRUPTED", async () => {
		const store = new FileDurableMissionStore({ root });
		await store.create(runningRecord(request("mission_c"), "exec_E1", 1000));

		const executor = new CountingExecutor();
		const coordinator = new DurableMissionCoordinator(new FileDurableMissionStore({ root }), executor, {
			now: () => 2000,
		});
		const report = await coordinator.recover();

		expect(report.reconciled).toEqual(["mission_c"]);
		const record = await coordinator.getMission("mission_c");
		expect(record?.missionId).toBe("mission_c");
		expect(record?.state).toBe("INTERRUPTED");
		expect(record?.currentAttemptId).toBeUndefined();
		expect(record?.currentExecutionId).toBeUndefined();
		expect(record?.attempts).toHaveLength(1);
		expect(record?.attempts[0].attemptId).toBe("attempt_E1");
		expect(record?.attempts[0].executionId).toBe("exec_E1");
		expect(record?.attempts[0].endReason).toBe("INTERRUPTED");
		expect(record?.attempts[0].recovery?.reason).toMatch(/control_plane_restart/u);

		// J: no executor launch occurred merely from recovery.
		expect(executor.launchCount).toBe(0);
	});

	it("J1 CREATED and terminal missions are untouched by recovery", async () => {
		const store = new FileDurableMissionStore({ root });
		await store.create(createDurableMissionRecord({ request: request("mission_created"), now: 1 }));
		const terminal: DurableMissionRecord = {
			...createDurableMissionRecord({ request: request("mission_done"), now: 1 }),
			state: "SUCCEEDED",
			result: createMissionResult({
				missionId: "mission_done",
				depth: 0,
				state: "SUCCEEDED",
				executionOutcome: "COMPLETED",
				verification: { status: "verified" },
				completionDecision: "accepted",
				failures: [],
				executorDiagnostics: { executorId: "test", processExitCode: 0 },
				startedAtMs: 1,
				finishedAtMs: 2,
			}),
			resultExecutionId: "exec_done",
			transitions: [{ seq: 0, from: "RUNNING", to: "SUCCEEDED", atMs: 2, executionId: "exec_done" }],
			attempts: [
				{
					attemptId: "attempt_done",
					executionId: "exec_done",
					startedAtMs: 1,
					finishedAtMs: 2,
					endReason: "COMPLETED",
				},
			],
			revision: 3,
		};
		await store.create(terminal);

		const executor = new CountingExecutor();
		const coordinator = new DurableMissionCoordinator(new FileDurableMissionStore({ root }), executor, {
			now: () => 2000,
		});
		const report = await coordinator.recover();
		expect(report.reconciled).toEqual([]);
		expect(report.unchanged.sort()).toEqual(["mission_created", "mission_done"]);
		expect(executor.launchCount).toBe(0);

		expect((await coordinator.getMission("mission_created"))?.state).toBe("CREATED");
		expect((await coordinator.getMission("mission_done"))?.state).toBe("SUCCEEDED");
	});
});

describe("TEST D — resume creates a new execution attempt", () => {
	it("D1 same missionId, new executionId, prior attempt preserved", async () => {
		const store = new FileDurableMissionStore({ root });
		await store.create(runningRecord(request("mission_d"), "exec_E1", 1000));

		const executor = new CountingExecutor();
		executor.outcomes.push({ state: "PARTIAL", executionOutcome: "COMPLETED" });
		const coordinator = new DurableMissionCoordinator(new FileDurableMissionStore({ root }), executor, {
			now: () => 2000,
		});
		await coordinator.recover();

		const resumed = await coordinator.resume("mission_d");
		expect(resumed.missionId).toBe("mission_d");
		expect(resumed.parentMissionId).toBeUndefined();
		expect(resumed.depth).toBe(0);
		expect(resumed.attempts).toHaveLength(2);
		expect(resumed.attempts[0].attemptId).toBe("attempt_E1");
		expect(resumed.attempts[0].executionId).toBe("exec_E1");
		expect(resumed.attempts[0].endReason).toBe("INTERRUPTED");
		expect(resumed.attempts[1].attemptId).not.toBe("attempt_E1");
		expect(resumed.attempts[1].executionId).not.toBe("exec_E1");
		expect(resumed.resultExecutionId).toBe(resumed.attempts[1].executionId);
		expect(resumed.state).toBe("PARTIAL");
		expect(resumed.transitions.map((t) => t.to)).toContain("INTERRUPTED");
		expect(resumed.transitions.map((t) => t.to)).toContain("QUEUED");
		expect(resumed.transitions.map((t) => t.to)).toContain("LAUNCHING");
	});
});

describe("TEST K — explicit resume", () => {
	it("K1 resume launches exactly once and persists transitions and result", async () => {
		const executor = new CountingExecutor();
		executor.outcomes.push({ state: "SUCCEEDED", executionOutcome: "COMPLETED" });
		const coordinator = new DurableMissionCoordinator(new FileDurableMissionStore({ root }), executor);

		await coordinator.createMission(request("mission_k"));
		await coordinator.resume("mission_k");

		expect(executor.launchCount).toBe(1);
		const record = await coordinator.getMission("mission_k");
		expect(record?.state).toBe("SUCCEEDED");
		expect(record?.result?.missionId).toBe("mission_k");
		expect(record?.result?.state).toBe("SUCCEEDED");
		expect(record?.attempts).toHaveLength(1);
		expect(record?.attempts[0].attemptId).toBeDefined();
		expect(record?.attempts[0].executionId).toBeDefined();
		expect(record?.currentAttemptId).toBeUndefined();
		expect(record?.currentExecutionId).toBeUndefined();
	});

	it("K2 resume of a terminal mission is rejected structurally", async () => {
		const executor = new CountingExecutor();
		executor.outcomes.push({ state: "SUCCEEDED", executionOutcome: "COMPLETED" });
		const coordinator = new DurableMissionCoordinator(new FileDurableMissionStore({ root }), executor);
		await coordinator.createMission(request("mission_k_terminal"));
		await coordinator.resume("mission_k_terminal");

		await expect(coordinator.resume("mission_k_terminal")).rejects.toThrow(/terminal mission/u);
		expect(executor.launchCount).toBe(1);
	});
});

describe("TEST M — subagent durable integration", () => {
	it("M1 a child mission persists identity and a structured result without prose reparsing", async () => {
		const executor = new CountingExecutor();
		executor.outcomes.push({ state: "SUCCEEDED", executionOutcome: "COMPLETED" });
		const coordinator = new DurableMissionCoordinator(new FileDurableMissionStore({ root }), executor);

		const child = request("mission_child", { missionId: "mission_root_parent", depth: 0 });
		await coordinator.createMission(child);

		// Child record exists before execution.
		const before = await coordinator.getMission("mission_child");
		expect(before?.state).toBe("CREATED");
		expect(before?.parentMissionId).toBe("mission_root_parent");
		expect(before?.depth).toBe(1);

		await coordinator.resume("mission_child");

		const after = await coordinator.getMission("mission_child");
		expect(after?.parentMissionId).toBe("mission_root_parent");
		expect(after?.depth).toBe(1);
		expect(after?.state).toBe("SUCCEEDED");
		expect(after?.result?.missionId).toBe("mission_child");
		expect(after?.result?.state).toBe("SUCCEEDED");
	});
});

describe("TEST N — reliability authority", () => {
	it("N1 verified SUCCEEDED round-trips; unverified PARTIAL never becomes SUCCEEDED", async () => {
		const verified = new CountingExecutor();
		verified.outcomes.push({ state: "SUCCEEDED", executionOutcome: "COMPLETED" });
		const verifiedCoordinator = new DurableMissionCoordinator(new FileDurableMissionStore({ root }), verified);
		await verifiedCoordinator.createMission(request("mission_n_verified"));
		await verifiedCoordinator.resume("mission_n_verified");
		const verifiedRecord = await verifiedCoordinator.getMission("mission_n_verified");
		expect(verifiedRecord?.state).toBe("SUCCEEDED");
		expect(verifiedRecord?.result?.verification.status).toBe("verified");
		expect(verifiedRecord?.result?.completionDecision).toBe("accepted");

		const partial = new CountingExecutor();
		partial.outcomes.push({ state: "PARTIAL", executionOutcome: "COMPLETED" });
		const partialCoordinator = new DurableMissionCoordinator(new FileDurableMissionStore({ root }), partial);
		await partialCoordinator.createMission(request("mission_n_partial"));
		await partialCoordinator.resume("mission_n_partial");
		const partialRecord = await partialCoordinator.getMission("mission_n_partial");
		expect(partialRecord?.state).toBe("PARTIAL");
		expect(partialRecord?.result?.success).toBe(false);

		// Reopen: a normal shutdown / presence of output never upgrades PARTIAL.
		const reopened = new DurableMissionCoordinator(new FileDurableMissionStore({ root }), new CountingExecutor());
		const reloaded = await reopened.getMission("mission_n_partial");
		expect(reloaded?.state).toBe("PARTIAL");
		expect(reloaded?.result?.success).toBe(false);
	});
});

/**
 * Failure injection: a store that delegates everything to a real file store but
 * throws when the RUNNING record is about to be persisted. This deterministically
 * simulates "the executor actually launched, then Jensen crashed before the
 * RUNNING/executionId/attempt ownership was durably written."
 */
class CrashAfterLaunchStore implements DurableMissionStore {
	readonly storeId = "crash-after-launch";
	constructor(private readonly inner: FileDurableMissionStore) {}

	create(record: DurableMissionRecord) {
		return this.inner.create(record);
	}

	load(missionId: string) {
		return this.inner.load(missionId);
	}

	async save(record: DurableMissionRecord, options?: DurableMissionSaveOptions): Promise<DurableMissionSaveResult> {
		if (record.state === "RUNNING") {
			throw new Error("simulated crash after launch, before RUNNING persistence");
		}
		return this.inner.save(record, options);
	}

	mutate<T>(
		missionId: string,
		mutation: (current: DurableMissionRecord) => DurableMissionMutation<T>,
	): Promise<DurableMissionMutateResult<T>> {
		return this.inner.mutate(missionId, mutation);
	}

	listMissions() {
		return this.inner.listMissions();
	}

	listNonterminalMissions() {
		return this.inner.listNonterminalMissions();
	}

	listChildren(parentMissionId: string) {
		return this.inner.listChildren(parentMissionId);
	}
}

/** Leave a mission durably in LAUNCHING state after a simulated launch crash. */
async function leaveUncertainLaunch(root: string): Promise<void> {
	const inner = new FileDurableMissionStore({ root });
	const executor = new CountingExecutor();
	const coordinator = new DurableMissionCoordinator(new CrashAfterLaunchStore(inner), executor, {
		now: () => 2000,
		attemptIdFactory: () => "attempt_uncertain",
		leaseDurationMs: 500,
	});
	await coordinator.createMission(request("mission_launch_gap"));
	await expect(coordinator.resume("mission_launch_gap")).rejects.toThrow(/simulated crash/u);
	expect(executor.launchCount).toBe(1);
}

describe("LAUNCH-GAP — crash after launch, before RUNNING persistence", () => {
	it("LAUNCH-GAP-1 the durable record keeps the attempt intent even though RUNNING was never persisted", async () => {
		await leaveUncertainLaunch(root);

		const reopened = new FileDurableMissionStore({ root });
		const loaded = await reopened.load("mission_launch_gap");
		expect(loaded.status).toBe("ok");
		if (loaded.status !== "ok") return;

		expect(loaded.record.state).toBe("LAUNCHING");
		expect(loaded.record.currentAttemptId).toBe("attempt_uncertain");
		expect(loaded.record.currentExecutionId).toBeUndefined();
		expect(loaded.record.result).toBeUndefined();
		expect(loaded.record.attempts).toHaveLength(1);
		expect(loaded.record.attempts[0].attemptId).toBe("attempt_uncertain");
		expect(loaded.record.attempts[0].executionId).toBeUndefined();
	});

	it("LAUNCH-GAP-2 restart recovery marks the uncertain launch INTERRUPTED without re-running", async () => {
		await leaveUncertainLaunch(root);

		const fresh = new CountingExecutor();
		const coordinator = new DurableMissionCoordinator(new FileDurableMissionStore({ root }), fresh, {
			now: () => 3000,
		});
		const report = await coordinator.recover();

		expect(report.reconciled).toEqual(["mission_launch_gap"]);
		expect(fresh.launchCount).toBe(0);

		const record = await coordinator.getMission("mission_launch_gap");
		expect(record?.state).toBe("INTERRUPTED");
		expect(record?.result).toBeUndefined();
		expect(record?.currentAttemptId).toBeUndefined();
		expect(record?.attempts).toHaveLength(1);
		expect(record?.attempts[0].attemptId).toBe("attempt_uncertain");
		expect(record?.attempts[0].endReason).toBe("INTERRUPTED");
		expect(record?.attempts[0].recovery?.reason).toMatch(/launch initiated but runtime ownership never confirmed/u);
	});

	it("LAUNCH-GAP-3 explicit resume preserves missionId, starts a new attempt, keeps the uncertain attempt", async () => {
		await leaveUncertainLaunch(root);

		const fresh = new CountingExecutor();
		fresh.outcomes.push({ state: "PARTIAL", executionOutcome: "COMPLETED" });
		const coordinator = new DurableMissionCoordinator(new FileDurableMissionStore({ root }), fresh, {
			now: () => 3000,
			attemptIdFactory: () => "attempt_resume",
		});
		await coordinator.recover();

		const resumed = await coordinator.resume("mission_launch_gap");
		expect(resumed.missionId).toBe("mission_launch_gap");
		expect(resumed.attempts).toHaveLength(2);
		expect(resumed.attempts[0].attemptId).toBe("attempt_uncertain");
		expect(resumed.attempts[0].executionId).toBeUndefined();
		expect(resumed.attempts[0].endReason).toBe("INTERRUPTED");
		expect(resumed.attempts[1].attemptId).toBe("attempt_resume");
		expect(resumed.attempts[1].executionId).toBe("exec_test_1");
		expect(resumed.attempts[1].attemptId).not.toBe(resumed.attempts[0].attemptId);
	});
});
