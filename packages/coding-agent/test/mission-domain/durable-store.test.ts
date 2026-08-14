/**
 * Durable Mission Store tests (2.4.0) — store-level durability.
 *
 * TEST A — create / reopen
 * TEST E — terminal roundtrip
 * TEST F — parent/child restore
 * TEST G — corrupt record
 * TEST H — partial write / temp file
 * TEST I — duplicate create
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createDurableMissionRecord,
	createMissionRequest,
	createMissionResult,
	type DurableMissionRecord,
	type MissionExecutionOutcome,
	type MissionRequest,
	type MissionState,
} from "../../src/core/mission-domain/index.js";
import { FileDurableMissionStore } from "../../src/core/mission-durable/index.js";

function makeRoot(): string {
	return mkdtempSync(path.join(tmpdir(), "durable-mission-"));
}

let root: string;
let store: FileDurableMissionStore;

beforeEach(() => {
	root = makeRoot();
	store = new FileDurableMissionStore({ root });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function request(missionId: string, parent?: { missionId: string; depth: number }): MissionRequest {
	return createMissionRequest({
		missionId,
		parent,
		objective: `objective of ${missionId}`,
		agent: "worker",
		executionMode: "execute",
		acceptanceCriteria: [],
	});
}

function resultFor(
	missionId: string,
	parentMissionId: string | undefined,
	depth: number,
	state: MissionState,
	executionOutcome: MissionExecutionOutcome,
) {
	return createMissionResult({
		missionId,
		parentMissionId,
		depth,
		state,
		executionOutcome,
		outputText: state === "PARTIAL" ? "execution completed, unverified" : undefined,
		verification: { status: state === "SUCCEEDED" ? "verified" : "unverified" },
		completionDecision: state === "SUCCEEDED" ? "accepted" : "unavailable",
		failures: [],
		executorDiagnostics: {
			executorId: "test",
			processExitCode: executionOutcome === "COMPLETED" ? 0 : 1,
		},
		startedAtMs: 1,
		finishedAtMs: 2,
	});
}

/** Build a valid next record one revision ahead of `record`. */
function advance(record: DurableMissionRecord, to: MissionState, reason: string): DurableMissionRecord {
	return {
		...record,
		state: to,
		transitions: [
			...record.transitions,
			{ seq: record.transitions.length, from: record.state, to, atMs: record.updatedAtMs + 1, reason },
		],
		updatedAtMs: record.updatedAtMs + 1,
		revision: record.revision + 1,
	};
}

describe("TEST A — create / reopen", () => {
	it("A1 persists identity, request, parent, depth, and known state without executing", async () => {
		const req = request("mission_a", { missionId: "root", depth: 0 });
		const record = createDurableMissionRecord({ request: req, now: 1000 });
		const created = await store.create(record);
		expect(created.status).toBe("created");

		// "Destroy" the store instance and reopen over the same root.
		const reopened = new FileDurableMissionStore({ root });
		const loaded = await reopened.load("mission_a");
		expect(loaded.status).toBe("ok");
		if (loaded.status !== "ok") return;

		expect(loaded.record.missionId).toBe("mission_a");
		expect(loaded.record.request.missionId).toBe("mission_a");
		expect(loaded.record.request.objective).toBe("objective of mission_a");
		expect(loaded.record.parentMissionId).toBe("root");
		expect(loaded.record.depth).toBe(1);
		expect(loaded.record.state).toBe("CREATED");
		expect(loaded.record.result).toBeUndefined();
	});
});

