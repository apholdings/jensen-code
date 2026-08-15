/**
 * Heartbeat + coordinator integration tests (2.8.0).
 *
 * These prove the heartbeat is owned by the execution lifetime inside
 * DurableMissionCoordinator: renewals preserve the fencing token, authority
 * loss aborts the executor and cannot persist a terminal result, the terminal
 * race is decided by the fence, and every exit path stops the heartbeat with no
 * orphan timer.
 *
 * The coordinator runs against the REAL file store with short real lease
 * durations so the renewal path is exercised end-to-end. The pure timing state
 * machine (fake clock/scheduler) is covered separately in
 * execution-heartbeat.test.ts.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createDurableMissionRecord,
	createMissionHandle,
	createMissionRequest,
	createMissionResult,
	DurableMissionCoordinator,
	type DurableMissionStore,
	ExecutionAuthorityLostError,
	type ExecutionLease,
	ExecutionOwnershipError,
	type MissionExecutor,
	type MissionHandle,
	type MissionRequest,
	type MissionResult,
	ProcessMissionExecutor,
} from "../../src/core/mission-domain/index.js";
import { FileDurableMissionStore } from "../../src/core/mission-durable/index.js";

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	for (;;) {
		if (predicate()) return;
		if (Date.now() - start > timeoutMs) throw new Error("waitUntil timeout");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function makeRoot(): string {
	return mkdtempSync(path.join(tmpdir(), "heartbeat-coordinator-"));
}

function request(missionId: string, childSessionId?: string): MissionRequest {
	return createMissionRequest({
		missionId,
		objective: `objective of ${missionId}`,
		agent: "worker",
		executionMode: "execute",
		acceptanceCriteria: [],
		childSessionId,
	});
}

function terminalResult(handle: MissionHandle, state: "SUCCEEDED" | "FAILED" | "CANCELLED"): MissionResult {
	return createMissionResult({
		missionId: handle.missionId,
		parentMissionId: handle.parentMissionId,
		depth: handle.depth,
		state,
		executionOutcome: state === "SUCCEEDED" ? "COMPLETED" : state === "FAILED" ? "FAILED" : "CANCELLED",
		verification: { status: state === "SUCCEEDED" ? "verified" : "unverified" },
		completionDecision: state === "SUCCEEDED" ? "accepted" : "unavailable",
		failures:
			state === "FAILED"
				? [{ category: "EXECUTION", message: "failed" }]
				: state === "CANCELLED"
					? [{ category: "CANCELLED", message: "cancelled" }]
					: [],
		executorDiagnostics: { executorId: "controlled", processExitCode: state === "FAILED" ? 1 : 0 },
		startedAtMs: handle.startedAtMs ?? Date.now(),
		finishedAtMs: Date.now(),
	});
}

class ControlledExecutor implements MissionExecutor {
	readonly executorId = "controlled";
	launchCount = 0;
	cancelCount = 0;
	abortObserved = 0;
	lastHandle?: MissionHandle;
	private signal?: AbortSignal;
	private resolveResult?: (result: MissionResult) => void;
	private resultPromise: Promise<MissionResult> = new Promise((resolve) => {
		this.resolveResult = resolve;
	});

	async launch(req: MissionRequest, options: { signal?: AbortSignal } = {}): Promise<MissionHandle> {
		this.launchCount += 1;
		this.signal = options.signal;
		this.resultPromise = new Promise((resolve) => {
			this.resolveResult = resolve;
		});
		if (options.signal) {
			options.signal.addEventListener(
				"abort",
				() => {
					this.abortObserved += 1;
				},
				{ once: true },
			);
		}
		return createMissionHandle({
			missionId: req.missionId,
			parentMissionId: req.parentMissionId,
			depth: req.depth,
			executionId: `exec_controlled_${this.launchCount}`,
			state: "RUNNING",
			createdAtMs: req.createdAtMs,
			startedAtMs: Date.now(),
			cancel: async () => {
				this.cancelCount += 1;
			},
		});
	}

	async awaitResult(handle: MissionHandle): Promise<MissionResult> {
		this.lastHandle = handle;
		if (this.signal) {
			if (this.signal.aborted) return terminalResult(handle, "CANCELLED");
			this.signal.addEventListener(
				"abort",
				() => {
					this.resolveResult?.(terminalResult(handle, "CANCELLED"));
				},
				{ once: true },
			);
		}
		return this.resultPromise;
	}

	complete(result: MissionResult): void {
		this.resolveResult?.(result);
	}

	async cancel(): Promise<void> {
		this.cancelCount += 1;
	}
}

/** Forcibly replaces the lease with a higher fence (defined takeover test seam). */
async function forceTakeover(store: DurableMissionStore, missionId: string, now: number): Promise<void> {
	const lease: ExecutionLease = {
		ownerId: "owner_b",
		leaseId: "lease_b",
		fencingToken: 2,
		acquiredAtMs: now,
		renewedAtMs: now,
		expiresAtMs: now + 60_000,
	};
	await store.mutate(missionId, (current) => ({
		kind: "write",
		value: undefined,
		next: {
			...current,
			fencingToken: 2,
			lease,
			updatedAtMs: now,
		},
	}));
}

