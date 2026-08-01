import { describe, expect, test } from "vitest";
import type {
	AbandonContinuationRequest,
	CancelContinuationRequest,
	ConsumeContinuationRequest,
	DispatchContinuationRequest,
} from "../../src/core/long-horizon/continuation-scheduler.js";
import {
	abandonContinuation,
	cancelContinuation,
	consumeContinuation,
	dispatchContinuation,
	initializeContinuationScheduler,
	scheduleContinuation,
} from "../../src/core/long-horizon/continuation-scheduler.js";

const CONTRACT_DIGEST = "test-contract-digest";
const EXECUTION_ID = "exec-1";

function setupScheduled(): { record: NonNullable<ReturnType<typeof initializeContinuationScheduler>> } {
	let record = initializeContinuationScheduler(EXECUTION_ID, CONTRACT_DIGEST);
	const schedResult = scheduleContinuation(record, {
		eventId: "sched-1",
		expectedSchedulerRevision: 0,
		expectedExecutionRevision: 10,
	});
	record = schedResult.record!;
	return { record };
}

function setupDispatched(): { record: NonNullable<ReturnType<typeof initializeContinuationScheduler>> } {
	const { record: scheduled } = setupScheduled();
	const dispResult = dispatchContinuation(
		scheduled,
		{
			eventId: "disp-1",
			cycleId: "sched-1",
			expectedSchedulerRevision: 1,
			dispatchedContinuationId: "cont-1",
		},
		10,
	);
	return { record: dispResult.record! };
}

describe("ABANDON idempotency", () => {
	test("exact ABANDON retry succeeds", () => {
		const { record } = setupScheduled();
		const abandonReq: AbandonContinuationRequest = {
			eventId: "abandon-1",
			cycleId: "sched-1",
			expectedSchedulerRevision: 1,
		};
		const r1 = abandonContinuation(record, abandonReq, 20); // 20 > 10 → superseded
		expect(r1.ok).toBe(true);
		if (!r1.ok) throw new Error("should succeed");
		const sha1 = r1.event!.eventDigest;
		const rev1 = r1.record!.schedulerRevision;

		// Exact retry
		const r2 = abandonContinuation(r1.record!, abandonReq, 20);
		expect(r2.ok).toBe(true);
		if (!r2.ok) throw new Error("retry should succeed");
		expect(r2.event!.eventDigest).toBe(sha1);
		expect(r2.record!.schedulerRevision).toBe(rev1);
		expect(r2.record!.events.length).toBe(r1.record!.events.length);
		expect(r2.record!.historyDigest).toBe(r1.record!.historyDigest);
	});

	test("ABANDON-vs-CANCEL idempotency conflict", () => {
		const { record } = setupScheduled();
		// First use abandon with eventId "shared-id"
		const abandonReq: AbandonContinuationRequest = {
			eventId: "shared-id",
			cycleId: "sched-1",
			expectedSchedulerRevision: 1,
		};
		const r1 = abandonContinuation(record, abandonReq, 20);
		expect(r1.ok).toBe(true);

		// Now try a cancel with the same eventId
		const cancelReq: CancelContinuationRequest = {
			eventId: "shared-id",
			cycleId: "sched-1",
			expectedSchedulerRevision: 1,
		};
		const r2 = cancelContinuation(r1.record!, cancelReq, 20);
		expect(r2.ok).toBe(false);
		if (r2.ok) throw new Error("should fail");
		expect(r2.code).toBe("IDEMPOTENCY_CONFLICT");
	});
});

