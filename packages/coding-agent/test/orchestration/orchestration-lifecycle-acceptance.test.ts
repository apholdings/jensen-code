import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FileAssignmentStore } from "../../src/core/assignment/index.js";
import { FileDurableMissionStore } from "../../src/core/mission-durable/index.js";
import { createFileOrchestrationStore } from "../../src/core/orchestration/index.js";
import { FileSchedulerStore } from "../../src/core/scheduler/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../../");
const PACKAGE_ROOT = path.resolve(__dirname, "../..");
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const FIXTURE = path.join(__dirname, "fixtures", "orchestration-lifecycle-worker.ts");

interface ChildResult {
	stdout: string;
	stderr: string;
	exit: Promise<{ code: number | null; signal: string | null }>;
	process: ChildProcess;
}

function spawnFixture(root: string, operation: string, ...args: string[]): ChildResult {
	const child = spawn(
		process.execPath,
		[path.relative(PACKAGE_ROOT, TSX_CLI), path.relative(PACKAGE_ROOT, FIXTURE), operation, root, ...args],
		{
			cwd: PACKAGE_ROOT,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (data: Buffer) => {
		stdout += data.toString();
	});
	child.stderr.on("data", (data: Buffer) => {
		stderr += data.toString();
	});
	const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
		child.on("exit", (code, signal) => resolve({ code, signal }));
	});
	return {
		get stdout() {
			return stdout;
		},
		get stderr() {
			return stderr;
		},
		exit,
		process: child,
	};
}

async function waitFor(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`timeout waiting for ${label}`);
}

async function successfulFixture(root: string, operation: string, ...args: string[]): Promise<Record<string, unknown>> {
	const child = spawnFixture(root, operation, ...args);
	const result = await child.exit;
	expect(result.code, `${operation} stderr: ${child.stderr}`).toBe(0);
	const line = child.stdout.trim().split("\n").filter(Boolean).at(-1);
	if (!line) throw new Error(`${operation} produced no JSON output; stderr: ${child.stderr}`);
	return JSON.parse(line) as Record<string, unknown>;
}

function rootFixture(): string {
	return mkdtempSync(path.join(tmpdir(), "jensen-orchestration-lifecycle-"));
}

let root: string;

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

