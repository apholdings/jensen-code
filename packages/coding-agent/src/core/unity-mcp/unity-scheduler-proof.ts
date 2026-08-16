/**
 * Unity MCP Vertical Slice — scheduler designation proof (2.13.0).
 *
 * Proves LOTG Unity participates in Jensen's existing scheduling concepts
 * WITHOUT implementing Worker execution. It registers a logical Unity-capable
 * executor, creates a real durable mission requiring Unity capability, enqueues
 * scheduling intent, runs one scheduler tick, and stops at the durable
 * Assignment. The vertical-slice inspection is then explicitly correlated with
 * the resulting missionId / intentId / assignmentId / executorId.
 *
 * No assignment is accepted or started here. The Worker daemon + remote
 * execution are explicitly out of scope and remain a later slice.
 */

import { join } from "node:path";
import { AssignmentControlService } from "../assignment/assignment-control-service.js";
import type { MissionRequirements } from "../assignment/assignment-types.js";
import { FileAssignmentStore } from "../assignment/file-assignment-store.js";
import type { ExecutorCapabilities } from "../executor-registry/index.js";
import { ExecutorControlService, FileExecutorRegistry } from "../executor-registry/index.js";
import { createDurableMissionRecord, createMissionRequest } from "../mission-domain/index.js";
import { FileDurableMissionStore } from "../mission-durable/index.js";
import { FileSchedulerStore } from "../scheduler/file-scheduler-store.js";
import { SchedulerControlService } from "../scheduler/scheduler-control-service.js";
import type { SchedulingDecisionKind } from "../scheduler/scheduler-types.js";

/** Stable logical executor identity for the LOTG Unity-capable target. */
export const UNITY_EXECUTOR_ID = "blackpearl-unity-lotg";

/** Existing-style capability advertisement using the Executor Registry model. */
export const UNITY_EXECUTOR_CAPABILITIES: ExecutorCapabilities = {
	platform: { os: "windows", arch: "x64" },
	specialized: ["unity.editor", "unity.mcp", "project.lotg"],
};

/** Mission requirement that only a Unity-capable Windows executor can satisfy. */
export const UNITY_MISSION_REQUIREMENTS: MissionRequirements = {
	platform: { os: "windows" },
	specialized: ["unity.editor", "unity.mcp", "project.lotg"],
};

export interface UnitySchedulerProofOptions {
	/** Durable store root (temp dir for tests; agent dir for operator proof). */
	root: string;
	missionId?: string;
	now?: () => number;
	tickIdFactory?: () => string;
}

export interface UnitySchedulerProofResult {
	missionId: string;
	executorId: string;
	intentId: string;
	decision: SchedulingDecisionKind;
	assignmentId?: string;
	reason?: string;
}

/**
 * Run the scheduler designation proof. Deterministic given the same clock; the
 * chosen executor is total-ordered by executorId and the mission requires the
 * Unity specialized capabilities.
 */
export async function runUnitySchedulerProof(options: UnitySchedulerProofOptions): Promise<UnitySchedulerProofResult> {
	const now = options.now ?? (() => Date.now());
	const missionStore = new FileDurableMissionStore({ root: join(options.root, "missions") });
	const executorStore = new FileExecutorRegistry({ root: join(options.root, "executors") });
	const assignmentStore = new FileAssignmentStore({ root: join(options.root, "assignments") });
	const schedulerStore = new FileSchedulerStore({ root: join(options.root, "intents") });

	const executors = new ExecutorControlService({
		store: executorStore,
		now,
		expiryMs: 30_000,
		assignmentStore,
	});
	const assignments = new AssignmentControlService({
		store: assignmentStore,
		missions: missionStore,
		executors,
		now,
	});
	const scheduler = new SchedulerControlService({
		store: schedulerStore,
		missions: missionStore,
		executors,
		assignments,
		now,
		tickIdFactory: options.tickIdFactory ?? (() => "tick_unity_proof"),
	});

	await executors.registerExecutor({
		executorId: UNITY_EXECUTOR_ID,
		displayName: "Blackpearl LOTG Unity Editor",
		labels: ["blackpearl", "lotg"],
		configuredCapabilities: UNITY_EXECUTOR_CAPABILITIES,
	});
	await executors.activateExecutor(UNITY_EXECUTOR_ID, {
		hostname: "blackpearl",
		platform: "windows",
		arch: "x64",
		advertisedCapabilities: { ...UNITY_EXECUTOR_CAPABILITIES, platform: undefined },
	});

	const missionId = options.missionId ?? `mission_unity_proof`;
	const request = createMissionRequest({
		missionId,
		objective: "Inspect the currently open LOTG Unity project on Blackpearl through Unity MCP",
		agent: "worker",
		executionMode: "observe",
		acceptanceCriteria: [],
	});
	await missionStore.create(createDurableMissionRecord({ request, now: now() }));

	const enqueued = await scheduler.enqueueIntent(missionId, { requirements: UNITY_MISSION_REQUIREMENTS });
	const tick = await scheduler.runTick();

	const decision = tick.decisions.find((entry) => entry.missionId === missionId);
	const assignment = await assignments.getCurrentForMission(missionId).catch(() => undefined);

	return {
		missionId,
		executorId: UNITY_EXECUTOR_ID,
		intentId: enqueued.intentId,
		decision: decision?.decision ?? "UNSCHEDULABLE",
		assignmentId: assignment?.assignmentId,
		reason: decision?.reason,
	};
}
