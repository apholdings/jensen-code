/**
 * Scheduler Foundation — deterministic control-plane tests (2.12.0).
 *
 * Proves pending scheduling intent, deterministic policy decisions, mission
 * eligibility, executor assignability, and the durable-assignment output using
 * a deterministic clock and in-process stores. Cross-process races are covered
 * in scheduler-multiprocess.test.ts.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AssignmentControlService, FileAssignmentStore } from "../../src/core/assignment/index.js";
import type { ExecutorActivationOutcome, ExecutorCapabilities } from "../../src/core/executor-registry/index.js";
import { ExecutorControlService, FileExecutorRegistry } from "../../src/core/executor-registry/index.js";
import {
	createDurableMissionRecord,
	createMissionRequest,
	createMissionResult,
	type ExecutionLease,
	type MissionRequest,
} from "../../src/core/mission-domain/index.js";
import { FileDurableMissionStore } from "../../src/core/mission-durable/index.js";
import type { SchedulingPolicy } from "../../src/core/scheduler/index.js";
import { FileSchedulerStore, SchedulerControlService } from "../../src/core/scheduler/index.js";

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
	schedulerStore: FileSchedulerStore;
	executors: ExecutorControlService;
	assignments: AssignmentControlService;
	scheduler: SchedulerControlService;
	advance(ms: number): void;
	now(): number;
}

function makeHarness(policy?: SchedulingPolicy): Harness {
	const root = makeRoot("scheduler-");
	const missionStore = new FileDurableMissionStore({ root: path.join(root, "missions") });
	const executorStore = new FileExecutorRegistry({ root: path.join(root, "executors") });
	const assignmentStore = new FileAssignmentStore({ root: path.join(root, "assignments") });
	const schedulerStore = new FileSchedulerStore({ root: path.join(root, "intents") });
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
	});
	const scheduler = new SchedulerControlService({
		store: schedulerStore,
		missions: missionStore,
		executors,
		assignments,
		now: () => nowValue,
		policy,
		tickIdFactory: () => "tick_test",
	});
	return {
		root,
		missionStore,
		executorStore,
		assignmentStore,
		schedulerStore,
		executors,
		assignments,
		scheduler,
		now: () => nowValue,
		advance(ms: number) {
			nowValue += ms;
		},
	};
}

function request(missionId: string): MissionRequest {
	return createMissionRequest({
		missionId,
		objective: `objective of ${missionId}`,
		agent: "worker",
		executionMode: "execute",
		acceptanceCriteria: [],
	});
}

async function seedMission(h: Harness, missionId: string): Promise<void> {
	await h.missionStore.create(createDurableMissionRecord({ request: request(missionId), now: 1 }));
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

async function seedActiveLease(h: Harness, missionId: string, lease: ExecutionLease): Promise<void> {
	await h.missionStore.mutate(missionId, (current) => ({
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

describe("TEST A — ENQUEUE_INTENT", () => {
	it("creates a PENDING intent deterministically keyed by mission", async () => {
		await seedMission(h, "mission_a");
		const outcome = await h.scheduler.enqueueIntent("mission_a", { priority: 3 });
		expect(outcome.status).toBe("created");
		expect(outcome.state).toBe("PENDING");
		expect(outcome.intentId).toBe("intent_mission_a");

		const detail = await h.scheduler.getIntentForMission("mission_a");
		expect(detail.state).toBe("PENDING");
		expect(detail.priority).toBe(3);
	});
});

describe("TEST B — ENQUEUE_IDEMPOTENT", () => {
	it("a second enqueue of the same mission is idempotent", async () => {
		await seedMission(h, "mission_b");
		const first = await h.scheduler.enqueueIntent("mission_b");
		h.advance(10);
		const second = await h.scheduler.enqueueIntent("mission_b");
		expect(first.status).toBe("created");
		expect(second.status).toBe("idempotent");
		expect(second.intentId).toBe(first.intentId);

		const ids = await h.schedulerStore.listIntents();
		expect(ids).toEqual(["intent_mission_b"]);
	});
});

describe("TEST C — ENQUEUE_TERMINAL_MISSION", () => {
	it("enqueueing a terminal mission fails fast", async () => {
		await seedMission(h, "mission_c");
		await h.missionStore.mutate("mission_c", (current) => ({
			kind: "write",
			value: undefined,
			next: {
				...current,
				state: "SUCCEEDED",
				result: createMissionResult({
					missionId: "mission_c",
					depth: current.depth,
					state: "SUCCEEDED",
					executionOutcome: "COMPLETED",
					verification: { status: "verified" },
					executorDiagnostics: { executorId: "exec_terminal" },
					startedAtMs: h.now(),
					finishedAtMs: h.now(),
				}),
				updatedAtMs: h.now(),
				revision: current.revision + 1,
			},
		}));
		await expect(h.scheduler.enqueueIntent("mission_c")).rejects.toMatchObject({ code: "MISSION_TERMINAL" });
	});
});

describe("TEST D — CANCEL_INTENT", () => {
	it("cancels a PENDING intent and no-ops on a second cancel", async () => {
		await seedMission(h, "mission_d");
		await h.scheduler.enqueueIntent("mission_d");
		const cancelled = await h.scheduler.cancelIntent("mission_d");
		expect(cancelled.state).toBe("CANCELLED");

		const again = await h.scheduler.cancelIntent("mission_d");
		expect(again.state).toBe("CANCELLED");
	});
});

describe("TEST E — RUN_TICK_ASSIGNS", () => {
	it("a scheduler run turns a PENDING intent into a durable assignment", async () => {
		await seedMission(h, "mission_e");
		await onlineExecutor(h, "exec_e");
		await h.scheduler.enqueueIntent("mission_e");

		const result = await h.scheduler.runTick();
		expect(result.assignmentsCreated).toBe(1);
		expect(result.intentsAssigned).toBe(1);
		expect(result.intentsUnschedulable).toBe(0);
		expect(result.decisions[0].decision).toBe("ASSIGN");
		expect(result.decisions[0].executorId).toBe("exec_e");

		const intent = await h.scheduler.getIntentForMission("mission_e");
		expect(intent.state).toBe("ASSIGNED");
		expect(intent.assignmentId).toBeDefined();

		const assignment = await h.assignments.getAssignment(intent.assignmentId ?? "");
		expect(assignment.missionId).toBe("mission_e");
		expect(assignment.executorId).toBe("exec_e");
		expect(assignment.state).toBe("ASSIGNED");
	});
});

describe("TEST F — POLICY_FIRST_FIT", () => {
	it("first-fit picks the lexicographically smallest assignable executorId", async () => {
		await seedMission(h, "mission_f");
		await onlineExecutor(h, "exec_f_b");
		await onlineExecutor(h, "exec_f_a");
		await h.scheduler.enqueueIntent("mission_f");

		const result = await h.scheduler.runTick();
		expect(result.decisions[0].executorId).toBe("exec_f_a");
	});
});

describe("TEST G — POLICY_LEAST_ASSIGNED", () => {
	it("least-assigned prefers the executor with the fewest current assignments", async () => {
		const g = makeHarness({ mode: "least-assigned" });
		try {
			await seedMission(g, "mission_g_existing");
			await seedMission(g, "mission_g_new");
			await onlineExecutor(g, "exec_g_a");
			await onlineExecutor(g, "exec_g_b");

			// Give exec_g_a one current assignment.
			await g.assignments.assignMission({ missionId: "mission_g_existing", executorId: "exec_g_a" });

			await g.scheduler.enqueueIntent("mission_g_new");
			const result = await g.scheduler.runTick();
			expect(result.decisions[0].decision).toBe("ASSIGN");
			expect(result.decisions[0].executorId).toBe("exec_g_b");
		} finally {
			rmSync(g.root, { recursive: true, force: true });
		}
	});
});

describe("TEST H — NO_ASSIGNABLE_EXECUTOR", () => {
	it("marks the intent UNSCHEDULABLE without creating an assignment", async () => {
		await seedMission(h, "mission_h");
		const activation = await onlineExecutor(h, "exec_h");
		// Make the only executor offline so it is not assignable.
		await h.executors.deactivateExecutor(activation.proof);

		await h.scheduler.enqueueIntent("mission_h");
		const result = await h.scheduler.runTick();
		expect(result.intentsUnschedulable).toBe(1);
		expect(result.assignmentsCreated).toBe(0);
		expect(result.decisions[0].decision).toBe("UNSCHEDULABLE");
		expect(result.decisions[0].reason).toContain("no assignable executor");

		const intent = await h.scheduler.getIntentForMission("mission_h");
		expect(intent.state).toBe("UNSCHEDULABLE");
		expect(intent.unschedulableReason).toBeDefined();
	});
});

describe("TEST I — REQUIREMENTS_FILTER", () => {
	it("only an executor satisfying MissionRequirements is chosen", async () => {
		await seedMission(h, "mission_i");
		await onlineExecutor(h, "exec_i_gpu", { ...CAPS, specialized: ["gpu-compute"] });
		await onlineExecutor(h, "exec_i_cpu", { ...CAPS, specialized: ["cpu-compute"] });

		await h.scheduler.enqueueIntent("mission_i", {
			requirements: { specialized: ["gpu-compute"] },
		});
		const result = await h.scheduler.runTick();
		expect(result.decisions[0].decision).toBe("ASSIGN");
		expect(result.decisions[0].executorId).toBe("exec_i_gpu");

		const intent = await h.scheduler.getIntentForMission("mission_i");
		const assignment = await h.assignments.getAssignment(intent.assignmentId ?? "");
		expect(assignment.requirementsSnapshot).toEqual({ specialized: ["gpu-compute"] });
	});
});

describe("TEST J — MISSION_ACTIVE_LEASE", () => {
	it("a mission with an active execution owner is not scheduled", async () => {
		await seedMission(h, "mission_j");
		await onlineExecutor(h, "exec_j");
		const now = h.now();
		await seedActiveLease(h, "mission_j", {
			ownerId: "owner_j",
			leaseId: "lease_j",
			fencingToken: 1,
			acquiredAtMs: now,
			renewedAtMs: now,
			expiresAtMs: now + 60_000,
		});

		await h.scheduler.enqueueIntent("mission_j");
		const result = await h.scheduler.runTick();
		expect(result.decisions[0].decision).toBe("UNSCHEDULABLE");
		expect(result.decisions[0].reason).toContain("active execution owner");
		expect(result.assignmentsCreated).toBe(0);
	});
});

describe("TEST K — ALREADY_ASSIGNED_RECONCILE", () => {
	it("an already-assigned mission reconciles the intent without a duplicate assignment", async () => {
		await seedMission(h, "mission_k");
		await onlineExecutor(h, "exec_k");
		const existing = await h.assignments.assignMission({ missionId: "mission_k", executorId: "exec_k" });

		await h.scheduler.enqueueIntent("mission_k");
		const result = await h.scheduler.runTick();
		expect(result.decisions[0].decision).toBe("RECONCILE");
		expect(result.decisions[0].assignmentId).toBe(existing.assignmentId);
		expect(result.assignmentsCreated).toBe(0);
		expect(result.intentsAssigned).toBe(1);

		const intent = await h.scheduler.getIntentForMission("mission_k");
		expect(intent.state).toBe("ASSIGNED");
		expect(intent.assignmentId).toBe(existing.assignmentId);

		const records = await h.assignments.listForMission("mission_k");
		expect(records.filter((r) => r.current)).toHaveLength(1);
	});
});

describe("TEST L — PRIORITY_AND_FIFO_ORDER", () => {
	it("processes intents by priority descending, then FIFO by enqueuedAtMs", async () => {
		await seedMission(h, "mission_low");
		await seedMission(h, "mission_high");
		await seedMission(h, "mission_mid");
		await onlineExecutor(h, "exec_l");

		await h.scheduler.enqueueIntent("mission_low", { priority: 0 });
		h.advance(1);
		await h.scheduler.enqueueIntent("mission_high", { priority: 10 });
		h.advance(1);
		await h.scheduler.enqueueIntent("mission_mid", { priority: 5 });

		const result = await h.scheduler.runTick();
		expect(result.decisions.map((d) => d.missionId)).toEqual(["mission_high", "mission_mid", "mission_low"]);
	});
});

describe("TEST M — PREVIEW_NO_MUTATION", () => {
	it("preview returns a deterministic decision without mutating any store", async () => {
		await seedMission(h, "mission_m");
		await onlineExecutor(h, "exec_m");
		await h.scheduler.enqueueIntent("mission_m");

		const preview = await h.scheduler.previewTick();
		expect(preview.dryRun).toBe(true);
		expect(preview.decisions[0].decision).toBe("ASSIGN");
		expect(preview.decisions[0].executorId).toBe("exec_m");

		// Nothing persisted: intent still PENDING and no assignment exists.
		expect((await h.scheduler.getIntentForMission("mission_m")).state).toBe("PENDING");
		const list = await h.assignments.listAssignments();
		expect(list.entries).toHaveLength(0);
	});
});

describe("TEST N — REOPEN_UNSCHEDULABLE", () => {
	it("an UNSCHEDULABLE intent can be re-enqueued back to PENDING", async () => {
		await seedMission(h, "mission_n");
		const activation = await onlineExecutor(h, "exec_n");
		await h.executors.deactivateExecutor(activation.proof);

		await h.scheduler.enqueueIntent("mission_n");
		await h.scheduler.runTick();
		expect((await h.scheduler.getIntentForMission("mission_n")).state).toBe("UNSCHEDULABLE");

		const reopened = await h.scheduler.enqueueIntent("mission_n");
		expect(reopened.status).toBe("reopened");
		expect(reopened.state).toBe("PENDING");
	});
});

describe("TEST O — CORRUPT_INTENT", () => {
	it("a corrupt intent is surfaced structurally and never folded into healthy state", async () => {
		await seedMission(h, "mission_o");
		await h.scheduler.enqueueIntent("mission_o");
		writeFileSync(path.join(h.root, "intents", "intent_bad.intent.json"), '{"schemaVersion": 999}\n', "utf8");

		const list = await h.scheduler.listIntents();
		expect(list.corrupt).toEqual([{ intentId: "intent_bad", diagnostic: expect.stringContaining("schemaVersion") }]);
		expect(list.entries.map((e) => e.intentId)).toEqual(["intent_mission_o"]);

		const tick = await h.scheduler.runTick();
		expect(tick.corrupt).toEqual([{ intentId: "intent_bad", diagnostic: expect.stringContaining("schemaVersion") }]);
	});
});

describe("TEST P — DETERMINISM", () => {
	it("two previews of the same scheduler state are identical", async () => {
		await seedMission(h, "mission_p");
		await onlineExecutor(h, "exec_p_a");
		await onlineExecutor(h, "exec_p_b");
		await h.scheduler.enqueueIntent("mission_p");

		const a = await h.scheduler.previewTick();
		const b = await h.scheduler.previewTick();
		expect(a.decisions).toEqual(b.decisions);
		expect(a.decisions[0].executorId).toBe("exec_p_a");
	});
});