/** Attach a rejection handler immediately so no unhandled-rejection is reported. */
function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
	return promise.then(
		(value) => ({ ok: true, value }),
		(error) => ({ ok: false, error }),
	);
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

describe("TEST A/R/O/P — long execution renews while preserving the fence", () => {
	it("renews several times during a long await, then completes with an unchanged fence and stopped heartbeat", async () => {
		const executor = new ControlledExecutor();
		const coordinator = new DurableMissionCoordinator(store, executor, {
			leaseDurationMs: 300,
			heartbeatIntervalMs: 100,
			renewalSafetyMarginMs: 100,
			leaseIdFactory: () => "lease_a",
			attemptIdFactory: () => "attempt_a",
		});
		await coordinator.createMission(request("mission_long"));

		const resumePromise = coordinator.resume("mission_long");
		await waitUntil(() => coordinator.heartbeatTelemetry("mission_long")?.heartbeatActive === true);
		await waitUntil(() => (coordinator.heartbeatTelemetry("mission_long")?.renewalCount ?? 0) >= 3);

		const live = coordinator.heartbeatTelemetry("mission_long");
		expect(live?.heartbeatActive).toBe(true);

		const mid = await store.load("mission_long");
		expect(mid.status).toBe("ok");
		if (mid.status === "ok") {
			expect(mid.record.state).toBe("RUNNING");
			expect(mid.record.fencingToken).toBe(1);
			expect(mid.record.lease?.leaseId).toBe("lease_a");
		}

		executor.complete(terminalResult(executor.lastHandle as MissionHandle, "SUCCEEDED"));
		const terminal = await resumePromise;

		expect(terminal.state).toBe("SUCCEEDED");
		expect(terminal.fencingToken).toBe(1);
		expect(terminal.lease).toBeUndefined();

		const stopped = coordinator.heartbeatTelemetry("mission_long");
		expect(stopped?.heartbeatActive).toBe(false);
		expect(stopped?.renewalCount ?? 0).toBeGreaterThanOrEqual(3);
	});
});

describe("TEST B/E — stops on success with no orphan timer", () => {
	it("a completed mission leaves heartbeatActive false", async () => {
		const executor = new ControlledExecutor();
		const coordinator = new DurableMissionCoordinator(store, executor, {
			leaseDurationMs: 300,
			heartbeatIntervalMs: 100,
			renewalSafetyMarginMs: 100,
		});
		await coordinator.createMission(request("mission_success_stop"));

		const resumePromise = coordinator.resume("mission_success_stop");
		await waitUntil(() => coordinator.heartbeatTelemetry("mission_success_stop")?.heartbeatActive === true);
		executor.complete(terminalResult(executor.lastHandle as MissionHandle, "SUCCEEDED"));

		await resumePromise;
		expect(coordinator.heartbeatTelemetry("mission_success_stop")?.heartbeatActive).toBe(false);
	});
});

