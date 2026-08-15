/**
 * Mission Control Plane — CLI output tests (2.9.0).
 *
 * Proves `jensen mission ...` human and `--json` machine output are structured
 * and stable. Runs against a temp durable-mission store (not the operator's
 * real ~/.jensen/durable-missions directory).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleMissionControlCommand } from "../../src/core/mission-control/cli.js";
import { createDurableMissionRecord, createMissionRequest } from "../../src/core/mission-domain/index.js";
import { FileDurableMissionStore } from "../../src/core/mission-durable/index.js";

function makeRoot(): string {
	return mkdtempSync(path.join(tmpdir(), "mission-control-cli-"));
}

let root: string;
let store: FileDurableMissionStore;
let captured: string[];

beforeEach(() => {
	root = makeRoot();
	store = new FileDurableMissionStore({ root });
	process.env.JENSEN_DURABLE_MISSION_STORE = root;
	captured = [];
	process.exitCode = 0;
	vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		captured.push(String(chunk));
		return true;
	});
});

afterEach(() => {
	delete process.env.JENSEN_DURABLE_MISSION_STORE;
	process.exitCode = 0;
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

function text(): string {
	return captured.join("");
}

describe("TEST X — JSON CLI output matches DTO schema", () => {
	it("mission list/show/ownership --json emit stable structured DTOs", async () => {
		await store.create(
			createDurableMissionRecord({
				request: createMissionRequest({
					missionId: "mission_cli_json",
					objective: "objective",
					agent: "worker",
					executionMode: "execute",
					acceptanceCriteria: [],
					childSessionId: "child_cli",
				}),
				now: 1,
			}),
		);

		expect(await handleMissionControlCommand(["mission", "list", "--json"])).toBe(true);
		const list = JSON.parse(text()) as { entries: Record<string, unknown>[] };
		expect(list.entries).toHaveLength(1);
		expect(list.entries[0]).toMatchObject({
			missionId: "mission_cli_json",
			state: "CREATED",
			childSessionId: "child_cli",
			terminal: false,
			resumable: true,
		});

		captured = [];
		expect(await handleMissionControlCommand(["mission", "show", "mission_cli_json", "--json"])).toBe(true);
		const show = JSON.parse(text()) as { summary: Record<string, unknown>; request: Record<string, unknown> };
		expect(show.summary.missionId).toBe("mission_cli_json");
		expect(show.request.objective).toBe("objective");

		captured = [];
		expect(await handleMissionControlCommand(["mission", "ownership", "mission_cli_json", "--json"])).toBe(true);
		const ownership = JSON.parse(text()) as { owned: boolean; leaseStatus: string; fencingToken: number };
		expect(ownership.owned).toBe(false);
		expect(ownership.leaseStatus).toBe("NONE");
		expect(ownership.fencingToken).toBe(0);
	});
});

describe("TEST Y — human CLI output", () => {
	it("mission show prints key state stably for operator use", async () => {
		await store.create(
			createDurableMissionRecord({
				request: createMissionRequest({
					missionId: "mission_cli_human",
					objective: "objective",
					agent: "worker",
					executionMode: "execute",
					acceptanceCriteria: [],
				}),
				now: 1,
			}),
		);

		expect(await handleMissionControlCommand(["mission", "show", "mission_cli_human"])).toBe(true);
		const out = text();
		expect(out).toContain("id: mission_cli_human");
		expect(out).toContain("state: CREATED");
		expect(out).toContain("resumable: no");
		expect(out).toContain("OWNERSHIP");
		expect(out).toContain("owned: no");
	});
});
