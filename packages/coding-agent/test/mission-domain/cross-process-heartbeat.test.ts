/**
 * Cross-process heartbeat liveness + stale-owner abort tests (2.8.0).
 *
 * Real OS processes (spawned tsx workers) run the full
 * DurableMissionCoordinator resume path with a live heartbeat. Phase V proves a
 * live owner keeps its lease alive past the original lease duration and that a
 * second process can never acquire while the heartbeat is healthy. Phase W
 * proves a fenced heartbeat aborts the stale executor, which then cannot write
 * a terminal result.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createDurableMissionRecord,
	createMissionRequest,
	DurableMissionCoordinator,
	type ExecutionLease,
	ExecutionOwnershipError,
	type MissionExecutor,
	type MissionRequest,
} from "../../src/core/mission-domain/index.js";
import { FileDurableMissionStore } from "../../src/core/mission-durable/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../../");
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const WORKER = path.join(__dirname, "fixtures", "heartbeat-worker.ts");

function makeRoot(): string {
	return mkdtempSync(path.join(tmpdir(), "cross-process-heartbeat-"));
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

const NOOP_EXECUTOR: MissionExecutor = {
	executorId: "noop",
	async launch(): Promise<never> {
		throw new Error("noop cannot launch");
	},
	async awaitResult(): Promise<never> {
		throw new Error("noop cannot await");
	},
	async cancel(): Promise<void> {},
};

interface SpawnedWorker {
	child: ReturnType<typeof spawn>;
	exited: Promise<{ code: number | null; signal: string | null }>;
	kill: () => void;
	stdout: string;
	stderr: string;
}

function spawnWorker(args: string[]): SpawnedWorker {
	const child = spawn(process.execPath, [TSX_CLI, WORKER, ...args], {
		cwd: REPO_ROOT,
		stdio: ["ignore", "pipe", "pipe"],
		// tsx's CLI supervises the actual worker as a child process, so detach to
		// give the whole tree its own process group and kill the group on teardown.
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
				// Fall through to the direct child.
			}
		}
		child.kill("SIGKILL");
	};
	return {
		child,
		exited,
		kill,
		get stdout() {
			return stdout;
		},
		get stderr() {
			return stderr;
		},
	};
}

function readJsonLines(file: string): Record<string, unknown>[] {
	try {
		const content = readFileSync(file, "utf8").trim();
		if (!content) return [];
		return content
			.split("\n")
			.map((line) => {
				try {
					return JSON.parse(line) as Record<string, unknown>;
				} catch {
					return {};
				}
			})
			.filter((line) => Object.keys(line).length > 0);
	} catch {
		return [];
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLog(
	file: string,
	predicate: (line: Record<string, unknown>) => boolean,
	timeoutMs: number,
): Promise<void> {
	const start = Date.now();
	for (;;) {
		if (readJsonLines(file).some(predicate)) return;
		if (Date.now() - start > timeoutMs) throw new Error("waitForLog timeout");
		await sleep(50);
	}
}

let root: string;
let store: FileDurableMissionStore;

beforeEach(() => {
	root = makeRoot();
	store = new FileDurableMissionStore({ root });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("PHASE V — real multiprocess lease liveness", () => {
	it("a live owner renews past the original lease duration and a second process never acquires until expiry", async () => {
		await store.create(createDurableMissionRecord({ request: request("mission_live"), now: Date.now() }));

		const log = path.join(root, "a.log");
		const spawned = spawnWorker([
			"--root",
			root,
			"--missionId",
			"mission_live",
			"--log",
			log,
			"--leaseDurationMs",
			"1200",
			"--heartbeatIntervalMs",
			"400",
			"--renewalSafetyMarginMs",
			"400",
			"--pollMs",
			"150",
		]);

		const bCoordinator = new DurableMissionCoordinator(store, NOOP_EXECUTOR, {});

		// Wait for A to acquire and start its heartbeat before B starts racing,
		// so the test proves B cannot steal a *live* lease (not a startup race).
		await waitForLog(log, (line) => line.t === "telemetry" && line.heartbeatActive === true, 8000);
		// A must survive well past the original lease duration purely via renewals.
		await waitForLog(
			log,
			(line) => line.t === "telemetry" && ((line.renewalCount as number | undefined) ?? 0) >= 3,
			8000,
		);

		// B periodically attempts acquisition while A is alive; it must never win.
		const bAttempts: string[] = [];
		for (let i = 0; i < 5; i += 1) {
			try {
				await bCoordinator.acquireOwnership("mission_live");
				bAttempts.push("acquired");
			} catch (error) {
				bAttempts.push(error instanceof ExecutionOwnershipError ? error.code : "ERROR");
			}
		}
		expect(bAttempts.length).toBe(5);
		expect(bAttempts.every((code) => code === "MISSION_OWNED")).toBe(true);

		// Kill the live owner (the whole tsx process tree); the heartbeat dies
		// with the process.
		spawned.kill();
		await spawned.exited;

		// The lease naturally expires (no more renewals).
		await sleep(1200 + 1200);

		const report = await bCoordinator.recover();
		expect(report.reconciled).toContain("mission_live");

		const acquired = await bCoordinator.acquireOwnership("mission_live");
		expect(acquired.lease.fencingToken).toBeGreaterThan(1);
	});
});

describe("PHASE W — real stale-owner heartbeat abort", () => {
	it("a fenced renewal aborts the old process executor and it cannot write a terminal result", async () => {
		await store.create(createDurableMissionRecord({ request: request("mission_stale"), now: Date.now() }));

		const log = path.join(root, "a.log");
		const spawned = spawnWorker([
			"--root",
			root,
			"--missionId",
			"mission_stale",
			"--log",
			log,
			"--leaseDurationMs",
			"1000",
			"--heartbeatIntervalMs",
			"400",
			"--renewalSafetyMarginMs",
			"300",
			"--pollMs",
			"150",
		]);

		// Wait for the live owner to renew at least once.
		await waitForLog(
			log,
			(line) => line.t === "telemetry" && ((line.renewalCount as number | undefined) ?? 0) >= 1,
			8000,
		);

		// B force-takes over through the defined test seam (a newer fence).
		const takeoverLease: ExecutionLease = {
			ownerId: "owner_b",
			leaseId: "lease_b",
			fencingToken: 2,
			acquiredAtMs: Date.now(),
			renewedAtMs: Date.now(),
			expiresAtMs: Date.now() + 60_000,
		};
		await store.mutate("mission_stale", (current) => ({
			kind: "write",
			value: undefined,
			next: {
				...current,
				fencingToken: 2,
				lease: takeoverLease,
				updatedAtMs: Date.now(),
			},
		}));

		// The old owner's next renewal is fenced out; it aborts and exits.
		await waitForLog(log, (line) => line.t === "done", 8000);
		const result = await spawned.exited;
		expect(result.code).toBe(0);

		const lines = readJsonLines(log);
		const done = lines.find((line) => line.t === "done");
		expect(done).toBeDefined();
		expect(done?.ok).toBe(false);
		expect(done?.code).toBe("EXECUTION_AUTHORITY_LOST");
		expect(done?.abortObserved).toBeGreaterThanOrEqual(1);

		// The stale owner never persisted a terminal result; B remains authoritative.
		const loaded = await store.load("mission_stale");
		expect(loaded.status).toBe("ok");
		if (loaded.status === "ok") {
			expect(loaded.record.result).toBeUndefined();
			expect(loaded.record.fencingToken).toBe(2);
			expect(loaded.record.lease?.leaseId).toBe("lease_b");
		}
	});
});