describe("TEST C — stops on verified terminal failure", () => {
	it("a terminal FAILED result stops the heartbeat", async () => {
		const executor = new ControlledExecutor();
		const coordinator = new DurableMissionCoordinator(store, executor, {
			leaseDurationMs: 300,
			heartbeatIntervalMs: 100,
			renewalSafetyMarginMs: 100,
		});
		await coordinator.createMission(request("mission_failure_stop"));

		const resumePromise = coordinator.resume("mission_failure_stop");
		await waitUntil(() => coordinator.heartbeatTelemetry("mission_failure_stop")?.heartbeatActive === true);
		executor.complete(terminalResult(executor.lastHandle as MissionHandle, "FAILED"));

		const terminal = await resumePromise;
		expect(terminal.state).toBe("FAILED");
		expect(coordinator.heartbeatTelemetry("mission_failure_stop")?.heartbeatActive).toBe(false);
	});
});

describe("TEST D — stops on cancellation", () => {
	it("a user cancellation aborts the executor and stops the heartbeat", async () => {
		const executor = new ControlledExecutor();
		const coordinator = new DurableMissionCoordinator(store, executor, {
			leaseDurationMs: 300,
			heartbeatIntervalMs: 100,
			renewalSafetyMarginMs: 100,
		});
		await coordinator.createMission(request("mission_cancel_stop"));

		const user = new AbortController();
		const resumePromise = coordinator.resume("mission_cancel_stop", { signal: user.signal });
		await waitUntil(() => coordinator.heartbeatTelemetry("mission_cancel_stop")?.heartbeatActive === true);

		user.abort();
		const terminal = await resumePromise;
		expect(terminal.state).toBe("CANCELLED");
		expect(executor.abortObserved).toBe(1);
		expect(coordinator.heartbeatTelemetry("mission_cancel_stop")?.heartbeatActive).toBe(false);
	});
});

describe("TEST H/I — stale owner heartbeat aborts the executor and cannot write terminal state", () => {
	it("a fenced renewal aborts the old executor and leaves the takeover owner authoritative", async () => {
		const executor = new ControlledExecutor();
		const coordinator = new DurableMissionCoordinator(store, executor, {
			leaseDurationMs: 300,
			heartbeatIntervalMs: 100,
			renewalSafetyMarginMs: 100,
			leaseIdFactory: () => "lease_a",
		});
		await coordinator.createMission(request("mission_stale_abort"));

		const settled = settle(coordinator.resume("mission_stale_abort"));
		await waitUntil(() => coordinator.heartbeatTelemetry("mission_stale_abort")?.heartbeatActive === true);
		await waitUntil(() => (coordinator.heartbeatTelemetry("mission_stale_abort")?.renewalCount ?? 0) >= 1);

		// B force-takes over with a higher fence while A is still alive.
		await forceTakeover(store, "mission_stale_abort", Date.now());

		// A's next heartbeat renewal is fenced out and A aborts.
		await waitUntil(() => coordinator.heartbeatTelemetry("mission_stale_abort")?.authorityLost === true);

		const outcome = await settled;
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.error).toBeInstanceOf(ExecutionAuthorityLostError);
			expect((outcome.error as ExecutionAuthorityLostError).code).toBe("EXECUTION_AUTHORITY_LOST");
		}

		expect(executor.abortObserved).toBe(1);
		const loaded = await store.load("mission_stale_abort");
		expect(loaded.status).toBe("ok");
		if (loaded.status === "ok") {
			expect(loaded.record.state).toBe("RUNNING");
			expect(loaded.record.result).toBeUndefined();
			expect(loaded.record.fencingToken).toBe(2);
			expect(loaded.record.lease?.leaseId).toBe("lease_b");
		}
	});
});