describe("parent orchestration lifecycle acceptance", () => {
	it("recovers across real OS process restart with stable orchestration, child mission, and session identities", async () => {
		root = rootFixture();
		await successfulFixture(root, "start");

		const crashed = spawnFixture(root, "crash");
		await waitFor(() => existsSync(path.join(root, "crash-started")), 30_000, "crash execution marker");
		crashed.process.kill("SIGKILL");
		const crashedResult = await crashed.exit;
		expect(crashedResult.signal).toBe("SIGKILL");

		await new Promise((resolve) => setTimeout(resolve, 600));
		const recovered = await successfulFixture(root, "recover");
		expect(recovered).toMatchObject({
			operation: "recover",
			orchestrationId: "orch_acceptance",
			childMissionId: "mission_orch_orch_acceptance_write-result",
			childSessionId: "child_orch_orch_acceptance_write-result",
			missionState: "INTERRUPTED",
		});

		const missions = new FileDurableMissionStore({ root: path.join(root, "missions") });
		const orchestrations = createFileOrchestrationStore(path.join(root, "orchestrations"));
		const assignments = new FileAssignmentStore({ root: path.join(root, "assignments") });
		const scheduler = new FileSchedulerStore({ root: path.join(root, "scheduler") });
		const plan = await orchestrations.load("orch_acceptance");
		expect(plan.status).toBe("ok");
		if (plan.status === "ok") {
			expect(plan.document.plan.nodes[0]).toMatchObject({
				childMissionId: "mission_orch_orch_acceptance_write-result",
				childSessionId: "child_orch_orch_acceptance_write-result",
			});
		}
		expect(await missions.listChildren("mission_parent")).toEqual(["mission_orch_orch_acceptance_write-result"]);
		expect(await scheduler.listIntents()).toEqual(["intent_mission_orch_orch_acceptance_write-result"]);
		const assignmentRecords = await assignments.listRecords();
		expect(assignmentRecords.records).toHaveLength(1);
		expect(assignmentRecords.records[0]).toMatchObject({ state: "FAILED", current: false });
		const child = await missions.load("mission_orch_orch_acceptance_write-result");
		expect(child.status).toBe("ok");
		if (child.status === "ok") {
			expect(child.record.attempts).toHaveLength(1);
			expect(child.record.attempts[0]).toMatchObject({
				executionId: "exec_gpt_luna_acceptance",
				endReason: "INTERRUPTED",
			});
			expect(child.record.result).toBeUndefined();
		}
	}, 90_000);

	it("converges concurrent cold reconcile across OS processes to one child, intent, assignment, and execution", async () => {
		root = rootFixture();
		await successfulFixture(root, "seed");

		const a = spawnFixture(root, "cold-reconcile", "a");
		const b = spawnFixture(root, "cold-reconcile", "b");
		const [resultA, resultB] = await Promise.all([a.exit, b.exit]);
		expect(resultA.code, a.stderr).toBe(0);
		expect(resultB.code, b.stderr).toBe(0);
		const coldResults = [a, b].map((child) => {
			const line = child.stdout.trim().split("\n").filter(Boolean).at(-1);
			if (!line) throw new Error(`cold-reconcile produced no JSON output; stderr: ${child.stderr}`);
			return JSON.parse(line) as Record<string, unknown>;
		});
		expect(coldResults.filter((result) => (result.materializedMissionIds as unknown[]).length === 1)).toHaveLength(1);
		expect(coldResults.filter((result) => (result.materializedMissionIds as unknown[]).length === 0)).toHaveLength(1);
		expect(coldResults.flatMap((result) => result.materializedMissionIds as string[])).toEqual([
			"mission_orch_orch_acceptance_write-result",
		]);

		const executed = await successfulFixture(root, "execute");
		expect(executed).toMatchObject({
			operation: "execute",
			missionState: "SUCCEEDED",
			childMissionId: "mission_orch_orch_acceptance_write-result",
			executionId: "exec_gpt_luna_acceptance",
		});

		const missions = new FileDurableMissionStore({ root: path.join(root, "missions") });
		const assignments = new FileAssignmentStore({ root: path.join(root, "assignments") });
		const scheduler = new FileSchedulerStore({ root: path.join(root, "scheduler") });
		expect(await missions.listChildren("mission_parent")).toEqual(["mission_orch_orch_acceptance_write-result"]);
		expect(await scheduler.listIntents()).toEqual(["intent_mission_orch_orch_acceptance_write-result"]);
		const finalAssignments = await assignments.listRecords();
		expect(finalAssignments.records).toHaveLength(1);
		expect(finalAssignments.records[0]).toMatchObject({ state: "COMPLETED", current: false });
		expect(readFileSync(path.join(root, "workspace", "result.txt"), "utf8")).toBe("expected content\n");
		expect(executed.result).toMatchObject({
			state: "SUCCEEDED",
			executionOutcome: "COMPLETED",
			success: true,
			outputText: "Created result.txt",
			verification: {
				status: "verified",
				summary: "result.txt was created by the deterministic GPT-5.6 Luna seam",
				criterionIds: ["file-created"],
			},
			completionDecision: "accepted",
		});
		const child = await missions.load("mission_orch_orch_acceptance_write-result");
		expect(child.status).toBe("ok");
		if (child.status === "ok") {
			expect(child.record.state).toBe("SUCCEEDED");
			expect(child.record.result).toMatchObject({
				state: "SUCCEEDED",
				executionOutcome: "COMPLETED",
				success: true,
				outputText: "Created result.txt",
				verification: { status: "verified", criterionIds: ["file-created"] },
				completionDecision: "accepted",
			});
			expect(child.record.attempts).toHaveLength(1);
			expect(child.record.attempts[0]?.executionId).toBe("exec_gpt_luna_acceptance");
			expect(child.record.request.childSessionId).toBe("child_orch_orch_acceptance_write-result");
		}
	});
});
