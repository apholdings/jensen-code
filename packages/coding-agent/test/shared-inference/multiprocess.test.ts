/**
 * Shared Inference Scheduler — multiprocess test (3.0.0 foundation).
 *
 * Launches multiple real OS clients targeting the same file-backed queue with
 * capacity=1 and proves global active inference concurrency never exceeds 1. A
 * process-local semaphore that allowed one request PER PROCESS would fail here.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../../");
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const FIXTURE = path.join(__dirname, "fixtures", "inference-client.ts");

let root: string;

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

function runClient(
	queueDir: string,
	agent: string,
	requests: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(
			process.execPath,
			[TSX_CLI, FIXTURE, "--dir", queueDir, "--agent", agent, "--requests", String(requests), "--hold-ms", "15"],
			{ cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		child.stderr.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		child.on("error", (error) => {
			resolve({ code: -1, stdout, stderr: `${stderr}\n${error.message}` });
		});
		child.on("exit", (code) => resolve({ code, stdout, stderr }));
	});
}

describe("SharedInferenceScheduler — multiprocess", () => {
	it("multiple OS processes share one physical slot (capacity=1)", async () => {
		root = mkdtempSync(path.join(tmpdir(), "shared-inference-mp-"));
		const queueDir = path.join(root, "queue");

		const results = await Promise.all([
			runClient(queueDir, "agent_a", 5),
			runClient(queueDir, "agent_b", 5),
			runClient(queueDir, "agent_c", 5),
		]);

		for (const result of results) {
			expect(result.code, `stderr: ${result.stderr}`).toBe(0);
			const summary = JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}") as {
				admittedCount: number;
				violations: number;
			};
			expect(summary.admittedCount).toBe(5);
			expect(summary.violations).toBe(0);
		}
	});
});