describe("TEST J — terminal race decided by the fence", () => {
	it("an executor that finishes after a takeover cannot overwrite canonical state", async () => {
		const executor = new ControlledExecutor();
		const coordinator = new DurableMissionCoordinator(store, executor, {
			// Long lease so the heartbeat stays dormant during the test; the fence
			// is the only authority deciding this race.
			leaseDurationMs: 60_000,
			heartbeatIntervalMs: 20_000,
			renewalSafetyMarginMs: 10_000,
			leaseIdFactory: () => "lease_a",
		});
		await coordinator.createMission(request("mission_terminal_race"));

		const settled = settle(coordinator.resume("mission_terminal_race"));
		await waitUntil(() => executor.launchCount === 1);

		// The takeover wins the fence, then the executor finishes its local work.
		await forceTakeover(store, "mission_terminal_race", Date.now());
		executor.complete(terminalResult(executor.lastHandle as MissionHandle, "SUCCEEDED"));

		const outcome = await settled;
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.error).toBeInstanceOf(ExecutionOwnershipError);
			expect((outcome.error as ExecutionOwnershipError).code).toBe("STALE_EXECUTION_OWNER");
		}

		const loaded = await store.load("mission_terminal_race");
		expect(loaded.status).toBe("ok");
		if (loaded.status === "ok") {
			expect(loaded.record.result).toBeUndefined();
			expect(loaded.record.fencingToken).toBe(2);
			expect(loaded.record.lease?.leaseId).toBe("lease_b");
		}
	});
});

describe("TEST L — process death naturally expires the lease and recovery requires explicit resume", () => {
	it("an un-renewed lease expires, recovery marks INTERRUPTED, and no auto-run occurs", async () => {
		const owner = new DurableMissionCoordinator(store, new ControlledExecutor(), {
			leaseDurationMs: 120,
			leaseIdFactory: () => "lease_dead",
		});
		await owner.createMission(request("mission_crash_expiry"));
		const acquired = await owner.acquireOwnership("mission_crash_expiry");
		expect(acquired.lease.fencingToken).toBe(1);

		// No heartbeat exists for a raw acquisition; simulate the owner process
		// dying by letting the lease lapse.
		await new Promise((resolve) => setTimeout(resolve, 160));

		const recovering = new DurableMissionCoordinator(store, new ControlledExecutor(), {});
		const report = await recovering.recover();
		expect(report.reconciled).toContain("mission_crash_expiry");

		const loaded = await store.load("mission_crash_expiry");
		expect(loaded.status).toBe("ok");
		if (loaded.status === "ok") {
			expect(loaded.record.state).toBe("INTERRUPTED");
			expect(loaded.record.result).toBeUndefined();
		}
	});
});

describe("TEST M/N — explicit resume starts a fresh heartbeat with a new fence and preserves identity", () => {
	it("resume after recovery gets a new lease/fence and independent heartbeat", async () => {
		const childSessionId = "child_session_hb";
		await store.create(createDurableMissionRecord({ request: request("mission_resume_hb", childSessionId), now: 0 }));

		// First owner acquires without a heartbeat, then "dies": the lease lapses.
		const firstOwner = new DurableMissionCoordinator(store, new ControlledExecutor(), {
			leaseDurationMs: 120,
			leaseIdFactory: () => "lease_first",
		});
		const first = await firstOwner.acquireOwnership("mission_resume_hb");
		expect(first.lease.fencingToken).toBe(1);
		await new Promise((resolve) => setTimeout(resolve, 160));

		const recovering = new DurableMissionCoordinator(store, new ControlledExecutor(), {});
		const report = await recovering.recover();
		expect(report.reconciled).toContain("mission_resume_hb");

		// Second owner resumes explicitly: new fence, new attempt, fresh heartbeat.
		const second = new ControlledExecutor();
		const secondCoordinator = new DurableMissionCoordinator(store, second, {
			leaseDurationMs: 300,
			heartbeatIntervalMs: 100,
			renewalSafetyMarginMs: 100,
			leaseIdFactory: () => "lease_second",
			attemptIdFactory: () => "attempt_second",
		});
		const secondResume = secondCoordinator.resume("mission_resume_hb");
		await waitUntil(() => secondCoordinator.heartbeatTelemetry("mission_resume_hb")?.heartbeatActive === true);

		const fresh = secondCoordinator.heartbeatTelemetry("mission_resume_hb");
		expect(fresh?.heartbeatActive).toBe(true);
		expect(fresh?.renewalCount).toBe(0);

		second.complete(terminalResult(second.lastHandle as MissionHandle, "SUCCEEDED"));
		const terminal = await secondResume;

		expect(terminal.request.childSessionId).toBe(childSessionId);
		expect(terminal.fencingToken).toBeGreaterThan(1);
		expect(terminal.attempts).toHaveLength(1);
		expect(terminal.attempts[0].attemptId).toBe("attempt_second");
	});
});

