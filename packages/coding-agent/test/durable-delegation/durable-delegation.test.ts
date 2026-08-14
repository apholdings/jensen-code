/**
 * Durable Delegation tests (2.5.0).
 *
 * These tests exercise the production delegation seam (DurableMissionDelegator)
 * that the subagent extension now drives. They prove the durable child mission
 * exists BEFORE execution, terminal results round-trip, interruption is
 * conservative, parallel/chain semantics are preserved, correlation is
 * observable, identity is never PID-derived, and recovery never auto-runs work.
 *
 * Every test uses a temporary injected store; nothing writes to the real
 * ~/.jensen durable mission directory.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DurableMissionDelegator,
	parentIdentityFor,
	rootDelegationMissionId,
} from "../../src/core/durable-delegation/index.js";
import {
	aggregateMissionResults,
	createMissionHandle,
	createMissionRequest,
	createMissionResult,
	type DurableMissionRecord,
	type DurableMissionStore,
	type MissionExecutionOutcome,
	type MissionExecutor,
	type MissionHandle,
	type MissionRequest,
	type MissionResult,
	type MissionState,
	parseDurableMissionRecord,
	shouldContinueMissionChain,
} from "../../src/core/mission-domain/index.js";
import { FileDurableMissionStore } from "../../src/core/mission-durable/index.js";

// =============================================================================
// Helpers
// =============================================================================

interface PlannedOutcome {
	state: MissionState;
	executionOutcome: MissionExecutionOutcome;
	/** If set, the executor records the durable record state it observed at launch. */
	onLaunch?: (request: MissionRequest) => void | Promise<void>;
}

class SpyExecutor implements MissionExecutor {
	readonly executorId = "spy";
	launchCount = 0;
	outcomes: PlannedOutcome[] = [];
	/** The durable state observed by the store at launch time (if captured). */
	observedLaunchState: { state: MissionState; currentAttemptId?: string } | undefined;
	private next = 0;

	constructor(private readonly store?: DurableMissionStore) {}

	async launch(request: MissionRequest): Promise<MissionHandle> {
		this.launchCount += 1;
		if (this.store) {
			const loaded = await this.store.load(request.missionId);
			if (loaded.status === "ok") {
				this.observedLaunchState = {
					state: loaded.record.state,
					currentAttemptId: loaded.record.currentAttemptId,
				};
			}
		}
		const executionId = `exec_spy_${this.launchCount}`;
		return createMissionHandle({
			missionId: request.missionId,
			parentMissionId: request.parentMissionId,
			depth: request.depth,
			executionId,
			state: "RUNNING",
			createdAtMs: request.createdAtMs,
			startedAtMs: Date.now(),
			cancel: async () => undefined,
		});
	}

	async awaitResult(handle: MissionHandle, options?: { signal?: AbortSignal }): Promise<MissionResult> {
		if (options?.signal?.aborted) {
			return createMissionResult({
				missionId: handle.missionId,
				parentMissionId: handle.parentMissionId,
				depth: handle.depth,
				state: "CANCELLED",
				executionOutcome: "CANCELLED",
				verification: { status: "unverified" },
				completionDecision: "unavailable",
				failures: [{ category: "CANCELLED", message: "cancelled" }],
				executorDiagnostics: { executorId: this.executorId, signal: "SIGTERM" },
				startedAtMs: handle.startedAtMs ?? Date.now(),
				finishedAtMs: Date.now(),
			});
		}
		const outcome = this.outcomes[this.next++] ?? { state: "PARTIAL", executionOutcome: "COMPLETED" };
		const succeeded = outcome.state === "SUCCEEDED";
		return createMissionResult({
			missionId: handle.missionId,
			parentMissionId: handle.parentMissionId,
			depth: handle.depth,
			state: outcome.state,
			executionOutcome: outcome.executionOutcome,
			verification: { status: succeeded ? "verified" : "unverified" },
			completionDecision: succeeded ? "accepted" : "unavailable",
			failures: [],
			executorDiagnostics: {
				executorId: this.executorId,
				processExitCode: outcome.executionOutcome === "COMPLETED" ? 0 : 1,
			},
			startedAtMs: handle.startedAtMs ?? Date.now(),
			finishedAtMs: Date.now(),
		});
	}

	async cancel(): Promise<void> {}
}

function makeRoot(): string {
	return mkdtempSync(path.join(tmpdir(), "durable-delegation-"));
}

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