describe("DISPATCH supersession guards", () => {
	test("superseded DISPATCH (current > active) → CYCLE_SUPERSEDED", () => {
		const { record } = setupScheduled();
		// expectedExecutionRevision is 10, current is 20
		const dispatchReq: DispatchContinuationRequest = {
			eventId: "disp-2",
			cycleId: "sched-1",
			expectedSchedulerRevision: 1,
			dispatchedContinuationId: "cont-2",
		};
		const result = dispatchContinuation(record, dispatchReq, 20);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("should fail");
		expect(result.code).toBe("CYCLE_SUPERSEDED");
	});

	test("lower execution revision on DISPATCH → EXECUTION_REVISION_MISMATCH", () => {
		const { record } = setupScheduled();
		const dispatchReq: DispatchContinuationRequest = {
			eventId: "disp-3",
			cycleId: "sched-1",
			expectedSchedulerRevision: 1,
			dispatchedContinuationId: "cont-3",
		};
		const result = dispatchContinuation(record, dispatchReq, 5); // 5 < 10
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("should fail");
		expect(result.code).toBe("EXECUTION_REVISION_MISMATCH");
	});

	test("equal execution revision on DISPATCH → success", () => {
		const { record } = setupScheduled();
		const dispatchReq: DispatchContinuationRequest = {
			eventId: "disp-4",
			cycleId: "sched-1",
			expectedSchedulerRevision: 1,
			dispatchedContinuationId: "cont-4",
		};
		const result = dispatchContinuation(record, dispatchReq, 10);
		expect(result.ok).toBe(true);
	});

	test("exact retry of superseded dispatch preserves state", () => {
		const { record } = setupScheduled();
		const dispatchReq: DispatchContinuationRequest = {
			eventId: "disp-5",
			cycleId: "sched-1",
			expectedSchedulerRevision: 1,
			dispatchedContinuationId: "cont-5",
		};
		const r1 = dispatchContinuation(record, dispatchReq, 10);
		expect(r1.ok).toBe(true);
		if (!r1.ok) throw new Error("should succeed");

		const r2 = dispatchContinuation(r1.record!, dispatchReq, 10);
		expect(r2.ok).toBe(true);
		if (!r2.ok) throw new Error("retry should succeed");
		expect(r2.event!.eventDigest).toBe(r1.event!.eventDigest);
	});
});

describe("CONSUME supersession guards", () => {
	test("superseded CONSUME (current > active) → CYCLE_SUPERSEDED", () => {
		const { record } = setupDispatched();
		const consumeReq: ConsumeContinuationRequest = {
			eventId: "con-1",
			cycleId: "sched-1",
			expectedSchedulerRevision: 2,
			dispatchedContinuationId: "cont-1",
			resultDigest: "sha256:abc",
		};
		const result = consumeContinuation(record, consumeReq, 20); // 20 > 10
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("should fail");
		expect(result.code).toBe("CYCLE_SUPERSEDED");
	});

	test("lower execution revision on CONSUME → EXECUTION_REVISION_MISMATCH", () => {
		const { record } = setupDispatched();
		const consumeReq: ConsumeContinuationRequest = {
			eventId: "con-2",
			cycleId: "sched-1",
			expectedSchedulerRevision: 2,
			dispatchedContinuationId: "cont-1",
			resultDigest: "sha256:abc",
		};
		const result = consumeContinuation(record, consumeReq, 5); // 5 < 10
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("should fail");
		expect(result.code).toBe("EXECUTION_REVISION_MISMATCH");
	});

	test("equal execution revision on CONSUME → success", () => {
		const { record } = setupDispatched();
		const consumeReq: ConsumeContinuationRequest = {
			eventId: "con-3",
			cycleId: "sched-1",
			expectedSchedulerRevision: 2,
			dispatchedContinuationId: "cont-1",
			resultDigest: "sha256:abc",
		};
		const result = consumeContinuation(record, consumeReq, 10);
		expect(result.ok).toBe(true);
	});
});

describe("Scheduler byte-preservation on rejection", () => {
	test("every rejection leaves scheduler bytes unchanged", () => {
		const { record } = setupScheduled();
		const jsonBefore = JSON.stringify(record);

		// Superseded dispatch
		const r1 = dispatchContinuation(
			record,
			{
				eventId: "d-fail",
				cycleId: "sched-1",
				expectedSchedulerRevision: 1,
				dispatchedContinuationId: "x",
			},
			20,
		);
		expect(r1.ok).toBe(false);
		expect(JSON.stringify(record)).toBe(jsonBefore);

		// Lower revision dispatch
		const r2 = dispatchContinuation(
			record,
			{
				eventId: "d-fail2",
				cycleId: "sched-1",
				expectedSchedulerRevision: 1,
				dispatchedContinuationId: "x",
			},
			5,
		);
		expect(r2.ok).toBe(false);
		expect(JSON.stringify(record)).toBe(jsonBefore);
	});
});
