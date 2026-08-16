/**
 * Capability Routing Foundation — deterministic tests (2.15.0).
 *
 * Pure evaluator tests prove requirements+snapshots → candidates without any
 * Scheduler/Worker/SSH/Qwen side effects. Scheduler-integration tests prove the
 * router reports feasibility while the Scheduler still selects and creates the
 * durable Assignment via its existing policy.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MissionRequirements } from "../../src/core/assignment/assignment-types.js";
import { AssignmentControlService, FileAssignmentStore } from "../../src/core/assignment/index.js";
import { CapabilityRouter, evaluateRouteCandidates } from "../../src/core/capability-routing/index.js";
import type { ExecutionRoute, RouteCandidate } from "../../src/core/capability-routing/route-types.js";
import type { ExecutorCapabilities } from "../../src/core/executor-registry/index.js";
import { ExecutorControlService, FileExecutorRegistry } from "../../src/core/executor-registry/index.js";
import {
	createDurableMissionRecord,
	createMissionRequest,
	type MissionRequest,
} from "../../src/core/mission-domain/index.js";
import { FileDurableMissionStore } from "../../src/core/mission-durable/index.js";
import type {
	RemoteTargetLoadResult,
	RemoteTargetRegisterResult,
	RemoteTargetStore,
} from "../../src/core/remote-execution/remote-target-registry.js";
import { RemoteTargetRegistry } from "../../src/core/remote-execution/remote-target-registry.js";
import type { RemoteExecutionTarget, RemoteTargetHealth } from "../../src/core/remote-execution/remote-target-types.js";
import { FileSchedulerStore, SchedulerControlService } from "../../src/core/scheduler/index.js";

// =============================================================================
// Pure evaluator helpers
// =============================================================================

const LINUX_X64: ExecutorCapabilities = {
	platform: { os: "linux", arch: "x64" },
	execution: ["node", "git"],
	tools: ["bash", "read", "edit"],
	specialized: [],
	extra: [],
};

const WINDOWS_X64: ExecutorCapabilities = {
	platform: { os: "windows", arch: "x64" },
	execution: ["node", "git"],
	tools: ["powershell"],
	specialized: [],
	extra: [],
};

function route(overrides: Partial<ExecutionRoute> & { executorId: string }): ExecutionRoute {
	return {
		executionMode: "local",
		remoteTargetId: undefined,
		platform: "linux",
		arch: "x64",
		capabilities: LINUX_X64,
		status: "ONLINE",
		retired: false,
		...overrides,
	};
}

function candidates(requirements: MissionRequirements, routes: ExecutionRoute[]): RouteCandidate[] {
	return evaluateRouteCandidates({ requirements, routes, now: 1_000_000 });
}

// =============================================================================
// Pure evaluator tests
// =============================================================================

describe("capability router — pure evaluator", () => {
	it("TEST A — exact capability match is eligible", () => {
		const result = candidates({ execution: ["node"] }, [route({ executorId: "local-node" })]);
		expect(result).toHaveLength(1);
		expect(result[0].executorId).toBe("local-node");
		expect(result[0].eligible).toBe(true);
		expect(result[0].status).toBe("ELIGIBLE");
		expect(result[0].capabilityMatch).toBe(true);
	});

	it("TEST B — missing required capability rejects", () => {
		const result = candidates({ execution: ["docker"] }, [route({ executorId: "local-node" })]);
		expect(result[0].eligible).toBe(false);
		expect(result[0].status).toBe("INELIGIBLE_CAPABILITY");
		expect(result[0].capabilityMatch).toBe(false);
	});

	it("TEST C — unknown capability is rejected, never guessed", () => {
		const result = candidates({ specialized: ["capability_that_no_executor_declares"] }, [
			route({ executorId: "local-node" }),
		]);
		expect(result[0].eligible).toBe(false);
		expect(result[0].status).toBe("INELIGIBLE_CAPABILITY");
		expect(result[0].rejectedRequirements.some((r) => r.kind === "specialized")).toBe(true);
	});

	it("TEST D — Windows requirement rejects Linux executor", () => {
		const result = candidates({ platform: { os: "windows" } }, [route({ executorId: "linux-node" })]);
		expect(result[0].eligible).toBe(false);
		expect(result[0].status).toBe("INELIGIBLE_PLATFORM");
	});

	it("TEST E — Linux requirement rejects Windows-only remote route", () => {
		const result = candidates({ platform: { os: "linux" } }, [
			route({
				executorId: "windows-node",
				executionMode: "remote",
				remoteTargetId: "blackpearl",
				platform: "windows",
				arch: "x64",
				transport: "ssh",
				capabilities: WINDOWS_X64,
			}),
		]);
		expect(result[0].eligible).toBe(false);
		expect(result[0].status).toBe("INELIGIBLE_PLATFORM");
	});

	it("TEST F — architecture mismatch rejects route", () => {
		const result = candidates({ platform: { arch: "arm64" } }, [route({ executorId: "x64-node", arch: "x64" })]);
		expect(result[0].eligible).toBe(false);
		expect(result[0].status).toBe("INELIGIBLE_ARCH");
	});

	it("TEST G — local route is represented correctly", () => {
		const result = candidates({ platform: { os: "linux", arch: "x64" } }, [
			route({ executorId: "bucephalus-local" }),
		]);
		expect(result[0].executionMode).toBe("local");
		expect(result[0].remoteTargetId).toBeUndefined();
		expect(result[0].platform).toBe("linux");
		expect(result[0].arch).toBe("x64");
		expect(result[0].eligible).toBe(true);
	});

	it("TEST H — remote route is represented with remoteTargetId", () => {
		const result = candidates({ platform: { os: "windows", arch: "x64" } }, [
			route({
				executorId: "blackpearl-code",
				executionMode: "remote",
				remoteTargetId: "blackpearl",
				transport: "ssh",
				platform: "windows",
				arch: "x64",
				capabilities: WINDOWS_X64,
				targetHealth: health("blackpearl", "reachable"),
			}),
		]);
		expect(result[0].executionMode).toBe("remote");
		expect(result[0].remoteTargetId).toBe("blackpearl");
		expect(result[0].transport).toBe("ssh");
		expect(result[0].eligible).toBe(true);
		expect(result[0].targetHealth?.status).toBe("reachable");
	});

	it("TEST I — worker offline is compatible but unavailable", () => {
		const result = candidates({ execution: ["node"] }, [route({ executorId: "offline-node", status: "OFFLINE" })]);
		expect(result[0].capabilityMatch).toBe(true);
		expect(result[0].workerAvailable).toBe(false);
		expect(result[0].eligible).toBe(false);
		expect(result[0].status).toBe("UNAVAILABLE_WORKER");
	});

	it("TEST J — remote target unreachable makes remote route unavailable", () => {
		const result = candidates({ execution: ["node"] }, [
			route({
				executorId: "blackpearl-code",
				executionMode: "remote",
				remoteTargetId: "blackpearl",
				transport: "ssh",
				platform: "windows",
				arch: "x64",
				capabilities: WINDOWS_X64,
				targetHealth: health("blackpearl", "unreachable"),
			}),
		]);
		expect(result[0].capabilityMatch).toBe(true);
		expect(result[0].targetAvailable).toBe(false);
		expect(result[0].status).toBe("UNAVAILABLE_TARGET");
	});

	it("TEST K — auth failure is distinguished from unreachable", () => {
		const result = candidates({ execution: ["node"] }, [
			route({
				executorId: "blackpearl-code",
				executionMode: "remote",
				remoteTargetId: "blackpearl",
				transport: "ssh",
				platform: "windows",
				arch: "x64",
				capabilities: WINDOWS_X64,
				targetHealth: health("blackpearl", "auth_failed"),
			}),
		]);
		expect(result[0].status).toBe("UNAVAILABLE_TARGET");
		expect(result[0].rejectionReasons.join(" ")).toContain("auth_failed");
	});

	it("TEST L — remote runtime unavailable is distinguished", () => {
		const result = candidates({ execution: ["node"] }, [
			route({
				executorId: "blackpearl-code",
				executionMode: "remote",
				remoteTargetId: "blackpearl",
				transport: "ssh",
				platform: "windows",
				arch: "x64",
				capabilities: WINDOWS_X64,
				targetHealth: health("blackpearl", "runtime_unavailable"),
			}),
		]);
		expect(result[0].status).toBe("UNAVAILABLE_TARGET");
		expect(result[0].rejectionReasons.join(" ")).toContain("runtime_unavailable");
	});

	it("TEST S — every rejection carries a structured reason", () => {
		const result = candidates(
			{ platform: { os: "windows", arch: "arm64" }, execution: ["node"], specialized: ["unity.editor"] },
			[route({ executorId: "linux-node" })],
		);
		expect(result[0].rejectionReasons.length).toBeGreaterThan(0);
		for (const reason of result[0].rejectionReasons) expect(typeof reason).toBe("string");
		expect(result[0].rejectedRequirements.length).toBeGreaterThan(0);
	});

	it("TEST T — identical inputs produce identical candidates", () => {
		const routes = [route({ executorId: "a" }), route({ executorId: "b" })];
		const first = candidates({ execution: ["node"] }, routes);
		const second = candidates({ execution: ["node"] }, routes);
		expect(second).toEqual(first);
	});

	it("TEST V — no inference backend/slot concept leaks into a route", () => {
		const result = candidates({ models: ["qwen3.8-27b"] }, [
			route({ executorId: "with-model", capabilities: { ...LINUX_X64, models: ["qwen3.8-27b"] } }),
			route({ executorId: "no-model" }),
		]);
		for (const candidate of result) {
			expect(Object.keys(candidate).some((key) => /inference|slot|llama/i.test(key))).toBe(false);
		}
		expect(result.find((c) => c.executorId === "with-model")?.eligible).toBe(true);
		expect(result.find((c) => c.executorId === "no-model")?.status).toBe("INELIGIBLE_CAPABILITY");
	});

	it("preferences rank without changing eligibility", () => {
		const result = candidates(
			{ execution: ["node"], preferences: { executionMode: "remote", remoteTargetId: "blackpearl" } },
			[
				route({ executorId: "local-node" }),
				route({
					executorId: "blackpearl-code",
					executionMode: "remote",
					remoteTargetId: "blackpearl",
					transport: "ssh",
					platform: "windows",
					arch: "x64",
					capabilities: WINDOWS_X64,
					targetHealth: health("blackpearl", "reachable"),
				}),
			],
		);
		const remote = result.find((c) => c.executorId === "blackpearl-code");
		const local = result.find((c) => c.executorId === "local-node");
		expect(remote?.eligible).toBe(true);
		expect(local?.eligible).toBe(true);
		expect(remote!.preferenceScore).toBeGreaterThan(local!.preferenceScore);
	});
});

// =============================================================================
// Scheduler integration helpers
// =============================================================================

function health(targetId: string, status: RemoteTargetHealth["status"]): RemoteTargetHealth {
	return { targetId, status, summary: `synthetic ${status}`, observedAtMs: 1_000_000 };
}

class MemoryRemoteTargetStore implements RemoteTargetStore {
	readonly storeId = "memory";
	private readonly targets = new Map<string, RemoteExecutionTarget>();

	constructor(targets: RemoteExecutionTarget[] = []) {
		for (const target of targets) this.targets.set(target.targetId, target);
	}

	async register(target: RemoteExecutionTarget): Promise<RemoteTargetRegisterResult> {
		this.targets.set(target.targetId, target);
		return { status: "created" };
	}

	async load(targetId: string): Promise<RemoteTargetLoadResult> {
		const target = this.targets.get(targetId);
		return target ? { status: "ok", target } : { status: "missing" };
	}

	async listTargets(): Promise<string[]> {
		return [...this.targets.keys()].sort();
	}

	async remove(targetId: string): Promise<boolean> {
		return this.targets.delete(targetId);
	}
}

interface Harness {
	root: string;
	missionStore: FileDurableMissionStore;
	executors: ExecutorControlService;
	assignments: AssignmentControlService;
	scheduler: SchedulerControlService;
	router: CapabilityRouter;
	health: Map<string, RemoteTargetHealth>;
	registerOnlineLocal(executorId: string, caps?: ExecutorCapabilities): Promise<void>;
	registerOnlineRemote(executorId: string, targetId: string, caps?: ExecutorCapabilities): Promise<void>;
	seedMission(missionId: string): Promise<void>;
}

function makeHarness(policy?: "first-fit" | "least-assigned"): Harness {
	const root = mkdtempSync(path.join(tmpdir(), "capability-routing-"));
	const missionStore = new FileDurableMissionStore({ root: path.join(root, "missions") });
	const executorStore = new FileExecutorRegistry({ root: path.join(root, "executors") });
	const assignmentStore = new FileAssignmentStore({ root: path.join(root, "assignments") });
	const schedulerStore = new FileSchedulerStore({ root: path.join(root, "intents") });
	const nowValue = 1_000_000;

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
	const health = new Map<string, RemoteTargetHealth>();
	const targets = new RemoteTargetRegistry({
		store: new MemoryRemoteTargetStore([
			{
				targetId: "blackpearl",
				transport: "ssh",
				host: "blackpearl",
				user: "sparrow",
				platform: "windows",
				arch: "x64",
			},
			{
				targetId: "blackpearl-arm",
				transport: "ssh",
				host: "blackpearl-arm",
				user: "sparrow",
				platform: "windows",
				arch: "arm64",
			},
		]),
	});
	const router = new CapabilityRouter({
		executors,
		targets,
		healthProvider: (targetId) =>
			Promise.resolve(
				health.get(targetId) ?? {
					targetId,
					status: "unknown",
					summary: "no synthetic health",
					observedAtMs: nowValue,
				},
			),
	});
	const scheduler = new SchedulerControlService({
		store: schedulerStore,
		missions: missionStore,
		executors,
		assignments,
		now: () => nowValue,
		policy: { mode: policy ?? "first-fit" },
		tickIdFactory: () => "tick_test",
		router,
	});

	return {
		root,
		missionStore,
		executors,
		assignments,
		scheduler,
		router,
		health,
		async registerOnlineLocal(executorId, caps = LINUX_X64) {
			await executors.registerExecutor({ executorId, configuredCapabilities: caps });
			await executors.activateExecutor(executorId, { platform: caps.platform?.os, arch: caps.platform?.arch });
		},
		async registerOnlineRemote(executorId, targetId, caps = WINDOWS_X64) {
			await executors.registerExecutor({ executorId, configuredCapabilities: caps, remoteTargetId: targetId });
			await executors.activateExecutor(executorId, { platform: caps.platform?.os, arch: caps.platform?.arch });
		},
		async seedMission(missionId) {
			const request: MissionRequest = createMissionRequest({
				missionId,
				objective: `objective of ${missionId}`,
				agent: "worker",
				executionMode: "execute",
				acceptanceCriteria: [],
			});
			await missionStore.create(createDurableMissionRecord({ request, now: 1 }));
		},
	};
}

let h: Harness;

beforeEach(() => {
	h = makeHarness();
});

afterEach(() => {
	rmSync(h.root, { recursive: true, force: true });
});

// =============================================================================
// Scheduler integration tests
// =============================================================================

describe("capability router — scheduler integration", () => {
	it("TEST M — two valid executors remain eligible before policy", async () => {
		await h.registerOnlineLocal("bucephalus-local");
		await h.registerOnlineRemote("blackpearl-code", "blackpearl");
		h.health.set("blackpearl", health("blackpearl", "reachable"));

		const evaluation = await h.router.evaluate({ requirements: { execution: ["node"] } });
		expect(evaluation.eligibleCount).toBe(2);
		expect(evaluation.eligibleExecutorIds).toEqual(["blackpearl-code", "bucephalus-local"]);
	});

	it("TEST N — first-fit selects deterministically and records route provenance", async () => {
		await h.seedMission("mission_n");
		await h.registerOnlineLocal("bucephalus-local");
		await h.registerOnlineRemote("blackpearl-code", "blackpearl");
		h.health.set("blackpearl", health("blackpearl", "reachable"));

		await h.scheduler.enqueueIntent("mission_n", { requirements: { execution: ["node"] } });
		const result = await h.scheduler.runTick();
		expect(result.decisions[0].decision).toBe("ASSIGN");
		expect(result.decisions[0].executorId).toBe("blackpearl-code");
		expect(result.decisions[0].executionMode).toBe("remote");
		expect(result.decisions[0].remoteTargetId).toBe("blackpearl");

		const intent = await h.scheduler.getIntentForMission("mission_n");
		const assignment = await h.assignments.getAssignment(intent.assignmentId ?? "");
		expect(assignment.executionMode).toBe("remote");
		expect(assignment.remoteTargetId).toBe("blackpearl");
	});

	it("TEST O — least-assigned is preserved with the router wired", async () => {
		const g = makeHarness("least-assigned");
		try {
			await g.seedMission("mission_existing");
			await g.seedMission("mission_new");
			await g.registerOnlineLocal("bucephalus-local");
			await g.registerOnlineRemote("blackpearl-code", "blackpearl");
			g.health.set("blackpearl", health("blackpearl", "reachable"));

			await g.assignments.assignMission({ missionId: "mission_existing", executorId: "bucephalus-local" });
			await g.scheduler.enqueueIntent("mission_new", { requirements: { execution: ["node"] } });
			const result = await g.scheduler.runTick();
			expect(result.decisions[0].executorId).toBe("blackpearl-code");
		} finally {
			rmSync(g.root, { recursive: true, force: true });
		}
	});

	it("TEST P — no valid route yields UNSCHEDULABLE", async () => {
		await h.seedMission("mission_p");
		await h.registerOnlineLocal("bucephalus-local");
		await h.registerOnlineRemote("blackpearl-code", "blackpearl");
		h.health.set("blackpearl", health("blackpearl", "unreachable"));

		await h.scheduler.enqueueIntent("mission_p", { requirements: { platform: { os: "windows" } } });
		const result = await h.scheduler.runTick();
		expect(result.decisions[0].decision).toBe("UNSCHEDULABLE");
		expect(result.assignmentsCreated).toBe(0);
		expect((await h.scheduler.getIntentForMission("mission_p")).state).toBe("UNSCHEDULABLE");
	});

	it("TEST Q — UNSCHEDULABLE recovers after availability changes without a new mission", async () => {
		await h.seedMission("mission_q");
		await h.registerOnlineLocal("bucephalus-local");
		await h.registerOnlineRemote("blackpearl-code", "blackpearl");
		h.health.set("blackpearl", health("blackpearl", "unreachable"));

		await h.scheduler.enqueueIntent("mission_q", { requirements: { platform: { os: "windows" } } });
		await h.scheduler.runTick();
		expect((await h.scheduler.getIntentForMission("mission_q")).state).toBe("UNSCHEDULABLE");

		h.health.set("blackpearl", health("blackpearl", "reachable"));
		await h.scheduler.enqueueIntent("mission_q"); // reopen the SAME intent (no new mission)
		const result = await h.scheduler.runTick();
		expect(result.decisions[0].decision).toBe("ASSIGN");
		expect(result.decisions[0].executorId).toBe("blackpearl-code");

		const missions = await h.missionStore.listMissions();
		expect(missions).toEqual(["mission_q"]);
	});

	it("TEST R — preview creates no Assignment", async () => {
		await h.seedMission("mission_r");
		await h.registerOnlineLocal("bucephalus-local");
		await h.registerOnlineRemote("blackpearl-code", "blackpearl");
		h.health.set("blackpearl", health("blackpearl", "reachable"));

		await h.scheduler.enqueueIntent("mission_r", { requirements: { execution: ["node"] } });
		const preview = await h.scheduler.previewTick();
		expect(preview.dryRun).toBe(true);
		expect(preview.decisions[0].decision).toBe("ASSIGN");
		expect((await h.scheduler.getIntentForMission("mission_r")).state).toBe("PENDING");
		expect((await h.assignments.listAssignments()).entries).toHaveLength(0);
	});

	it("TEST U — routing does not modify an active Assignment", async () => {
		await h.seedMission("mission_u");
		await h.registerOnlineLocal("bucephalus-local");
		await h.registerOnlineRemote("blackpearl-code", "blackpearl");
		h.health.set("blackpearl", health("blackpearl", "reachable"));

		const existing = await h.assignments.assignMission({ missionId: "mission_u", executorId: "bucephalus-local" });
		await h.scheduler.enqueueIntent("mission_u", { requirements: { platform: { os: "windows" } } });
		const result = await h.scheduler.runTick();
		expect(result.decisions[0].decision).toBe("RECONCILE");
		expect(result.assignmentsCreated).toBe(0);

		const current = await h.assignments.getCurrentForMission("mission_u");
		expect(current?.assignmentId).toBe(existing.assignmentId);
		expect(current?.executorId).toBe("bucephalus-local");
	});
});
