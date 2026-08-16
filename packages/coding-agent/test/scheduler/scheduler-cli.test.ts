/**
 * Scheduler Foundation — CLI output tests (2.12.0).
 *
 * Proves `jensen scheduler ...` human and `--json` machine output are
 * structured and stable. Runs against temp durable stores (not the operator's
 * real ~/.jensen directories).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssignmentControlService, FileAssignmentStore } from "../../src/core/assignment/index.js";
import { ExecutorControlService, FileExecutorRegistry } from "../../src/core/executor-registry/index.js";
import { createDurableMissionRecord, createMissionRequest } from "../../src/core/mission-domain/index.js";
import { FileDurableMissionStore } from "../../src/core/mission-durable/index.js";
import { handleSchedulerCommand } from "../../src/core/scheduler/cli.js";
import { FileSchedulerStore } from "../../src/core/scheduler/index.js";

function makeRoot(): string {
	return mkdtempSync(path.join(tmpdir(), "scheduler-cli-"));
}

let root: string;
let captured: string[];

beforeEach(async () => {
	root = makeRoot();
	process.env.JENSEN_SCHEDULER_REGISTRY_DIR = `${root}/intents`;
	process.env.JENSEN_ASSIGNMENT_REGISTRY_DIR = `${root}/assignments`;
	process.env.JENSEN_DURABLE_MISSION_STORE = `${root}/missions`;
	process.env.JENSEN_EXECUTOR_REGISTRY_DIR = `${root}/executors`;
	captured = [];
	process.exitCode = 0;
	vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		captured.push(String(chunk));
		return true;
	});

	const missionStore = new FileDurableMissionStore({ root: `${root}/missions` });
	const executors = new ExecutorControlService({
		store: new FileExecutorRegistry({ root: `${root}/executors` }),
		expiryMs: 30_000,
	});
	new AssignmentControlService({
		store: new FileAssignmentStore({ root: `${root}/assignments` }),
		missions: missionStore,
		executors,
	});
	new FileSchedulerStore({ root: `${root}/intents` });

	await missionStore.create(
		createDurableMissionRecord({
			request: createMissionRequest({
				missionId: "mission_cli",
				objective: "objective",
				agent: "worker",
				executionMode: "execute",
				acceptanceCriteria: [],
			}),
			now: 1,
		}),
	);
	await executors.registerExecutor({
		executorId: "exec_cli",
		configuredCapabilities: { platform: { os: "linux", arch: "x64" }, execution: ["git"] },
	});
	await executors.activateExecutor("exec_cli", { platform: "linux", arch: "x64" });
});

afterEach(() => {
	delete process.env.JENSEN_SCHEDULER_REGISTRY_DIR;
	delete process.env.JENSEN_ASSIGNMENT_REGISTRY_DIR;
	delete process.env.JENSEN_DURABLE_MISSION_STORE;
	delete process.env.JENSEN_EXECUTOR_REGISTRY_DIR;
	process.exitCode = 0;
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

function text(): string {
	return captured.join("");
}

describe("TEST A — JSON CLI output matches DTO schema", () => {
	it("scheduler enqueue/list/show/run --json emit stable structured DTOs", async () => {
		expect(await handleSchedulerCommand(["scheduler", "enqueue", "mission_cli", "--json"])).toBe(true);
		const enqueued = JSON.parse(text()) as { intentId: string; state: string; status: string };
		expect(enqueued).toMatchObject({ intentId: "intent_mission_cli", state: "PENDING", status: "created" });

		captured = [];
		expect(await handleSchedulerCommand(["scheduler", "list", "--json"])).toBe(true);
		const list = JSON.parse(text()) as { entries: Record<string, unknown>[]; corrupt: unknown[] };
		expect(list.entries).toHaveLength(1);
		expect(list.entries[0]).toMatchObject({ missionId: "mission_cli", state: "PENDING" });
		expect(list.corrupt).toEqual([]);

		captured = [];
		expect(await handleSchedulerCommand(["scheduler", "show", "intent_mission_cli", "--json"])).toBe(true);
		const show = JSON.parse(text()) as { intentId: string; missionId: string; state: string };
		expect(show).toMatchObject({ intentId: "intent_mission_cli", missionId: "mission_cli", state: "PENDING" });

		captured = [];
		expect(await handleSchedulerCommand(["scheduler", "run", "--json"])).toBe(true);
		const run = JSON.parse(text()) as {
			assignmentsCreated: number;
			intentsAssigned: number;
			decisions: { decision: string; executorId: string; assignmentId: string }[];
		};
		expect(run.assignmentsCreated).toBe(1);
		expect(run.intentsAssigned).toBe(1);
		expect(run.decisions[0].decision).toBe("ASSIGN");
		expect(run.decisions[0].executorId).toBe("exec_cli");
		expect(run.decisions[0].assignmentId).toBeDefined();

		captured = [];
		expect(await handleSchedulerCommand(["scheduler", "list", "--json"])).toBe(true);
		const after = JSON.parse(text()) as { entries: { state: string; assignmentId: string }[] };
		expect(after.entries[0].state).toBe("ASSIGNED");
		expect(after.entries[0].assignmentId).toBe(run.decisions[0].assignmentId);
	});
});

describe("TEST B — preview is a read-only dry run", () => {
	it("scheduler preview --json does not mutate intent or assignment", async () => {
		await handleSchedulerCommand(["scheduler", "enqueue", "mission_cli"]);

		captured = [];
		expect(await handleSchedulerCommand(["scheduler", "preview", "--json"])).toBe(true);
		const preview = JSON.parse(text()) as { dryRun: boolean; decisions: { decision: string }[] };
		expect(preview.dryRun).toBe(true);
		expect(preview.decisions[0].decision).toBe("ASSIGN");

		captured = [];
		await handleSchedulerCommand(["scheduler", "list", "--json"]);
		const list = JSON.parse(text()) as { entries: { state: string }[] };
		expect(list.entries[0].state).toBe("PENDING");
	});
});

describe("TEST C — human CLI output", () => {
	it("scheduler show prints key state stably for operator use", async () => {
		await handleSchedulerCommand(["scheduler", "enqueue", "mission_cli"]);
		await handleSchedulerCommand(["scheduler", "run"]);

		captured = [];
		expect(await handleSchedulerCommand(["scheduler", "show", "mission_cli"])).toBe(true);
		const out = text();
		expect(out).toContain("intent: intent_mission_cli");
		expect(out).toContain("mission: mission_cli");
		expect(out).toContain("state: ASSIGNED");
	});
});
