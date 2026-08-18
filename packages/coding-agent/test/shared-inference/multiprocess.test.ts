/**
 * Shared Inference Scheduler — multiprocess test (3.0.0 foundation).
 *
 * Launches multiple real OS clients targeting the same file-backed queue with
 * capacity=1 and proves global active inference concurrency never exceeds 1. A
 * process-local semaphore that allowed one request PER PROCESS would fail here.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FileInferenceQueueStore } from "../../src/core/shared-inference/file-inference-queue-store.js";
import { terminateDetached, waitForChildExit } from "../utils/detached-process.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../../");
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const FIXTURE = path.join(__dirname, "fixtures", "inference-client.ts");

let root: string;
const activeChildren = new Set<ChildProcess>();

afterEach(async () => {
	const results = await Promise.allSettled(
		[...activeChildren].map(async (child) => {
			await terminateDetached(child);
			activeChildren.delete(child);
		}),
	);
	const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
	if (root) rmSync(root, { recursive: true, force: true });
	if (failures.length > 0)
		throw new AggregateError(
			failures.map((failure) => failure.reason),
			"child cleanup failed",
		);
});

function spawnClient(queueDir: string, agent: string, requests: number, extraArgs: string[] = []): ChildProcess {
	const child = spawn(
		process.execPath,
		[
			TSX_CLI,
			FIXTURE,
			"--dir",
			queueDir,
			"--agent",
			agent,
			"--requests",
			String(requests),
			"--hold-ms",
			"15",
			...extraArgs,
		],
		{ cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" },
	);
	activeChildren.add(child);
	return child;
}

async function runClient(
	queueDir: string,
	agent: string,
	requests: number,
	extraArgs: string[] = [],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const child = spawnClient(queueDir, agent, requests, extraArgs);
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (d: Buffer) => {
		stdout += d.toString();
	});
	child.stderr?.on("data", (d: Buffer) => {
		stderr += d.toString();
	});
	try {
		const exit = await waitForChildExit(child, 15_000);
		activeChildren.delete(child);
		return { code: exit.code, stdout, stderr };
	} catch (error) {
		try {
			await terminateDetached(child, { signal: "SIGKILL" });
			activeChildren.delete(child);
		} catch (cleanupError: unknown) {
			stderr += `\ncleanup: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
		}
		return { code: -1, stdout, stderr: `${stderr}\n${error instanceof Error ? error.message : String(error)}` };
	}
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

	it("bounds leak-soak cleanup, restart recovery, and unknown-request safety", async () => {
		root = mkdtempSync(path.join(tmpdir(), "shared-inference-mp-safety-"));
		const queueDir = path.join(root, "queue");

		const soak = await Promise.all([
			runClient(queueDir, "soak_a", 8),
			runClient(queueDir, "soak_b", 8),
			runClient(queueDir, "soak_c", 8),
		]);
		for (const result of soak) {
			expect(result.code, result.stderr).toBe(0);
			const summary = JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}") as {
				admittedCount: number;
				violations: number;
			};
			expect(summary.admittedCount).toBe(8);
			expect(summary.violations).toBe(0);
		}

		const crashed = spawnClient(queueDir, "crashed", 1, ["--lease-ms", "100", "--crash-after-admit"]);
		let crashedOutput = "";
		crashed.stdout?.on("data", (d: Buffer) => {
			crashedOutput += d.toString();
		});
		const started = Date.now();
		while (!crashedOutput.includes('"event":"admitted"')) {
			if (Date.now() - started >= 10_000)
				throw new Error(`timeout waiting for crash client admission; got: ${crashedOutput}`);
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const killed = await terminateDetached(crashed, {
			signal: "SIGKILL",
			gracefulTimeoutMs: 100,
			forceTimeoutMs: 1000,
		});
		expect(killed.forced).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 150));

		const restarted = await runClient(queueDir, "restarted", 2, [
			"--lease-ms",
			"100",
			"--recover",
			"--probe-unknown",
		]);
		expect(restarted.code, restarted.stderr).toBe(0);
		const restartSummary = JSON.parse(restarted.stdout.trim().split("\n").pop() ?? "{}") as {
			admittedCount: number;
			violations: number;
			recovered: string[];
			unknownStatus: string;
		};
		expect(restartSummary.admittedCount).toBe(2);
		expect(restartSummary.violations).toBe(0);
		expect(restartSummary.recovered).toContain("crashed-1");
		expect(restartSummary.unknownStatus).toBe("unknown");

		const store = new FileInferenceQueueStore({ root: queueDir });
		const ledger = await store.load("qwen38-bucephalus");
		expect(ledger.status).toBe("ok");
		if (ledger.status === "ok") {
			expect(ledger.ledger.running).toHaveLength(0);
			expect(ledger.ledger.queue).toHaveLength(0);
			expect(ledger.ledger.interruptedCount).toBe(1);
			expect(ledger.ledger.completedCount).toBe(26);
		}
	});
});
