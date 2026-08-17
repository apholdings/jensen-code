/**
 * Durable Child AgentSession Restore — deterministic tests (2.6.0).
 *
 * Covers identity, binding, session persistence, checkpoint reconstruction,
 * evidence-reference durability, and conservative failure modes without a real
 * model or process boundary.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Message } from "@apholdings/jensen-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSubagentInvocation } from "../../examples/extensions/subagent/index.js";
import {
	buildEvidenceRecord,
	checkpointToRehydrationPreamble,
	hashContent,
	InMemoryEvidenceArchive,
} from "../../src/core/context-runtime/index.js";
import {
	bindChildSession,
	buildChildResumeCheckpoint,
	buildChildResumePrompt,
	ChildSessionRestoreError,
	defaultChildSessionDir,
	resolveChildSessionForResume,
} from "../../src/core/durable-child-session/index.js";
import {
	createDurableMissionRecord,
	createMissionRequest,
	createMissionResult,
	type DurableMissionRecord,
	isSafeChildSessionId,
	type MissionRequest,
	newChildSessionId,
	validateMissionRequest,
} from "../../src/core/mission-domain/index.js";
import { FileDurableMissionStore } from "../../src/core/mission-durable/index.js";
import { SessionManager } from "../../src/core/session-manager.js";

function makeDir(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

function childRequest(options: {
	missionId: string;
	childSessionId: string;
	parent?: { missionId: string; depth: number };
	constraints?: string[];
}): MissionRequest {
	return createMissionRequest({
		missionId: options.missionId,
		parent: options.parent,
		objective: "Implement a bounded task with tests",
		agent: "worker",
		executionMode: "execute",
		acceptanceCriteria: [],
		childSessionId: options.childSessionId,
		constraints: options.constraints ?? ["do not modify src/index.js"],
	});
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
			{
				seq: 3,
				from: "RUNNING",
				to: "INTERRUPTED",
				atMs: now,
				reason: "control_plane_restart: executor ownership lost",
			},
		],
		attempts: [
			{
				attemptId: "attempt_prior",
				executionId: "exec_prior",
				startedAtMs: now - 1000,
				endReason: "INTERRUPTED",
				recovery: { reason: "control_plane_restart: executor ownership lost", recoveredAtMs: now },
			},
		],
		fencingToken: 0,
		revision: 4,
	};
}

/** Create a flushed (on-disk) child session bound to a mission. */
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

describe("TEST A/B — durable child session identity", () => {
	it("A1 allocates a stable path-safe childSessionId and validates it", () => {
		const id = newChildSessionId();
		expect(id).toMatch(/^child_[0-9a-f-]+$/u);
		expect(isSafeChildSessionId(id)).toBe(true);
		expect(isSafeChildSessionId("../../evil")).toBe(false);
	});

	it("A2 a mission request persists childSessionId and constraints before execution", () => {
		const id = newChildSessionId();
		const request = childRequest({ missionId: "mission_a", childSessionId: id });
		const validation = validateMissionRequest(request);
		expect(validation.valid).toBe(true);
		expect(request.childSessionId).toBe(id);
		expect(request.constraints).toEqual(["do not modify src/index.js"]);
	});

	it("A3 unsafe childSessionId is rejected structurally", () => {
		const request = childRequest({ missionId: "mission_unsafe", childSessionId: "a/b" });
		const validation = validateMissionRequest(request);
		expect(validation.valid).toBe(false);
		if (!validation.valid) expect(validation.errors).toContain("UNSAFE_CHILD_SESSION_ID");
	});

	it("B1 the same missionId always resolves to the same immutable childSessionId", () => {
		const id = newChildSessionId();
		const first = childRequest({ missionId: "mission_b", childSessionId: id });
		const second = childRequest({ missionId: "mission_b", childSessionId: id });
		expect(first.childSessionId).toBe(second.childSessionId);

		// A conflicting re-create with a different session id is a semantic change.
		const different = childRequest({ missionId: "mission_b", childSessionId: newChildSessionId() });
		expect(different.childSessionId).not.toBe(first.childSessionId);
	});
});

