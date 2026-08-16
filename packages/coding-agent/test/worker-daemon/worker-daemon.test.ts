/**
 * Worker Daemon Foundation — deterministic control-plane tests (2.13.0).
 *
 * Proves worker identity/incarnation, executor binding, assignment discovery,
 * exact-once claim, execution identity correlation, wrong-executor refusal,
 * verification gating, wait/park semantics, crash reconciliation, and
 * inference-independence using a deterministic clock and in-process stores.
 * Real OS-process races (duplicate daemons, kill/restart, heartbeat staleness)
 * are covered in worker-daemon-multiprocess.test.ts.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Message } from "@apholdings/jensen-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AssignmentControlService, FileAssignmentStore } from "../../src/core/assignment/index.js";
import { bindChildSession } from "../../src/core/durable-child-session/index.js";
import {
	type ExecutorCapabilities,
	ExecutorControlService,
	FileExecutorRegistry,
} from "../../src/core/executor-registry/index.js";
import type { ProcessMissionVerifier } from "../../src/core/mission-domain/index.js";
import {
	createDurableMissionRecord,
	createMissionRequest,
	type MissionRequest,
	newChildSessionId,
} from "../../src/core/mission-domain/index.js";
import { FileDurableMissionStore } from "../../src/core/mission-durable/index.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { WorkerControlService } from "../../src/core/worker-daemon/index.js";

function makeRoot(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

const CAPS: ExecutorCapabilities = {
	platform: { os: "linux", arch: "x64" },
	execution: ["shell", "git", "filesystem"],
	providers: ["llamacpp-local"],
	models: ["qwen-local"],
	tools: ["read", "bash", "edit", "write"],
	specialized: ["python"],
	extra: ["local-ai"],
};

const PASSING_VERIFIER: ProcessMissionVerifier = async () => ({
	verified: true,
	summary: "fixture verifier passed",
	criterionIds: ["c1"],
});

interface Harness {
	root: string;
	missionStore: FileDurableMissionStore;
	executorStore: FileExecutorRegistry;
	assignmentStore: FileAssignmentStore;
	executors: ExecutorControlService;
	assignments: AssignmentControlService;
	sessionDir: string;
	cwd: string;
	now: () => number;
	advance(ms: number): void;
}

function makeHarness(): Harness {
	const root = makeRoot("worker-daemon-");
	const missionStore = new FileDurableMissionStore({ root: path.join(root, "missions") });
	const executorStore = new FileExecutorRegistry({ root: path.join(root, "executors") });
	const assignmentStore = new FileAssignmentStore({ root: path.join(root, "assignments") });
	const sessionDir = makeRoot("worker-session-");
	const cwd = makeRoot("worker-cwd-");
	let nowValue = 1_000_000;
	const executors = new ExecutorControlService({
		store: executorStore,
		now: () => nowValue,
		expiryMs: 30_000,
		assignmentStore,
	});
	const assignments = new AssignmentControlService({
		store: assignmentStore,
		missions: missionStore,
		executors,
		now: () => nowValue,
		sessionDir,
	});
	return {
		root,
		missionStore,
		executorStore,
		assignmentStore,
		executors,
		assignments,
		sessionDir,
		cwd,
		now: () => nowValue,
		advance(ms: number) {
			nowValue += ms;
		},
	};
}

function request(
	missionId: string,
	childSessionId?: string,
	acceptanceCriteria: MissionRequest["acceptanceCriteria"] = [],
): MissionRequest {
	return createMissionRequest({
		missionId,
		objective: `objective of ${missionId}`,
		agent: "worker",
		executionMode: "execute",
		acceptanceCriteria,
		childSessionId,
	});
}

async function seedMission(
	h: Harness,
	missionId: string,
	childSessionId?: string,
	acceptanceCriteria: MissionRequest["acceptanceCriteria"] = [],
): Promise<void> {
	await h.missionStore.create(
		createDurableMissionRecord({ request: request(missionId, childSessionId, acceptanceCriteria), now: 1 }),
	);
}

function persistChildSession(h: Harness, childSessionId: string, missionId: string): SessionManager {
	const sm = SessionManager.createWithId(h.cwd, h.sessionDir, childSessionId);
	bindChildSession(sm, missionId);
	sm.appendMessage({ role: "user", content: "start" } as Message);
	sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }] } as Message);
	return sm;
}

function fixtureBuildResumeLaunch(cwd: string) {
	return () => ({ command: process.execPath, args: ["-e", "process.exit(0)"], cwd });
}

async function makeWorker(
	h: Harness,
	executorId: string,
	options: { verifier?: ProcessMissionVerifier; reconcile?: boolean } = {},
): Promise<WorkerControlService> {
	const worker = new WorkerControlService({
		executorId,
		executors: h.executors,
		assignments: h.assignments,
		missions: h.missionStore,
		buildResumeLaunch: fixtureBuildResumeLaunch(h.cwd),
		verifier: options.verifier,
		pollMs: 3_600_000,
		heartbeatMs: 3_600_000,
		now: h.now,
	});
	await worker.start({ reconcile: options.reconcile ?? false });
	return worker;
}

let h: Harness;
const workers: WorkerControlService[] = [];

beforeEach(() => {
	h = makeHarness();
});

afterEach(async () => {
	for (const worker of workers.splice(0)) {
		await worker.stop();
	}
	rmSync(h.root, { recursive: true, force: true });
	rmSync(h.sessionDir, { recursive: true, force: true });
	rmSync(h.cwd, { recursive: true, force: true });
});

describe("TEST A — WORKER_STARTUP", () => {
	it("establishes identity, executor binding, and healthy liveness", async () => {
		const worker = await makeWorker(h, "exec_a");
		workers.push(worker);

		const status = await worker.status();
		expect(status.identity.workerId).toBe("worker_exec_a");
		expect(status.identity.executorId).toBe("exec_a");
		expect(status.identity.workerInstanceId).toBeTruthy();
		expect(status.identity.workerEpoch).toBe(1);
		expect(status.liveness).toBe("ONLINE");
		expect(status.daemonState).toBe("RUNNING");
		expect(status.activity).toBe("IDLE");
	});
});

describe("TEST B/C/D — DISCOVERY + CLAIM + EXECUTION_IDENTITY", () => {
	it("discovers an assigned mission, claims it, executes it, and correlates identity", async () => {
		const executorId = "exec_bcd";
		const childSessionId = newChildSessionId();
		const missionId = "mission_bcd";
		await seedMission(h, missionId, childSessionId);
		persistChildSession(h, childSessionId, missionId);

		const worker = await makeWorker(h, executorId, { verifier: PASSING_VERIFIER });
		workers.push(worker);

		const assignment = await h.assignments.assignMission({ missionId, executorId });

		// Idle before assignment exists is exercised implicitly by the first cycle.
		const outcome = await worker.runOnce();
		expect(outcome.kind).toBe("executed");
		if (outcome.kind !== "executed") throw new Error("expected executed");
		expect(outcome.missionId).toBe(missionId);
		expect(outcome.assignmentId).toBe(assignment.assignmentId);
		expect(outcome.missionState).toBe("SUCCEEDED");
		expect(outcome.success).toBe(true);
		expect(outcome.attemptId).toBeTruthy();
		expect(outcome.executionId).toBeTruthy();

		const detail = await h.assignments.getAssignment(assignment.assignmentId);
		expect(detail.state).toBe("COMPLETED");
		expect(detail.consumedByAttemptId).toBe(outcome.attemptId);
		expect(detail.consumedByExecutionId).toBe(outcome.executionId);
		expect(detail.executionOwnerIdentity?.executorId).toBe(executorId);
		expect(detail.terminalMissionState).toBe("SUCCEEDED");

		const mission = await h.missionStore.load(missionId);
		expect(mission.status).toBe("ok");
		if (mission.status === "ok") {
			expect(mission.record.state).toBe("SUCCEEDED");
			expect(mission.record.result?.verification.status).toBe("verified");
		}
	});
});

describe("TEST E — WRONG_EXECUTOR", () => {
	it("ignores assignments intended for another executor", async () => {
		const worker = await makeWorker(h, "exec_e_a");
		workers.push(worker);

		await h.executors.registerExecutor({ executorId: "exec_e_b", configuredCapabilities: CAPS });
		await h.executors.activateExecutor("exec_e_b");
		const missionId = "mission_e";
		await seedMission(h, missionId);

		const other = await h.assignments.assignMission({ missionId, executorId: "exec_e_b" });

		const outcome = await worker.runOnce();
		expect(outcome.kind).toBe("idle");

		const detail = await h.assignments.getAssignment(other.assignmentId);
		expect(detail.state).toBe("ASSIGNED");
	});
});

describe("TEST P — VERIFICATION_GATE", () => {
	it("does not fabricate success from a bare clean exit", async () => {
		const executorId = "exec_p";
		const childSessionId = newChildSessionId();
		const missionId = "mission_p";
		await seedMission(h, missionId, childSessionId);
		persistChildSession(h, childSessionId, missionId);

		// No verifier + no verifiable acceptance criteria → PARTIAL, never SUCCEEDED.
		const worker = await makeWorker(h, executorId);
		workers.push(worker);

		await h.assignments.assignMission({ missionId, executorId });
		const outcome = await worker.runOnce();
		expect(outcome.kind).toBe("executed");
		if (outcome.kind !== "executed") throw new Error("expected executed");
		expect(outcome.missionState).toBe("PARTIAL");
		expect(outcome.success).toBe(false);

		const mission = await h.missionStore.load(missionId);
		expect(mission.status).toBe("ok");
		if (mission.status === "ok") {
			expect(mission.record.state).toBe("PARTIAL");
			expect(mission.record.result?.verification.status).toBe("unverified");
		}
	});
});

describe("TEST R — DAEMON_CONTINUES", () => {
	it("remains available for a second assignment after completing the first", async () => {
		const executorId = "exec_r";
		const worker = await makeWorker(h, executorId, { verifier: PASSING_VERIFIER });
		workers.push(worker);

		const firstSession = newChildSessionId();
		await seedMission(h, "mission_r1", firstSession);
		persistChildSession(h, firstSession, "mission_r1");
		await h.assignments.assignMission({ missionId: "mission_r1", executorId });
		const first = await worker.runOnce();
		expect(first.kind).toBe("executed");
		if (first.kind !== "executed") throw new Error("expected executed");
		expect(first.success).toBe(true);

		const secondSession = newChildSessionId();
		await seedMission(h, "mission_r2", secondSession);
		persistChildSession(h, secondSession, "mission_r2");
		await h.assignments.assignMission({ missionId: "mission_r2", executorId });
		const second = await worker.runOnce();
		expect(second.kind).toBe("executed");
		if (second.kind !== "executed") throw new Error("expected executed");
		expect(second.missionId).toBe("mission_r2");

		// Worker stays healthy and idle (no permanent inference lease held).
		const status = await worker.status();
		expect(status.liveness).toBe("ONLINE");
		expect(status.activity).toBe("IDLE");
	});
});

describe("TEST M — WAIT_PARK_STATE", () => {
	it("surfaces a waiting mission without fabricating a terminal result", async () => {
		const executorId = "exec_m";
		const childSessionId = newChildSessionId();
		const missionId = "mission_m";
		await seedMission(h, missionId, childSessionId);
		persistChildSession(h, childSessionId, missionId);

		const worker = await makeWorker(h, executorId, { reconcile: false });
		workers.push(worker);

		const assignment = await h.assignments.assignMission({ missionId, executorId });
		await h.assignments.beginAssignedExecution(assignment.assignmentId, worker.proof!);

		// Seed the mission into a waiting (parked) non-terminal state.
		await h.missionStore.mutate(missionId, (current) => ({
			kind: "write",
			value: undefined,
			next: {
				...current,
				state: "WAITING",
				transitions: [
					{ seq: 0, from: "CREATED", to: "QUEUED", atMs: h.now() },
					{ seq: 1, from: "QUEUED", to: "RUNNING", atMs: h.now() },
					{ seq: 2, from: "RUNNING", to: "WAITING", atMs: h.now(), reason: "waiting for inference" },
				],
				updatedAtMs: h.now(),
				revision: current.revision + 1,
			},
		}));

		const status = await worker.status();
		expect(status.liveness).toBe("ONLINE");
		expect(status.currentExecution?.missionState).toBe("WAITING");
		expect(status.currentExecution?.waitReason).toBe("INFERENCE");
		expect(status.activity).toBe("EXECUTING");

		const mission = await h.missionStore.load(missionId);
		expect(mission.status).toBe("ok");
		if (mission.status === "ok") {
			expect(mission.record.state).toBe("WAITING");
		}
	});
});

describe("TEST K/J — OWNERSHIP_LOSS + CRASH_RECONCILIATION", () => {
	it("reconciles a stale prior worker's live lease to INTERRUPTED without re-execution", async () => {
		const executorId = "exec_k";
		const childSessionId = newChildSessionId();
		const missionId = "mission_k";
		await seedMission(h, missionId, childSessionId);
		persistChildSession(h, childSessionId, missionId);

		await h.executors.registerExecutor({ executorId, configuredCapabilities: CAPS });
		const firstActivation = await h.executors.activateExecutor(executorId);
		const firstProof = firstActivation.proof;
		const assignment = await h.assignments.assignMission({ missionId, executorId });
		const begun = await h.assignments.beginAssignedExecution(assignment.assignmentId, firstProof);

		// Seed a still-live lease owned by the first (now-dead) worker incarnation.
		await h.missionStore.mutate(missionId, (current) => ({
			kind: "write",
			value: undefined,
			next: {
				...current,
				state: "RUNNING",
				fencingToken: current.fencingToken + 1,
				lease: {
					ownerId: begun.executionOwnerIdentity.ownerId,
					leaseId: "lease_stale",
					fencingToken: current.fencingToken + 1,
					acquiredAtMs: h.now(),
					renewedAtMs: h.now(),
					expiresAtMs: h.now() + 60_000,
				},
				updatedAtMs: h.now(),
				revision: current.revision + 1,
			},
		}));

		// The prior worker died: let its runtime go stale before a new worker starts.
		h.advance(31_000);

		const worker = await makeWorker(h, executorId, { reconcile: true });
		workers.push(worker);

		// Reconcile ran inside start(): the prior worker's still-live lease was
		// revoked to INTERRUPTED and the stale assignment was failed honestly.
		const mission = await h.missionStore.load(missionId);
		expect(mission.status).toBe("ok");
		if (mission.status === "ok") {
			expect(mission.record.state).toBe("INTERRUPTED");
			expect(mission.record.lease).toBeUndefined();
		}

		const detail = await h.assignments.getAssignment(assignment.assignmentId);
		expect(detail.state).toBe("FAILED");

		// The restarted worker must NOT silently re-execute the side-effectful work.
		const outcome = await worker.runOnce();
		expect(outcome.kind).toBe("idle");
	});
});

describe("TEST N — INFERENCE_INDEPENDENCE", () => {
	it("worker status carries no inference-slot/reservation field and holds no permanent lease", async () => {
		const executorId = "exec_n";
		const childSessionId = newChildSessionId();
		const missionId = "mission_n";
		await seedMission(h, missionId, childSessionId);
		persistChildSession(h, childSessionId, missionId);

		const worker = await makeWorker(h, executorId, { verifier: PASSING_VERIFIER });
		workers.push(worker);
		await h.assignments.assignMission({ missionId, executorId });
		await worker.runOnce();

		const status = await worker.status();
		const json = JSON.stringify(status);
		for (const forbidden of ["slot", "gpu", "reservation", "parallel", "inferenceSlot"]) {
			expect(json.toLowerCase()).not.toContain(forbidden.toLowerCase());
		}

		// After execution, the worker remains live and idle: no permanent inference
		// resource is owned across the assignment's logical lifetime.
		expect(status.liveness).toBe("ONLINE");
		expect(status.currentAssignment).toBeUndefined();
	});
});
