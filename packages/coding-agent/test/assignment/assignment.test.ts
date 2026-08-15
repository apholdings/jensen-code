/**
 * Assignment Foundation — deterministic control-plane tests (2.11.0).
 *
 * Proves the durable mission↔executor designation domain, the deterministic
 * capability/assignability split, current-assignment invariants, runtime-proof
 * fencing, ownership correlation, and corruption isolation using a deterministic
 * clock and in-process stores. Cross-process races are covered in
 * assignment-multiprocess.test.ts.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Message } from "@apholdings/jensen-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AssignmentControlService, FileAssignmentStore } from "../../src/core/assignment/index.js";
import { bindChildSession } from "../../src/core/durable-child-session/index.js";
import {
	type ExecutorActivationOutcome,
	type ExecutorCapabilities,
	ExecutorControlService,
	FileExecutorRegistry,
} from "../../src/core/executor-registry/index.js";
import { MissionControlService } from "../../src/core/mission-control/index.js";
import {
	createDurableMissionRecord,
	createMissionRequest,
	type DurableMissionRecord,
	type ExecutionLease,
	type MissionRequest,
	newChildSessionId,
} from "../../src/core/mission-domain/index.js";
import { FileDurableMissionStore } from "../../src/core/mission-durable/index.js";
import { SessionManager } from "../../src/core/session-manager.js";

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

interface Harness {
	root: string;
	missionStore: FileDurableMissionStore;
	executorStore: FileExecutorRegistry;
	assignmentStore: FileAssignmentStore;
	executors: ExecutorControlService;
	service: AssignmentControlService;
	advance(ms: number): void;
	now(): number;
}

function makeHarness(): Harness {
	const root = makeRoot("assignment-");
	const missionStore = new FileDurableMissionStore({ root: path.join(root, "missions") });
	const executorStore = new FileExecutorRegistry({ root: path.join(root, "executors") });
	const assignmentStore = new FileAssignmentStore({ root: path.join(root, "assignments") });
	let nowValue = 1_000_000;
	const executors = new ExecutorControlService({
		store: executorStore,
		now: () => nowValue,
		expiryMs: 30_000,
		assignmentStore,
	});
	const service = new AssignmentControlService({
		store: assignmentStore,
		missions: missionStore,
		executors,
		now: () => nowValue,
	});
	return {
		root,
		missionStore,
		executorStore,
		assignmentStore,
		executors,
		service,
		now: () => nowValue,
		advance(ms: number) {
			nowValue += ms;
		},
	};
}

function request(missionId: string, childSessionId?: string): MissionRequest {
	return createMissionRequest({
		missionId,
		objective: `objective of ${missionId}`,
		agent: "worker",
		executionMode: "execute",
		acceptanceCriteria: [],
		childSessionId,
	});
}

async function seedMission(h: Harness, missionId: string, childSessionId?: string): Promise<void> {
	await h.missionStore.create(createDurableMissionRecord({ request: request(missionId, childSessionId), now: 1 }));
}

async function onlineExecutor(
	h: Harness,
	executorId: string,
	caps: ExecutorCapabilities = CAPS,
): Promise<ExecutorActivationOutcome> {
	await h.executors.registerExecutor({ executorId, configuredCapabilities: caps });
	return h.executors.activateExecutor(executorId, {
		platform: caps.platform?.os,
		arch: caps.platform?.arch,
		advertisedCapabilities: { ...caps, platform: undefined },
	});
}

function persistChildSession(
	sessionDir: string,
	childSessionId: string,
	missionId: string,
	cwd: string,
): SessionManager {
	const sm = SessionManager.createWithId(cwd, sessionDir, childSessionId);
	bindChildSession(sm, missionId);
	sm.appendMessage({ role: "user", content: "start" } as Message);
	sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }] } as Message);
	return sm;
}

async function seedActiveLease(
	store: FileDurableMissionStore,
	missionId: string,
	lease: ExecutionLease,
): Promise<void> {
	await store.mutate(missionId, (current) => ({
		kind: "write",
		value: undefined,
		next: {
			...current,
			state: "RUNNING",
			fencingToken: lease.fencingToken,
			lease,
			updatedAtMs: lease.acquiredAtMs,
			revision: current.revision + 1,
		},
	}));
}

let h: Harness;

beforeEach(() => {
	h = makeHarness();
});

afterEach(() => {
	rmSync(h.root, { recursive: true, force: true });
});

describe("TEST A — CREATE_ASSIGNMENT", () => {
	it("durably designates a compatible executor and snapshots requirements", async () => {
		await seedMission(h, "mission_a");
		await onlineExecutor(h, "exec_a");

		const outcome = await h.service.assignMission({
			missionId: "mission_a",
			executorId: "exec_a",
			requirements: { platform: { os: "linux" }, execution: ["git"] },
		});
		expect(outcome.state).toBe("ASSIGNED");
		expect(outcome.record.current).toBe(true);
		expect(outcome.record.requirementsSnapshot?.platform?.os).toBe("linux");

		const detail = await h.service.getAssignment(outcome.assignmentId);
		expect(detail.missionId).toBe("mission_a");
		expect(detail.executorId).toBe("exec_a");
		expect(detail.compatibilitySnapshot?.compatible).toBe(true);
		expect(detail.executorRuntimeAtAssignment?.status).toBe("ONLINE");

		const current = await h.service.getCurrentForMission("mission_a");
		expect(current?.assignmentId).toBe(outcome.assignmentId);
	});
});

describe("TEST B — INCOMPATIBLE_EXECUTOR", () => {
	it("unsatisfied capability is a structured rejection with no record", async () => {
		await seedMission(h, "mission_b");
		await onlineExecutor(h, "exec_b", { platform: { os: "windows", arch: "x64" }, execution: ["git"] });

		await expect(
			h.service.assignMission({
				missionId: "mission_b",
				executorId: "exec_b",
				requirements: { platform: { os: "linux" } },
			}),
		).rejects.toMatchObject({ code: "EXECUTOR_INCOMPATIBLE" });

		expect(await h.service.listForMission("mission_b")).toEqual([]);
	});
});

describe("TEST C — COMPATIBILITY_REASONS", () => {
	it("satisfied/unsatisfied reasons are deterministic and explainable", async () => {
		await seedMission(h, "mission_c");
		await onlineExecutor(h, "exec_c", {
			platform: { os: "linux", arch: "x64" },
			execution: ["shell"],
			tools: ["git"],
		});

		const result = await h.service.evaluateCompatibility("mission_c", "exec_c", {
			platform: { os: "linux", arch: "arm64" },
			execution: ["shell", "docker"],
			tools: ["git", "k8s"],
		});
		expect(result.assignability.compatible).toBe(false);
		const kinds = result.assignability.compatibility.unsatisfied.map((u) => u.kind);
		expect(kinds).toContain("platform.arch");
		expect(kinds).toContain("execution");
		expect(kinds).toContain("tool");
		const satisfied = result.assignability.compatibility.satisfied.map((s) => s.kind);
		expect(satisfied).toContain("platform.os");
		expect(satisfied).toContain("execution");
	});
});

describe("TEST D — OFFLINE_DISTINCTION", () => {
	it("compatible-but-offline is distinct from capability incompatibility", async () => {
		await seedMission(h, "mission_d");
		await h.executors.registerExecutor({
			executorId: "exec_d",
			configuredCapabilities: { platform: { os: "linux" }, execution: ["shell"] },
		});

		const result = await h.service.evaluateCompatibility("mission_d", "exec_d", {
			platform: { os: "linux" },
		});
		expect(result.assignability.compatible).toBe(true);
		expect(result.assignability.assignable).toBe(false);
		expect(result.assignability.status).toBe("REGISTERED");

		await expect(
			h.service.assignMission({
				missionId: "mission_d",
				executorId: "exec_d",
				requirements: { platform: { os: "linux" } },
			}),
		).rejects.toMatchObject({ code: "EXECUTOR_OFFLINE" });
	});
});

describe("TEST E — ONE_CURRENT_ASSIGNMENT", () => {
	it("a mission cannot have two current assignments", async () => {
		await seedMission(h, "mission_e");
		await onlineExecutor(h, "exec_e1");
		await onlineExecutor(h, "exec_e2");

		await h.service.assignMission({ missionId: "mission_e", executorId: "exec_e1" });
		await expect(h.service.assignMission({ missionId: "mission_e", executorId: "exec_e2" })).rejects.toMatchObject({
			code: "MISSION_ALREADY_ASSIGNED",
		});

		const records = await h.service.listForMission("mission_e");
		expect(records.filter((r) => r.current)).toHaveLength(1);
	});
});

describe("TEST G/H — HISTORICAL_ASSIGNMENTS + REASSIGN", () => {
	it("reassignment preserves history and keeps exactly one current", async () => {
		await seedMission(h, "mission_gh");
		await onlineExecutor(h, "exec_gh1");
		await onlineExecutor(h, "exec_gh2");

		const first = await h.service.assignMission({ missionId: "mission_gh", executorId: "exec_gh1" });
		const second = await h.service.reassignMission("mission_gh", "exec_gh2");
		expect(second.assignmentId).not.toBe(first.assignmentId);

		const records = await h.service.listForMission("mission_gh");
		expect(records).toHaveLength(2);
		expect(records.filter((r) => r.current)).toHaveLength(1);
		expect(records.find((r) => r.assignmentId === first.assignmentId)?.state).toBe("SUPERSEDED");
		expect(records.find((r) => r.assignmentId === first.assignmentId)?.supersededByAssignmentId).toBe(
			second.assignmentId,
		);
		expect(records.find((r) => r.assignmentId === second.assignmentId)?.state).toBe("ASSIGNED");

		const firstDetail = await h.service.getAssignment(first.assignmentId);
		expect(firstDetail.state).toBe("SUPERSEDED");
		expect(firstDetail.current).toBe(false);
	});
});

describe("TEST I — REASSIGN_ACTIVE_MISSION", () => {
	it("an active execution lease blocks casual reassignment", async () => {
		await seedMission(h, "mission_i");
		await onlineExecutor(h, "exec_i1");
		await onlineExecutor(h, "exec_i2");
		await h.service.assignMission({ missionId: "mission_i", executorId: "exec_i1" });

		const now = h.now();
		await seedActiveLease(h.missionStore, "mission_i", {
			ownerId: "owner_active",
			leaseId: "lease_active",
			fencingToken: 1,
			acquiredAtMs: now,
			renewedAtMs: now,
			expiresAtMs: now + 10_000,
		});

		await expect(h.service.reassignMission("mission_i", "exec_i2")).rejects.toMatchObject({ code: "MISSION_ACTIVE" });
	});
});

describe("TEST J — RELEASE", () => {
	it("releases a non-active assignment cleanly without cancelling execution", async () => {
		await seedMission(h, "mission_j");
		await onlineExecutor(h, "exec_j");
		const assignment = await h.service.assignMission({ missionId: "mission_j", executorId: "exec_j" });

		const released = await h.service.releaseAssignment(assignment.assignmentId);
		expect(released.state).toBe("RELEASED");
		expect(released.current).toBe(false);
		expect(released.releasedAtMs).toBeDefined();

		expect(await h.service.getCurrentForMission("mission_j")).toBeUndefined();
		// The mission is untouched (still CREATED, no lease).
		const mission = await h.missionStore.load("mission_j");
		expect(mission.status).toBe("ok");
		if (mission.status === "ok") expect(mission.record.state).toBe("CREATED");
	});
});

describe("TEST K — TERMINAL_MISSION", () => {
	it("a terminal mission rejects new assignment", async () => {
		await onlineExecutor(h, "exec_k");
		const terminal: DurableMissionRecord = {
			...createDurableMissionRecord({ request: request("mission_k"), now: 1 }),
			state: "SUCCEEDED",
			updatedAtMs: 2,
			startedAtMs: 1,
			finishedAtMs: 2,
			result: {
				missionId: "mission_k",
				depth: 0,
				state: "SUCCEEDED",
				executionOutcome: "COMPLETED",
				success: true,
				evidenceRefs: [],
				verification: { status: "verified" },
				completionDecision: "accepted",
				failures: [],
				executorDiagnostics: { executorId: "test", processExitCode: 0 },
				startedAtMs: 1,
				finishedAtMs: 2,
			},
			resultExecutionId: "exec_term",
			transitions: [{ seq: 0, from: "RUNNING", to: "SUCCEEDED", atMs: 2, executionId: "exec_term" }],
			attempts: [
				{
					attemptId: "attempt_term",
					executionId: "exec_term",
					startedAtMs: 1,
					finishedAtMs: 2,
					endReason: "COMPLETED",
				},
			],
			fencingToken: 1,
			revision: 2,
		};
		await h.missionStore.create(terminal);

		await expect(h.service.assignMission({ missionId: "mission_k", executorId: "exec_k" })).rejects.toMatchObject({
			code: "MISSION_NOT_ASSIGNABLE",
		});
	});
});

describe("TEST L — RETIRED_EXECUTOR", () => {
	it("a retired executor cannot receive a new executable assignment", async () => {
		await seedMission(h, "mission_l");
		await h.executors.registerExecutor({ executorId: "exec_l" });
		await h.executors.activateExecutor("exec_l", { platform: "linux", arch: "x64" });
		await h.executors.retireExecutor("exec_l");

		await expect(h.service.assignMission({ missionId: "mission_l", executorId: "exec_l" })).rejects.toMatchObject({
			code: "EXECUTOR_RETIRED",
		});
	});
});

describe("TEST M/N/O — EXECUTOR_RESTART + STALE + CURRENT_ACCEPTS", () => {
	it("assignment survives runtime epoch change; stale proof rejected; current proof accepted", async () => {
		await seedMission(h, "mission_mno");
		await h.executors.registerExecutor({ executorId: "exec_mno", configuredCapabilities: CAPS });
		const old = await h.executors.activateExecutor("exec_mno", {
			platform: "linux",
			arch: "x64",
			advertisedCapabilities: { ...CAPS, platform: undefined },
		});
		const assignment = await h.service.assignMission({ missionId: "mission_mno", executorId: "exec_mno" });

		// Runtime A dies (expires), runtime B re-activates with same executorId.
		h.advance(30_001);
		const next = await h.executors.activateExecutor("exec_mno", {
			platform: "linux",
			arch: "x64",
			advertisedCapabilities: { ...CAPS, platform: undefined },
		});
		expect(next.runtimeEpoch).toBe(2);

		// The logical assignment remains M -> exec_mno.
		const current = await h.service.getCurrentForMission("mission_mno");
		expect(current?.assignmentId).toBe(assignment.assignmentId);
		expect(current?.executorId).toBe("exec_mno");

		// Old runtime proof is rejected; new runtime proof is accepted.
		await expect(h.service.acceptAssignment(assignment.assignmentId, old.proof)).rejects.toMatchObject({
			code: "STALE_EXECUTOR_INSTANCE",
		});
		const accepted = await h.service.acceptAssignment(assignment.assignmentId, next.proof);
		expect(accepted.state).toBe("ACCEPTED");
	});
});

describe("TEST P — ASSIGNMENT_DOES_NOT_ACQUIRE_LEASE", () => {
	it("creating an assignment leaves mission ownership untouched", async () => {
		await seedMission(h, "mission_p");
		await onlineExecutor(h, "exec_p");
		const before = await h.missionStore.load("mission_p");
		expect(before.status).toBe("ok");

		await h.service.assignMission({ missionId: "mission_p", executorId: "exec_p" });

		const after = await h.missionStore.load("mission_p");
		expect(after.status).toBe("ok");
		if (before.status === "ok" && after.status === "ok") {
			expect(after.record.lease).toBeUndefined();
			expect(after.record.fencingToken).toBe(0);
			expect(after.record.revision).toBe(before.record.revision);
			expect(after.record.updatedAtMs).toBe(before.record.updatedAtMs);
		}
	});
});

describe("TEST Q/R/S — ASSIGNED_EXECUTION_START + CORRELATION", () => {
	it("startAssignedMission drives the fenced coordinator and records correlation", async () => {
		const sessionDir = makeRoot("session-");
		const cwd = makeRoot("cwd-");
		const childSessionId = newChildSessionId();
		const missionId = "mission_q";
		await seedMission(h, missionId, childSessionId);
		persistChildSession(sessionDir, childSessionId, missionId, cwd);

		await onlineExecutor(h, "exec_q");
		const assignment = await h.service.assignMission({ missionId, executorId: "exec_q" });
		const act = await h.executors.getExecutor("exec_q");

		const serviceWithSession = new AssignmentControlService({
			store: h.assignmentStore,
			missions: h.missionStore,
			executors: h.executors,
			now: h.now,
			sessionDir,
		});
		const proof = {
			executorId: "exec_q",
			runtimeInstanceId: act.runtime!.runtimeInstanceId,
			runtimeEpoch: act.runtimeEpoch,
		};
		const started = await serviceWithSession.startAssignedMission(assignment.assignmentId, proof, {
			buildResumeLaunch: () => ({ command: process.execPath, args: ["-e", "process.exit(0)"], cwd }),
		});

		expect(started.missionState).toBe("PARTIAL");
		expect(started.assignmentState).toBe("COMPLETED");
		expect(started.attemptId).toBeTruthy();
		expect(started.executionId).toBeTruthy();
		expect(started.assignment.consumedByAttemptId).toBe(started.attemptId);
		expect(started.assignment.consumedByExecutionId).toBe(started.executionId);
		expect(started.assignment.terminalMissionState).toBe("PARTIAL");
		expect(started.assignment.executionOwnerIdentity?.executorId).toBe("exec_q");
		expect(started.assignment.executionOwnerIdentity?.runtimeEpoch).toBe(act.runtimeEpoch);

		// Mission lease owner correlates to the assignment's recorded owner identity.
		const mission = await h.missionStore.load(missionId);
		expect(mission.status).toBe("ok");
		if (mission.status === "ok") {
			expect(mission.record.state).toBe("PARTIAL");
			expect(mission.record.lease).toBeUndefined();
			expect(mission.record.result?.state).toBe("PARTIAL");
		}

		rmSync(sessionDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});
});

describe("TEST R/V/W — OWNER_CORRELATION + TERMINAL_AUTHORITY", () => {
	it("begin + complete persist owner identity observationally without fabricating MissionResult", async () => {
		await seedMission(h, "mission_rw");
		await onlineExecutor(h, "exec_rw");
		const assignment = await h.service.assignMission({ missionId: "mission_rw", executorId: "exec_rw" });
		const act = await h.executors.getExecutor("exec_rw");

		const proof = {
			executorId: "exec_rw",
			runtimeInstanceId: act.runtime!.runtimeInstanceId,
			runtimeEpoch: act.runtimeEpoch,
		};
		const begun = await h.service.beginAssignedExecution(assignment.assignmentId, proof);
		expect(begun.state).toBe("EXECUTING");
		expect(begun.executionOwnerIdentity).toEqual({
			executorId: "exec_rw",
			runtimeInstanceId: proof.runtimeInstanceId,
			runtimeEpoch: proof.runtimeEpoch,
			ownerId: begun.executionOwnerIdentity.ownerId,
		});

		// Begin alone does not touch the mission record.
		const mid = await h.missionStore.load("mission_rw");
		expect(mid.status).toBe("ok");
		if (mid.status === "ok") expect(mid.record.state).toBe("CREATED");

		const completed = await h.service.completeAssignment(assignment.assignmentId, {
			resultState: "SUCCEEDED",
			attemptId: "attempt_1",
			executionId: "exec_1",
		});
		expect(completed.state).toBe("COMPLETED");
		expect(completed.terminalMissionState).toBe("SUCCEEDED");
		expect(completed.record.consumedByAttemptId).toBe("attempt_1");
		expect(completed.record.consumedByExecutionId).toBe("exec_1");
		expect(completed.record.current).toBe(false);

		// Assignment cannot fabricate a mission result: the mission record stays
		// CREATED and still has no canonical result.
		const after = await h.missionStore.load("mission_rw");
		expect(after.status).toBe("ok");
		if (after.status === "ok") {
			expect(after.record.state).toBe("CREATED");
			expect(after.record.result).toBeUndefined();
		}
	});
});

describe("TEST T/U — INTERRUPTED_RETAINS_ASSIGNMENT + RESUME_SAME_EXECUTOR_NEW_RUNTIME", () => {
	it("an interrupted mission remains assigned and can resume with a newer runtime", async () => {
		const interrupted: DurableMissionRecord = {
			...createDurableMissionRecord({ request: request("mission_tu"), now: 1 }),
			state: "INTERRUPTED",
			updatedAtMs: 2,
			startedAtMs: 1,
			transitions: [{ seq: 0, from: "RUNNING", to: "INTERRUPTED", atMs: 2, reason: "control_plane_restart" }],
			attempts: [{ attemptId: "attempt_prior", startedAtMs: 1, finishedAtMs: 2, endReason: "INTERRUPTED" }],
			fencingToken: 0,
			revision: 2,
		};
		await h.missionStore.create(interrupted);

		await h.executors.registerExecutor({ executorId: "exec_tu", configuredCapabilities: CAPS });
		const old = await h.executors.activateExecutor("exec_tu", {
			platform: "linux",
			arch: "x64",
			advertisedCapabilities: { ...CAPS, platform: undefined },
		});
		const assignment = await h.service.assignMission({ missionId: "mission_tu", executorId: "exec_tu" });

		h.advance(30_001);
		const next = await h.executors.activateExecutor("exec_tu", {
			platform: "linux",
			arch: "x64",
			advertisedCapabilities: { ...CAPS, platform: undefined },
		});

		const current = await h.service.getCurrentForMission("mission_tu");
		expect(current?.executorId).toBe("exec_tu");

		await expect(h.service.acceptAssignment(assignment.assignmentId, old.proof)).rejects.toMatchObject({
			code: "STALE_EXECUTOR_INSTANCE",
		});
		const begun = await h.service.beginAssignedExecution(assignment.assignmentId, next.proof);
		expect(begun.state).toBe("EXECUTING");
	});
});

describe("TEST X — EXECUTOR_CURRENT_ASSIGNMENTS", () => {
	it("executor detail exposes real current assignments when wired", async () => {
		await seedMission(h, "mission_x");
		await onlineExecutor(h, "exec_x");
		const assignment = await h.service.assignMission({ missionId: "mission_x", executorId: "exec_x" });

		const detail = await h.executors.getExecutor("exec_x");
		expect(detail.currentAssignments.status).toBe("available");
		if (detail.currentAssignments.status === "available") {
			expect(detail.currentAssignments.assignments.map((a) => a.assignmentId)).toContain(assignment.assignmentId);
		}
	});
});

describe("TEST Y — MISSION_ASSIGNMENT_VIEW", () => {
	it("mission control exposes assigned executor and current assignment", async () => {
		await seedMission(h, "mission_y");
		await onlineExecutor(h, "exec_y");
		const assignment = await h.service.assignMission({ missionId: "mission_y", executorId: "exec_y" });

		const control = new MissionControlService({
			store: h.missionStore,
			assignmentStore: h.assignmentStore,
			now: h.now,
		});
		const detail = await control.getMission("mission_y");
		expect(detail.summary.assigned).toBe(true);
		expect(detail.summary.currentAssignmentId).toBe(assignment.assignmentId);
		expect(detail.summary.assignedExecutorId).toBe("exec_y");
		expect(detail.assignment?.assignmentId).toBe(assignment.assignmentId);

		const list = await control.listMissions();
		const entry = list.entries.find((e) => e.missionId === "mission_y");
		expect(entry?.assigned).toBe(true);
		expect(entry?.assignedExecutorId).toBe("exec_y");
	});
});

describe("TEST Z — READ_ONLY_NO_MUTATION", () => {
	it("list/show/compatibility do not mutate mission/executor/assignment records", async () => {
		await seedMission(h, "mission_z");
		await onlineExecutor(h, "exec_z");
		await h.service.assignMission({ missionId: "mission_z", executorId: "exec_z" });

		const missionBefore = await h.missionStore.load("mission_z");
		const executorBefore = await h.executorStore.load("exec_z");
		const assignmentsBefore = await h.assignmentStore.listRecords();

		await h.service.listAssignments();
		await h.service.getCurrentForMission("mission_z");
		await h.service.evaluateCompatibility("mission_z", "exec_z", { platform: { os: "linux" } });

		const missionAfter = await h.missionStore.load("mission_z");
		const executorAfter = await h.executorStore.load("exec_z");
		const assignmentsAfter = await h.assignmentStore.listRecords();

		expect(missionAfter.status).toBe("ok");
		expect(executorAfter.status).toBe("ok");
		if (missionBefore.status === "ok" && missionAfter.status === "ok") {
			expect(missionAfter.record.revision).toBe(missionBefore.record.revision);
		}
		if (executorBefore.status === "ok" && executorAfter.status === "ok") {
			expect(executorAfter.record.revision).toBe(executorBefore.record.revision);
		}
		expect(assignmentsAfter.records.map((r) => r.revision)).toEqual(assignmentsBefore.records.map((r) => r.revision));
	});
});

describe("TEST AA — CORRUPT_ASSIGNMENT", () => {
	it("fails closed and keeps healthy records inspectable", async () => {
		await seedMission(h, "mission_aa");
		await onlineExecutor(h, "exec_aa");
		await h.service.assignMission({ missionId: "mission_aa", executorId: "exec_aa" });
		writeFileSync(path.join(h.root, "assignments", "assign_corrupt.assignment.json"), "{ not json");

		const list = await h.service.listAssignments();
		expect(list.corrupt).toHaveLength(1);
		expect(list.entries.length).toBeGreaterThan(0);

		await expect(h.service.getAssignment("assign_corrupt")).rejects.toMatchObject({ code: "ASSIGNMENT_CORRUPT" });
	});
});

describe("TEST AJ — PROVIDER_INDEPENDENCE", () => {
	it("assignment domain has no provider/model coupling", () => {
		const sourceRoot = path.resolve(__dirname, "../../src/core/assignment");
		const files = [
			"assignment-types.ts",
			"assignment-store.ts",
			"assignment-control-service.ts",
			"compatibility.ts",
			"file-assignment-store.ts",
		];
		const combined = files
			.map((f) => readFileSync(path.join(sourceRoot, f), "utf8"))
			.join("\n")
			.toLowerCase();
		for (const provider of ["qwen", "openrouter", "llamacpp", "anthropic", "openai", "bedrock"]) {
			expect(combined).not.toContain(provider);
		}
	});
});

describe("Assignment error surface", () => {
	it("throws structured AssignmentError instances", async () => {
		await expect(h.service.getAssignment("assign_missing")).rejects.toMatchObject({ code: "ASSIGNMENT_NOT_FOUND" });
	});
});