function runningRecord(request: MissionRequest, executionId: string, now: number): DurableMissionRecord {
	return {
		schemaVersion: 1,
		missionId: request.missionId,
		parentMissionId: request.parentMissionId,
		depth: request.depth,
		request,
		state: "RUNNING",
		currentAttemptId: "attempt_E1",
		currentExecutionId: executionId,
		createdAtMs: request.createdAtMs,
		updatedAtMs: now,
		startedAtMs: now,
		transitions: [
			{ seq: 0, from: "CREATED", to: "QUEUED", atMs: now },
			{ seq: 1, from: "QUEUED", to: "LAUNCHING", atMs: now, attemptId: "attempt_E1" },
			{ seq: 2, from: "LAUNCHING", to: "RUNNING", atMs: now, executionId },
		],
		attempts: [{ attemptId: "attempt_E1", executionId, startedAtMs: now }],
		revision: 4,
	};
}

describe("DurableMissionDelegator", () => {
	let root: string;
	let store: FileDurableMissionStore;
	let delegator: DurableMissionDelegator;

	beforeEach(() => {
		root = makeRoot();
		store = new FileDurableMissionStore({ root });
		delegator = new DurableMissionDelegator({ store });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	// =========================================================================
	// TEST A — real delegation creates durable child before execution
	// =========================================================================
	it("TEST A: persists the child durably and allocates attemptId before executor.launch", async () => {
		const parent = { missionId: "mission_parent", depth: 0 };
		const child = request("mission_child", parent);
		const executor = new SpyExecutor(store);

		const outcome = await delegator.executeChild(child, executor);

		// At launch time the durable record already existed in LAUNCHING with a
		// coordinator-allocated attemptId (persisted before executor.launch).
		expect(executor.observedLaunchState?.state).toBe("LAUNCHING");
		expect(executor.observedLaunchState?.currentAttemptId).toBeDefined();
		expect(executor.launchCount).toBe(1);

		// The terminal durable record carries the canonical identity and result.
		expect(outcome.missionId).toBe(child.missionId);
		expect(outcome.parentMissionId).toBe(parent.missionId);
		expect(outcome.depth).toBe(1);
		expect(outcome.attemptId).toBeDefined();
		expect(outcome.executionId).toBe("exec_spy_1");
		expect(outcome.result.missionId).toBe(child.missionId);
	});

	// =========================================================================
	// TEST B — terminal child durability
	// =========================================================================
	it("TEST B: terminal MissionResult round-trips exactly through the store", async () => {
		const parent = { missionId: "mission_parent", depth: 0 };
		const child = request("mission_child", parent);
		const executor = new SpyExecutor();
		executor.outcomes.push({ state: "SUCCEEDED", executionOutcome: "COMPLETED" });

		const outcome = await delegator.executeChild(child, executor);

		const reloaded = await delegator.getMission(child.missionId);
		expect(reloaded).toBeDefined();
		expect(reloaded?.state).toBe("SUCCEEDED");
		expect(reloaded?.result).toBeDefined();
		// Canonical equality — no prose parsing anywhere.
		expect(reloaded?.result?.missionId).toBe(outcome.result.missionId);
		expect(reloaded?.result?.state).toBe(outcome.result.state);
		expect(reloaded?.result?.executionOutcome).toBe(outcome.result.executionOutcome);
		expect(reloaded?.result?.success).toBe(outcome.result.success);
		expect(reloaded?.parentMissionId).toBe(parent.missionId);
		expect(reloaded?.depth).toBe(1);
	});

	// =========================================================================
	// TEST C — parent crash / child interrupted
	// =========================================================================
	it("TEST C: recovery marks RUNNING child INTERRUPTED, keeps parent + attempt, never launches", async () => {
		const parent = { missionId: "mission_parent", depth: 0 };
		const child = request("mission_child", parent);
		const now = Date.now();
		await store.create(runningRecord(child, "exec_E1", now));

		const report = await delegator.recover({ now: now + 1 });

		expect(report.reconciled).toContain(child.missionId);
		const reloaded = await delegator.getMission(child.missionId);
		expect(reloaded?.state).toBe("INTERRUPTED");
		expect(reloaded?.parentMissionId).toBe(parent.missionId);
		// Prior attempt retained with recovery metadata; ownership pointers cleared.
		expect(reloaded?.attempts).toHaveLength(1);
		expect(reloaded?.attempts[0].attemptId).toBe("attempt_E1");
		expect(reloaded?.attempts[0].endReason).toBe("INTERRUPTED");
		expect(reloaded?.attempts[0].recovery?.reason).toContain("ownership lost");
		expect(reloaded?.currentAttemptId).toBeUndefined();
		expect(reloaded?.currentExecutionId).toBeUndefined();
	});

	// =========================================================================
	// TEST D — child completes / parent crashes before consumption
	// =========================================================================
	it("TEST D: terminal child remains discoverable after reopen; never rerun", async () => {
		const parent = { missionId: "mission_parent", depth: 0 };
		const child = request("mission_child", parent);
		const executor = new SpyExecutor();
		executor.outcomes.push({ state: "SUCCEEDED", executionOutcome: "COMPLETED" });

		await delegator.executeChild(child, executor);

		// Simulate parent crash before consuming the result by reopening a fresh
		// delegator over the same store (new process view).
		const reopened = new DurableMissionDelegator({ store });
		const reloaded = await reopened.getMission(child.missionId);
		expect(reloaded?.state).toBe("SUCCEEDED");
		expect(reloaded?.result?.missionId).toBe(child.missionId);
		expect(reloaded?.attempts).toHaveLength(1);

		// Recovery leaves a terminal mission terminal — no rerun, no extra attempt.
		const report = await reopened.recover();
		expect(report.reconciled).not.toContain(child.missionId);
		const after = await reopened.getMission(child.missionId);
		expect(after?.attempts).toHaveLength(1);
		expect(after?.state).toBe("SUCCEEDED");
	});

	// =========================================================================
	// TEST E — parallel durable children
	// =========================================================================
	it("TEST E: parallel children persist independently with canonical aggregation", async () => {
		const parent = { missionId: "mission_parent", depth: 0 };
		const children = ["mission_b", "mission_c", "mission_d"].map((id) => request(id, parent));

		const results = [];
		for (const child of children) {
			const executor = new SpyExecutor();
			executor.outcomes.push({ state: "PARTIAL", executionOutcome: "COMPLETED" });
			results.push((await delegator.executeChild(child, executor)).result);
		}

		expect(new Set(results.map((r) => r.missionId))).toEqual(new Set(children.map((c) => c.missionId)));
		for (const result of results) {
			expect(result.parentMissionId).toBe(parent.missionId);
			expect(result.depth).toBe(1);
		}

		const aggregate = aggregateMissionResults(results);
		expect(aggregate.outcome).toBe("PARTIAL");
		expect(aggregate.allCompletedExecution).toBe(true);
		expect(aggregate.anyHardFailure).toBe(false);

		// Each child has its own durable record and attempt history.
		for (const child of children) {
			const record = await delegator.getMission(child.missionId);
			expect(record?.parentMissionId).toBe(parent.missionId);
			expect(record?.attempts).toHaveLength(1);
		}
	});

	// =========================================================================
	// TEST F — chain durable children
	// =========================================================================
	it("TEST F: PARTIAL continues, hard failure stops, unlaunched child never becomes a record", async () => {
		const parent = { missionId: "mission_parent", depth: 0 };
		const a = request("mission_a", parent);
		const b = request("mission_b", parent);
		const c = request("mission_c", parent);

		const run = async (req: MissionRequest, state: MissionState) => {
			const executor = new SpyExecutor();
			executor.outcomes.push({ state, executionOutcome: state === "PARTIAL" ? "COMPLETED" : "FAILED" });
			return (await delegator.executeChild(req, executor)).result;
		};

		// A completes (unverified), chain continues.
		const aResult = await run(a, "PARTIAL");
		expect(shouldContinueMissionChain(aResult)).toBe(true);

		// B hard-fails; chain stops. C is never reached and must not exist.
		const bResult = await run(b, "FAILED");
		expect(shouldContinueMissionChain(bResult)).toBe(false);

		expect(await delegator.getMission(c.missionId)).toBeUndefined();
		expect(await delegator.getMission(a.missionId)).toBeDefined();
		expect(await delegator.getMission(b.missionId)).toBeDefined();
	});

	// =========================================================================
	// TEST G — correlation
	// =========================================================================
	it("TEST G: outcome exposes canonical child/attempt/execution correlation", async () => {
		const parent = { missionId: "mission_parent", depth: 0 };
		const child = request("mission_child", parent);
		const executor = new SpyExecutor();

		const outcome = await delegator.executeChild(child, executor);

		expect(outcome.missionId).toBe(child.missionId);
		expect(outcome.parentMissionId).toBe(parent.missionId);
		expect(outcome.depth).toBe(1);
		expect(outcome.attemptId).toMatch(/^attempt_/);
		expect(outcome.executionId).toBe("exec_spy_1");

		const record = await delegator.getMission(outcome.missionId);
		expect(record?.resultExecutionId).toBe(outcome.executionId);
		expect(record?.attempts[0].attemptId).toBe(outcome.attemptId);
	});

	// =========================================================================
	// TEST H — no PID identity
	// =========================================================================
	it("TEST H: identity helpers never derive from PID; parent identity is structural", () => {
		const pid = String(process.pid);
		expect(rootDelegationMissionId("session-abcd")).not.toContain(pid);
		expect(rootDelegationMissionId("session-abcd")).toBe("delegation-root-session-abcd");

		const active = "mission_1234";
		expect(parentIdentityFor(active, "session-abcd")).toEqual({ missionId: active, depth: 0 });
		expect(parentIdentityFor(undefined, "session-abcd")).toEqual({
			missionId: "delegation-root-session-abcd",
			depth: 0,
		});

		// Depth is derived from the parent, never from process state.
		const child = createMissionRequest({
			missionId: "mission_child",
			parent: { missionId: active, depth: 3 },
			objective: "x",
			agent: "worker",
			executionMode: "execute",
			acceptanceCriteria: [],
		});
		expect(child.depth).toBe(4);
		expect(child.parentMissionId).toBe(active);
	});

	// =========================================================================
	// TEST I — recursive structure
	// =========================================================================
	it("TEST I: A→B→C produces exact durable parent/depth relationships", async () => {
		const rootMission = request("mission_a");
		const b = request("mission_b", { missionId: rootMission.missionId, depth: 0 });
		const c = request("mission_c", { missionId: b.missionId, depth: 1 });

		expect(rootMission.depth).toBe(0);
		expect(rootMission.parentMissionId).toBeUndefined();
		expect(b.parentMissionId).toBe(rootMission.missionId);
		expect(b.depth).toBe(1);
		expect(c.parentMissionId).toBe(b.missionId);
		expect(c.depth).toBe(2);

		const execB = new SpyExecutor();
		const execC = new SpyExecutor();
		await delegator.createChild(b, execB);
		await delegator.createChild(c, execC);

		expect(await delegator.listChildren(rootMission.missionId)).toEqual([b.missionId]);
		expect(await delegator.listChildren(b.missionId)).toEqual([c.missionId]);
	});

	// =========================================================================
	// TEST J — cancellation
	// =========================================================================
	it("TEST J: aborted child reaches durable CANCELLED, never remains RUNNING", async () => {
		const parent = { missionId: "mission_parent", depth: 0 };
		const child = request("mission_child", parent);
		const executor = new SpyExecutor();

		const controller = new AbortController();
		controller.abort();
		const outcome = await delegator.executeChild(child, executor, { signal: controller.signal });

		expect(outcome.result.state).toBe("CANCELLED");
		expect(outcome.result.executionOutcome).toBe("CANCELLED");
		const record = await delegator.getMission(child.missionId);
		expect(record?.state).toBe("CANCELLED");
		expect(record?.currentAttemptId).toBeUndefined();
	});

	// =========================================================================
	// TEST K — no store-open side effect
	// =========================================================================
	it("TEST K: reopening + recovering launches zero children", async () => {
		const parent = { missionId: "mission_parent", depth: 0 };
		const child = request("mission_child", parent);
		await store.create(runningRecord(child, "exec_E1", Date.now()));

		// A fresh delegator over the same store represents a reopened control plane.
		const reopened = new DurableMissionDelegator({ store });
		const report = await reopened.recover();

		expect(report.reconciled).toContain(child.missionId);
		// INTERRUPTED is intentionally still non-terminal (resumable), so it
		// remains in the nonterminal list rather than disappearing.
		expect(await reopened.listNonterminalMissions()).toContain(child.missionId);

		// The executor seam was never driven: recover uses a no-op executor whose
		// launch throws, so a successful recovery proves zero launches.
		const record = await reopened.getMission(child.missionId);
		expect(record?.state).toBe("INTERRUPTED");
		expect(record?.attempts).toHaveLength(1);
	});

	// =========================================================================
	// TEST M — reliability authority
	// =========================================================================
	it("TEST M: exit-0 / COMPLETED / normal shutdown never fabricate SUCCEEDED", async () => {
		const parent = { missionId: "mission_parent", depth: 0 };
		const child = request("mission_child", parent);
		const executor = new SpyExecutor();
		// Executor reports a clean exit-0 COMPLETED but unverified outcome.
		executor.outcomes.push({ state: "PARTIAL", executionOutcome: "COMPLETED" });

		const outcome = await delegator.executeChild(child, executor);
		expect(outcome.result.success).toBe(false);
		expect(outcome.result.state).toBe("PARTIAL");

		// A forged terminal record whose result claims success for a non-SUCCEEDED
		// state is structurally corrupt and never round-trips.
		const forged = await delegator.getMission(child.missionId);
		expect(forged).toBeDefined();
		const forgedJson = {
			...forged,
			state: "PARTIAL",
			result: { ...forged?.result, success: true },
		};
		expect(parseDurableMissionRecord(forgedJson).ok).toBe(false);
	});

	// =========================================================================
	// TEST N — store isolation
	// =========================================================================
	it("TEST N: tests use an injected temporary store, never the user store", () => {
		expect(root.startsWith(tmpdir())).toBe(true);
		expect(root).not.toContain(".jensen");
	});
});
