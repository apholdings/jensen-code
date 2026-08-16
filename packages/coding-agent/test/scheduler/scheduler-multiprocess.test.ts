/**
 * Scheduler Foundation — multiprocess race tests (2.12.0).
 *
 * Genuinely separate OS processes prove:
 *   - concurrent scheduler ticks produce exactly one durable assignment;
 *   - concurrent enqueue of the same mission is idempotent (one intent record).
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AssignmentControlService, FileAssignmentStore } from "../../src/core/assignment/index.js";
import { ExecutorControlService, FileExecutorRegistry } from "../../src/core/executor-registry/index.js";
import { createDurableMissionRecord, createMissionRequest } from "../../src/core/mission-domain/index.js";
import { FileDurableMissionStore } from "../../src/core/mission-durable/index.js";
import { FileSchedulerStore, SchedulerControlService } from "../../src/core/scheduler/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../../");
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const TICK_WORKER = path.join(__dirname, "fixtures", "scheduler-tick-worker.ts");

function makeRoot(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

interface Spawned {
	stdout: string;
	stderr: string;
	exited: Promise<{ code: number | null; signal: string | null }>;
}

function spawnWorker(args: string[]): Spawned {
	const child = spawn(process.execPath, [TSX_CLI, TICK_WORKER, ...args], {
		cwd: REPO_ROOT,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (data: Buffer) => {
		stdout += data.toString();
	});
	child.stderr.on("data", (data: Buffer) => {
		stderr += data.toString();
	});
	const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
		child.on("exit", (code, signal) => resolve({ code, signal }));
	});
	return {
		get stdout() {
			return stdout;
		},
		get stderr() {
			return stderr;
		},
		exited,
	};
}

function lastLine(spawned: Spawned): Record<string, unknown> {
	const line = spawned.stdout.trim().split("\n").filter(Boolean).at(-1);
	return line ? (JSON.parse(line) as Record<string, unknown>) : {};
}

interface RootServices {
	root: string;
	missionStore: FileDurableMissionStore;
	executors: ExecutorControlService;
	assignments: AssignmentControlService;
	scheduler: SchedulerControlService;
}

function services(root: string): RootServices {
	const missionStore = new FileDurableMissionStore({ root: `${root}/missions` });
	const executors = new ExecutorControlService({
		store: new FileExecutorRegistry({ root: `${root}/executors` }),
		expiryMs: 30_000,
	});
	const assignments = new AssignmentControlService({
		store: new FileAssignmentStore({ root: `${root}/assignments` }),
		missions: missionStore,
		executors,
	});
	const scheduler = new SchedulerControlService({
		store: new FileSchedulerStore({ root: `${root}/intents` }),
		missions: missionStore,
		executors,
		assignments,
	});
	return { root, missionStore, executors, assignments, scheduler };
}

async function seedMission(store: FileDurableMissionStore, missionId: string): Promise<void> {
	await store.create(
		createDurableMissionRecord({
			request: createMissionRequest({
				missionId,
				objective: `objective of ${missionId}`,
				agent: "worker",
				executionMode: "execute",
				acceptanceCriteria: [],
			}),
			now: 1,
		}),
	);
}

let root: string;
let svc: RootServices;

beforeEach(async () => {
	root = makeRoot("scheduler-mp-");
	svc = services(root);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("TEST A — CROSS_PROCESS_TICK_RACE", () => {
	it("concurrent ticks yield exactly one durable assignment and one ASSIGNED intent", async () => {
		await seedMission(svc.missionStore, "mission_tick_race");
		await svc.executors.registerExecutor({
			executorId: "exec_tick",
			configuredCapabilities: { platform: { os: "linux", arch: "x64" } },
		});
		await svc.executors.activateExecutor("exec_tick", { platform: "linux", arch: "x64" });
		await svc.scheduler.enqueueIntent("mission_tick_race");

		const a = spawnWorker(["--root", root, "--op", "tick"]);
		const b = spawnWorker(["--root", root, "--op", "tick"]);

		await Promise.all([a.exited, b.exited]);
		const resultA = lastLine(a);
		const resultB = lastLine(b);

		expect(resultA.t).toBe("tick_ok");
		expect(resultB.t).toBe("tick_ok");

		const assignmentIds = new Set(
			[resultA, resultB].map((r) => r.assignmentId).filter((id): id is string => typeof id === "string"),
		);
		// Both processes converge on the same authoritative assignment id.
		expect(assignmentIds.size).toBe(1);
		// Exactly one process created the assignment; the other reconciled.
		const created = [resultA, resultB].filter((r) => r.assignmentsCreated === 1);
		expect(created).toHaveLength(1);

		const current = await svc.assignments.getCurrentForMission("mission_tick_race");
		expect(current?.assignmentId).toBe([...assignmentIds][0]);

		const intent = await svc.scheduler.getIntentForMission("mission_tick_race");
		expect(intent.state).toBe("ASSIGNED");
		expect(intent.assignmentId).toBe(current?.assignmentId);

		const records = await svc.assignments.listForMission("mission_tick_race");
		expect(records.filter((r) => r.current)).toHaveLength(1);
	});
});

describe("TEST B — CROSS_PROCESS_ENQUEUE_RACE", () => {
	it("concurrent enqueue of the same mission is idempotent (one intent record)", async () => {
		await seedMission(svc.missionStore, "mission_enqueue_race");

		const a = spawnWorker(["--root", root, "--op", "enqueue", "--missionId", "mission_enqueue_race"]);
		const b = spawnWorker(["--root", root, "--op", "enqueue", "--missionId", "mission_enqueue_race"]);

		await Promise.all([a.exited, b.exited]);
		const resultA = lastLine(a);
		const resultB = lastLine(b);

		expect(resultA.t).toBe("enqueue_ok");
		expect(resultB.t).toBe("enqueue_ok");

		const statuses = [resultA.status, resultB.status].sort();
		expect(statuses).toEqual(["created", "idempotent"]);

		const detail = await svc.scheduler.getIntentForMission("mission_enqueue_race");
		expect(detail.state).toBe("PENDING");
		const ids = await svc.scheduler.store.listIntents();
		expect(ids).toEqual(["intent_mission_enqueue_race"]);
	});
});