describe("TEST Q — independent missions have independent heartbeats", () => {
	it("two missions renew independently and both stop on completion", async () => {
		const storeA = new FileDurableMissionStore({ root: path.join(root, "a") });
		const storeB = new FileDurableMissionStore({ root: path.join(root, "b") });
		await storeA.create(createDurableMissionRecord({ request: request("mission_q_a"), now: 0 }));
		await storeB.create(createDurableMissionRecord({ request: request("mission_q_b"), now: 0 }));

		const executorA = new ControlledExecutor();
		const executorB = new ControlledExecutor();
		const coordinatorA = new DurableMissionCoordinator(storeA, executorA, {
			leaseDurationMs: 300,
			heartbeatIntervalMs: 100,
			renewalSafetyMarginMs: 100,
		});
		const coordinatorB = new DurableMissionCoordinator(storeB, executorB, {
			leaseDurationMs: 300,
			heartbeatIntervalMs: 100,
			renewalSafetyMarginMs: 100,
		});

		const resumeA = coordinatorA.resume("mission_q_a");
		const resumeB = coordinatorB.resume("mission_q_b");
		await waitUntil(
			() =>
				(coordinatorA.heartbeatTelemetry("mission_q_a")?.renewalCount ?? 0) >= 2 &&
				(coordinatorB.heartbeatTelemetry("mission_q_b")?.renewalCount ?? 0) >= 2,
		);

		executorA.complete(terminalResult(executorA.lastHandle as MissionHandle, "SUCCEEDED"));
		executorB.complete(terminalResult(executorB.lastHandle as MissionHandle, "SUCCEEDED"));
		await Promise.all([resumeA, resumeB]);

		expect(coordinatorA.heartbeatTelemetry("mission_q_a")?.heartbeatActive).toBe(false);
		expect(coordinatorB.heartbeatTelemetry("mission_q_b")?.heartbeatActive).toBe(false);
	});
});

describe("TEST S — heartbeat never holds the mutation lock long-term", () => {
	it("another mission's mutation proceeds while a lease heartbeat is active", async () => {
		const storeA = new FileDurableMissionStore({ root: path.join(root, "a") });
		const storeB = new FileDurableMissionStore({ root: path.join(root, "b") });
		await storeA.create(createDurableMissionRecord({ request: request("mission_s_a"), now: 0 }));
		await storeB.create(createDurableMissionRecord({ request: request("mission_s_b"), now: 0 }));

		const executor = new ControlledExecutor();
		const coordinator = new DurableMissionCoordinator(storeA, executor, {
			leaseDurationMs: 300,
			heartbeatIntervalMs: 100,
			renewalSafetyMarginMs: 100,
		});
		const resume = coordinator.resume("mission_s_a");
		await waitUntil(() => coordinator.heartbeatTelemetry("mission_s_a")?.heartbeatActive === true);

		const bLoaded = await storeB.load("mission_s_b");
		expect(bLoaded.status).toBe("ok");
		if (bLoaded.status === "ok") {
			const saved = await storeB.save(
				{
					...bLoaded.record,
					state: "QUEUED",
					updatedAtMs: bLoaded.record.updatedAtMs + 1,
					transitions: [
						...bLoaded.record.transitions,
						{
							seq: bLoaded.record.transitions.length,
							from: "CREATED",
							to: "QUEUED" as const,
							atMs: bLoaded.record.updatedAtMs + 1,
						},
					],
					revision: bLoaded.record.revision + 1,
				},
				{ expectedRevision: bLoaded.record.revision },
			);
			expect(saved.status).toBe("saved");
		}

		executor.complete(terminalResult(executor.lastHandle as MissionHandle, "SUCCEEDED"));
		await resume;
	});
});