describe("TEST C/D — binding and durable execution path", () => {
	it("C1 bindChildSession fails closed on a mismatched mission id", () => {
		const sm = SessionManager.inMemory();
		sm.appendChildBinding({ sessionId: sm.getSessionId(), missionId: "mission_wrong" });
		expect(() => bindChildSession(sm, "mission_expected")).toThrow(ChildSessionRestoreError);
		expect(() => bindChildSession(sm, "mission_expected")).toThrow(/bound to mission/u);
	});

	it("D1 durable child invocation carries --child-mission/--session-id and never --no-session", () => {
		const invocation = buildSubagentInvocation(
			"/tmp/cwd",
			{ name: "worker" } as never,
			"task",
			undefined,
			undefined,
			{
				childMissionId: "mission_d",
				childSessionId: "child_session_d",
				childSessionDir: "/tmp/child-sessions",
			},
		);
		expect(invocation.args).toContain("--child-mission");
		expect(invocation.args).toContain("mission_d");
		expect(invocation.args).toContain("--session-id");
		expect(invocation.args).toContain("child_session_d");
		expect(invocation.args).toContain("--session-dir");
		expect(invocation.args).not.toContain("--no-session");
	});
});

describe("TEST G/W — session survives interruption; corrupt binding fails safe", () => {
	let sessionDir: string;
	let cwd: string;

	beforeEach(() => {
		sessionDir = makeDir("child-session-dir-");
		cwd = makeDir("child-cwd-");
	});

	afterEach(() => {
		rmSync(sessionDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	it("G1 same childSessionId remains durable and loadable after a process boundary", async () => {
		const id = newChildSessionId();
		const missionId = "mission_g";
		persistChildSession(sessionDir, id, missionId, cwd);

		// Simulate restart: resolve the session by id and reopen it.
		const info = await SessionManager.findByExactIdInDir(id, sessionDir);
		expect(info).not.toBeNull();
		const reopened = SessionManager.open(info!.path, sessionDir);
		expect(reopened.getSessionId()).toBe(id);
		const binding = reopened.getLatestChildBinding();
		expect(binding?.missionId).toBe(missionId);
		expect(binding?.sessionId).toBe(id);
	});

	it("persists a binding when the existing session file contains only its header", async () => {
		const id = newChildSessionId();
		const sessionPath = path.join(sessionDir, `header-only-${id}.jsonl`);
		writeFileSync(
			sessionPath,
			`${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd })}\n`,
		);
		const sm = SessionManager.open(sessionPath, sessionDir);
		bindChildSession(sm, "mission_header_only");
		const reopened = SessionManager.open(sessionPath, sessionDir);
		expect(reopened.getLatestChildBinding()).toMatchObject({
			sessionId: id,
			missionId: "mission_header_only",
		});
	});

	it("W1 corrupt binding data is not trusted (treated as absent, then fail-closed)", async () => {
		const id = newChildSessionId();
		const missionId = "mission_w";
		const sm = SessionManager.createWithId(cwd, sessionDir, id);
		// Write a malformed binding payload directly.
		sm.appendCustomEntry("child_mission_binding", { not: "a binding" });
		expect(sm.getLatestChildBinding()).toBeUndefined();

		// A session with no valid binding cannot be restored for a mission.
		const store = new FileDurableMissionStore({ root: makeDir("store-w-") });
		await store.create(interruptedRecord(childRequest({ missionId, childSessionId: id }), Date.now()));
		await expect(resolveChildSessionForResume({ store, missionId, sessionDir })).rejects.toThrow(
			ChildSessionRestoreError,
		);
	});
});

describe("TEST H/I/K/L/M/N/O — resume resolution and checkpoint reconstruction", () => {
	let root: string;
	let sessionDir: string;
	let cwd: string;

	beforeEach(() => {
		root = makeDir("store-resume-");
		sessionDir = makeDir("child-session-dir-");
		cwd = makeDir("child-cwd-");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(sessionDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	it("H1 resolves the SAME mission + SAME session after interruption", async () => {
		const id = newChildSessionId();
		const missionId = "mission_h";
		const store = new FileDurableMissionStore({ root });
		await store.create(interruptedRecord(childRequest({ missionId, childSessionId: id }), Date.now()));
		const sm = persistChildSession(sessionDir, id, missionId, cwd);

		// Persist operational state + evidence refs BEFORE interruption.
		sm.appendSessionTodos([
			{ id: "t1", content: "read the spec", activeForm: "reading the spec", status: "completed" },
			{ id: "t2", content: "implement drain()", activeForm: "implementing drain()", status: "pending" },
		]);
		sm.appendSessionMemory([
			{ key: "decision.architecture", value: "use a queue", timestamp: new Date().toISOString() },
		]);
		sm.appendSessionEvidenceRefs([{ evidenceId: "tool-result:read:abc123", summary: "spec synopsis" }]);

		const resolved = await resolveChildSessionForResume({ store, missionId, sessionDir });
		expect(resolved.record.missionId).toBe(missionId);
		expect(resolved.childSessionId).toBe(id);
		expect(resolved.binding.missionId).toBe(missionId);
	});

	it("K1 constraints survive into the resume checkpoint", async () => {
		const id = newChildSessionId();
		const missionId = "mission_k";
		const record = interruptedRecord(
			childRequest({
				missionId,
				childSessionId: id,
				constraints: ["never modify src/index.js", "no cloud fallback"],
			}),
			Date.now(),
		);
		const sm = persistChildSession(sessionDir, id, missionId, cwd);
		const checkpoint = buildChildResumeCheckpoint(record, sm);
		expect(checkpoint.constraints).toEqual(["never modify src/index.js", "no cloud fallback"]);
	});

	it("L1 decisions (memory) survive into the resume checkpoint", async () => {
		const id = newChildSessionId();
		const missionId = "mission_l";
		const record = interruptedRecord(childRequest({ missionId, childSessionId: id }), Date.now());
		const sm = persistChildSession(sessionDir, id, missionId, cwd);
		sm.appendSessionMemory([
			{ key: "decision.use-queue", value: "FIFO with drain()", timestamp: new Date().toISOString() },
		]);
		const checkpoint = buildChildResumeCheckpoint(record, sm);
		expect(checkpoint.decisions).toHaveLength(1);
		expect(checkpoint.decisions[0].decision).toContain("decision");
		expect(checkpoint.decisions[0].rationale).toBe("FIFO with drain()");
	});

	it("J/N1 completed vs pending steps survive, so resume continues rather than replays", async () => {
		const id = newChildSessionId();
		const missionId = "mission_j";
		const record = interruptedRecord(childRequest({ missionId, childSessionId: id }), Date.now());
		const sm = persistChildSession(sessionDir, id, missionId, cwd);
		sm.appendSessionTodos([
			{ id: "t1", content: "read the spec", activeForm: "reading the spec", status: "completed" },
			{ id: "t2", content: "implement drain()", activeForm: "implementing drain()", status: "pending" },
		]);
		sm.appendSessionTasks([
			{ id: "task1", subject: "implement drain", description: "add drain method", status: "pending" },
		]);

		const checkpoint = buildChildResumeCheckpoint(record, sm);
		expect(checkpoint.completedSteps).toEqual(["read the spec"]);
		expect(checkpoint.pendingSteps).toEqual(["implement drain()"]);
		expect(checkpoint.nextActions).toContain("implement drain");

		const prompt = buildChildResumePrompt(record, sm);
		expect(prompt).toContain("resume");
		expect(prompt).toContain("read the spec");
		expect(prompt).toContain("implement drain()");
		expect(prompt).toContain("NEW execution attempt");
	});

	it("O1 evidence references from before interruption survive and remain retrievable", async () => {
		const id = newChildSessionId();
		const missionId = "mission_o";
		const record = interruptedRecord(childRequest({ missionId, childSessionId: id }), Date.now());
		const sm = persistChildSession(sessionDir, id, missionId, cwd);

		const archive = new InMemoryEvidenceArchive();
		const storedId = await archive.store({
			kind: "tool-result",
			source: "read",
			content: "authoritative spec content (large)",
		});
		sm.appendSessionEvidenceRefs([{ evidenceId: storedId, summary: "spec synopsis" }]);

		const checkpoint = buildChildResumeCheckpoint(record, sm);
		expect(checkpoint.evidenceRefs.map((r) => r.evidenceId)).toContain(storedId);

		// Cold evidence remains loadable and integrity-verifiable after the checkpoint.
		const loaded = await archive.load(storedId);
		expect(loaded).toBeDefined();
		expect(hashContent(loaded!.content)).toBe(loaded!.contentHash);
	});

	it("X1 a durable mission referencing a missing child session fails conservatively", async () => {
		const id = newChildSessionId();
		const missionId = "mission_x";
		const store = new FileDurableMissionStore({ root });
		await store.create(interruptedRecord(childRequest({ missionId, childSessionId: id }), Date.now()));

		await expect(resolveChildSessionForResume({ store, missionId, sessionDir })).rejects.toThrow(
			ChildSessionRestoreError,
		);
		await expect(resolveChildSessionForResume({ store, missionId, sessionDir })).rejects.toThrow(
			/CHILD_SESSION_NOT_FOUND|not found/u,
		);
	});
});

describe("TEST T/Y/Z — terminal authority, evidence authority, provider independence", () => {
	it("T1 a terminal child mission cannot be resumed again", async () => {
		const id = newChildSessionId();
		const missionId = "mission_t";
		const store = new FileDurableMissionStore({ root: makeDir("store-t-") });
		const request = childRequest({ missionId, childSessionId: id });
		const base = createDurableMissionRecord({ request, now: 1000 });
		const terminal: DurableMissionRecord = {
			...base,
			state: "SUCCEEDED",
			result: createMissionResult({
				missionId,
				parentMissionId: request.parentMissionId,
				depth: request.depth,
				state: "SUCCEEDED",
				executionOutcome: "COMPLETED",
				verification: { status: "verified" },
				completionDecision: "accepted",
				failures: [],
				executorDiagnostics: { executorId: "test", processExitCode: 0 },
				startedAtMs: 1000,
				finishedAtMs: 2000,
			}),
			resultExecutionId: "exec_t",
			transitions: [{ seq: 0, from: "RUNNING", to: "SUCCEEDED", atMs: 2000, executionId: "exec_t" }],
			attempts: [
				{
					attemptId: "attempt_t",
					executionId: "exec_t",
					startedAtMs: 1000,
					finishedAtMs: 2000,
					endReason: "COMPLETED",
				},
			],
			revision: 3,
		};
		await store.create(terminal);

		await expect(resolveChildSessionForResume({ store, missionId })).rejects.toThrow(/terminal mission/u);
	});

	it("Y1 a checkpoint can never fabricate success", () => {
		const id = newChildSessionId();
		const record = createDurableMissionRecord({
			request: childRequest({ missionId: "mission_y", childSessionId: id }),
			now: 1,
		});
		const sm = SessionManager.inMemory();
		const checkpoint = buildChildResumeCheckpoint(record, sm);
		expect(checkpoint.completionAuthority).toBe("mission-runtime-only");
		const preamble = checkpointToRehydrationPreamble(checkpoint);
		expect(preamble).toContain("completion remains governed by the Reliability Kernel");
		expect(preamble).not.toContain("SUCCEEDED");
	});

	it("Z1 child-session semantics are provider-independent (no provider in the durable path)", () => {
		const id = newChildSessionId();
		const request = childRequest({ missionId: "mission_z", childSessionId: id });
		const record = createDurableMissionRecord({ request, now: 1 });
		expect(record.request.modelPolicy).toBeUndefined();
		expect(record.request.childSessionId).toBe(id);
		expect(defaultChildSessionDir()).toContain("child-sessions");
		expect(buildEvidenceRecord({ kind: "tool-result", source: "read", content: "x" }).evidenceId).toMatch(
			/^tool-result/u,
		);
	});
});
