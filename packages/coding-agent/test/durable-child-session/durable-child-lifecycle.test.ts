/**
 * Durable Child AgentSession Restore — lifecycle tests (2.6.0).
 *
 * Coordinator-level: interruption semantics, explicit resume with a NEW
 * attempt/execution while preserving mission/session identity, attempt history,
 * double-resume exclusivity, parent restart discoverability, and parallel /
 * recursive child structure.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DurableMissionDelegator } from "../../src/core/durable-delegation/index.js";
import {
	createMissionHandle,
	createMissionRequest,
	createMissionResult,
	DurableMissionCoordinator,
	type DurableMissionRecord,
	type MissionExecutor,
	type MissionHandle,
	type MissionRequest,
	type MissionResult,
	type MissionState,
	newChildSessionId,
} from "../../src/core/mission-domain/index.js";
import { FileDurableMissionStore } from "../../src/core/mission-durable/index.js";

interface PlannedOutcome {
	state: MissionState;
}

class CountingExecutor implements MissionExecutor {
	readonly executorId = "test-child";
	launchCount = 0;
	outcomes: PlannedOutcome[] = [];
	private next = 0;

	async launch(request: MissionRequest): Promise<MissionHandle> {
		this.launchCount += 1;
		return createMissionHandle({
			missionId: request.missionId,
			parentMissionId: request.parentMissionId,
			depth: request.depth,
			executionId: `exec_child_${this.launchCount}`,
			state: "RUNNING",
			createdAtMs: request.createdAtMs,
			startedAtMs: Date.now(),
			cancel: async () => undefined,
		});
	}

	async awaitResult(handle: MissionHandle): Promise<MissionResult> {
		const outcome = this.outcomes[this.next++] ?? { state: "SUCCEEDED" };
		return createMissionResult({
			missionId: handle.missionId,
			parentMissionId: handle.parentMissionId,
			depth: handle.depth,
			state: outcome.state,
			executionOutcome: outcome.state === "SUCCEEDED" ? "COMPLETED" : "FAILED",
			verification: { status: outcome.state === "SUCCEEDED" ? "verified" : "unverified" },
			completionDecision: outcome.state === "SUCCEEDED" ? "accepted" : "rejected",
			failures: [],
			executorDiagnostics: {
				executorId: this.executorId,
				processExitCode: outcome.state === "SUCCEEDED" ? 0 : 1,
			},
			startedAtMs: handle.startedAtMs ?? Date.now(),
			finishedAtMs: Date.now(),
		});
	}

	async cancel(): Promise<void> {}
}

function makeDir(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

function childRequest(
	missionId: string,
	childSessionId: string,
	parent?: { missionId: string; depth: number },
): MissionRequest {
	return createMissionRequest({
		missionId,
		parent,
		objective: `objective of ${missionId}`,
		agent: "worker",
		executionMode: "execute",
		acceptanceCriteria: [],
		childSessionId,
		constraints: ["constraint-A", "constraint-B"],
	});
}

/** Build a durable INTERRUPTED child record through the real recover() path. */
async function interruptMission(
	store: FileDurableMissionStore,
	missionId: string,
	childSessionId: string,
): Promise<void> {
	// Persist a RUNNING record with confirmed ownership.
	const request = childRequest(missionId, childSessionId);
	const now = Date.now();
	const running: DurableMissionRecord = {
		schemaVersion: 1,
		missionId,
		parentMissionId: request.parentMissionId,
		depth: request.depth,
		request,
		state: "RUNNING",
		currentAttemptId: "attempt_first",
		currentExecutionId: "exec_first",
		createdAtMs: request.createdAtMs,
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

	const executor = new CountingExecutor();
	const coordinator = new DurableMissionCoordinator(store, executor, { now: () => now + 500 });
	const report = await coordinator.recover();
	expect(report.reconciled).toEqual([missionId]);
	expect(executor.launchCount).toBe(0);
}

describe("durable child lifecycle", () => {
	let root: string;
	let store: FileDurableMissionStore;

	beforeEach(() => {
		root = makeDir("child-lifecycle-");
		store = new FileDurableMissionStore({ root });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("TEST F — interruption marks RUNNING → INTERRUPTED with no automatic rerun", async () => {
		await interruptMission(store, "mission_f", newChildSessionId());
		const record = await store.load("mission_f");
		expect(record.status).toBe("ok");
		if (record.status !== "ok") return;
		expect(record.record.state).toBe("INTERRUPTED");
		expect(record.record.currentAttemptId).toBeUndefined();
		expect(record.record.currentExecutionId).toBeUndefined();
		expect(record.record.attempts[0].attemptId).toBe("attempt_first");
		expect(record.record.attempts[0].endReason).toBe("INTERRUPTED");
	});

	it("TEST I/P/Q — resume restores same mission/session with a NEW attempt and persists one canonical result", async () => {
		const childSessionId = newChildSessionId();
		await interruptMission(store, "mission_ipq", childSessionId);

		const delegator = new DurableMissionDelegator({ store });
		const executor = new CountingExecutor();
		executor.outcomes.push({ state: "SUCCEEDED" });

		const outcome = await delegator.resumeMission("mission_ipq", executor);

		expect(outcome.missionId).toBe("mission_ipq");
		expect(outcome.record.request.childSessionId).toBe(childSessionId);
		expect(outcome.attemptId).toBeDefined();
		expect(outcome.attemptId).not.toBe("attempt_first");
		expect(outcome.executionId).toBeDefined();
		expect(outcome.executionId).not.toBe("exec_first");

		const record = outcome.record;
		expect(record.state).toBe("SUCCEEDED");
		expect(record.result).toBeDefined();
		expect(record.result?.missionId).toBe("mission_ipq");
		expect(record.resultExecutionId).toBe(outcome.executionId);
		expect(record.currentAttemptId).toBeUndefined();
		expect(record.currentExecutionId).toBeUndefined();
		expect(record.attempts).toHaveLength(2);
		expect(record.attempts[0].attemptId).toBe("attempt_first");
		expect(record.attempts[0].endReason).toBe("INTERRUPTED");
		expect(record.attempts[1].attemptId).toBe(outcome.attemptId);
		expect(record.attempts[1].executionId).toBe(outcome.executionId);
		expect(record.attempts[1].endReason).toBe("COMPLETED");
	});

	it("TEST R — concurrent resume attempts fail conservatively; only one wins", async () => {
		const childSessionId = newChildSessionId();
		await interruptMission(store, "mission_r", childSessionId);

		const a = new DurableMissionDelegator({ store });
		const b = new DurableMissionDelegator({ store });
		const execA = new CountingExecutor();
		const execB = new CountingExecutor();

		const results = await Promise.allSettled([
			a.resumeMission("mission_r", execA),
			b.resumeMission("mission_r", execB),
		]);

		const fulfilled = results.filter((r) => r.status === "fulfilled");
		const rejected = results.filter((r) => r.status === "rejected");
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect(execA.launchCount + execB.launchCount).toBe(1);
	});

	it("TEST S — parent restart does not erase child discoverability", async () => {
		const parentId = "mission_parent_s";
		const childSessionId = newChildSessionId();
		// Root parent (CREATED) + child (CREATED), both durable.
		await new DurableMissionDelegator({ store }).createChild(
			childRequest(parentId, newChildSessionId()),
			new CountingExecutor(),
		);
		await new DurableMissionDelegator({ store }).createChild(
			childRequest("mission_child_s", childSessionId, { missionId: parentId, depth: 0 }),
			new CountingExecutor(),
		);

		// Reopen a fresh store (simulated parent restart).
		const reopened = new FileDurableMissionStore({ root });
		const children = await reopened.listChildren(parentId);
		expect(children).toEqual(["mission_child_s"]);

		const child = await reopened.load("mission_child_s");
		expect(child.status).toBe("ok");
		if (child.status === "ok") {
			expect(child.record.request.childSessionId).toBe(childSessionId);
			expect(child.record.parentMissionId).toBe(parentId);
		}
	});

	it("TEST U — parallel children have unique isolated session identities", async () => {
		const parentId = "mission_parent_u";
		await new DurableMissionDelegator({ store }).createChild(
			childRequest(parentId, newChildSessionId()),
			new CountingExecutor(),
		);

		const sessions = new Set<string>();
		for (const name of ["child_a", "child_b", "child_c"]) {
			const sessionId = newChildSessionId();
			sessions.add(sessionId);
			await new DurableMissionDelegator({ store }).createChild(
				childRequest(name, sessionId, { missionId: parentId, depth: 0 }),
				new CountingExecutor(),
			);
		}

		const children = await store.listChildren(parentId);
		expect(children.sort()).toEqual(["child_a", "child_b", "child_c"]);

		const seen = new Set<string>();
		for (const id of children) {
			const loaded = await store.load(id);
			expect(loaded.status).toBe("ok");
			if (loaded.status === "ok") seen.add(loaded.record.request.childSessionId as string);
		}
		expect(seen).toEqual(sessions);
		expect(seen.size).toBe(3);
	});

	it("TEST V — recursive children A→B→C remain structurally correct", async () => {
		const a = newChildSessionId();
		const b = newChildSessionId();
		const c = newChildSessionId();
		const delegator = new DurableMissionDelegator({ store });

		await delegator.createChild(childRequest("mission_a", a), new CountingExecutor());
		await delegator.createChild(
			childRequest("mission_b", b, { missionId: "mission_a", depth: 0 }),
			new CountingExecutor(),
		);
		await delegator.createChild(
			childRequest("mission_c", c, { missionId: "mission_b", depth: 1 }),
			new CountingExecutor(),
		);

		expect(await store.listChildren("mission_a")).toEqual(["mission_b"]);
		expect(await store.listChildren("mission_b")).toEqual(["mission_c"]);

		const bRecord = await store.load("mission_b");
		const cRecord = await store.load("mission_c");
		expect(bRecord.status).toBe("ok");
		expect(cRecord.status).toBe("ok");
		if (bRecord.status === "ok" && cRecord.status === "ok") {
			expect(bRecord.record.depth).toBe(1);
			expect(bRecord.record.parentMissionId).toBe("mission_a");
			expect(bRecord.record.request.childSessionId).toBe(b);
			expect(cRecord.record.depth).toBe(2);
			expect(cRecord.record.parentMissionId).toBe("mission_b");
			expect(cRecord.record.request.childSessionId).toBe(c);
		}
	});

	it("TEST E — objective and constraints remain durable across interruption and resume", async () => {
		const childSessionId = newChildSessionId();
		const request = childRequest("mission_e", childSessionId);
		const delegator = new DurableMissionDelegator({ store });
		await delegator.createChild(request, new CountingExecutor());

		// Build the INTERRUPTED state via recover, then resume.
		const now = Date.now();
		const running: DurableMissionRecord = {
			schemaVersion: 1,
			missionId: "mission_e",
			parentMissionId: request.parentMissionId,
			depth: request.depth,
			request,
			state: "RUNNING",
			currentAttemptId: "attempt_e1",
			currentExecutionId: "exec_e1",
			createdAtMs: request.createdAtMs,
			updatedAtMs: now,
			startedAtMs: now - 10,
			transitions: [{ seq: 0, from: "CREATED", to: "RUNNING", atMs: now - 10, executionId: "exec_e1" }],
			attempts: [{ attemptId: "attempt_e1", executionId: "exec_e1", startedAtMs: now - 10 }],
			fencingToken: 0,
			revision: 3,
		};
		await store.create(running);
		await new DurableMissionCoordinator(store, new CountingExecutor(), { now: () => now + 5 }).recover();

		const executor = new CountingExecutor();
		executor.outcomes.push({ state: "SUCCEEDED" });
		const outcome = await delegator.resumeMission("mission_e", executor);

		expect(outcome.record.request.objective).toBe("objective of mission_e");
		expect(outcome.record.request.constraints).toEqual(["constraint-A", "constraint-B"]);
		expect(outcome.record.request.childSessionId).toBe(childSessionId);
	});
});
