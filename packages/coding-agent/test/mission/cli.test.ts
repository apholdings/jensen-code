/**
 * Durable Mission Graph — Mission Control CLI commands.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleMissionCommand } from "../../src/core/mission/index.js";

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "mission-cli-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
	for (const env of ["JENSEN_MISSION_STORE"]) delete process.env[env];
});

function writeDefinition(storeRoot: string, missionId: string): string {
	const file = path.join(storeRoot, "def.json");
	writeFileSync(
		file,
		JSON.stringify(
			{
				missionId,
				scope: { repositories: ["repo:A", "repo:B"], requireDeclaredRepositories: true },
				objectives: [
					{
						id: "a",
						title: "a",
						dependencies: [],
						declaredRepositories: ["repo:A"],
						estimate: 1,
						acceptanceCriteria: [{ id: "a-c1", statement: "done" }],
						requiresApproval: false,
						status: "PENDING",
					},
					{
						id: "b",
						title: "b",
						dependencies: ["a"],
						declaredRepositories: ["repo:B"],
						estimate: 1,
						acceptanceCriteria: [{ id: "b-c1", statement: "done" }],
						requiresApproval: false,
						status: "PENDING",
					},
				],
				contracts: [],
			},
			null,
			2,
		),
	);
	return file;
}

describe("mission CLI", () => {
	let root: string;

	beforeEach(() => {
		root = tempDir();
		process.env.JENSEN_MISSION_STORE = root;
	});

	it("handles mission|doctor mission commands", async () => {
		expect(await handleMissionCommand(["mission", "help"])).toBe(true);
		expect(await handleMissionCommand([""])).toBe(false);
	});

	it("create -> validate -> plan -> graph -> status round trip", async () => {
		const def = writeDefinition(root, "m1");
		expect(await handleMissionCommand(["mission", "create", def])).toBe(true);
		expect(await handleMissionCommand(["mission", "validate", "m1"])).toBe(true);
		expect(await handleMissionCommand(["mission", "plan", "m1"])).toBe(true);
		expect(await handleMissionCommand(["mission", "graph", "m1"])).toBe(true);
		expect(await handleMissionCommand(["mission", "start", "m1"])).toBe(true);
		expect(await handleMissionCommand(["mission", "status", "m1"])).toBe(true);
		expect(await handleMissionCommand(["mission", "replay", "m1"])).toBe(true);
		expect(await handleMissionCommand(["mission", "reconcile", "--preview", "m1"])).toBe(true);
		expect(await handleMissionCommand(["doctor", "mission"])).toBe(true);
	});

	it("creates a persisted graph with a stable digest", async () => {
		const def = writeDefinition(root, "m2");
		await handleMissionCommand(["mission", "create", def, "--json"]);
		const raw = readFileSync(path.join(root, "m2", "mission-graph.json"), "utf8");
		const g = JSON.parse(raw);
		expect(g.missionId).toBe("m2");
		expect(g.schemaVersion).toBe(1);
		expect(g.revision).toBe(1);
		expect(typeof g.digest).toBe("string");
	});

	it("rejects an invalid mission on create", async () => {
		const file = path.join(root, "bad.json");
		writeFileSync(
			file,
			JSON.stringify({
				missionId: "bad",
				scope: { repositories: ["repo:A"], requireDeclaredRepositories: true },
				objectives: [
					{
						id: "x",
						dependencies: ["ghost"],
						declaredRepositories: ["repo:A"],
						estimate: 1,
						acceptanceCriteria: [{ id: "x-c1", statement: "d" }],
						requiresApproval: false,
						status: "PENDING",
					},
				],
			}),
		);
		expect(await handleMissionCommand(["mission", "create", file])).toBe(true);
		expect(process.exitCode).toBe(1);
		process.exitCode = 0;
	});
});