describe("TEST E — terminal roundtrip", () => {
	const terminal: Array<[MissionState, MissionExecutionOutcome]> = [
		["SUCCEEDED", "COMPLETED"],
		["PARTIAL", "COMPLETED"],
		["FAILED", "FAILED"],
		["CANCELLED", "CANCELLED"],
		["TIMED_OUT", "TIMED_OUT"],
		["CRASHED", "CRASHED"],
	];

	it("E1 every terminal state and structured result round-trips exactly", async () => {
		for (const [state, outcome] of terminal) {
			const missionId = `mission_${state.toLowerCase()}`;
			const req = request(missionId);
			const result = resultFor(missionId, undefined, 0, state, outcome);
			const record: DurableMissionRecord = {
				...createDurableMissionRecord({ request: req, now: 1 }),
				state,
				updatedAtMs: 2,
				finishedAtMs: 2,
				result,
				resultExecutionId: `exec_${state.toLowerCase()}`,
				transitions: [{ seq: 0, from: "RUNNING", to: state, atMs: 2, executionId: `exec_${state.toLowerCase()}` }],
				attempts: [
					{
						attemptId: `attempt_${state.toLowerCase()}`,
						executionId: `exec_${state.toLowerCase()}`,
						startedAtMs: 1,
						finishedAtMs: 2,
						endReason: outcome,
					},
				],
				revision: 3,
			};
			await store.create(record);
		}

		const reopened = new FileDurableMissionStore({ root });
		for (const [state] of terminal) {
			const missionId = `mission_${state.toLowerCase()}`;
			const loaded = await reopened.load(missionId);
			expect(loaded.status).toBe("ok");
			if (loaded.status !== "ok") continue;
			expect(loaded.record.state).toBe(state);
			expect(loaded.record.result?.state).toBe(state);
			expect(loaded.record.result?.success).toBe(state === "SUCCEEDED");
			expect(loaded.record.result?.verification.status).toBe(state === "SUCCEEDED" ? "verified" : "unverified");
		}
	});

	it("E2 a terminal record never becomes INTERRUPTED merely because the store reopens", async () => {
		const req = request("mission_terminal_guard");
		const record: DurableMissionRecord = {
			...createDurableMissionRecord({ request: req, now: 1 }),
			state: "SUCCEEDED",
			finishedAtMs: 2,
			result: resultFor("mission_terminal_guard", undefined, 0, "SUCCEEDED", "COMPLETED"),
			resultExecutionId: "exec_1",
			transitions: [{ seq: 0, from: "RUNNING", to: "SUCCEEDED", atMs: 2, executionId: "exec_1" }],
			attempts: [
				{ attemptId: "attempt_1", executionId: "exec_1", startedAtMs: 1, finishedAtMs: 2, endReason: "COMPLETED" },
			],
			revision: 3,
		};
		await store.create(record);

		const reopened = new FileDurableMissionStore({ root });
		const loaded = await reopened.load("mission_terminal_guard");
		expect(loaded.status).toBe("ok");
		if (loaded.status === "ok") {
			expect(loaded.record.state).toBe("SUCCEEDED");
		}
	});
});

describe("TEST F — parent/child restore", () => {
	it("F1 reconstructs the tree A → (B,C), B → D without parsing prompts", async () => {
		const A = request("mission_A");
		const B = request("mission_B", { missionId: "mission_A", depth: 0 });
		const C = request("mission_C", { missionId: "mission_A", depth: 0 });
		const D = request("mission_D", { missionId: "mission_B", depth: 1 });

		for (const req of [A, B, C, D]) {
			await store.create(createDurableMissionRecord({ request: req, now: 1 }));
		}

		const reopened = new FileDurableMissionStore({ root });
		const childrenA = await reopened.listChildren("mission_A");
		expect(childrenA.sort()).toEqual(["mission_B", "mission_C"]);
		const childrenB = await reopened.listChildren("mission_B");
		expect(childrenB).toEqual(["mission_D"]);
		const childrenD = await reopened.listChildren("mission_D");
		expect(childrenD).toEqual([]);

		const loadedD = await reopened.load("mission_D");
		expect(loadedD.status).toBe("ok");
		if (loadedD.status === "ok") {
			expect(loadedD.record.parentMissionId).toBe("mission_B");
			expect(loadedD.record.depth).toBe(2);
		}
	});
});

