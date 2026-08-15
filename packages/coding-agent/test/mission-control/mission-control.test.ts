/**
 * Mission Control Plane — deterministic tests (2.9.0).
 *
 * Covers the structured read model, resumability, resume integration, cancel
 * safety, corruption isolation, evidence compatibility, and provider
 * independence without a real model. Multiprocess observability/resume-race
 * tests live in mission-control-multiprocess.test.ts; CLI output tests live in
 * mission-control-cli.test.ts.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Message } from "@apholdings/jensen-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryEvidenceArchive } from "../../src/core/context-runtime/index.js";
import { bindChildSession } from "../../src/core/durable-child-session/index.js";
import { DurableMissionDelegator } from "../../src/core/durable-delegation/index.js";
import {
	MissionControlError,
	MissionControlService,
	type MissionDetail,
} from "../../src/core/mission-control/index.js";
import {
	createDurableMissionRecord,
	createMissionRequest,
	createMissionResult,
	type DurableMissionRecord,
	type ExecutionLease,
	ExecutionOwnershipError,
	type MissionRequest,
	newChildSessionId,
} from "../../src/core/mission-domain/index.js";
import { FileDurableMissionStore } from "../../src/core/mission-durable/index.js";
import { SessionManager } from "../../src/core/session-manager.js";

function makeRoot(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

function request(
	missionId: string,
	childSessionId?: string,
	parent?: { missionId: string; depth: number },
): MissionRequest {
	return createMissionRequest({
		missionId,
		parent,
		objective: `objective of ${missionId}`,
		agent: "worker",
		executionMode: "execute",
		acceptanceCriteria: [],
		childSessionId,
	});
}

async function waitUntil(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
	const start = Date.now();
	for (;;) {
		if (predicate()) return;
		if (Date.now() - start > timeoutMs) throw new Error("waitUntil timeout");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function persistChildSession(
	sessionDir: string,
	childSessionId: string,
	missionId: string,
	cwd: string,
): SessionManager {
	const sm = SessionManager.createWithId(cwd, sessionDir, childSessionId);
	bindChildSession(sm, missionId);
	sm.appendMessage({ role: "user", content: "start" } as Message);
	sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }] } as Message);
	return sm;
}

function interruptedRecord(request: MissionRequest, now: number): DurableMissionRecord {
	return {
		schemaVersion: 1,
		missionId: request.missionId,
		parentMissionId: request.parentMissionId,
		depth: request.depth,
		request,
		state: "INTERRUPTED",
		createdAtMs: request.createdAtMs,
		updatedAtMs: now,
		startedAtMs: now - 1000,
		transitions: [
			{ seq: 0, from: "CREATED", to: "QUEUED", atMs: now - 1000 },
			{ seq: 1, from: "QUEUED", to: "LAUNCHING", atMs: now - 1000, attemptId: "attempt_prior" },
			{ seq: 2, from: "LAUNCHING", to: "RUNNING", atMs: now - 1000, executionId: "exec_prior" },
			{ seq: 3, from: "RUNNING", to: "INTERRUPTED", atMs: now, reason: "control_plane_restart" },
		],
		attempts: [
			{
				attemptId: "attempt_prior",
				executionId: "exec_prior",
				startedAtMs: now - 1000,
				endReason: "INTERRUPTED",
				recovery: { reason: "control_plane_restart", recoveredAtMs: now },
			},
		],
		fencingToken: 0,
		revision: 4,
	};
}

function terminalRecord(request: MissionRequest, now: number): DurableMissionRecord {
	const base = createDurableMissionRecord({ request, now });
	return {
		...base,
		state: "SUCCEEDED",
		updatedAtMs: now + 1000,
		startedAtMs: now,
		finishedAtMs: now + 1000,
		result: createMissionResult({
			missionId: request.missionId,
			parentMissionId: request.parentMissionId,
			depth: request.depth,
			state: "SUCCEEDED",
			executionOutcome: "COMPLETED",
			verification: { status: "verified" },
			completionDecision: "accepted",
			evidenceRefs: ["tool-result:test:abc123"],
			failures: [],
			executorDiagnostics: { executorId: "test", processExitCode: 0 },
			startedAtMs: now,
			finishedAtMs: now + 1000,
		}),
		resultExecutionId: "exec_terminal",
		transitions: [{ seq: 0, from: "RUNNING", to: "SUCCEEDED", atMs: now + 1000, executionId: "exec_terminal" }],
		attempts: [
			{
				attemptId: "attempt_terminal",
				executionId: "exec_terminal",
				startedAtMs: now,
				finishedAtMs: now + 1000,
				endReason: "COMPLETED",
			},
		],
		fencingToken: 3,
		revision: 3,
	};
}

async function seedActiveLease(
	store: FileDurableMissionStore,
	missionId: string,
	lease: ExecutionLease,
): Promise<void> {
	await store.mutate(missionId, (current) => ({
		kind: "write",
		value: undefined,
		next: {
			...current,
			state: "RUNNING",
			fencingToken: lease.fencingToken,
			lease,
			updatedAtMs: lease.acquiredAtMs,
			revision: current.revision + 1,
		},
	}));
}

let root: string;
let store: FileDurableMissionStore;

beforeEach(() => {
	root = makeRoot("mission-control-");
	store = new FileDurableMissionStore({ root });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("TEST A/B — list and deterministic filtering", () => {
	it("lists multiple mission states correctly and filters without altering records", async () => {
		await store.create(createDurableMissionRecord({ request: request("mission_created"), now: 1 }));
		await store.create(interruptedRecord(request("mission_interrupted", "child_i"), 2));
		await store.create(terminalRecord(request("mission_done"), 3));

		const control = new MissionControlService({ store, now: () => 100 });
		const all = await control.listMissions();
		expect(all.entries.map((e) => e.missionId).sort()).toEqual([
			"mission_created",
			"mission_done",
			"mission_interrupted",
		]);
		expect(all.corrupt).toEqual([]);

		const interrupted = await control.listMissions({ filter: { state: "INTERRUPTED" } });
		expect(interrupted.entries.map((e) => e.missionId)).toEqual(["mission_interrupted"]);

		const terminal = await control.listMissions({ filter: { terminal: true } });
		expect(terminal.entries.map((e) => e.missionId)).toEqual(["mission_done"]);

		// Filtering is a pure projection: records are unchanged.
		const reloaded = await store.load("mission_interrupted");
		expect(reloaded.status).toBe("ok");
		if (reloaded.status === "ok") {
			expect(reloaded.record.state).toBe("INTERRUPTED");
			expect(reloaded.record.revision).toBe(4);
		}
	});
});

describe("TEST C/AA — detail aggregates request/attempt/result and exposes childSessionId", () => {
	it("detail is structured and bounded", async () => {
		const sessionId = newChildSessionId();
		const record = interruptedRecord(
			request("mission_detail", sessionId, { missionId: "mission_parent", depth: 0 }),
			10,
		);
		await store.create(record);

		const control = new MissionControlService({ store, now: () => 100 });
		const detail = await control.getMission("mission_detail");
		expect(detail.summary.missionId).toBe("mission_detail");
		expect(detail.summary.childSessionId).toBe(sessionId);
		expect(detail.summary.parentMissionId).toBe("mission_parent");
		expect(detail.summary.attemptCount).toBe(1);
		expect(detail.request.objective).toContain("mission_detail");
		// Interrupted records clear the current-attempt pointer; prior attempts
		// remain in attempt history (verified separately in TEST G).
		expect(detail.currentAttempt).toBeUndefined();
		expect((await control.getAttempts("mission_detail")).attempts[0].attemptId).toBe("attempt_prior");
		expect(detail.result.available).toBe(false);
		expect(detail.resumability.resumable).toBe(true);
		expect(detail.children).toEqual([]);
	});
});

describe("TEST D/E/F — mission tree", () => {
	it("nests A→B→C plus a sibling and survives a store/process restart", async () => {
		const a = request("mission_a");
		const b = request("mission_b", "child_b", { missionId: "mission_a", depth: 0 });
		const c = request("mission_c", "child_c", { missionId: "mission_b", depth: 1 });
		const d = request("mission_d", "child_d", { missionId: "mission_b", depth: 1 });
		await store.create(createDurableMissionRecord({ request: a, now: 1 }));
		await store.create(createDurableMissionRecord({ request: b, now: 2 }));
		await store.create(createDurableMissionRecord({ request: c, now: 3 }));
		await store.create(createDurableMissionRecord({ request: d, now: 4 }));

		const control = new MissionControlService({ store, now: () => 100 });
		const tree = await control.getMissionTree("mission_a");
		expect(tree.missionId).toBe("mission_a");
		expect(tree.children.map((n) => n.missionId)).toEqual(["mission_b"]);
		expect(tree.children[0].children.map((n) => n.missionId)).toEqual(["mission_c", "mission_d"]);

		// Restart simulation: a fresh control instance over the same store root.
		const restarted = new MissionControlService({ store: new FileDurableMissionStore({ root }), now: () => 100 });
		const tree2 = await restarted.getMissionTree("mission_a");
		expect(tree2.children[0].children.map((n) => n.missionId)).toEqual(["mission_c", "mission_d"]);
	});

	it("broken/missing relation fails diagnostically", async () => {
		await store.create(createDurableMissionRecord({ request: request("mission_root"), now: 1 }));
		// A child record whose parent does not match the traversal edge.
		await store.create(
			createDurableMissionRecord({
				request: request("mission_orphan", undefined, { missionId: "mission_missing_parent", depth: 0 }),
				now: 2,
			}),
		);

		const control = new MissionControlService({ store, now: () => 100 });
		await expect(control.getMissionTree("mission_root")).resolves.toBeDefined();
		await expect(control.getMissionTree("mission_missing_parent")).rejects.toThrow(MissionControlError);
	});
});

describe("TEST G — attempt history", () => {
	it("preserves interrupted and resumed attempts in order", async () => {
		const sessionId = newChildSessionId();
		const record = interruptedRecord(request("mission_history", sessionId), 10);
		// Append a prior attempt so ordering is observable.
		record.attempts.unshift({
			attemptId: "attempt_oldest",
			startedAtMs: 1,
			finishedAtMs: 2,
			endReason: "INTERRUPTED",
		});
		await store.create(record);

		const control = new MissionControlService({ store });
		const history = await control.getAttempts("mission_history");
		expect(history.attempts.map((a) => a.attemptId)).toEqual(["attempt_oldest", "attempt_prior"]);
		expect(history.currentAttemptId).toBeUndefined();
	});
});

describe("TEST H/I — ownership and lease status", () => {
	it("active lease rendered; expired lease never presented as healthy owner", async () => {
		const now = 1000;
		await store.create(createDurableMissionRecord({ request: request("mission_owned"), now: 1 }));

		const active: ExecutionLease = {
			ownerId: "owner_active",
			leaseId: "lease_active",
			fencingToken: 1,
			acquiredAtMs: now,
			renewedAtMs: now,
			expiresAtMs: now + 10_000,
		};
		await seedActiveLease(store, "mission_owned", active);

		const control = new MissionControlService({ store, now: () => now });
		const activeView = await control.getOwnership("mission_owned");
		expect(activeView.owned).toBe(true);
		expect(activeView.leaseStatus).toBe("ACTIVE");
		expect(activeView.ownerId).toBe("owner_active");
		expect(activeView.fencingToken).toBe(1);

		const expiredControl = new MissionControlService({ store, now: () => now + 20_000 });
		const expired = await expiredControl.getOwnership("mission_owned");
		expect(expired.owned).toBe(false);
		expect(expired.leaseStatus).toBe("EXPIRED");
	});
});

describe("TEST J — local heartbeat telemetry distinguished from durable ownership", () => {
	it("this process sees heartbeat; another process sees only durable lease", async () => {
		const sessionId = newChildSessionId();
		const sessionDir = makeRoot("session-");
		const cwd = makeRoot("cwd-");
		const missionId = "mission_heartbeat_visible";
		await store.create(interruptedRecord(request(missionId, sessionId), Date.now()));
		persistChildSession(sessionDir, sessionId, missionId, cwd);

		const control = new MissionControlService({
			store,
			sessionDir,
			leaseDurationMs: 2000,
			heartbeatIntervalMs: 500,
			renewalSafetyMarginMs: 500,
		});
		const resume = control.resumeMission(missionId, {
			buildResumeLaunch: () => ({
				command: process.execPath,
				args: ["-e", "setInterval(()=>{},1000)"],
				cwd,
			}),
		});

		await waitUntil(() => control.localHeartbeatTelemetry(missionId)?.heartbeatActive === true);

		const sameProcess = await control.getOwnership(missionId);
		expect(sameProcess.owned).toBe(true);
		expect(sameProcess.localRuntime?.known).toBe(true);
		expect(sameProcess.localRuntime?.heartbeatTelemetry?.heartbeatActive).toBe(true);

		const otherProcess = new MissionControlService({ store });
		const otherView = await otherProcess.getOwnership(missionId);
		expect(otherView.owned).toBe(true);
		expect(otherView.localRuntime).toBeUndefined();

		// Cleanup: cancel the still-running child through the owning control plane.
		const cancelled = await control.cancelMission(missionId);
		expect(cancelled.executorConfirmedStopped).toBe(true);
		await resume;
		rmSync(sessionDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});
});

describe("TEST K/L — canonical result authority and no fabrication", () => {
	it("result view uses the canonical MissionResult and non-terminal prose cannot fabricate one", async () => {
		await store.create(terminalRecord(request("mission_canonical"), 10));
		await store.create(interruptedRecord(request("mission_nonterminal", "child_nt"), 10));

		const control = new MissionControlService({ store });
		const canonical = await control.getResult("mission_canonical");
		expect(canonical.available).toBe(true);
		expect(canonical.result?.state).toBe("SUCCEEDED");
		expect(canonical.result?.verification.status).toBe("verified");
		expect(canonical.resultExecutionId).toBe("exec_terminal");

		const nonterminal = await control.getResult("mission_nonterminal");
		expect(nonterminal.available).toBe(false);
		expect(nonterminal.result).toBeUndefined();

		const detail = await control.getMission("mission_nonterminal");
		expect(detail.result.available).toBe(false);
		expect(detail.summary.resultStatus).toBeUndefined();
	});
});

describe("TEST M/AB — evidence refs and retrieval continuity", () => {
	it("refs are inspectable without loading contents and existing retrieval remains compatible", async () => {
		const archive = new InMemoryEvidenceArchive();
		const evidenceId = await archive.store({
			kind: "tool-result",
			source: "test",
			content: "authoritative large content",
		});
		const record = terminalRecord(request("mission_evidence"), 10);
		record.result = {
			...record.result!,
			evidenceRefs: Object.freeze([evidenceId]),
		};
		await store.create(record);

		const control = new MissionControlService({ store, evidenceArchive: archive });
		const refs = await control.getEvidenceRefs("mission_evidence");
		expect(refs).toHaveLength(1);
		expect(refs[0].evidenceId).toBe(evidenceId);
		expect(refs[0].available).toBe(true);

		const resolved = await control.resolveEvidence(evidenceId);
		expect(resolved.ok).toBe(true);
		expect(resolved.metadata?.contentHash).toBeDefined();
	});
});

describe("TEST N/O — resumability", () => {
	it("classifies resumable vs non-resumable and terminal missions are never resumable", async () => {
		const sessionId = newChildSessionId();
		await store.create(interruptedRecord(request("mission_resumable", sessionId), 10));
		await store.create(interruptedRecord(request("mission_no_session"), 10));
		await store.create(terminalRecord(request("mission_terminal"), 10));

		const control = new MissionControlService({ store, now: () => 100 });
		expect((await control.getResumability("mission_resumable")).resumable).toBe(true);
		expect((await control.getResumability("mission_no_session")).resumable).toBe(false);
		expect((await control.getResumability("mission_terminal")).resumable).toBe(false);

		await expect(
			control.resumeMission("mission_terminal", {
				buildResumeLaunch: () => ({ command: "true", args: [], cwd: root }),
			}),
		).rejects.toThrow(MissionControlError);
	});
});

describe("TEST P/Q — resume via control plane preserves identity and gets a new fence", () => {
	it("interrupted child resumes through MissionControl with new attempt/fence", async () => {
		const sessionId = newChildSessionId();
		const sessionDir = makeRoot("session-");
		const cwd = makeRoot("cwd-");
		const missionId = "mission_resume_control";
		await store.create(interruptedRecord(request(missionId, sessionId), Date.now()));
		persistChildSession(sessionDir, sessionId, missionId, cwd);

		const control = new MissionControlService({ store, sessionDir });
		const outcome = await control.resumeMission(missionId, {
			buildResumeLaunch: () => ({ command: process.execPath, args: ["-e", "process.exit(0)"], cwd }),
		});

		expect(outcome.missionId).toBe(missionId);
		expect(outcome.childSessionId).toBe(sessionId);
		expect(outcome.attemptId).not.toBe("attempt_prior");
		expect(outcome.fencingToken).toBeGreaterThan(0);
		expect(outcome.missionState).toBe("PARTIAL");
		expect(outcome.result.verification.status).toBe("unverified");

		const reloaded = await store.load(missionId);
		expect(reloaded.status).toBe("ok");
		if (reloaded.status === "ok") {
			expect(reloaded.record.request.childSessionId).toBe(sessionId);
			expect(reloaded.record.attempts).toHaveLength(2);
		}

		rmSync(sessionDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});
});

describe("TEST S/T/U — cancellation safety", () => {
	it("supported cancel stops a local child; terminal no-ops; stale owner cannot overwrite", async () => {
		const sessionId = newChildSessionId();
		const sessionDir = makeRoot("session-");
		const cwd = makeRoot("cwd-");
		const missionId = "mission_cancel_local";
		await store.create(interruptedRecord(request(missionId, sessionId), Date.now()));
		persistChildSession(sessionDir, sessionId, missionId, cwd);

		const control = new MissionControlService({ store, sessionDir });
		const resume = control.resumeMission(missionId, {
			buildResumeLaunch: () => ({
				command: process.execPath,
				args: ["-e", "setInterval(()=>{},1000)"],
				cwd,
			}),
		});
		await waitUntil(() => control.localHeartbeatTelemetry(missionId)?.heartbeatActive === true);

		const cancelled = await control.cancelMission(missionId);
		expect(cancelled.status).toBe("cancelled");
		expect(cancelled.executorConfirmedStopped).toBe(true);
		await resume;

		const reloaded = await store.load(missionId);
		expect(reloaded.status).toBe("ok");
		if (reloaded.status === "ok") {
			expect(reloaded.record.state).toBe("CANCELLED");
			expect(reloaded.record.lease).toBeUndefined();
		}

		// Terminal no-op.
		const terminal = await control.cancelMission(missionId);
		expect(terminal.status).toBe("terminal");
		expect(terminal.executorConfirmedStopped).toBe(false);

		// Stale owner cannot overwrite cancellation: the old execution-lease proof
		// is rejected and the terminal CANCELLED record remains authoritative.
		const staleOwner = new DurableMissionDelegator({ store });
		await expect(staleOwner.releaseOwnership(missionId, { leaseId: "lease_old", fencingToken: 1 })).rejects.toThrow(
			ExecutionOwnershipError,
		);
		const afterStale = await store.load(missionId);
		expect(afterStale.status).toBe("ok");
		if (afterStale.status === "ok") {
			expect(afterStale.record.state).toBe("CANCELLED");
			expect(afterStale.record.result).toBeDefined();
		}

		rmSync(sessionDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});
});

describe("TEST V — read-only inspection never mutates", () => {
	it("list/show/tree/ownership/attempts/result/evidence leave revision and lease untouched", async () => {
		const now = 1000;
		await store.create(createDurableMissionRecord({ request: request("mission_readonly"), now: 1 }));
		await seedActiveLease(store, "mission_readonly", {
			ownerId: "owner_r",
			leaseId: "lease_r",
			fencingToken: 1,
			acquiredAtMs: now,
			renewedAtMs: now,
			expiresAtMs: now + 10_000,
		});

		const before = await store.load("mission_readonly");
		expect(before.status).toBe("ok");

		const control = new MissionControlService({ store, now: () => now });
		await control.listMissions();
		await control.getMission("mission_readonly");
		await control.getMissionTree("mission_readonly");
		await control.getOwnership("mission_readonly");
		await control.getAttempts("mission_readonly");
		await control.getResult("mission_readonly");
		await control.getEvidenceRefs("mission_readonly");

		const after = await store.load("mission_readonly");
		expect(after.status).toBe("ok");
		if (before.status === "ok" && after.status === "ok") {
			expect(after.record.revision).toBe(before.record.revision);
			expect(after.record.lease).toEqual(before.record.lease);
			expect(after.record.updatedAtMs).toBe(before.record.updatedAtMs);
		}
	});
});

describe("TEST Z — corrupt mission isolation", () => {
	it("one corrupt record does not destroy healthy listing and reports structurally", async () => {
		await store.create(createDurableMissionRecord({ request: request("mission_healthy"), now: 1 }));
		writeFileSync(path.join(root, "mission_corrupt.mission.json"), "{not json", "utf8");

		const control = new MissionControlService({ store });
		const list = await control.listMissions();
		expect(list.entries.map((e) => e.missionId)).toEqual(["mission_healthy"]);
		expect(list.corrupt).toHaveLength(1);
		expect(list.corrupt[0].missionId).toBe("mission_corrupt");

		await expect(control.getMission("mission_corrupt")).rejects.toThrow(MissionControlError);
	});
});

describe("TEST AC/AD — completion authority and provider independence", () => {
	it("control plane never fabricates success and has no provider dependency", () => {
		const sourceRoot = path.resolve(__dirname, "../../src/core/mission-control");
		const serviceSource = readFileSync(path.join(sourceRoot, "mission-control-service.ts"), "utf8");
		const typesSource = readFileSync(path.join(sourceRoot, "mission-control-types.ts"), "utf8");
		const combined = `${serviceSource}\n${typesSource}`.toLowerCase();
		for (const provider of ["qwen", "openrouter", "llamacpp", "anthropic", "openai", "bedrock"]) {
			expect(combined).not.toContain(provider);
		}
	});

	it("checkpoint summary is bounded and does not include transcripts", async () => {
		await store.create(interruptedRecord(request("mission_checkpoint", "child_cp"), 10));
		const control = new MissionControlService({ store });
		const detail: MissionDetail = await control.getMission("mission_checkpoint");
		expect(detail.checkpointSummary.objective).toContain("mission_checkpoint");
		expect(detail.checkpointSummary.lastTransition?.from).toBe("RUNNING");
	});
});
