/**
 * Assignment Foundation — multiprocess race / runtime-incarnation tests (2.11.0).
 *
 * Genuinely separate OS processes prove:
 *   - exactly one current assignment after a simultaneous assign race;
 *   - one authoritative current after a simultaneous reassign race;
 *   - a logical assignment survives a real executor runtime restart;
 *   - stale runtime proofs are rejected at a process boundary;
 *   - repeated cross-process churn keeps <=1 current assignment per mission.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../../");
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const MUTATE_WORKER = path.join(__dirname, "fixtures", "assignment-mutate-worker.ts");
const RUNTIME_WORKER = path.join(__dirname, "fixtures", "assignment-runtime-worker.ts");
const STRESS_WORKER = path.join(__dirname, "fixtures", "assignment-stress-worker.ts");

function makeRoot(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

interface Spawned {
	stdout: string;
	stderr: string;
	exited: Promise<{ code: number | null; signal: string | null }>;
	kill: () => void;
}

function spawnWorker(worker: string, args: string[]): Spawned {
	const child = spawn(process.execPath, [TSX_CLI, worker, ...args], {
		cwd: REPO_ROOT,
		stdio: ["ignore", "pipe", "pipe"],
		detached: process.platform !== "win32",
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
	const kill = () => {
		if (child.pid && process.platform !== "win32") {
			try {
				process.kill(-child.pid, "SIGKILL");
				return;
			} catch {
				// fall through
			}
		}
		child.kill("SIGKILL");
	};
	return {
		get stdout() {
			return stdout;
		},
		get stderr() {
			return stderr;
		},
		exited,
		kill,
	};
}

function lastLine(spawned: Spawned): Record<string, unknown> {
	const line = spawned.stdout.trim().split("\n").filter(Boolean).at(-1);
	return line ? (JSON.parse(line) as Record<string, unknown>) : {};
}

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 12_000): Promise<void> {
	const start = Date.now();
	for (;;) {
		if (await predicate()) return;
		if (Date.now() - start > timeoutMs) throw new Error("waitUntil timeout");
		await sleep(25);
	}
}

interface RootServices {
	root: string;
	missionStore: FileDurableMissionStore;
	executorStore: FileExecutorRegistry;
	assignmentStore: FileAssignmentStore;
	executors: ExecutorControlService;
	service: AssignmentControlService;
}

function services(root: string): RootServices {
	const missionStore = new FileDurableMissionStore({ root: `${root}/missions` });
	const executorStore = new FileExecutorRegistry({ root: `${root}/executors` });
	const assignmentStore = new FileAssignmentStore({ root: `${root}/assignments` });
	const executors = new ExecutorControlService({ store: executorStore, expiryMs: 30_000, assignmentStore });
	const service = new AssignmentControlService({ store: assignmentStore, missions: missionStore, executors });
	return { root, missionStore, executorStore, assignmentStore, executors, service };
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
	root = makeRoot("assignment-mp-");
	svc = services(root);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("TEST F — CROSS_PROCESS_ASSIGN_RACE", () => {
	it("two processes racing to assign one mission yield exactly one current assignment", async () => {
		await seedMission(svc.missionStore, "mission_race");

		const a = spawnWorker(MUTATE_WORKER, [
			"--root",
			root,
			"--op",
			"assign",
			"--missionId",
			"mission_race",
			"--executorId",
			"exec_race_1",
		]);
		const b = spawnWorker(MUTATE_WORKER, [
			"--root",
			root,
			"--op",
			"assign",
			"--missionId",
			"mission_race",
			"--executorId",
			"exec_race_2",
		]);

		await Promise.all([a.exited, b.exited]);
		const resultA = lastLine(a);
		const resultB = lastLine(b);

		const winners = [resultA, resultB].filter((r) => r.t === "assign_ok");
		const losers = [resultA, resultB].filter((r) => r.t === "assign_error");
		expect(winners).toHaveLength(1);
		expect(losers).toHaveLength(1);
		expect(losers[0].code).toBe("MISSION_ALREADY_ASSIGNED");

		const current = await svc.service.getCurrentForMission("mission_race");
		expect(current?.assignmentId).toBe(winners[0].assignmentId);

		const records = await svc.service.listForMission("mission_race");
		expect(records.filter((r) => r.current)).toHaveLength(1);
	});
});

describe("TEST AB — CROSS_PROCESS_REASSIGN_RACE", () => {
	it("concurrent reassigns yield one authoritative current with a valid supersession chain", async () => {
		await seedMission(svc.missionStore, "mission_reassign");
		await svc.executors.registerExecutor({ executorId: "exec_r0" });
		await svc.executors.activateExecutor("exec_r0", { platform: "linux", arch: "x64" });
		const initial = await svc.service.assignMission({ missionId: "mission_reassign", executorId: "exec_r0" });

		const a = spawnWorker(MUTATE_WORKER, [
			"--root",
			root,
			"--op",
			"reassign",
			"--missionId",
			"mission_reassign",
			"--executorId",
			"exec_r1",
		]);
		const b = spawnWorker(MUTATE_WORKER, [
			"--root",
			root,
			"--op",
			"reassign",
			"--missionId",
			"mission_reassign",
			"--executorId",
			"exec_r2",
		]);

		await Promise.all([a.exited, b.exited]);

		const records = await svc.service.listForMission("mission_reassign");
		const current = records.filter((r) => r.current);
		expect(current).toHaveLength(1);

		// History is acyclic and every superseded record points forward to an
		// existing newer assignment.
		const byId = new Map(records.map((r) => [r.assignmentId, r]));
		for (const record of records) {
			if (record.supersededByAssignmentId) {
				expect(byId.has(record.supersededByAssignmentId)).toBe(true);
				expect(byId.get(record.supersededByAssignmentId)?.assignmentId).not.toBe(record.assignmentId);
			}
		}
		expect(records.find((r) => r.assignmentId === initial.assignmentId)?.state).toBe("SUPERSEDED");
	});
});

describe("TEST AF — EXECUTOR_RUNTIME_RESTART_QA", () => {
	it("assignment survives a real process restart; stale proof rejected; new proof accepted", async () => {
		await seedMission(svc.missionStore, "mission_restart");
		await svc.executors.registerExecutor({
			executorId: "exec_restart",
			configuredCapabilities: { platform: { os: "linux" } },
		});

		// Runtime A is a real OS process.
		const runtimeA = spawnWorker(RUNTIME_WORKER, [
			"--root",
			root,
			"--executorId",
			"exec_restart",
			"--expiryMs",
			"500",
			"--keepAlive",
		]);
		await waitUntil(() => runtimeA.stdout.includes('"t":"activated"'));
		const proofA = lastLine(runtimeA);
		expect(proofA.runtimeEpoch).toBe(1);

		const assignment = await svc.service.assignMission({ missionId: "mission_restart", executorId: "exec_restart" });

		// Kill A; wait for STALE.
		runtimeA.kill();
		await runtimeA.exited;
		await waitUntil(async () => {
			const detail = await svc.executors.getExecutor("exec_restart");
			return detail.status === "STALE";
		});

		// Runtime B is a real OS process with the same executorId, new epoch.
		const runtimeB = spawnWorker(RUNTIME_WORKER, [
			"--root",
			root,
			"--executorId",
			"exec_restart",
			"--expiryMs",
			"30000",
			"--once",
		]);
		await runtimeB.exited;
		const proofB = lastLine(runtimeB);
		expect(proofB.t).toBe("activated");
		expect(proofB.runtimeEpoch).toBe(2);
		expect(proofB.runtimeInstanceId).not.toBe(proofA.runtimeInstanceId);

		// Logical assignment still points to the same executor.
		const current = await svc.service.getCurrentForMission("mission_restart");
		expect(current?.assignmentId).toBe(assignment.assignmentId);
		expect(current?.executorId).toBe("exec_restart");

		const oldProof = {
			executorId: "exec_restart",
			runtimeInstanceId: String(proofA.runtimeInstanceId),
			runtimeEpoch: Number(proofA.runtimeEpoch),
		};
		const newProof = {
			executorId: "exec_restart",
			runtimeInstanceId: String(proofB.runtimeInstanceId),
			runtimeEpoch: Number(proofB.runtimeEpoch),
		};
		await expect(svc.service.acceptAssignment(assignment.assignmentId, oldProof)).rejects.toMatchObject({
			code: "STALE_EXECUTOR_INSTANCE",
		});
		const accepted = await svc.service.acceptAssignment(assignment.assignmentId, newProof);
		expect(accepted.state).toBe("ACCEPTED");
	});
});

describe("TEST AI — MULTIPROCESS_STRESS", () => {
	it("repeated cross-process churn never produces two current assignments or corruption", async () => {
		const missionId = "mission_stress";
		await seedMission(svc.missionStore, missionId);

		const workers: Spawned[] = [];
		const executorIds = ["exec_stress_a", "exec_stress_b", "exec_stress_c"];
		for (const executorId of executorIds) {
			await svc.executors.registerExecutor({ executorId, configuredCapabilities: { platform: { os: "linux" } } });
			workers.push(
				spawnWorker(STRESS_WORKER, [
					"--root",
					root,
					"--missionId",
					missionId,
					"--executorId",
					executorId,
					"--iterations",
					"15",
				]),
			);
		}

		await Promise.all(workers.map((w) => w.exited));

		const records = await svc.service.listForMission(missionId);
		expect(records.filter((r) => r.current).length).toBeLessThanOrEqual(1);

		const byId = new Map(records.map((r) => [r.assignmentId, r]));
		for (const record of records) {
			if (record.supersededByAssignmentId) {
				expect(byId.has(record.supersededByAssignmentId)).toBe(true);
			}
		}

		// No corrupt records surfaced by a bulk read.
		const all = await svc.assignmentStore.listRecords();
		expect(all.corrupt).toEqual([]);
	}, 30_000);
});