describe("TEST G — corrupt record", () => {
	it("G1 corruption is surfaced structurally and healthy siblings stay readable", async () => {
		await store.create(createDurableMissionRecord({ request: request("mission_healthy"), now: 1 }));

		writeFileSync(path.join(root, "mission_bad.mission.json"), "{ not valid json", "utf8");

		const bad = await store.load("mission_bad");
		expect(bad.status).toBe("corrupt");
		if (bad.status === "corrupt") {
			expect(bad.missionId).toBe("mission_bad");
			expect(bad.diagnostic).toMatch(/not valid JSON/u);
		}

		const healthy = await store.load("mission_healthy");
		expect(healthy.status).toBe("ok");
	});

	it("G2 a structurally-valid JSON record with a wrong schema version is corrupt, never success", async () => {
		const req = request("mission_wrong_schema");
		const record = createDurableMissionRecord({ request: req, now: 1 });
		writeFileSync(
			path.join(root, "mission_wrong_schema.mission.json"),
			JSON.stringify({ ...record, schemaVersion: 99 }),
			"utf8",
		);

		const loaded = await store.load("mission_wrong_schema");
		expect(loaded.status).toBe("corrupt");
	});

	it("G3 a fabricated SUCCEEDED result with inconsistent success flag is corrupt", async () => {
		const req = request("mission_bad_success");
		const record = createDurableMissionRecord({ request: req, now: 1 });
		// Corrupt: state is SUCCEEDED but success is false — impossible under the
		// canonical invariant (success === state === "SUCCEEDED").
		const fabricated = {
			...record,
			state: "SUCCEEDED",
			result: {
				...resultFor("mission_bad_success", undefined, 0, "PARTIAL", "COMPLETED"),
				state: "SUCCEEDED",
				success: false,
			},
		};
		writeFileSync(path.join(root, "mission_bad_success.mission.json"), JSON.stringify(fabricated), "utf8");

		const loaded = await store.load("mission_bad_success");
		expect(loaded.status).toBe("corrupt");
	});
});

describe("TEST H — partial write / temp file", () => {
	it("H1 an incomplete temp file never replaces the last valid authoritative state", async () => {
		const req = request("mission_atomic");
		const record = createDurableMissionRecord({ request: req, now: 1 });
		await store.create(record);

		// Simulate a crash mid-write: a truncated temp file sits beside the target.
		writeFileSync(path.join(root, "mission_atomic.mission.json.tmp"), '{"schemaVersion":1,"missi', "utf8");

		const loaded = await store.load("mission_atomic");
		expect(loaded.status).toBe("ok");
		if (loaded.status === "ok") {
			expect(loaded.record.missionId).toBe("mission_atomic");
			expect(loaded.record.state).toBe("CREATED");
		}

		const ids = await store.listMissions();
		expect(ids).toEqual(["mission_atomic"]);
	});
});

describe("TEST I — duplicate create", () => {
	it("I1 identical request is idempotent; conflicting request is rejected", async () => {
		const req1 = request("mission_dup");
		const record1 = createDurableMissionRecord({ request: req1, now: 1 });
		expect((await store.create(record1)).status).toBe("created");

		// Identical immutable request (same fields, different field insertion order).
		const req1Equivalent = createMissionRequest({
			missionId: "mission_dup",
			objective: "objective of mission_dup",
			agent: "worker",
			executionMode: "execute",
			acceptanceCriteria: [],
			now: req1.createdAtMs,
		});
		const idempotent = await store.create(createDurableMissionRecord({ request: req1Equivalent, now: 2 }));
		expect(idempotent.status).toBe("idempotent");

		// Conflicting request (different objective).
		const conflicting = createMissionRequest({
			missionId: "mission_dup",
			objective: "a DIFFERENT objective",
			agent: "worker",
			executionMode: "execute",
			acceptanceCriteria: [],
		});
		const conflict = await store.create(createDurableMissionRecord({ request: conflicting, now: 3 }));
		expect(conflict.status).toBe("conflict");

		// The original request was never overwritten.
		const loaded = await store.load("mission_dup");
		expect(loaded.status).toBe("ok");
		if (loaded.status === "ok") {
			expect(loaded.record.request.objective).toBe("objective of mission_dup");
		}
	});
});

