/**
 * SchedulerWorkerChildExecutionPort — deterministic adapter tests.
 *
 * Proves the child execution authority adapter contract against real
 * SchedulerControlService + WorkerControlService instances on in-process file
 * stores with a deterministic clock:
 *
 *   - executeChild creates exactly one durable scheduling intent for a
 *     materialized child and reuses it on repeated requests,
 *   - executeChild never launches: no worker start, no resume-launch
 *     invocation, the child mission stays CREATED,
 *   - executeChild declines mismatched authority (the parent's durable
 *     contract must name exactly this port's authority and orchestration)
 *     and invalid children (identity mismatch, unmaterialized, missing
 *     plan/node, terminal),
 *   - childStatus polls mission state and terminal outcome through the
 *     existing stores.
 *
 * Actual launch remains owned by Scheduler -> Assignment -> Worker and is
 * intentionally not exercised here.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AssignmentControlService, FileAssignmentStore } from "../../src/core/assignment/index.js";
import { ExecutorControlService, FileExecutorRegistry } from "../../src/core/executor-registry/index.js";
import {
	createDurableMissionRecord,
	createMissionRequest,
	createMissionResult,
} from "../../src/core/mission-domain/index.js";
import { FileDurableMissionStore } from "../../src/core/mission-durable/index.js";
import {
	createFileOrchestrationStore,
	type OrchestrationPlanProposal,
	OrchestratorService,
	SchedulerWorkerChildExecutionPort,
} from "../../src/core/orchestration/index.js";
import type { OrchestrationChildExecutionRequest } from "../../src/core/orchestration/types.js";
import { FileSchedulerStore, SchedulerControlService } from "../../src/core/scheduler/index.js";
import { WorkerControlService } from "../../src/core/worker-daemon/index.js";

const AUTHORITY = "scheduler_authority";
const ORCHESTRATION_ID = "orch_pw";
const CHILD_MISSION_ID = `mission_orch_${ORCHESTRATION_ID}_n1`;
const CHILD_SESSION_ID = `child_orch_${ORCHESTRATION_ID}_n1`;

interface Harness {
	root: string;
	missions: FileDurableMissionStore;
	executors: ExecutorControlService;
	assignments: AssignmentControlService;
	scheduler: SchedulerControlService;
	schedulerStore: FileSchedulerStore;
	orchestration: ReturnType<typeof createFileOrchestrationStore>;
	worker: WorkerControlService;
	launchCalls: string[];
	now(): number;
	advance(ms: number): void;
}

function makeHarness(): Harness {
	const root = mkdtempSync(path.join(tmpdir(), "jensen-orch-child-port-"));
	const sessionDir = path.join(root, "sessions");
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
		sessionDir,
	});
	const scheduler = new SchedulerControlService({
		store: schedulerStore,
		missions: missionStore,
		executors,
		assignments,
		now: () => nowValue,
		tickIdFactory: () => "tick_test",
	});
	const launchCalls: string[] = [];
	const worker = new WorkerControlService({
		executorId: "worker_a",
		executors,
		assignments,
		missions: missionStore,
		buildResumeLaunch: (input) => {
			launchCalls.push(input.childSessionId);
			return { command: "jensen", args: ["resume"], cwd: root };
		},
		pollMs: 3_600_000,
		heartbeatMs: 3_600_000,
		now: () => nowValue,
	});
	return {
		root,
		missions: missionStore,
		executors,
		assignments,
		scheduler,
		schedulerStore,
		orchestration: createFileOrchestrationStore(path.join(root, "orchestrations")),
		worker,
		launchCalls,
		now: () => nowValue,
		advance(ms: number) {
			nowValue += ms;
		},
	};
}

function proposal(): OrchestrationPlanProposal {
	return {
		decision: "FANOUT",
		rationale: "independent recon then gated verification",
		nodes: [
			{
				nodeId: "n1",
				role: "investigation",
				nodeKind: "CHILD",
				objective: "Trace the failing flow",
				agent: "worker",
				executionMode: "observe",
				requirement: "REQUIRED",
				workspaceAccess: "WRITE",
				status: "PROPOSED",
				acceptanceCriteria: [{ id: "c1", description: "Root cause identified" }],
				priority: 5,
				requirements: { specialized: ["gpu-compute"] },
				dependencyCriticality: 0,
			},
			{
				nodeId: "n2",
				role: "verification",
				nodeKind: "VERIFICATION",
				objective: "Verify the fix end to end",
				agent: "worker",
				executionMode: "execute",
				requirement: "REQUIRED",
				workspaceAccess: "READ_ONLY",
				status: "PROPOSED",
				acceptanceCriteria: [{ id: "c2", description: "Tests pass" }],
				dependencyCriticality: 0,
			},
		],
		edges: [{ from: "n1", to: "n2", kind: "REQUIRED" }],
	};
}

let h: Harness;

beforeEach(() => {
	h = makeHarness();
});

afterEach(() => {
	rmSync(h.root, { recursive: true, force: true });
});

async function seedParent(
	missionId: string,
	authority: string | undefined,
	namedOrchestrationId?: string,
): Promise<void> {
	await h.missions.create(
		createDurableMissionRecord({
			request: createMissionRequest({
				missionId,
				objective: "Drive the orchestration to completion",
				agent: "worker",
				executionMode: "execute",
				acceptanceCriteria: [],
				workspaceScope: { cwd: h.root },
				childSessionId: `session_${missionId}`,
				orchestrationExecution: authority
					? { orchestrationId: namedOrchestrationId ?? missionId, childExecutionAuthority: authority }
					: undefined,
			}),
			now: h.now(),
		}),
	);
}

async function seedOrchestration(orchestrationId: string, parentMissionId: string): Promise<void> {
	const service = new OrchestratorService({
		store: h.orchestration,
		missions: h.missions,
		sessionDir: path.join(h.root, "sessions"),
		orchestrationIdFactory: () => orchestrationId,
	});
	await service.create({ parentMissionId, proposal: proposal() });
	await service.materializeReady(orchestrationId);
}

function makePort(authority: string): SchedulerWorkerChildExecutionPort {
	return new SchedulerWorkerChildExecutionPort({
		authority,
		missions: h.missions,
		store: h.orchestration,
		scheduler: h.scheduler,
		workers: [h.worker],
		now: h.now,
	});
}

function request(
	overrides?: Partial<Omit<OrchestrationChildExecutionRequest, "workspaceAccess">> & {
		workspaceAccess?: "READ_ONLY" | "WRITE";
	},
): OrchestrationChildExecutionRequest {
	return {
		orchestrationId: ORCHESTRATION_ID,
		nodeId: "n1",
		childMissionId: CHILD_MISSION_ID,
		childSessionId: CHILD_SESSION_ID,
		workspaceAccess: "WRITE",
		...overrides,
	};
}

async function seedFixture(): Promise<void> {
	await seedParent("mission_parent", AUTHORITY, ORCHESTRATION_ID);
	await seedOrchestration(ORCHESTRATION_ID, "mission_parent");
}

async function markSucceeded(missionId: string): Promise<void> {
	const result = await h.missions.mutate(missionId, (current) => ({
		kind: "write",
		value: undefined,
		next: {
			...current,
			state: "SUCCEEDED",
			result: createMissionResult({
				missionId,
				depth: current.depth,
				state: "SUCCEEDED",
				executionOutcome: "COMPLETED",
				verification: { status: "verified" },
				executorDiagnostics: { executorId: "exec_test" },
				startedAtMs: h.now(),
				finishedAtMs: h.now(),
			}),
			updatedAtMs: h.now(),
			revision: current.revision + 1,
		},
	}));
	if (result.status !== "ok") throw new Error(`expected mission mutate to succeed, got ${result.status}`);
}

describe("SchedulerWorkerChildExecutionPort", () => {
	it("executeChild creates one scheduling intent and reuses it on repeated requests", async () => {
		await seedFixture();
		expect(await h.schedulerStore.listIntents()).toEqual([]);

		const port = makePort(AUTHORITY);
		const first = await port.executeChild(request());
		expect(first).toEqual({ accepted: true, authority: AUTHORITY });

		const firstDetail = await h.scheduler.getIntentForMission(CHILD_MISSION_ID);
		expect(await h.schedulerStore.listIntents()).toEqual([`intent_${CHILD_MISSION_ID}`]);
		expect(firstDetail.state).toBe("PENDING");
		expect(firstDetail.priority).toBe(5);
		expect(firstDetail.requirements).toEqual({ specialized: ["gpu-compute"] });

		h.advance(10);
		const second = await port.executeChild(request());
		expect(second).toEqual({ accepted: true, authority: AUTHORITY });

		// Same durable intent, untouched: one queue entry, original enqueue time.
		expect(await h.schedulerStore.listIntents()).toEqual([`intent_${CHILD_MISSION_ID}`]);
		const secondDetail = await h.scheduler.getIntentForMission(CHILD_MISSION_ID);
		expect(secondDetail.intentId).toBe(firstDetail.intentId);
		expect(secondDetail.state).toBe("PENDING");
		expect(secondDetail.enqueuedAtMs).toBe(firstDetail.enqueuedAtMs);
	});

	it("executeChild never launches: no worker start, no resume launch, child stays CREATED", async () => {
		await seedFixture();
		const port = makePort(AUTHORITY);
		expect((await port.executeChild(request())).accepted).toBe(true);
		expect((await port.executeChild(request())).accepted).toBe(true);

		// No launch path was touched: the worker was never started, the resume
		// launch builder was never called, and the child mission is still a
		// plain durable record with no execution attempts.
		expect(h.worker.daemonState).toBe("STOPPED");
		expect(h.launchCalls).toEqual([]);
		const child = await h.missions.load(CHILD_MISSION_ID);
		if (child.status !== "ok") throw new Error(`expected child mission to load, got ${child.status}`);
		expect(child.record.state).toBe("CREATED");
		expect(child.record.attempts).toEqual([]);
	});

	it("executeChild declines when the parent names a different authority", async () => {
		await seedFixture();
		const port = makePort("other_authority");
		const receipt = await port.executeChild(request());
		expect(receipt.accepted).toBe(false);
		expect(receipt.authority).toBe("other_authority");
		expect(receipt.reason).toContain("AUTHORITY_MISMATCH");
		expect(receipt.reason).toContain("'scheduler_authority', not 'other_authority'");
		// A mismatched authority never reaches the scheduler.
		expect(await h.schedulerStore.listIntents()).toEqual([]);
	});

	it("executeChild declines when the parent names no child execution authority", async () => {
		await seedParent("mission_parent_bare", undefined);
		await seedOrchestration("orch_bare", "mission_parent_bare");
		const port = makePort(AUTHORITY);
		const receipt = await port.executeChild(
			request({
				orchestrationId: "orch_bare",
				childMissionId: "mission_orch_orch_bare_n1",
				childSessionId: "child_orch_orch_bare_n1",
			}),
		);
		expect(receipt.accepted).toBe(false);
		expect(receipt.reason).toContain("AUTHORITY_MISMATCH");
		expect(receipt.reason).toContain("names no child execution authority");
		expect(await h.schedulerStore.listIntents()).toEqual([]);
	});

	it("executeChild declines when the parent names a different orchestration", async () => {
		await seedParent("mission_parent_other", AUTHORITY, "orch_named_other");
		await seedOrchestration("orch_pw_other", "mission_parent_other");
		const port = makePort(AUTHORITY);
		const receipt = await port.executeChild(
			request({
				orchestrationId: "orch_pw_other",
				childMissionId: "mission_orch_orch_pw_other_n1",
				childSessionId: "child_orch_orch_pw_other_n1",
			}),
		);
		expect(receipt.accepted).toBe(false);
		expect(receipt.reason).toContain("AUTHORITY_MISMATCH");
		expect(receipt.reason).toContain("'orch_named_other', not 'orch_pw_other'");
		expect(await h.schedulerStore.listIntents()).toEqual([]);
	});

	it("executeChild declines invalid children", async () => {
		await seedFixture();
		const port = makePort(AUTHORITY);

		// Unknown orchestration and unknown node.
		const missingPlan = await port.executeChild(request({ orchestrationId: "orch_missing" }));
		expect(missingPlan.accepted).toBe(false);
		expect(missingPlan.reason).toContain("ORCHESTRATION_NOT_FOUND");

		const missingNode = await port.executeChild(request({ nodeId: "nX" }));
		expect(missingNode.accepted).toBe(false);
		expect(missingNode.reason).toContain("NODE_NOT_FOUND");

		// n2 is blocked by its REQUIRED dependency and never materialized.
		const unmaterialized = await port.executeChild(
			request({
				nodeId: "n2",
				childMissionId: "mission_orch_orch_pw_n2",
				childSessionId: "child_orch_orch_pw_n2",
				workspaceAccess: "READ_ONLY",
			}),
		);
		expect(unmaterialized.accepted).toBe(false);
		expect(unmaterialized.reason).toContain("CHILD_NOT_MATERIALIZED");

		// Identity mismatch: the node's durable child identity does not match.
		const wrongChild = await port.executeChild(request({ childMissionId: "mission_orch_orch_pw_nX" }));
		expect(wrongChild.accepted).toBe(false);
		expect(wrongChild.reason).toContain("CHILD_IDENTITY_MISMATCH");

		const wrongAccess = await port.executeChild(request({ workspaceAccess: "READ_ONLY" }));
		expect(wrongAccess.accepted).toBe(false);
		expect(wrongAccess.reason).toContain("CHILD_IDENTITY_MISMATCH");

		expect(await h.schedulerStore.listIntents()).toEqual([]);
	});

	it("executeChild declines a terminal child and re-accepts nothing", async () => {
		await seedFixture();
		const port = makePort(AUTHORITY);
		expect((await port.executeChild(request())).accepted).toBe(true);
		await markSucceeded(CHILD_MISSION_ID);

		const receipt = await port.executeChild(request());
		expect(receipt.accepted).toBe(false);
		expect(receipt.reason).toContain("MISSION_TERMINAL");
		expect(receipt.reason).toContain("SUCCEEDED");
		// The terminal child keeps its single original intent.
		expect(await h.schedulerStore.listIntents()).toEqual([`intent_${CHILD_MISSION_ID}`]);
	});

	it("childStatus polls mission state and terminal outcome through existing stores", async () => {
		await seedFixture();
		const port = makePort(AUTHORITY);

		const before = await port.childStatus(request());
		expect(before).toEqual({
			orchestrationId: ORCHESTRATION_ID,
			nodeId: "n1",
			childMissionId: CHILD_MISSION_ID,
			childSessionId: CHILD_SESSION_ID,
			missionState: "CREATED",
			terminal: false,
			success: false,
			workers: [{ workerId: h.worker.workerId, daemonState: "STOPPED", activity: "IDLE" }],
		});

		expect((await port.executeChild(request())).accepted).toBe(true);
		const enqueued = await port.childStatus(request());
		expect(enqueued.missionState).toBe("CREATED");
		expect(enqueued.terminal).toBe(false);
		expect(enqueued.intent).toEqual({ intentId: `intent_${CHILD_MISSION_ID}`, state: "PENDING" });
		expect(enqueued.workers).toEqual([{ workerId: h.worker.workerId, daemonState: "STOPPED", activity: "IDLE" }]);

		await markSucceeded(CHILD_MISSION_ID);
		const terminal = await port.childStatus(request());
		expect(terminal.missionState).toBe("SUCCEEDED");
		expect(terminal.terminal).toBe(true);
		expect(terminal.success).toBe(true);
		expect(terminal.intent?.state).toBe("PENDING");

		// A never-materialized child is reported as MISSING, never fabricated.
		const missing = await port.childStatus(request({ childMissionId: "mission_never_materialized" }));
		expect(missing.missionState).toBe("MISSING");
		expect(missing.terminal).toBe(false);
		expect(missing.intent).toBeUndefined();
	});
});
