/**
 * Worker Daemon Foundation — multiprocess race / liveness / crash tests (2.13.0).
 *
 * Genuinely separate OS daemon processes prove the non-mockable properties:
 *   - duplicate-daemon claim race converges to exactly one execution;
 *   - heartbeat staleness is observable after a kill;
 *   - graceful shutdown stops cleanly without corruption;
 *   - shutdown during execution never fabricates success;
 *   - crash + restart reconciles honestly (INTERRUPTED, no re-execution).
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "@apholdings/jensen-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AssignmentControlService, FileAssignmentStore } from "../../src/core/assignment/index.js";
import { bindChildSession } from "../../src/core/durable-child-session/index.js";
import { ExecutorControlService, FileExecutorRegistry } from "../../src/core/executor-registry/index.js";
import {
	createDurableMissionRecord,
	createMissionRequest,
	newChildSessionId,
} from "../../src/core/mission-domain/index.js";
import { FileDurableMissionStore } from "../../src/core/mission-durable/index.js";
import { SessionManager } from "../../src/core/session-manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../../");
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const FIXTURE = path.join(__dirname, "fixtures", "worker-daemon-process.ts");

function makeRoot(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

interface Spawned {
	stdout: string;
	stderr: string;
	exited: Promise<{ code: number | null; signal: string | null }>;
	kill: (signal?: NodeJS.Signals) => void;
}

function spawnWorker(args: string[]): Spawned {
	const child = spawn(process.execPath, [TSX_CLI, FIXTURE, ...args], {
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
	const kill = (signal: NodeJS.Signals = "SIGKILL") => {
		if (child.pid && process.platform !== "win32") {
			try {
				process.kill(-child.pid, signal);
				return;
			} catch {
				// fall through to direct kill
			}
		}
		child.kill(signal);
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

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`timeout waiting for ${label}`);
}

interface StoreBundle {
	root: string;
	sessionDir: string;
	missions: FileDurableMissionStore;
	executors: ExecutorControlService;
	assignments: AssignmentControlService;
}

function makeStores(): StoreBundle {
	const root = makeRoot("worker-mp-");
	const sessionDir = makeRoot("worker-mp-session-");
	const missions = new FileDurableMissionStore({ root: path.join(root, "missions") });
	const executors = new ExecutorControlService({
		store: new FileExecutorRegistry({ root: path.join(root, "executors") }),
		expiryMs: 1000,
	});
	const assignments = new AssignmentControlService({
		store: new FileAssignmentStore({ root: path.join(root, "assignments") }),
		missions,
		executors,
		sessionDir,
	});
	return { root, sessionDir, missions, executors, assignments };
}

async function seedChildMission(
	bundle: StoreBundle,
	executorId: string,
	missionId: string,
): Promise<{ assignmentId: string; childSessionId: string }> {
	const childSessionId = newChildSessionId();
	await bundle.missions.create(
		createDurableMissionRecord({
			request: createMissionRequest({
				missionId,
				objective: `objective of ${missionId}`,
				agent: "worker",
				executionMode: "execute",
				acceptanceCriteria: [],
				childSessionId,
			}),
		}),
	);
	const sm = SessionManager.createWithId(bundle.root, bundle.sessionDir, childSessionId);
	bindChildSession(sm, missionId);
	sm.appendMessage({ role: "user", content: "start" } as Message);
	sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }] } as Message);

	const assignment = await bundle.assignments.assignMission({ missionId, executorId });
	return { assignmentId: assignment.assignmentId, childSessionId };
}

const bundles: StoreBundle[] = [];

afterEach(() => {
	for (const bundle of bundles.splice(0)) {
		rmSync(bundle.root, { recursive: true, force: true });
		rmSync(bundle.sessionDir, { recursive: true, force: true });
	}
});

describe("TEST F — DUPLICATE_DAEMON_RACE", () => {
	it("two concurrent OS daemons for one executor converge to exactly one execution", async () => {
		const bundle = makeStores();
		bundles.push(bundle);
		const executorId = "exec_f";

		await bundle.executors.registerExecutor({ executorId });
		// Make the executor ONLINE so the assignment can be created, then
		// deactivate it so the two `--once` daemons race to activate epoch 2.
		const activation = await bundle.executors.activateExecutor(executorId);
		await seedChildMission(bundle, executorId, "mission_f");
		const assignment = (await bundle.assignments.store.listRecords()).records.find(
			(r) => r.missionId === "mission_f",
		)!;
		await bundle.executors.deactivateExecutor(activation.proof);

		const a = spawnWorker([
			"--root",
			bundle.root,
			"--executor",
			executorId,
			"--session-dir",
			bundle.sessionDir,
			"--once",
			"--slow-ms",
			"1200",
		]);
		await new Promise((resolve) => setTimeout(resolve, 80));
		const b = spawnWorker([
			"--root",
			bundle.root,
			"--executor",
			executorId,
			"--session-dir",
			bundle.sessionDir,
			"--once",
			"--slow-ms",
			"1200",
		]);

		await Promise.all([a.exited, b.exited]);

		// Exactly one daemon claimed + executed; the loser observed ownership and
		// failed activation (or skipped) without a second execution.
		const executedCount = (a.stdout + b.stdout)
			.split("\n")
			.filter((line) => line.includes('"kind":"executed"')).length;
		expect(executedCount).toBe(1);

		const mission = await bundle.missions.load("mission_f");
		expect(mission.status).toBe("ok");
		if (mission.status === "ok") {
			expect(mission.record.state).toBe("SUCCEEDED");
			expect(mission.record.attempts).toHaveLength(1);
		}

		const detail = await bundle.assignments.getAssignment(assignment.assignmentId);
		expect(detail.state).toBe("COMPLETED");
		expect(detail.consumedByExecutionId).toBeTruthy();
	}, 30_000);
});

describe("TEST G — HEARTBEAT_STALE", () => {
	it("a killed daemon stops being reported healthy", async () => {
		const bundle = makeStores();
		bundles.push(bundle);
		const executorId = "exec_g";

		await bundle.executors.registerExecutor({ executorId });
		const daemon = spawnWorker([
			"--root",
			bundle.root,
			"--executor",
			executorId,
			"--session-dir",
			bundle.sessionDir,
			"--heartbeat-ms",
			"150",
			"--expiry-ms",
			"400",
		]);

		await waitFor(
			async () => {
				const detail = await bundle.executors.getExecutor(executorId);
				return detail.status === "ONLINE";
			},
			5000,
			"executor ONLINE",
		);

		daemon.kill("SIGKILL");
		await daemon.exited;

		await waitFor(
			async () => {
				const detail = await bundle.executors.getExecutor(executorId);
				return detail.status === "STALE";
			},
			5000,
			"executor STALE",
		);
	}, 30_000);
});

describe("TEST H — GRACEFUL_SHUTDOWN", () => {
	it("SIGTERM while idle stops cleanly and deactivates the runtime", async () => {
		const bundle = makeStores();
		bundles.push(bundle);
		const executorId = "exec_h";

		await bundle.executors.registerExecutor({ executorId });
		const daemon = spawnWorker([
			"--root",
			bundle.root,
			"--executor",
			executorId,
			"--session-dir",
			bundle.sessionDir,
			"--heartbeat-ms",
			"150",
			"--expiry-ms",
			"1000",
		]);

		await waitFor(async () => (await bundle.executors.getExecutor(executorId)).status === "ONLINE", 5000, "ONLINE");

		daemon.kill("SIGTERM");
		const result = await daemon.exited;
		expect(result.code).toBe(0);

		const detail = await bundle.executors.getExecutor(executorId);
		expect(detail.status).toBe("OFFLINE");
	}, 30_000);
});

describe("TEST I — SHUTDOWN_DURING_EXECUTION", () => {
	it("SIGTERM during execution never fabricates success", async () => {
		const bundle = makeStores();
		bundles.push(bundle);
		const executorId = "exec_i";

		await bundle.executors.registerExecutor({ executorId });

		const daemon = spawnWorker([
			"--root",
			bundle.root,
			"--executor",
			executorId,
			"--session-dir",
			bundle.sessionDir,
			"--heartbeat-ms",
			"150",
			"--expiry-ms",
			"1000",
			"--poll-ms",
			"150",
			"--slow-ms",
			"5000",
		]);

		await waitFor(async () => (await bundle.executors.getExecutor(executorId)).status === "ONLINE", 5000, "ONLINE");
		await seedChildMission(bundle, executorId, "mission_i");

		// Wait for the daemon to claim + reach RUNNING, then SIGTERM mid-child.
		await waitFor(
			async () => {
				const loaded = await bundle.missions.load("mission_i");
				return loaded.status === "ok" && (loaded.record.state === "RUNNING" || loaded.record.state === "LAUNCHING");
			},
			10_000,
			"mission RUNNING",
		);

		daemon.kill("SIGTERM");
		await daemon.exited;

		const mission = await bundle.missions.load("mission_i");
		expect(mission.status).toBe("ok");
		if (mission.status === "ok") {
			expect(mission.record.state).not.toBe("SUCCEEDED");
			expect(mission.record.state).not.toBe("PARTIAL");
		}
	}, 30_000);
});

describe("TEST J — CRASH_DURING_EXECUTION", () => {
	it("SIGKILL + restart reconciles to INTERRUPTED without duplicate execution", async () => {
		const bundle = makeStores();
		bundles.push(bundle);
		const executorId = "exec_j";

		await bundle.executors.registerExecutor({ executorId });

		const first = spawnWorker([
			"--root",
			bundle.root,
			"--executor",
			executorId,
			"--session-dir",
			bundle.sessionDir,
			"--heartbeat-ms",
			"150",
			"--expiry-ms",
			"1000",
			"--poll-ms",
			"150",
			"--slow-ms",
			"5000",
		]);

		await waitFor(async () => (await bundle.executors.getExecutor(executorId)).status === "ONLINE", 5000, "ONLINE");
		await seedChildMission(bundle, executorId, "mission_j");

		await waitFor(
			async () => {
				const loaded = await bundle.missions.load("mission_j");
				return loaded.status === "ok" && (loaded.record.state === "RUNNING" || loaded.record.state === "LAUNCHING");
			},
			10_000,
			"mission RUNNING",
		);

		first.kill("SIGKILL");
		await first.exited;

		// The crashed worker's runtime must be observed stale before a new
		// incarnation can activate (single healthy runtime per executor).
		await waitFor(
			async () => (await bundle.executors.getExecutor(executorId)).status === "STALE",
			5000,
			"executor STALE after crash",
		);

		// Restart a daemon for the same executor; startup reconciliation must
		// interrupt the stale owner and never re-execute.
		const second = spawnWorker([
			"--root",
			bundle.root,
			"--executor",
			executorId,
			"--session-dir",
			bundle.sessionDir,
			"--heartbeat-ms",
			"150",
			"--expiry-ms",
			"400",
			"--poll-ms",
			"150",
		]);

		await waitFor(
			async () => {
				const loaded = await bundle.missions.load("mission_j");
				return loaded.status === "ok" && loaded.record.state === "INTERRUPTED";
			},
			10_000,
			"mission INTERRUPTED",
		);

		second.kill("SIGTERM");
		await second.exited;

		const mission = await bundle.missions.load("mission_j");
		expect(mission.status).toBe("ok");
		if (mission.status === "ok") {
			expect(mission.record.state).toBe("INTERRUPTED");
			// Exactly one attempt from the first daemon; the restart did not re-run it.
			expect(mission.record.attempts.filter((a) => a.executionId).length).toBeLessThanOrEqual(1);
		}

		const assignment = (await bundle.assignments.store.listRecords()).records.find(
			(r) => r.missionId === "mission_j",
		);
		expect(assignment?.state).toBe("FAILED");
	}, 30_000);
});
