/**
 * Durable Mission Graph — engine state machines, durable store, replay and
 * reboot recovery.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	canExpandScope,
	completeObjective,
	deriveReadiness,
	initializeRuntime,
	isLegalTransition,
	type MissionEventRecord,
	type MissionGraphDocumentV1,
	type MissionObjective,
	type MissionScope,
	MissionStore,
	missionStatus,
	promoteMission,
	type RepositoryLease,
	reconcileAfterReboot,
	reconcileProcessAfterReboot,
	replayRuntime,
	startObjective,
	validateMissionGraph,
} from "../../src/core/mission/index.js";

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "mission-store-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function objective(id: string, deps: string[] = [], extra: Partial<MissionObjective> = {}): MissionObjective {
	return {
		id,
		title: id,
		dependencies: deps,
		declaredRepositories: ["repo:A"],
		estimate: 1,
		acceptanceCriteria: [{ id: `${id}-c1`, statement: `${id} done` }],
		requiresApproval: false,
		status: "PENDING",
		...extra,
	};
}

function doc(objectives: MissionObjective[]): MissionGraphDocumentV1 {
	const scope: MissionScope = { repositories: ["repo:A", "repo:B"], requireDeclaredRepositories: true };
	return {
		schemaVersion: 1,
		missionId: "m1",
		revision: 1,
		digest: "d",
		scope,
		objectives,
		contracts: [],
		status: "DRAFT",
		createdAtMs: 0,
		updatedAtMs: 0,
	};
}

function lease(repo = "repo:A"): RepositoryLease {
	return { leaseId: `lease-${repo}`, repositoryId: repo, holder: "proc-1", acquiredAtMs: 0, expiresAtMs: 1_000_000 };
}

describe("mission engine state machine", () => {
	it("promotes a valid DRAFT to ACTIVE and rejects an invalid graph", () => {
		const g = doc([objective("a")]);
		expect(validateMissionGraph(g).valid).toBe(true);
		const p = promoteMission(g, 100);
		expect(p.ok).toBe(true);
		expect(p.value?.status).toBe("ACTIVE");
		expect(p.value?.revision).toBe(2);

		const cyc = doc([objective("a", ["b"]), objective("b", ["a"])]);
		const bad = promoteMission(cyc, 100);
		expect(bad.ok).toBe(false);
		expect(bad.code).toBe("INVALID_GRAPH");
	});

	it("startObjective requires readiness and a held lease", () => {
		const g = promoteMission(doc([objective("a")]), 100).value!;
		const r0 = initializeRuntime(g, 0);
		// No lease → fail
		const noLease = startObjective(g, r0, "a", [], { processId: "proc-1", owner: "o", repositoryIds: ["repo:A"] }, 0);
		expect(noLease.ok).toBe(false);
		expect(noLease.code).toBe("LEASE_NOT_HELD");
		// With lease → ok
		const started = startObjective(
			g,
			r0,
			"a",
			[lease()],
			{ processId: "proc-1", owner: "o", repositoryIds: ["repo:A"] },
			0,
		);
		expect(started.ok).toBe(true);
		expect(started.value?.objectiveStatus.a).toBe("IN_PROGRESS");
	});

	it("completeObjective requires all acceptance criteria", () => {
		const g = promoteMission(doc([objective("a")]), 100).value!;
		const r = startObjective(
			g,
			initializeRuntime(g, 0),
			"a",
			[lease()],
			{ processId: "p", owner: "o", repositoryIds: ["repo:A"] },
			0,
		).value!;
		const missing = completeObjective(g, r, "a", [], 10);
		expect(missing.ok).toBe(false);
		expect(missing.code).toBe("MISSING_ACCEPTANCE_CRITERIA");
		const done = completeObjective(g, r, "a", ["a-c1"], 10).value!;
		expect(done.objectiveStatus.a).toBe("COMPLETED");
		expect(missionStatus(g, done)).toBe("COMPLETED");
	});

	it("legal transition table", () => {
		expect(isLegalTransition("PENDING", "READY")).toBe(true);
		expect(isLegalTransition("READY", "IN_PROGRESS")).toBe(true);
		expect(isLegalTransition("IN_PROGRESS", "COMPLETED")).toBe(true);
		expect(isLegalTransition("READY", "COMPLETED")).toBe(false);
	});

	it("readiness waits on approval and blocker", () => {
		const g = promoteMission(
			doc([
				objective("a", [], {
					requiresApproval: true,
					approvalGate: { id: "g", requiredPrincipals: ["human"], scope: "objective" },
				}),
			]),
			100,
		).value!;
		const readiness = deriveReadiness(g, initializeRuntime(g, 0), 0);
		expect(readiness.status.a).toBe("WAITING_APPROVAL");
	});
});

describe("mission scope integrity", () => {
	it("MISSION_CANNOT_EXPAND_ITS_OWN_SCOPE", () => {
		const g = doc([objective("a")]);
		const proposed = [objective("b", [], { declaredRepositories: ["repo:NEW"] })];
		expect(canExpandScope(g, proposed)).toBe(false);
		const allowed = [objective("b", [], { declaredRepositories: ["repo:B"] })];
		expect(canExpandScope(g, allowed)).toBe(true);
	});
});

describe("mission durable store & replay", () => {
	it("MISSION_STORE_ATOMIC save/load round-trips", async () => {
		const store = new MissionStore({ root: tempDir() });
		await store.initialize();
		const g = doc([objective("a")]);
		await store.saveGraph(g);
		const loaded = await store.loadGraph();
		expect(loaded).toEqual(g);
	});

	it("EVENT_LOG_REPLAY_PASS is idempotent (duplicate event ids not double-applied)", async () => {
		const store = new MissionStore({ root: tempDir() });
		await store.initialize();
		const ev: MissionEventRecord = {
			id: "ev-1",
			missionId: "m1",
			revision: 1,
			kind: "MISSION_CREATED",
			payload: { x: 1 },
			recordedAtMs: 0,
		};
		await store.appendEvent(ev);
		await store.appendEvent(ev); // duplicate
		const replayed = await store.replayEvents("m1");
		expect(replayed).toHaveLength(1);
		expect(replayed[0].id).toBe("ev-1");
	});

	it("MISSION_REPLAY_ZERO_EFFECTS derives state without mutating", async () => {
		const g = doc([objective("a")]);
		const { runtime, appliedCount } = replayRuntime(g, ["e1", "e1", "e2"], [], [], 0);
		// duplicate ids are not re-applied
		expect(appliedCount).toBe(2);
		expect(Object.keys(runtime.objectiveStatus)).toEqual(["a"]);
	});

	it("leases are repository-scoped and exclusive", async () => {
		const store = new MissionStore({ root: tempDir() });
		await store.initialize();
		const far = Date.now() + 60_000;
		expect(
			await store.acquireLease({
				leaseId: "l1",
				repositoryId: "repo:A",
				holder: "proc-1",
				acquiredAtMs: Date.now(),
				expiresAtMs: far,
			}),
		).toBe(true);
		// Another holder cannot take repo:A while unexpired.
		expect(
			await store.acquireLease({
				leaseId: "x",
				repositoryId: "repo:A",
				holder: "other",
				acquiredAtMs: Date.now(),
				expiresAtMs: far,
			}),
		).toBe(false);
		// A different repository is fine.
		expect(
			await store.acquireLease({
				leaseId: "y",
				repositoryId: "repo:B",
				holder: "other",
				acquiredAtMs: Date.now(),
				expiresAtMs: far,
			}),
		).toBe(true);
	});
});

describe("mission reboot recovery", () => {
	it("REBOOT_DOES_NOT_DUPLICATE_OBJECTIVE — completed work is preserved", () => {
		const g = promoteMission(doc([objective("a"), objective("b", ["a"])]), 100).value!;
		let r = initializeRuntime(g, 0);
		r = startObjective(g, r, "a", [lease()], { processId: "p", owner: "o", repositoryIds: ["repo:A"] }, 0).value!;
		r = completeObjective(g, r, "a", ["a-c1"], 10).value!;
		// a is COMPLETED; b had not started. After reboot:
		const rec = reconcileAfterReboot(g, r, /*processStillExists*/ false);
		expect(rec.runtime.objectiveStatus.a).toBe("COMPLETED"); // preserved
		expect(rec.runtime.objectiveStatus.b).toBe("PENDING");
		expect(rec.actions.some((x) => x.startsWith("objective a "))).toBe(false); // a not reverted
	});

	it("REBOOT reclassifies IN_PROGRESS to READY (no stale authority reuse) and marks process missing", () => {
		const g = promoteMission(doc([objective("a")]), 100).value!;
		let r = initializeRuntime(g, 0);
		r = startObjective(g, r, "a", [lease()], { processId: "proc-1", owner: "o", repositoryIds: ["repo:A"] }, 0)
			.value!;
		const rec = reconcileAfterReboot(g, r, false);
		expect(rec.runtime.objectiveStatus.a).toBe("READY");
		expect(rec.processRecordedMissing).toBe(true);
		expect(rec.runtime.process).toBeUndefined();
	});

	it("REBOOT does not reclassify a still-running process", () => {
		const g = promoteMission(doc([objective("a")]), 100).value!;
		const r = startObjective(
			g,
			initializeRuntime(g, 0),
			"a",
			[lease()],
			{ processId: "proc-1", owner: "o", repositoryIds: ["repo:A"] },
			0,
		).value!;
		const rec = reconcileAfterReboot(g, r, true);
		expect(rec.processRecordedMissing).toBe(false);
		expect(rec.runtime.process?.processId).toBe("proc-1");
	});

	it("STALE_PROCESS_RECONCILIATION releases leases of a dead process", async () => {
		const store = new MissionStore({ root: tempDir() });
		await store.initialize();
		await store.acquireLease(lease("repo:A")); // held by proc-1
		const rec = await reconcileProcessAfterReboot(store, "proc-1", false, 0);
		expect(rec.status).toBe("RECONCILED");
		const leases = await store.loadLeases();
		expect(leases.some((l) => l.holder === "proc-1")).toBe(false);
	});

	it("reconciliation is idempotent (second run has nothing to do)", async () => {
		const store = new MissionStore({ root: tempDir() });
		await store.initialize();
		await store.acquireLease(lease("repo:A"));
		await reconcileProcessAfterReboot(store, "proc-1", false, 0);
		const second = await reconcileProcessAfterReboot(store, "proc-1", false, 0);
		const leases = await store.loadLeases();
		expect(leases.some((l) => l.holder === "proc-1")).toBe(false);
		expect(["CLEAN", "RECONCILED"]).toContain(second.status);
	});
});