describe("safe mission id", () => {
	it("rejects path-traversal mission ids", async () => {
		await expect(store.load("../escape")).rejects.toThrow(/Unsafe mission id/u);
	});
});

describe("CONCURRENCY — optimistic revision compare-and-save", () => {
	it("CONCURRENCY-1 two independent store instances cannot silently overwrite a stale writer", async () => {
		const storeA = new FileDurableMissionStore({ root });
		const storeB = new FileDurableMissionStore({ root });
		const req = request("mission_concurrent");
		const initial = createDurableMissionRecord({ request: req, now: 1 });
		expect((await storeA.create(initial)).status).toBe("created");

		// Both instances read the same revision independently.
		const loadedA = await storeA.load("mission_concurrent");
		const loadedB = await storeB.load("mission_concurrent");
		if (loadedA.status !== "ok" || loadedB.status !== "ok") throw new Error("unexpected missing record");

		const nextA = advance(loadedA.record, "QUEUED", "writer A");
		const nextB = advance(loadedB.record, "QUEUED", "writer B");

		// Both try to commit the SAME revision advance concurrently.
		const [resultA, resultB] = await Promise.all([
			storeA.save(nextA, { expectedRevision: loadedA.record.revision }),
			storeB.save(nextB, { expectedRevision: loadedB.record.revision }),
		]);

		// Exactly one wins; the other receives a structural conflict, never a silent win.
		const statuses = [resultA.status, resultB.status].sort();
		expect(statuses).toEqual(["saved", "stale"]);

		const stale = resultA.status === "stale" ? resultA : resultB;
		expect(stale).toMatchObject({ status: "stale", expectedRevision: 1, actualRevision: 2 });

		const winnerReason = resultA.status === "saved" ? "writer A" : "writer B";
		const final = await storeA.load("mission_concurrent");
		expect(final.status).toBe("ok");
		if (final.status === "ok") {
			expect(final.record.revision).toBe(2);
			expect(final.record.state).toBe("QUEUED");
			expect(final.record.transitions[0].reason).toBe(winnerReason);
		}
	});

	it("CONCURRENCY-2 concurrent writes leave no temp residue and no cross-mission corruption", async () => {
		const store = new FileDurableMissionStore({ root });
		const records = Array.from({ length: 20 }, (_, i) =>
			createDurableMissionRecord({ request: request(`mission_burst_${i}`), now: i + 1 }),
		);
		await Promise.all(records.map((record) => store.create(record)));

		const loaded = await Promise.all(records.map((record) => store.load(record.missionId)));
		await Promise.all(
			loaded.map((entry) => {
				if (entry.status !== "ok") throw new Error("unexpected missing record");
				return store.save(advance(entry.record, "QUEUED", "burst"), { expectedRevision: entry.record.revision });
			}),
		);

		// No temporary files may remain, and every record must be complete + valid.
		expect(readdirSync(root).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
		for (const record of records) {
			const result = await store.load(record.missionId);
			expect(result.status).toBe("ok");
			if (result.status === "ok") expect(result.record.state).toBe("QUEUED");
		}
	});
});

describe("ATOMICITY — atomic write matches documented durability guarantees", () => {
	it("ATOMICITY-1 the target is always a complete record; temp files never survive a save", async () => {
		const store = new FileDurableMissionStore({ root });
		const req = request("mission_atomicity");
		const first = createDurableMissionRecord({ request: req, now: 1 });
		expect((await store.create(first)).status).toBe("created");

		const loaded = await store.load("mission_atomicity");
		if (loaded.status !== "ok") throw new Error("unexpected missing record");
		const second = advance(loaded.record, "QUEUED", "atomic");
		expect((await store.save(second, { expectedRevision: loaded.record.revision })).status).toBe("saved");

		const raw = readFileSync(path.join(root, "mission_atomicity.mission.json"), "utf8");
		expect(() => JSON.parse(raw)).not.toThrow();
		expect(readdirSync(root).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);

		const final = await store.load("mission_atomicity");
		expect(final.status).toBe("ok");
		if (final.status === "ok") expect(final.record.revision).toBe(2);
	});
});