describe("TEST V — heartbeat cannot promote mission state", () => {
	it("renewals only extend the lease and never change RUNNING to SUCCEEDED", async () => {
		const executor = new ControlledExecutor();
		const coordinator = new DurableMissionCoordinator(store, executor, {
			leaseDurationMs: 300,
			heartbeatIntervalMs: 100,
			renewalSafetyMarginMs: 100,
		});
		await coordinator.createMission(request("mission_no_promote"));

		const resumePromise = coordinator.resume("mission_no_promote");
		await waitUntil(() => (coordinator.heartbeatTelemetry("mission_no_promote")?.renewalCount ?? 0) >= 2);

		const loaded = await store.load("mission_no_promote");
		expect(loaded.status).toBe("ok");
		if (loaded.status === "ok") {
			expect(loaded.record.state).toBe("RUNNING");
			expect(loaded.record.result).toBeUndefined();
		}

		executor.complete(terminalResult(executor.lastHandle as MissionHandle, "SUCCEEDED"));
		await resumePromise;
	});
});

describe("TEST K — authority loss aborts the real ProcessMissionExecutor child and leaves no orphan", () => {
	it("a fenced heartbeat kills the spawned child process group", async () => {
		// A real long-running child process that records its pid and liveness.
		const childScript = path.join(root, "child.cjs");
		writeFileSync(
			childScript,
			`const fs = require("node:fs");
const dir = process.argv[2];
fs.writeFileSync(dir + "/child.pid", String(process.pid));
setInterval(() => { fs.appendFileSync(dir + "/child.alive", Date.now() + "\\n"); }, 150);
setInterval(() => {}, 1000);
`,
			"utf8",
		);

		const executor = new ProcessMissionExecutor({
			executorId: "process-child",
			buildLaunch: () => ({
				command: process.execPath,
				args: [childScript, root],
				cwd: root,
			}),
		});
		const coordinator = new DurableMissionCoordinator(store, executor, {
			leaseDurationMs: 2000,
			heartbeatIntervalMs: 700,
			renewalSafetyMarginMs: 700,
			leaseIdFactory: () => "lease_a",
		});
		await coordinator.createMission(request("mission_process_abort"));

		const settled = settle(coordinator.resume("mission_process_abort"));

		// Wait for the child to actually start and for the heartbeat to renew.
		await waitUntil(() => existsSync(path.join(root, "child.pid")));
		await waitUntil(() => (coordinator.heartbeatTelemetry("mission_process_abort")?.renewalCount ?? 0) >= 1);

		const pid = Number(readFileSync(path.join(root, "child.pid"), "utf8").trim());
		expect(pid).toBeGreaterThan(0);

		// Force a takeover; the next renewal is fenced and aborts the child.
		await forceTakeover(store, "mission_process_abort", Date.now());
		await waitUntil(() => coordinator.heartbeatTelemetry("mission_process_abort")?.authorityLost === true, 8000);

		const outcome = await settled;
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.error).toBeInstanceOf(ExecutionAuthorityLostError);
		}

		// The child must be gone (no orphan process doing work).
		await waitUntil(() => {
			try {
				process.kill(pid, 0);
				return false;
			} catch {
				return true;
			}
		}, 8000);

		const loaded = await store.load("mission_process_abort");
		expect(loaded.status).toBe("ok");
		if (loaded.status === "ok") {
			expect(loaded.record.result).toBeUndefined();
			expect(loaded.record.fencingToken).toBe(2);
			expect(loaded.record.lease?.leaseId).toBe("lease_b");
		}
	});
});
