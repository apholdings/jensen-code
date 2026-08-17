/**
 * OrchestrationLifecycleExecutor — parent lifecycle executor contract tests.
 *
 * Deterministic: file stores in a temp directory, mock recording ports for
 * the authority-resolution, launch-request, and child status polling
 * contracts, and (for the end-to-end pass) the real
 * SchedulerWorkerChildExecutionPort over the real Scheduler/Assignment/Worker
 * chain. The executor never launches anything — the tests assert no worker
 * start, no resume launch, and no mission state change beyond what the port
 * itself performs (one durable scheduling intent, idempotently reused).
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
	type DurableMissionStore,
	type MissionOrchestrationExecution,
} from "../../src/core/mission-domain/index.js";
import { createFileDurableMissionStore } from "../../src/core/mission-durable/index.js";
import {
	createFileOrchestrationStore,
	createOrchestrationLifecycleExecutor,
	type OrchestrationChildExecutionPort,
	type OrchestrationChildExecutionReceipt,
	type OrchestrationChildExecutionRequest,
	type OrchestrationChildExecutionStatus,
	type OrchestrationNode,
	type OrchestrationPlanDocument,
	type OrchestrationStore,
	OrchestratorService,
	SchedulerWorkerChildExecutionPort,
} from "../../src/core/orchestration/index.js";
import { FileSchedulerStore, SchedulerControlService } from "../../src/core/scheduler/index.js";
import { WorkerControlService } from "../../src/core/worker-daemon/index.js";

interface RecordingPort extends OrchestrationChildExecutionPort {
	requests: OrchestrationChildExecutionRequest[];
	statusRequests: OrchestrationChildExecutionRequest[];
}

function recordPort(
	authority: string,
	respond?: (request: OrchestrationChildExecutionRequest) => OrchestrationChildExecutionReceipt,
	status?: (request: OrchestrationChildExecutionRequest) => OrchestrationChildExecutionStatus,
): RecordingPort {
	const requests: OrchestrationChildExecutionRequest[] = [];
	const statusRequests: OrchestrationChildExecutionRequest[] = [];
	const port: RecordingPort = {
		authority,
		requests,
		statusRequests,
		async executeChild(request) {
			requests.push(request);
			return respond ? respond(request) : { accepted: true, authority };
		},
	};
	if (status)
		port.childStatus = (request) => {
			statusRequests.push(request);
			return Promise.resolve(status(request));
		};
	return port;
}

function planNode(nodeId: string, overrides: Partial<OrchestrationNode> = {}): OrchestrationNode {
	return {
		nodeId,
		role: `${nodeId}-role`,
		nodeKind: "CHILD",
		objective: `${nodeId} objective`,
		agent: "worker",
		executionMode: "observe",
		requirement: "REQUIRED",
		workspaceAccess: "WRITE",
		status: "MATERIALIZED",
		acceptanceCriteria: [],
		dependencyCriticality: 0,
		...overrides,
	};
}

function planDocument(
	orchestrationId: string,
	parentMissionId: string,
	nodes: OrchestrationNode[],
): OrchestrationPlanDocument {
	return {
		schemaVersion: 1,
		plan: {
			schemaVersion: 1,
			orchestrationId,
			parentMissionId,
			decision: "FANOUT",
			rationale: "lifecycle executor test plan",
			nodes,
			edges: [],
			revision: 2,
			state: "ACTIVE",
			maxDepth: 2,
			maxChildrenPerNode: 20,
			maxTotalLogicalAgents: 20,
			maxReplans: 2,
			replanCount: 0,
			createdAtMs: 1,
			updatedAtMs: 1,
		},
		revisions: [],
	};
}

async function seedParent(
	missions: DurableMissionStore,
	missionId: string,
	orchestrationExecution?: MissionOrchestrationExecution,
): Promise<void> {
	await missions.create(
		createDurableMissionRecord({
			request: createMissionRequest({
				missionId,
				objective: "Drive the orchestration",
				agent: "worker",
				executionMode: "execute",
				acceptanceCriteria: [],
				orchestrationExecution,
			}),
			now: 1,
		}),
	);
}

describe("OrchestrationLifecycleExecutor", () => {
	let root: string;
	let missions: DurableMissionStore;
	let store: OrchestrationStore;

	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), "jensen-orch-lifecycle-"));
		missions = createFileDurableMissionStore(path.join(root, "missions"));
		store = createFileOrchestrationStore(path.join(root, "orchestrations"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("resolves the named authority and presents only materialized nodes to it", async () => {
		await seedParent(missions, "mission_parent", {
			orchestrationId: "orch_exec",
			childExecutionAuthority: "beta",
		});
		await store.create(
			planDocument("orch_exec", "mission_parent", [
				planNode("n1", { childMissionId: "mission_orch_exec_n1", childSessionId: "child_orch_exec_n1" }),
				planNode("n2", { status: "BLOCKED" }),
			]),
		);
		const alpha = recordPort("alpha");
		const beta = recordPort("beta");
		const executor = createOrchestrationLifecycleExecutor({ missions, store, ports: [alpha, beta] });

		const outcome = await executor.launchChildren("mission_parent");

		// Only the authority named by the parent's durable contract is used.
		expect(alpha.requests).toEqual([]);
		expect(beta.requests).toEqual([
			{
				orchestrationId: "orch_exec",
				nodeId: "n1",
				childMissionId: "mission_orch_exec_n1",
				childSessionId: "child_orch_exec_n1",
				workspaceAccess: "WRITE",
			},
		]);
		expect(outcome).toEqual({
			parentMissionId: "mission_parent",
			orchestrationId: "orch_exec",
			authority: "beta",
			nodes: [
				{
					nodeId: "n1",
					materialized: true,
					launched: true,
					receipt: { accepted: true, authority: "beta" },
				},
				{ nodeId: "n2", materialized: false, launched: false },
			],
			materializedCount: 1,
			launchedCount: 1,
			declinedCount: 0,
		});
	});

	it("never defaults: an unregistered named authority rejects and no port is called", async () => {
		await seedParent(missions, "mission_parent", {
			orchestrationId: "orch_exec",
			childExecutionAuthority: "gamma",
		});
		await store.create(
			planDocument("orch_exec", "mission_parent", [
				planNode("n1", { childMissionId: "mission_orch_exec_n1", childSessionId: "child_orch_exec_n1" }),
			]),
		);
		const alpha = recordPort("alpha");
		const executor = createOrchestrationLifecycleExecutor({ missions, store, ports: [alpha] });

		await expect(executor.launchChildren("mission_parent")).rejects.toThrow(
			"AUTHORITY_NOT_REGISTERED: no child execution authority registered for 'gamma'",
		);
		expect(alpha.requests).toEqual([]);
	});

	it("rejects a parent mission without an orchestration execution contract", async () => {
		await seedParent(missions, "mission_bare", undefined);
		const alpha = recordPort("alpha");
		const executor = createOrchestrationLifecycleExecutor({ missions, store, ports: [alpha] });

		await expect(executor.launchChildren("mission_bare")).rejects.toThrow(
			"NO_ORCHESTRATION_EXECUTION_CONTRACT: mission_bare names no orchestration execution",
		);
		expect(alpha.requests).toEqual([]);
	});

	it("rejects a missing parent mission", async () => {
		const executor = createOrchestrationLifecycleExecutor({ missions, store, ports: [recordPort("alpha")] });
		await expect(executor.launchChildren("mission_missing")).rejects.toThrow(
			"PARENT_MISSION_NOT_FOUND: mission_missing",
		);
	});

	it("rejects a contract naming a missing plan", async () => {
		await seedParent(missions, "mission_parent", {
			orchestrationId: "orch_missing",
			childExecutionAuthority: "alpha",
		});
		const alpha = recordPort("alpha");
		const executor = createOrchestrationLifecycleExecutor({ missions, store, ports: [alpha] });

		await expect(executor.launchChildren("mission_parent")).rejects.toThrow("ORCHESTRATION_NOT_FOUND: orch_missing");
		expect(alpha.requests).toEqual([]);
	});

	it("rejects a plan owned by a different parent", async () => {
		await store.create(planDocument("orch_exec", "mission_other", [planNode("n1")]));
		await seedParent(missions, "mission_parent", {
			orchestrationId: "orch_exec",
			childExecutionAuthority: "alpha",
		});
		const alpha = recordPort("alpha");
		const executor = createOrchestrationLifecycleExecutor({ missions, store, ports: [alpha] });

		await expect(executor.launchChildren("mission_parent")).rejects.toThrow(
			"ORCHESTRATION_PARENT_MISMATCH: orchestration orch_exec belongs to mission_other, not mission_parent",
		);
		expect(alpha.requests).toEqual([]);
	});

	it("relays port declines as the authoritative per-node outcome", async () => {
		await seedParent(missions, "mission_parent", {
			orchestrationId: "orch_exec",
			childExecutionAuthority: "beta",
		});
		await store.create(
			planDocument("orch_exec", "mission_parent", [
				planNode("n1", { childMissionId: "mission_orch_exec_n1", childSessionId: "child_orch_exec_n1" }),
				planNode("n2", {
					childMissionId: "mission_orch_exec_n2",
					childSessionId: "child_orch_exec_n2",
					workspaceAccess: "READ_ONLY",
				}),
				planNode("n3", { status: "BLOCKED" }),
			]),
		);
		const beta = recordPort("beta", (request) =>
			request.workspaceAccess === "WRITE"
				? { accepted: false, authority: "beta", reason: "workspace write not authorized" }
				: { accepted: true, authority: "beta" },
		);
		const executor = createOrchestrationLifecycleExecutor({ missions, store, ports: [beta] });

		const outcome = await executor.launchChildren("mission_parent");

		expect(outcome.launchedCount).toBe(1);
		expect(outcome.declinedCount).toBe(1);
		expect(outcome.materializedCount).toBe(2);
		expect(outcome.nodes).toEqual([
			{
				nodeId: "n1",
				materialized: true,
				launched: false,
				receipt: { accepted: false, authority: "beta", reason: "workspace write not authorized" },
			},
			{ nodeId: "n2", materialized: true, launched: true, receipt: { accepted: true, authority: "beta" } },
			{ nodeId: "n3", materialized: false, launched: false },
		]);
	});

	it("exposes the resolved port and registered authorities", async () => {
		await seedParent(missions, "mission_parent", {
			orchestrationId: "orch_exec",
			childExecutionAuthority: "beta",
		});
		const alpha = recordPort("alpha");
		const beta = recordPort("beta");
		const executor = createOrchestrationLifecycleExecutor({ missions, store, ports: [alpha, beta] });

		expect(executor.authorities).toEqual(["alpha", "beta"]);
		expect(await executor.resolvePort("mission_parent")).toBe(beta);
	});

	it("fails construction on a duplicate authority identity", () => {
		expect(() =>
			createOrchestrationLifecycleExecutor({ missions, store, ports: [recordPort("dup"), recordPort("dup")] }),
		).toThrow("DUPLICATE_AUTHORITY: child execution authority 'dup' is registered twice");
	});

	it("polls status through the named authority using the node's durable identity", async () => {
		await seedParent(missions, "mission_parent", {
			orchestrationId: "orch_exec",
			childExecutionAuthority: "beta",
		});
		await store.create(
			planDocument("orch_exec", "mission_parent", [
				planNode("n1", {
					childMissionId: "mission_orch_exec_n1",
					childSessionId: "child_orch_exec_n1",
				}),
				planNode("n2", { status: "BLOCKED" }),
			]),
		);
		const alpha = recordPort("alpha");
		const polled = {
			orchestrationId: "orch_exec",
			nodeId: "n1",
			childMissionId: "mission_orch_exec_n1",
			childSessionId: "child_orch_exec_n1",
			missionState: "RUNNING" as const,
			terminal: false,
			success: false,
			workers: [],
		};
		const beta = recordPort("beta", undefined, () => polled);
		const executor = createOrchestrationLifecycleExecutor({ missions, store, ports: [alpha, beta] });

		const status = await executor.childStatus("mission_parent", "n1");

		// The named authority's poll is authoritative and is built from the
		// node's durable identity — the caller supplied only the node id.
		expect(status).toEqual(polled);
		expect(beta.statusRequests).toEqual([
			{
				orchestrationId: "orch_exec",
				nodeId: "n1",
				childMissionId: "mission_orch_exec_n1",
				childSessionId: "child_orch_exec_n1",
				workspaceAccess: "WRITE",
			},
		]);
		// Status polling is read-only: no launch request reaches any port.
		expect(alpha.statusRequests).toEqual([]);
		expect(alpha.requests).toEqual([]);
		expect(beta.requests).toEqual([]);
	});

	it("rejects status polling when the named authority has no childStatus implementation", async () => {
		await seedParent(missions, "mission_parent", {
			orchestrationId: "orch_exec",
			childExecutionAuthority: "alpha",
		});
		await store.create(
			planDocument("orch_exec", "mission_parent", [
				planNode("n1", { childMissionId: "mission_orch_exec_n1", childSessionId: "child_orch_exec_n1" }),
			]),
		);
		const alpha = recordPort("alpha");
		const executor = createOrchestrationLifecycleExecutor({ missions, store, ports: [alpha] });

		await expect(executor.childStatus("mission_parent", "n1")).rejects.toThrow(
			"PORT_LACKS_CHILD_STATUS: child execution authority 'alpha' does not provide child status polling",
		);
		// A missing implementation never falls back to another registered port.
		expect(alpha.statusRequests).toEqual([]);
	});

	it("rejects status polling for an unmaterialized or unknown node", async () => {
		await seedParent(missions, "mission_parent", {
			orchestrationId: "orch_exec",
			childExecutionAuthority: "alpha",
		});
		await store.create(
			planDocument("orch_exec", "mission_parent", [
				planNode("n1", { childMissionId: "mission_orch_exec_n1", childSessionId: "child_orch_exec_n1" }),
				planNode("n2", { status: "BLOCKED" }),
			]),
		);
		const alpha = recordPort("alpha", undefined, () => {
			throw new Error("should not be called");
		});
		const executor = createOrchestrationLifecycleExecutor({ missions, store, ports: [alpha] });

		await expect(executor.childStatus("mission_parent", "n2")).rejects.toThrow(
			"CHILD_NOT_MATERIALIZED: node n2 has no materialized child mission",
		);
		await expect(executor.childStatus("mission_parent", "nX")).rejects.toThrow(
			"NODE_NOT_FOUND: orchestration orch_exec has no node nX",
		);
		// Neither invalid node ever reaches the port.
		expect(alpha.statusRequests).toEqual([]);
	});

	it("rejects status polling with the launch-pass error contract", async () => {
		let alpha = recordPort("alpha");
		let executor = createOrchestrationLifecycleExecutor({ missions, store, ports: [alpha] });
		await expect(executor.childStatus("mission_missing", "n1")).rejects.toThrow(
			"PARENT_MISSION_NOT_FOUND: mission_missing",
		);

		await seedParent(missions, "mission_bare", undefined);
		alpha = recordPort("alpha");
		executor = createOrchestrationLifecycleExecutor({ missions, store, ports: [alpha] });
		await expect(executor.childStatus("mission_bare", "n1")).rejects.toThrow(
			"NO_ORCHESTRATION_EXECUTION_CONTRACT: mission_bare names no orchestration execution",
		);
		expect(alpha.statusRequests).toEqual([]);

		await seedParent(missions, "mission_gamma", {
			orchestrationId: "orch_exec",
			childExecutionAuthority: "gamma",
		});
		alpha = recordPort("alpha");
		executor = createOrchestrationLifecycleExecutor({ missions, store, ports: [alpha] });
		await expect(executor.childStatus("mission_gamma", "n1")).rejects.toThrow(
			"AUTHORITY_NOT_REGISTERED: no child execution authority registered for 'gamma'",
		);
		expect(alpha.statusRequests).toEqual([]);

		await seedParent(missions, "mission_noplan", {
			orchestrationId: "orch_missing",
			childExecutionAuthority: "alpha",
		});
		alpha = recordPort("alpha");
		executor = createOrchestrationLifecycleExecutor({ missions, store, ports: [alpha] });
		await expect(executor.childStatus("mission_noplan", "n1")).rejects.toThrow(
			"ORCHESTRATION_NOT_FOUND: orch_missing",
		);
		expect(alpha.statusRequests).toEqual([]);

		await store.create(
			planDocument("orch_exec", "mission_other", [
				planNode("n1", { childMissionId: "mission_orch_exec_n1", childSessionId: "child_orch_exec_n1" }),
			]),
		);
		await seedParent(missions, "mission_mismatch", {
			orchestrationId: "orch_exec",
			childExecutionAuthority: "alpha",
		});
		alpha = recordPort("alpha");
		executor = createOrchestrationLifecycleExecutor({ missions, store, ports: [alpha] });
		await expect(executor.childStatus("mission_mismatch", "n1")).rejects.toThrow(
			"ORCHESTRATION_PARENT_MISMATCH: orchestration orch_exec belongs to mission_other, not mission_mismatch",
		);
		expect(alpha.statusRequests).toEqual([]);
	});
});

describe("OrchestrationLifecycleExecutor end-to-end through SchedulerWorkerChildExecutionPort", () => {
	const AUTHORITY = "scheduler_authority";
	const ORCHESTRATION_ID = "orch_pw";
	const CHILD_MISSION_ID = `mission_orch_${ORCHESTRATION_ID}_n1`;

	let h: {
		root: string;
		missions: ReturnType<typeof createFileDurableMissionStore>;
		scheduler: SchedulerControlService;
		schedulerStore: FileSchedulerStore;
		orchestration: ReturnType<typeof createFileOrchestrationStore>;
		worker: WorkerControlService;
		launchCalls: string[];
		now(): number;
		advance(ms: number): void;
	};

	beforeEach(() => {
		const root = mkdtempSync(path.join(tmpdir(), "jensen-orch-lifecycle-e2e-"));
		const sessionDir = path.join(root, "sessions");
		const missionStore = createFileDurableMissionStore(path.join(root, "missions"));
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
		h = {
			root,
			missions: missionStore,
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
	});

	afterEach(() => {
		rmSync(h.root, { recursive: true, force: true });
	});

	async function seedOrchestration(): Promise<void> {
		await h.missions.create(
			createDurableMissionRecord({
				request: createMissionRequest({
					missionId: "mission_parent",
					objective: "Drive the orchestration to completion",
					agent: "worker",
					executionMode: "execute",
					acceptanceCriteria: [],
					workspaceScope: { cwd: h.root },
					childSessionId: "session_mission_parent",
					orchestrationExecution: {
						orchestrationId: ORCHESTRATION_ID,
						childExecutionAuthority: AUTHORITY,
					},
				}),
				now: h.now(),
			}),
		);
		const service = new OrchestratorService({
			store: h.orchestration,
			missions: h.missions,
			sessionDir: path.join(h.root, "sessions"),
			orchestrationIdFactory: () => ORCHESTRATION_ID,
		});
		await service.create({
			parentMissionId: "mission_parent",
			proposal: {
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
			},
		});
		await service.materializeReady(ORCHESTRATION_ID);
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

	it("launches the materialized child through the named port and never launches itself", async () => {
		await seedOrchestration();
		const port = new SchedulerWorkerChildExecutionPort({
			authority: AUTHORITY,
			missions: h.missions,
			store: h.orchestration,
			scheduler: h.scheduler,
			workers: [h.worker],
			now: h.now,
		});
		const shadow = recordPort("shadow_authority");
		const executor = createOrchestrationLifecycleExecutor({
			missions: h.missions,
			store: h.orchestration,
			ports: [shadow, port],
		});

		const outcome = await executor.launchChildren("mission_parent");

		// The named authority handled the pass; the other registered port
		// was never consulted.
		expect(shadow.requests).toEqual([]);
		expect(outcome.authority).toBe(AUTHORITY);
		expect(outcome.orchestrationId).toBe(ORCHESTRATION_ID);
		expect(outcome.nodes).toEqual([
			{
				nodeId: "n1",
				materialized: true,
				launched: true,
				receipt: { accepted: true, authority: AUTHORITY },
			},
			{ nodeId: "n2", materialized: false, launched: false },
		]);
		expect(outcome.materializedCount).toBe(1);
		expect(outcome.launchedCount).toBe(1);
		expect(outcome.declinedCount).toBe(0);

		// The port performed its one and only side effect (one durable
		// scheduling intent). The executor and the worker launched nothing.
		expect(await h.schedulerStore.listIntents()).toEqual([`intent_${CHILD_MISSION_ID}`]);
		expect(h.worker.daemonState).toBe("STOPPED");
		expect(h.launchCalls).toEqual([]);
		const child = await h.missions.load(CHILD_MISSION_ID);
		if (child.status !== "ok") throw new Error(`expected child mission to load, got ${child.status}`);
		expect(child.record.state).toBe("CREATED");
		expect(child.record.attempts).toEqual([]);
	});

	it("is idempotent across repeated launch passes (one intent, no re-launch)", async () => {
		await seedOrchestration();
		const port = new SchedulerWorkerChildExecutionPort({
			authority: AUTHORITY,
			missions: h.missions,
			store: h.orchestration,
			scheduler: h.scheduler,
			workers: [h.worker],
			now: h.now,
		});
		const executor = createOrchestrationLifecycleExecutor({
			missions: h.missions,
			store: h.orchestration,
			ports: [port],
		});

		const first = await executor.launchChildren("mission_parent");
		h.advance(10);
		const second = await executor.launchChildren("mission_parent");

		expect(first.launchedCount).toBe(1);
		expect(second.launchedCount).toBe(1);
		// The port's deterministic intent id keeps exactly one queue entry
		// across passes; nothing was launched in between.
		expect(await h.schedulerStore.listIntents()).toEqual([`intent_${CHILD_MISSION_ID}`]);
		const detail = await h.scheduler.getIntentForMission(CHILD_MISSION_ID);
		expect(detail.state).toBe("PENDING");
		expect(h.worker.daemonState).toBe("STOPPED");
		expect(h.launchCalls).toEqual([]);
		const child = await h.missions.load(CHILD_MISSION_ID);
		if (child.status !== "ok") throw new Error(`expected child mission to load, got ${child.status}`);
		expect(child.record.state).toBe("CREATED");
		expect(child.record.attempts).toEqual([]);
	});

	it("polls child status through the named authority across the mission lifecycle", async () => {
		await seedOrchestration();
		const port = new SchedulerWorkerChildExecutionPort({
			authority: AUTHORITY,
			missions: h.missions,
			store: h.orchestration,
			scheduler: h.scheduler,
			workers: [h.worker],
			now: h.now,
		});
		const shadow = recordPort("shadow_authority");
		const executor = createOrchestrationLifecycleExecutor({
			missions: h.missions,
			store: h.orchestration,
			ports: [shadow, port],
		});

		// Before any launch pass: created child, no scheduling intent yet.
		const before = await executor.childStatus("mission_parent", "n1");
		expect(before).toEqual({
			orchestrationId: ORCHESTRATION_ID,
			nodeId: "n1",
			childMissionId: CHILD_MISSION_ID,
			childSessionId: `child_orch_${ORCHESTRATION_ID}_n1`,
			missionState: "CREATED",
			terminal: false,
			success: false,
			workers: [{ workerId: h.worker.workerId, daemonState: "STOPPED", activity: "IDLE" }],
		});

		// Status polling alone never launches: no intent, no worker start.
		expect(await h.schedulerStore.listIntents()).toEqual([]);
		expect(h.launchCalls).toEqual([]);

		// After the launch pass: the single durable intent is visible.
		const launch = await executor.launchChildren("mission_parent");
		expect(launch.launchedCount).toBe(1);
		const enqueued = await executor.childStatus("mission_parent", "n1");
		expect(enqueued.missionState).toBe("CREATED");
		expect(enqueued.terminal).toBe(false);
		expect(enqueued.intent).toEqual({ intentId: `intent_${CHILD_MISSION_ID}`, state: "PENDING" });

		// After the child reaches a terminal success: the poll reports it.
		await markSucceeded(CHILD_MISSION_ID);
		const terminal = await executor.childStatus("mission_parent", "n1");
		expect(terminal.missionState).toBe("SUCCEEDED");
		expect(terminal.terminal).toBe(true);
		expect(terminal.success).toBe(true);
		expect(terminal.intent?.state).toBe("PENDING");

		// The blocked node is never materialized; the executor reports that
		// instead of polling an identity it cannot verify.
		await expect(executor.childStatus("mission_parent", "n2")).rejects.toThrow(
			"CHILD_NOT_MATERIALIZED: node n2 has no materialized child mission",
		);

		// Only the named authority was consulted for status.
		expect(shadow.statusRequests).toEqual([]);
		expect(shadow.requests).toEqual([]);
	});
});
