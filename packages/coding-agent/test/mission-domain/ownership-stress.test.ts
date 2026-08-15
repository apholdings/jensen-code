/**
 * Multiprocess ownership stress harness (2.7.0).
 *
 * Spawns several independent worker processes that repeatedly race to acquire,
 * renew, and release the same durable mission's execution lease. The invariants
 * checked afterward are structural: the fencing token strictly increases across
 * every successful acquisition with no gaps or duplicates, every lease id is
 * unique, and the final record is valid, non-terminal, and lease-free.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDurableMissionRecord, createMissionRequest } from "../../src/core/mission-domain/index.js";
import { FileDurableMissionStore } from "../../src/core/mission-durable/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../../");
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const WORKER = path.join(__dirname, "fixtures", "store-worker.ts");

const WORKERS = 6;
const ITERATIONS = 15;

function runWorker(args: string[]): Promise<{ stdout: string; stderr: string }> {
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
		child.on("close", () => resolve({ stdout, stderr }));
	});
}

let root: string;
let store: FileDurableMissionStore;

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "ownership-stress-"));
	store = new FileDurableMissionStore({ root });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("Phase V — deterministic multiprocess stress", () => {
	it("revision/fence never regress and no two successful acquisitions share an epoch", async () => {
		await store.create(
			createDurableMissionRecord({
				request: createMissionRequest({
					missionId: "mission_stress",
					objective: "stress target",
					agent: "worker",
					executionMode: "execute",
					acceptanceCriteria: [],
				}),
				now: 1,
			}),
		);

		const logs: string[] = [];
		const workers = Array.from({ length: WORKERS }, (_, i) => {
			const logFile = path.join(root, `worker-${i}.log`);
			logs.push(logFile);
			return runWorker([
				"--root",
				root,
				"--op",
				"stress",
				"--missionId",
				"mission_stress",
				"--iterations",
				String(ITERATIONS),
				"--log",
				logFile,
			]);
		});

		const results = await Promise.all(workers);
		for (const result of results) {
			if (result.stderr.trim()) {
				throw new Error(`stress worker failed: ${result.stderr.trim()}`);
			}
		}

		const fences: number[] = [];
		const leaseIds = new Set<string>();
		for (const logFile of logs) {
			let content = "";
			try {
				content = readFileSync(logFile, "utf8").trim();
			} catch {
				// A worker that never won an acquisition has no log file.
				continue;
			}
			if (!content) continue;
			for (const line of content.split("\n")) {
				const [fence, leaseId] = line.split("\t");
				fences.push(Number(fence));
				leaseIds.add(leaseId);
			}
		}

		// Every successful acquisition must receive a strictly increasing epoch:
		// exactly 1..N with no gaps or duplicates. Each lease id is unique.
		const sorted = [...fences].sort((a, b) => a - b);
		expect(sorted).toEqual(Array.from({ length: sorted.length }, (_, i) => i + 1));
		expect(leaseIds.size).toBe(sorted.length);
		expect(sorted.length).toBeGreaterThan(0);

		// Final record is valid, lease-free, and its epoch equals the number of
		// successful acquisitions (no recovery revocation occurred).
		const loaded = await store.load("mission_stress");
		expect(loaded.status).toBe("ok");
		if (loaded.status === "ok") {
			expect(loaded.record.lease).toBeUndefined();
			expect(loaded.record.fencingToken).toBe(sorted.length);
			expect(loaded.record.revision).toBeGreaterThanOrEqual(1);
		}

		// No corrupt partial temp writes survive the stress.
		expect(readdirSync(root).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
	});
});
