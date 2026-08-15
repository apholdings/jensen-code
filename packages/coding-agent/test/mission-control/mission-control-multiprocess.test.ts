/**
 * Mission Control Plane — multiprocess observability + resume-race tests (2.9.0).
 *
 * Genuinely separate OS processes prove:
 *   - Process B inspects Process A's running mission without mutating it.
 *   - Two processes racing resumeMission through the control plane still have
 *     exactly one winner (fenced ownership is not weakened).
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "@apholdings/jensen-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bindChildSession } from "../../src/core/durable-child-session/index.js";
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
const OWNER_WORKER = path.join(__dirname, "../mission-domain/fixtures/heartbeat-worker.ts");
const INSPECT_WORKER = path.join(__dirname, "fixtures", "mission-control-inspect-worker.ts");
const RESUME_WORKER = path.join(__dirname, "fixtures", "mission-control-resume-worker.ts");

function makeRoot(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

function request(missionId: string, childSessionId?: string): ReturnType<typeof createMissionRequest> {
	return createMissionRequest({
		missionId,
		objective: `objective of ${missionId}`,
		agent: "worker",
		executionMode: "execute",
		acceptanceCriteria: [],
		childSessionId,
	});
}

function interruptedRecord(
	req: ReturnType<typeof createMissionRequest>,
	now: number,
): Parameters<FileDurableMissionStore["create"]>[0] {
	return {
		schemaVersion: 1,
		missionId: req.missionId,
		parentMissionId: req.parentMissionId,
		depth: req.depth,
		request: req,
		state: "INTERRUPTED",
		createdAtMs: req.createdAtMs,
		updatedAtMs: now,
		startedAtMs: now - 1000,
		transitions: [
			{ seq: 0, from: "CREATED", to: "QUEUED", atMs: now - 1000 },
			{ seq: 1, from: "QUEUED", to: "LAUNCHING", atMs: now - 1000, attemptId: "attempt_prior" },
			{ seq: 2, from: "LAUNCHING", to: "RUNNING", atMs: now - 1000, executionId: "exec_prior" },
			{ seq: 3, from: "RUNNING", to: "INTERRUPTED", atMs: now, reason: "control_plane_restart" },
		],
		attempts: [
			{
				attemptId: "attempt_prior",
				executionId: "exec_prior",
				startedAtMs: now - 1000,
				endReason: "INTERRUPTED",
				recovery: { reason: "control_plane_restart", recoveredAtMs: now },
			},
		],
		fencingToken: 0,
		revision: 4,
	};
}

function persistChildSession(sessionDir: string, childSessionId: string, missionId: string, cwd: string): void {
	const sm = SessionManager.createWithId(cwd, sessionDir, childSessionId);
	bindChildSession(sm, missionId);
	sm.appendMessage({ role: "user", content: "start" } as Message);
	sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }] } as Message);
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

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
	const start = Date.now();
	for (;;) {
		if (predicate()) return;
		if (Date.now() - start > timeoutMs) throw new Error("waitUntil timeout");
		await sleep(25);
	}
}

let root: string;
let store: FileDurableMissionStore;

beforeEach(() => {
	root = makeRoot("mission-control-mp-");
	store = new FileDurableMissionStore({ root });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("TEST W — multiprocess read-only inspection", () => {
	it("process B inspects process A's running mission without mutating revision or lease", async () => {
		await store.create(createDurableMissionRecord({ request: request("mission_inspect"), now: Date.now() }));

		const log = path.join(root, "owner.log");
		const owner = spawnWorker(OWNER_WORKER, [
			"--root",
			root,
			"--missionId",
			"mission_inspect",
			"--log",
			log,
			"--leaseDurationMs",
			"3000",
			"--heartbeatIntervalMs",
			"800",
			"--renewalSafetyMarginMs",
			"800",
			"--pollMs",
			"150",
		]);

		// Wait until the owner is actively running (durable RUNNING + heartbeat).
		await waitUntil(() => {
			try {
				const content = readFileSync(log, "utf8").trim();
				if (!content) return false;
				const lines = content.split("\n").filter(Boolean);
				const parsed = JSON.parse(lines[lines.length - 1]);
				return parsed.t === "telemetry" && parsed.heartbeatActive === true;
			} catch {
				return false;
			}
		});

		const inspector = spawnWorker(INSPECT_WORKER, ["--root", root, "--missionId", "mission_inspect"]);
		const inspected = await inspector.exited;
		expect(inspected.code).toBe(0);

		const report = JSON.parse(inspector.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "{}");
		expect(report.ok).toBe(true);
		expect(report.owned).toBe(true);
		expect(report.leaseStatus).toBe("ACTIVE");
		expect(report.localRuntimeKnown).toBe(false); // separate process never sees owner heartbeat
		expect(report.attemptsCount).toBeGreaterThanOrEqual(1);
		expect(report.beforeRevision).toBe(report.afterRevision);
		expect(report.beforeLease).toEqual(report.afterLease);
		expect(report.beforeUpdatedAtMs).toBe(report.afterUpdatedAtMs);

		owner.kill();
		await owner.exited;
	});
});

describe("TEST R — resume race through the control plane", () => {
	it("exactly one process owns the resume; the loser receives a structured error", async () => {
		const sessionId = newChildSessionId();
		const sessionDir = makeRoot("session-");
		const cwd = makeRoot("cwd-");
		const missionId = "mission_race";
		await store.create(interruptedRecord(request(missionId, sessionId), Date.now()));
		persistChildSession(sessionDir, sessionId, missionId, cwd);

		const first = spawnWorker(RESUME_WORKER, [
			"--root",
			root,
			"--missionId",
			missionId,
			"--sessionDir",
			sessionDir,
			"--cwd",
			cwd,
		]);
		const second = spawnWorker(RESUME_WORKER, [
			"--root",
			root,
			"--missionId",
			missionId,
			"--sessionDir",
			sessionDir,
			"--cwd",
			cwd,
		]);

		const [a, b] = await Promise.all([first.exited, second.exited]);
		expect(a.code).toBe(0);
		expect(b.code).toBe(0);

		const parse = (spawned: Spawned): Record<string, unknown> => {
			const line = spawned.stdout.trim().split("\n").filter(Boolean).at(-1);
			return line ? (JSON.parse(line) as Record<string, unknown>) : {};
		};
		const results = [parse(first), parse(second)];
		const winners = results.filter((r) => r.ok === true);
		const losers = results.filter((r) => r.ok === false);
		expect(winners).toHaveLength(1);
		expect(losers).toHaveLength(1);
		expect(["MISSION_OWNED", "MISSION_ACTIVE", "MISSION_TERMINAL"]).toContain(losers[0].code);

		const winner = winners[0];
		expect(winner.missionId).toBe(missionId);
		expect(winner.childSessionId).toBe(sessionId);
		expect(winner.attemptId).not.toBe("attempt_prior");
		expect(Number(winner.fencingToken)).toBeGreaterThan(0);

		const loaded = await store.load(missionId);
		expect(loaded.status).toBe("ok");
		if (loaded.status === "ok") {
			expect(loaded.record.request.childSessionId).toBe(sessionId);
			expect(loaded.record.attempts).toHaveLength(2);
		}

		rmSync(sessionDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});
});
