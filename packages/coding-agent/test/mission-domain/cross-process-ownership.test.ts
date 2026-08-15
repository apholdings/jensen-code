/**
 * Cross-process ownership tests (2.7.0).
 *
 * Spawn independent Node (tsx) processes against the SAME
 * FileDurableMissionStore to prove that the atomic mutation lock and execution
 * lease are truly cross-process: exactly-one-wins CAS, exactly-one-wins lease
 * acquisition, stale-owner fencing at the process boundary, stale-lock crash
 * recovery, corrupt-lock failure, and per-mission parallelism.
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createDurableMissionRecord,
	createMissionRequest,
	type DurableMissionRecord,
	type ExecutionLease,
} from "../../src/core/mission-domain/index.js";
import { FileDurableMissionStore } from "../../src/core/mission-durable/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../../");
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const WORKER = path.join(__dirname, "fixtures", "store-worker.ts");

function makeRoot(): string {
	return mkdtempSync(path.join(tmpdir(), "cross-process-ownership-"));
}

function request(missionId: string): ReturnType<typeof createMissionRequest> {
	return createMissionRequest({
		missionId,
		objective: `objective of ${missionId}`,
		agent: "worker",
		executionMode: "execute",
		acceptanceCriteria: [],
	});
}

function leaseOf(ownerId: string, leaseId: string, fencingToken: number, now: number): ExecutionLease {
	return { ownerId, leaseId, fencingToken, acquiredAtMs: now, renewedAtMs: now, expiresAtMs: now + 60_000 };
}

function runningWithLease(
	req: ReturnType<typeof createMissionRequest>,
	lease: ExecutionLease,
	now: number,
): DurableMissionRecord {
	return {
		schemaVersion: 1,
		missionId: req.missionId,
		parentMissionId: req.parentMissionId,
		depth: req.depth,
		request: req,
		state: "RUNNING",
		currentAttemptId: "attempt_B",
		currentExecutionId: "exec_B",
		createdAtMs: req.createdAtMs,
		updatedAtMs: now,
		startedAtMs: now,
		transitions: [
			{ seq: 0, from: "CREATED", to: "QUEUED", atMs: now },
			{ seq: 1, from: "QUEUED", to: "LAUNCHING", atMs: now, attemptId: "attempt_B" },
			{ seq: 2, from: "LAUNCHING", to: "RUNNING", atMs: now, executionId: "exec_B" },
		],
		attempts: [{ attemptId: "attempt_B", executionId: "exec_B", startedAtMs: now }],
		fencingToken: lease.fencingToken,
		lease,
		revision: 4,
	};
}

interface WorkerResult {
	stdout: string;
	stderr: string;
	code: number | null;
	signal: string | null;
}

function runWorker(args: string[]): Promise<WorkerResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [TSX_CLI, WORKER, ...args], {
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
		child.on("error", reject);
		child.on("close", (code, signal) => resolve({ stdout, stderr, code, signal }));
	});
}

function parseWorker(result: WorkerResult): Record<string, unknown> {
	const line = result.stdout.trim().split("\n").pop() ?? "";
	return JSON.parse(line) as Record<string, unknown>;
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

describe("TEST A — true cross-process compare-and-save", () => {
	it("two independent processes CAS the same revision and exactly one wins", async () => {
		await store.create(createDurableMissionRecord({ request: request("mission_cas"), now: 1 }));

		const [a, b] = await Promise.all([
			runWorker(["--root", root, "--op", "cas", "--missionId", "mission_cas", "--expectedRevision", "1"]),
			runWorker(["--root", root, "--op", "cas", "--missionId", "mission_cas", "--expectedRevision", "1"]),
		]);

		const statuses = [parseWorker(a).status, parseWorker(b).status].sort();
		expect(statuses).toEqual(["saved", "stale"]);

		const loaded = await store.load("mission_cas");
		expect(loaded.status).toBe("ok");
		if (loaded.status === "ok") {
			expect(loaded.record.revision).toBe(2);
			expect(loaded.record.state).toBe("QUEUED");
		}
	});
});

describe("TEST B — cross-process lease race", () => {
	it("two independent processes acquire the same mission and exactly one wins", async () => {
		await store.create(createDurableMissionRecord({ request: request("mission_lease_race"), now: 1 }));

		const [a, b] = await Promise.all([
			runWorker(["--root", root, "--op", "acquire", "--missionId", "mission_lease_race", "--ownerId", "owner_a"]),
			runWorker(["--root", root, "--op", "acquire", "--missionId", "mission_lease_race", "--ownerId", "owner_b"]),
		]);

		const pa = parseWorker(a);
		const pb = parseWorker(b);
		const acquired = pa.status === "acquired" ? pa : pb;
		const loser = pa.status === "acquired" ? pb : pa;

		expect(acquired.status).toBe("acquired");
		expect(acquired.fencingToken).toBe(1);
		expect(loser.status).toBe("error");
		expect(loser.code).toBe("MISSION_OWNED");
	});
});

describe("TEST P — parallel missions are independently mutable", () => {
	it("concurrent mutations of two different missions both proceed", async () => {
		await store.create(createDurableMissionRecord({ request: request("mission_parallel_a"), now: 1 }));
		await store.create(createDurableMissionRecord({ request: request("mission_parallel_b"), now: 1 }));

		const [a, b] = await Promise.all([
			runWorker(["--root", root, "--op", "cas", "--missionId", "mission_parallel_a", "--expectedRevision", "1"]),
			runWorker(["--root", root, "--op", "cas", "--missionId", "mission_parallel_b", "--expectedRevision", "1"]),
		]);

		expect(parseWorker(a).status).toBe("saved");
		expect(parseWorker(b).status).toBe("saved");

		const loadedA = await store.load("mission_parallel_a");
		const loadedB = await store.load("mission_parallel_b");
		expect(loadedA.status).toBe("ok");
		expect(loadedB.status).toBe("ok");
		if (loadedA.status === "ok" && loadedB.status === "ok") {
			expect(loadedA.record.revision).toBe(2);
			expect(loadedB.record.revision).toBe(2);
		}
	});
});

describe("TEST Q — process dies holding the mutation lock", () => {
	it("the store recovers the stale lock without corrupting the mission", async () => {
		await store.create(createDurableMissionRecord({ request: request("mission_lock_crash"), now: 1 }));

		const holder = spawn(
			process.execPath,
			[TSX_CLI, WORKER, "--root", root, "--op", "hold-lock", "--missionId", "mission_lock_crash"],
			{
				cwd: REPO_ROOT,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let locked = false;
		await new Promise<void>((resolve) => {
			holder.stdout.on("data", (data: Buffer) => {
				if (data.toString().includes("locked")) {
					locked = true;
					resolve();
				}
			});
			holder.on("close", () => resolve());
		});
		expect(locked).toBe(true);

		// Give the lock mtime time to age past the recovery window. proper-lockfile
		// enforces a 2s minimum staleness and sets the lock mtime to a
		// ceil-to-second value (up to ~1s in the future), so sleep with margin.
		await new Promise((resolve) => setTimeout(resolve, 3500));

		const recoveringStore = new FileDurableMissionStore({ root, lockStaleMs: 2000, lockRetries: 5 });
		const loaded = await recoveringStore.load("mission_lock_crash");
		expect(loaded.status).toBe("ok");
		if (loaded.status === "ok") {
			const next: DurableMissionRecord = {
				...loaded.record,
				state: "QUEUED",
				updatedAtMs: loaded.record.updatedAtMs + 1,
				transitions: [
					...loaded.record.transitions,
					{
						seq: loaded.record.transitions.length,
						from: "CREATED",
						to: "QUEUED" as const,
						atMs: loaded.record.updatedAtMs + 1,
					},
				],
				revision: loaded.record.revision + 1,
			};
			const saved = await recoveringStore.save(next, { expectedRevision: loaded.record.revision });
			expect(saved.status).toBe("saved");
		}

		const after = await store.load("mission_lock_crash");
		expect(after.status).toBe("ok");
		if (after.status === "ok") expect(after.record.state).toBe("QUEUED");
	});
});

describe("TEST R — corrupt lock metadata fails conservative and can be repaired", () => {
	it("a non-empty stale lock directory surfaces CORRUPT_LOCK_METADATA and recovers after repair", async () => {
		await store.create(createDurableMissionRecord({ request: request("mission_corrupt_lock"), now: 1 }));

		const lockDir = path.join(root, "mission_corrupt_lock.mission.json.lock");
		mkdirSync(lockDir, { recursive: true });
		writeFileSync(path.join(lockDir, "junk"), "stray file", "utf8");
		const old = new Date(Date.now() - 60_000);
		utimesSync(lockDir, old, old);

		await expect(
			store.save(createDurableMissionRecord({ request: request("mission_corrupt_lock"), now: 2 })),
		).rejects.toMatchObject({
			code: "CORRUPT_LOCK_METADATA",
		});

		// Repair by removing the corrupt lock directory, then retry.
		rmSync(lockDir, { recursive: true, force: true });
		const loaded = await store.load("mission_corrupt_lock");
		expect(loaded.status).toBe("ok");
		if (loaded.status === "ok") {
			const next: DurableMissionRecord = {
				...loaded.record,
				state: "QUEUED",
				updatedAtMs: loaded.record.updatedAtMs + 1,
				transitions: [
					...loaded.record.transitions,
					{
						seq: loaded.record.transitions.length,
						from: "CREATED",
						to: "QUEUED" as const,
						atMs: loaded.record.updatedAtMs + 1,
					},
				],
				revision: loaded.record.revision + 1,
			};
			expect((await store.save(next, { expectedRevision: loaded.record.revision })).status).toBe("saved");
		}
	});
});

describe("PHASE X — stale process fencing at the process boundary", () => {
	it("an old process/lease/fence cannot persist a terminal result after takeover", async () => {
		const req = request("mission_stale_process");
		await store.create(runningWithLease(req, leaseOf("owner_b", "lease_b", 2, 5000), 5000));

		const result = await runWorker([
			"--root",
			root,
			"--op",
			"fenced-terminal",
			"--missionId",
			"mission_stale_process",
			"--leaseId",
			"lease_a",
			"--fencingToken",
			"1",
		]);

		expect(parseWorker(result).status).toBe("stale_owner");

		const after = await store.load("mission_stale_process");
		expect(after.status).toBe("ok");
		if (after.status === "ok") {
			expect(after.record.state).toBe("RUNNING");
			expect(after.record.result).toBeUndefined();
			expect(after.record.lease?.fencingToken).toBe(2);
		}
	});
});
