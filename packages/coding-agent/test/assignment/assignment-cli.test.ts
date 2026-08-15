/**
 * Assignment Foundation — CLI output tests (2.11.0).
 *
 * Proves `jensen assignment ...` human and `--json` machine output are
 * structured and stable. Runs against temp durable stores (not the operator's
 * real ~/.jensen directories).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAssignmentCommand } from "../../src/core/assignment/cli.js";
import { AssignmentControlService, FileAssignmentStore } from "../../src/core/assignment/index.js";
import { ExecutorControlService, FileExecutorRegistry } from "../../src/core/executor-registry/index.js";
import { createDurableMissionRecord, createMissionRequest } from "../../src/core/mission-domain/index.js";
import { FileDurableMissionStore } from "../../src/core/mission-durable/index.js";

function makeRoot(): string {
	return mkdtempSync(path.join(tmpdir(), "assignment-cli-"));
}

let root: string;
let captured: string[];

beforeEach(async () => {
	root = makeRoot();
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
	const executorStore = new FileExecutorRegistry({ root: `${root}/executors` });
	const assignmentStore = new FileAssignmentStore({ root: `${root}/assignments` });
	const executors = new ExecutorControlService({ store: executorStore, expiryMs: 30_000, assignmentStore });
	const service = new AssignmentControlService({ store: assignmentStore, missions: missionStore, executors });

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
	await service.assignMission({
		missionId: "mission_cli",
		executorId: "exec_cli",
		requirements: { platform: { os: "linux" } },
	});
});

afterEach(() => {
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

describe("TEST AC — JSON CLI output matches DTO schema", () => {
	it("assignment list/show/compatibility --json emit stable structured DTOs", async () => {
		expect(await handleAssignmentCommand(["assignment", "list", "--json"])).toBe(true);
		const list = JSON.parse(text()) as { entries: Record<string, unknown>[]; corrupt: unknown[] };
		expect(list.entries).toHaveLength(1);
		expect(list.entries[0]).toMatchObject({
			missionId: "mission_cli",
			executorId: "exec_cli",
			state: "ASSIGNED",
			current: true,
		});
		expect(list.corrupt).toEqual([]);

		const assignmentId = String(list.entries[0].assignmentId);
		captured = [];
		expect(await handleAssignmentCommand(["assignment", "show", assignmentId, "--json"])).toBe(true);
		const show = JSON.parse(text()) as { assignmentId: string; requirementsSnapshot: Record<string, unknown> };
		expect(show.assignmentId).toBe(assignmentId);
		expect(show.requirementsSnapshot?.platform).toEqual({ os: "linux" });

		captured = [];
		expect(
			await handleAssignmentCommand([
				"assignment",
				"compatibility",
				"--mission",
				"mission_cli",
				"--executor",
				"exec_cli",
				"--json",
			]),
		).toBe(true);
		const compatibility = JSON.parse(text()) as { assignability: { compatible: boolean; assignable: boolean } };
		expect(compatibility.assignability.compatible).toBe(true);
		expect(compatibility.assignability.assignable).toBe(true);
	});
});

describe("TEST AD — human CLI output", () => {
	it("assignment show prints key state stably for operator use", async () => {
		// Discover the assignment id from the machine output first.
		expect(await handleAssignmentCommand(["assignment", "list", "--json"])).toBe(true);
		const list = JSON.parse(text()) as { entries: { assignmentId: string }[] };
		const assignmentId = list.entries[0].assignmentId;
		captured = [];

		expect(await handleAssignmentCommand(["assignment", "show", assignmentId])).toBe(true);
		const out = text();
		expect(out).toContain(`id: ${assignmentId}`);
		expect(out).toContain("mission: mission_cli");
		expect(out).toContain("executor: exec_cli");
		expect(out).toContain("state: ASSIGNED");
		expect(out).toContain("current: yes");
	});
});
