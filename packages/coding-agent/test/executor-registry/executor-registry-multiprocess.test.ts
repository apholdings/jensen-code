/**
 * Executor Registry — multiprocess activation race, stale fencing, heartbeat
 * liveness and stress (2.10.0).
 *
 * Genuinely separate OS processes prove:
 *   - exactly one process wins a simultaneous activation race;
 *   - a stale runtime instance is fenced at a real process boundary;
 *   - read-only inspection from another process never mutates the registry;
 *   - heartbeat liveness is extended by a live runtime and expires on loss.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExecutorControlService, FileExecutorRegistry } from "../../src/core/executor-registry/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../../");
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const ACTIVATE_WORKER = path.join(__dirname, "fixtures", "executor-activate-worker.ts");
const INSPECT_WORKER = path.join(__dirname, "fixtures", "executor-inspect-worker.ts");
const STALE_WORKER = path.join(__dirname, "fixtures", "executor-stale-worker.ts");
const STRESS_WORKER = path.join(__dirname, "fixtures", "executor-stress-worker.ts");

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

function lines(spawned: Spawned): Record<string, unknown>[] {
	return spawned.stdout
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
	const start = Date.now();
	for (;;) {
		if (await predicate()) return;
		if (Date.now() - start > timeoutMs) throw new Error("waitUntil timeout");
		await sleep(25);
	}
}

let root: string;
let store: FileExecutorRegistry;
let service: ExecutorControlService;

beforeEach(() => {
	root = makeRoot("executor-registry-mp-");
	store = new FileExecutorRegistry({ root });
	service = new ExecutorControlService({ store, expiryMs: 30_000 });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("TEST G — MULTIPROCESS_ACTIVATION", () => {
	it("exactly one process wins simultaneous activation; one authoritative epoch", async () => {
		await service.registerExecutor({ executorId: "qa-mp-act" });

		const a = spawnWorker(ACTIVATE_WORKER, ["--root", root, "--executorId", "qa-mp-act", "--once"]);
		const b = spawnWorker(ACTIVATE_WORKER, ["--root", root, "--executorId", "qa-mp-act", "--once"]);

		await Promise.all([a.exited, b.exited]);
		const resultA = lastLine(a);
		const resultB = lastLine(b);

		const winners = [resultA, resultB].filter((r) => r.t === "activated");
		const losers = [resultA, resultB].filter((r) => r.t === "activate_error");
		expect(winners).toHaveLength(1);
		expect(losers).toHaveLength(1);
		expect(losers[0].code).toBe("EXECUTOR_ALREADY_ACTIVE");

		const loaded = await store.load("qa-mp-act");
		expect(loaded.status).toBe("ok");
		if (loaded.status === "ok") {
			expect(loaded.record.runtimeEpoch).toBe(1);
			expect(loaded.record.runtime?.runtimeInstanceId).toBe(winners[0].runtimeInstanceId);
		}
	});
});

describe("TEST W — CROSS_PROCESS_READ_ONLY", () => {
	it("process B inspects process A's runtime without mutation", async () => {
		await service.registerExecutor({ executorId: "qa-mp-ro" });
		const owner = spawnWorker(ACTIVATE_WORKER, ["--root", root, "--executorId", "qa-mp-ro", "--keepAlive"]);
		await waitUntil(() => owner.stdout.includes('"t":"activated"'));

		const inspector = spawnWorker(INSPECT_WORKER, ["--root", root, "--executorId", "qa-mp-ro"]);
		const exited = await inspector.exited;
		expect(exited.code).toBe(0);

		const report = lastLine(inspector);
		expect(report.ok).toBe(true);
		expect(report.status).toBe("ONLINE");
		expect(report.beforeRevision).toBe(report.afterRevision);
		expect(report.beforeEpoch).toBe(report.afterEpoch);
		expect(report.beforeUpdatedAtMs).toBe(report.afterUpdatedAtMs);

		owner.kill();
		await owner.exited;
	});
});

describe("TEST AB — STALE_RUNTIME_FENCING", () => {
	it("an old runtime cannot heartbeat/update/deactivate after a takeover at a process boundary", async () => {
		await service.registerExecutor({ executorId: "qa-mp-stale" });

		const oldWorker = spawnWorker(ACTIVATE_WORKER, [
			"--root",
			root,
			"--executorId",
			"qa-mp-stale",
			"--expiryMs",
			"400",
			"--once",
		]);
		await oldWorker.exited;
		const old = lastLine(oldWorker);
		expect(old.t).toBe("activated");

		// Wait for the old runtime to become STALE (expired, no takeover yet).
		await waitUntil(async () => {
			const loaded = await store.load("qa-mp-stale");
			return (
				loaded.status === "ok" &&
				loaded.record.runtime !== undefined &&
				loaded.record.runtime.expiresAtMs <= Date.now()
			);
		});

		const newWorker = spawnWorker(ACTIVATE_WORKER, [
			"--root",
			root,
			"--executorId",
			"qa-mp-stale",
			"--expiryMs",
			"30000",
			"--once",
		]);
		await newWorker.exited;
		const next = lastLine(newWorker);
		expect(next.t).toBe("activated");
		expect(next.runtimeEpoch).toBe(2);
		expect(next.runtimeInstanceId).not.toBe(old.runtimeInstanceId);

		for (const op of ["heartbeat", "capabilities", "deactivate"]) {
			const stale = spawnWorker(STALE_WORKER, [
				"--root",
				root,
				"--executorId",
				"qa-mp-stale",
				"--instance",
				String(old.runtimeInstanceId),
				"--epoch",
				String(old.runtimeEpoch),
				"--op",
				op,
			]);
			await stale.exited;
			const outcome = lastLine(stale);
			expect(outcome.ok).toBe(false);
			expect(outcome.code).toBe("STALE_EXECUTOR_INSTANCE");
		}

		const loaded = await store.load("qa-mp-stale");
		expect(loaded.status).toBe("ok");
		if (loaded.status === "ok") {
			expect(loaded.record.runtime?.runtimeInstanceId).toBe(next.runtimeInstanceId);
			expect(loaded.record.runtimeEpoch).toBe(2);
		}
	});
});

describe("TEST AC — HEARTBEAT_LIVENESS", () => {
	it("a live runtime extends expiry repeatedly; loss of heartbeat becomes STALE", async () => {
		await service.registerExecutor({ executorId: "qa-mp-live" });

		const owner = spawnWorker(ACTIVATE_WORKER, [
			"--root",
			root,
			"--executorId",
			"qa-mp-live",
			"--expiryMs",
			"400",
			"--heartbeatIntervalMs",
			"150",
			"--keepAlive",
		]);

		await waitUntil(() => owner.stdout.includes('"t":"heartbeat"'));
		const first = await store.load("qa-mp-live");
		expect(first.status).toBe("ok");
		if (first.status !== "ok") return;
		const instanceId = first.record.runtime?.runtimeInstanceId;
		const initialExpiry = first.record.runtime?.expiresAtMs ?? 0;
		expect(first.record.runtimeEpoch).toBe(1);

		// Let several heartbeats extend the expiry well past the nominal window.
		await sleep(900);
		const mid = await store.load("qa-mp-live");
		expect(mid.status).toBe("ok");
		if (mid.status === "ok") {
			expect(mid.record.runtime?.runtimeInstanceId).toBe(instanceId);
			expect(mid.record.runtimeEpoch).toBe(1);
			expect(mid.record.runtime?.expiresAtMs ?? 0).toBeGreaterThan(initialExpiry);
		}

		owner.kill();
		await owner.exited;

		// After the last heartbeat lapses, liveness must become STALE.
		await waitUntil(async () => {
			const loaded = await store.load("qa-mp-live");
			return (
				loaded.status === "ok" &&
				loaded.record.runtime !== undefined &&
				loaded.record.runtime.expiresAtMs <= Date.now()
			);
		});
		const final = await service.getExecutor("qa-mp-live");
		expect(final.status).toBe("STALE");
		expect(final.runtimeEpoch).toBe(1);
	});
});

describe("TEST AG — MULTIPROCESS_STRESS", () => {
	it("concurrent activation attempts never reuse or regress an epoch", async () => {
		const ids = ["qa-mp-stress-a", "qa-mp-stress-b"];
		await service.registerExecutor({ executorId: ids[0] });
		await service.registerExecutor({ executorId: ids[1] });

		const workers: Spawned[] = [];
		for (const id of ids) {
			for (let i = 0; i < 4; i++) {
				workers.push(
					spawnWorker(STRESS_WORKER, [
						"--root",
						root,
						"--executorId",
						id,
						"--iterations",
						"20",
						"--expiryMs",
						"150",
					]),
				);
			}
		}
		await Promise.all(workers.map((w) => w.exited));

		for (const id of ids) {
			const observed = workers
				.filter((_, index) => (index < 4 ? id === ids[0] : id === ids[1]))
				.flatMap((w) => lines(w))
				.filter((line) => line.t === "activated")
				.map((line) => Number(line.epoch));

			expect(observed.length).toBeGreaterThan(0);
			// Every successful activation got a unique epoch; sorted they are
			// strictly increasing with no gaps (monotonic, no duplicate authority).
			const sorted = [...observed].sort((a, b) => a - b);
			expect(new Set(observed).size).toBe(observed.length);
			for (let i = 0; i < sorted.length; i++) {
				expect(sorted[i]).toBe(sorted[0] + i);
			}

			const loaded = await store.load(id);
			expect(loaded.status).toBe("ok");
			if (loaded.status === "ok") {
				expect(loaded.record.runtimeEpoch).toBe(sorted[sorted.length - 1]);
				expect(loaded.record.runtime).toBeDefined();
			}
		}
	}, 30_000);
});
