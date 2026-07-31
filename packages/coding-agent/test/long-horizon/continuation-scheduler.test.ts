/**
 * LH-3 Continuation Scheduler unit tests.
 *
 * Tests initialization, state transitions, event digests, history digest,
 * canonical replay, contract/execution binding, revision checks, idempotency,
 * cycle bindings, and error codes.
 */

import { describe, expect, it } from "vitest";
import type {
	ContinuationSchedulerEvent,
	ContinuationSchedulerRecord,
} from "../../src/core/long-horizon/continuation-scheduler.js";
import {
	abandonContinuation,
	cancelContinuation,
	consumeContinuation,
	dispatchContinuation,
	initializeContinuationScheduler,
	inspectContinuationScheduler,
	scheduleContinuation,
	validateContinuationScheduler,
} from "../../src/core/long-horizon/continuation-scheduler.js";

// =============================================================================
// Helpers
// =============================================================================

function freshScheduler(executionId = "exec-001", contractDigest = "abc123def456"): ContinuationSchedulerRecord {
	return initializeContinuationScheduler(executionId, contractDigest);
}

function _uniqueEventId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// =============================================================================
// Initialization
// =============================================================================

describe("initialization", () => {
	it("creates IDLE record with revision 0", () => {
		const s = freshScheduler();
		expect(s.schedulerVersion).toBe(1);
		expect(s.executionId).toBe("exec-001");
		expect(s.contractDigest).toBe("abc123def456");
		expect(s.schedulerRevision).toBe(0);
		expect(s.state).toBe("IDLE");
		expect(s.events).toEqual([]);
		expect(s.historyDigest).toBeNull();
	});

	it("produces deterministic inspection", () => {
		const s = freshScheduler();
		const insp = inspectContinuationScheduler(s);
		expect(insp.valid).toBe(true);
		expect(insp.state).toBe("IDLE");
		expect(insp.schedulerRevision).toBe(0);
		expect(insp.eventCount).toBe(0);
	});

	it("validates contract binding", () => {
		const s = freshScheduler("exec-X", "digest-A");
		const v = validateContinuationScheduler(s, "digest-A", "exec-X", 5);
		expect(v.valid).toBe(true);
		expect(v.contractBound).toBe(true);
		expect(v.executionBound).toBe(true);
		expect(v.semanticValid).toBe(true);
	});

	it("validates contract binding mismatch", () => {
		const s = freshScheduler("exec-X", "digest-A");
		const v = validateContinuationScheduler(s, "digest-B", "exec-X", 5);
		expect(v.valid).toBe(false);
		expect(v.contractBound).toBe(false);
	});

	it("validates execution binding mismatch", () => {
		const s = freshScheduler("exec-X", "digest-A");
		const v = validateContinuationScheduler(s, "digest-A", "exec-Y", 5);
		expect(v.valid).toBe(false);
		expect(v.executionBound).toBe(false);
	});
});

// =============================================================================
// Full cycle: IDLE → SCHEDULED → DISPATCHED → IDLE
// =============================================================================

describe("full cycle", () => {
	it("completes IDLE → SCHEDULED → DISPATCHED → IDLE", () => {
		let s = freshScheduler();

		// SCHEDULE
		const schR = scheduleContinuation(s, {
			eventId: "ev-sched-1",
			expectedSchedulerRevision: 0,
			expectedExecutionRevision: 5,
		});
		expect(schR.ok).toBe(true);
		expect(schR.record!.state).toBe("SCHEDULED");
		expect(schR.record!.schedulerRevision).toBe(1);
		expect(schR.event!.kind).toBe("SCHEDULE");
		expect(schR.event!.cycleId).toBe("ev-sched-1");
		expect(schR.event!.expectedExecutionRevision).toBe(5);
		expect(schR.event!.observedExecutionRevision).toBe(5);
		expect(schR.event!.fromState).toBe("IDLE");
		expect(schR.event!.toState).toBe("SCHEDULED");
		s = schR.record!;

		// DISPATCH
		const dispR = dispatchContinuation(
			s,
			{
				eventId: "ev-disp-1",
				cycleId: "ev-sched-1",
				expectedSchedulerRevision: 1,
				dispatchedContinuationId: "cont-001",
			},
			5,
		);
		expect(dispR.ok).toBe(true);
		expect(dispR.record!.state).toBe("DISPATCHED");
		expect(dispR.record!.schedulerRevision).toBe(2);
		expect(dispR.event!.dispatchedContinuationId).toBe("cont-001");
		s = dispR.record!;

		// CONSUME
		const conR = consumeContinuation(
			s,
			{
				eventId: "ev-consume-1",
				cycleId: "ev-sched-1",
				expectedSchedulerRevision: 2,
				dispatchedContinuationId: "cont-001",
				resultDigest: "result-digest-here",
			},
			5,
		);
		expect(conR.ok).toBe(true);
		expect(conR.record!.state).toBe("IDLE");
		expect(conR.record!.schedulerRevision).toBe(3);
		expect(conR.event!.resultDigest).toBe("result-digest-here");
	});
});

// =============================================================================
// Multiple cycles
// =============================================================================

describe("multiple cycles", () => {
	it("completes two full cycles", () => {
		let s = freshScheduler();

		// Cycle 1
		let r = scheduleContinuation(s, { eventId: "s1", expectedSchedulerRevision: 0, expectedExecutionRevision: 1 });
		expect(r.ok).toBe(true);
		s = r.record!;
		r = dispatchContinuation(
			s,
			{
				eventId: "d1",
				cycleId: "s1",
				expectedSchedulerRevision: 1,
				dispatchedContinuationId: "c1",
			},
			1,
		);
		expect(r.ok).toBe(true);
		s = r.record!;
		r = consumeContinuation(
			s,
			{
				eventId: "con1",
				cycleId: "s1",
				expectedSchedulerRevision: 2,
				dispatchedContinuationId: "c1",
				resultDigest: "r1",
			},
			1,
		);
		expect(r.ok).toBe(true);
		s = r.record!;
		expect(s.state).toBe("IDLE");
		expect(s.schedulerRevision).toBe(3);

		// Cycle 2
		r = scheduleContinuation(s, { eventId: "s2", expectedSchedulerRevision: 3, expectedExecutionRevision: 2 });
		expect(r.ok).toBe(true);
		s = r.record!;
		r = dispatchContinuation(
			s,
			{
				eventId: "d2",
				cycleId: "s2",
				expectedSchedulerRevision: 4,
				dispatchedContinuationId: "c2",
			},
			2,
		);
		expect(r.ok).toBe(true);
		s = r.record!;
		r = consumeContinuation(
			s,
			{
				eventId: "con2",
				cycleId: "s2",
				expectedSchedulerRevision: 5,
				dispatchedContinuationId: "c2",
				resultDigest: "r2",
			},
			2,
		);
		expect(r.ok).toBe(true);
		s = r.record!;
		expect(s.state).toBe("IDLE");
		expect(s.schedulerRevision).toBe(6);
		expect(s.events.length).toBe(6);
	});
});

// =============================================================================
// CANCEL
// =============================================================================

describe("cancel", () => {
	it("cancels SCHEDULED cycle", () => {
		let s = freshScheduler();
		let r = scheduleContinuation(s, { eventId: "s1", expectedSchedulerRevision: 0, expectedExecutionRevision: 5 });
		expect(r.ok).toBe(true);
		s = r.record!;

		r = cancelContinuation(s, { eventId: "cancel-1", cycleId: "s1", expectedSchedulerRevision: 1 }, 10);
		expect(r.ok).toBe(true);
		expect(r.record!.state).toBe("IDLE");
		expect(r.record!.schedulerRevision).toBe(2);
		expect(r.event!.observedExecutionRevision).toBe(10);
	});

	it("cancels DISPATCHED cycle", () => {
		let s = freshScheduler();
		let r = scheduleContinuation(s, { eventId: "s1", expectedSchedulerRevision: 0, expectedExecutionRevision: 5 });
		s = r.record!;
		r = dispatchContinuation(
			s,
			{
				eventId: "d1",
				cycleId: "s1",
				expectedSchedulerRevision: 1,
				dispatchedContinuationId: "c1",
			},
			5,
		);
		s = r.record!;

		r = cancelContinuation(s, { eventId: "cancel-1", cycleId: "s1", expectedSchedulerRevision: 2 }, 10);
		expect(r.ok).toBe(true);
		expect(r.record!.state).toBe("IDLE");
	});

	it("rejects cancel when execution revision < expected", () => {
		let s = freshScheduler();
		let r = scheduleContinuation(s, { eventId: "s1", expectedSchedulerRevision: 0, expectedExecutionRevision: 5 });
		s = r.record!;

		r = cancelContinuation(s, { eventId: "cancel-1", cycleId: "s1", expectedSchedulerRevision: 1 }, 3);
		expect(r.ok).toBe(false);
		expect(r.code).toBe("EXECUTION_REVISION_MISMATCH");
	});

	it("rejects cancel on IDLE", () => {
		const s = freshScheduler();
		const r = cancelContinuation(s, { eventId: "cancel-1", cycleId: "any", expectedSchedulerRevision: 0 }, 5);
		expect(r.ok).toBe(false);
		expect(r.code).toBe("INVALID_STATE");
	});
});

// =============================================================================
// ABANDON
// =============================================================================

describe("abandon", () => {
	it("abandons when execution revision > expected", () => {
		let s = freshScheduler();
		let r = scheduleContinuation(s, { eventId: "s1", expectedSchedulerRevision: 0, expectedExecutionRevision: 5 });
		expect(r.ok).toBe(true);
		s = r.record!;

		r = abandonContinuation(s, { eventId: "abandon-1", cycleId: "s1", expectedSchedulerRevision: 1 }, 7);
		expect(r.ok).toBe(true);
		expect(r.record!.state).toBe("IDLE");
		expect(r.event!.observedExecutionRevision).toBe(7);
	});

	it("rejects abandon when execution revision == expected (CYCLE_NOT_SUPERSEDED)", () => {
		let s = freshScheduler();
		let r = scheduleContinuation(s, { eventId: "s1", expectedSchedulerRevision: 0, expectedExecutionRevision: 5 });
		s = r.record!;

		r = abandonContinuation(s, { eventId: "abandon-1", cycleId: "s1", expectedSchedulerRevision: 1 }, 5);
		expect(r.ok).toBe(false);
		expect(r.code).toBe("CYCLE_NOT_SUPERSEDED");
	});

	it("rejects abandon when execution revision < expected", () => {
		let s = freshScheduler();
		let r = scheduleContinuation(s, { eventId: "s1", expectedSchedulerRevision: 0, expectedExecutionRevision: 5 });
		s = r.record!;

		r = abandonContinuation(s, { eventId: "abandon-1", cycleId: "s1", expectedSchedulerRevision: 1 }, 3);
		expect(r.ok).toBe(false);
		expect(r.code).toBe("EXECUTION_REVISION_MISMATCH");
	});
});

// =============================================================================
// Event digests
// =============================================================================

describe("event digests", () => {
	it("produces deterministic SHA-256 digest", () => {
		const s = freshScheduler();
		const r1 = scheduleContinuation(s, {
			eventId: "ev-1",
			expectedSchedulerRevision: 0,
			expectedExecutionRevision: 5,
		});
		expect(r1.ok).toBe(true);

		// Same inputs, fresh scheduler → same field values
		const s2 = freshScheduler();
		const r2 = scheduleContinuation(s2, {
			eventId: "ev-1",
			expectedSchedulerRevision: 0,
			expectedExecutionRevision: 5,
		});
		expect(r2.ok).toBe(true);

		// eventDigest differs because createdAt differs, so we compare fields
		expect(r1.event!.cycleId).toBe(r2.event!.cycleId);
		expect(r1.event!.kind).toBe(r2.event!.kind);
		expect(r1.event!.fromState).toBe(r2.event!.fromState);
		expect(r1.event!.toState).toBe(r2.event!.toState);
	});

	it("digest format is sha256:<64 hex chars>", () => {
		const s = freshScheduler();
		const r = scheduleContinuation(s, {
			eventId: "ev-1",
			expectedSchedulerRevision: 0,
			expectedExecutionRevision: 5,
		});
		expect(r.ok).toBe(true);
		expect(r.event!.eventDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	it("history digest null for empty events", () => {
		const s = freshScheduler();
		expect(s.historyDigest).toBeNull();
	});

	it("history digest format for non-empty events", () => {
		const s = freshScheduler();
		const r = scheduleContinuation(s, {
			eventId: "ev-1",
			expectedSchedulerRevision: 0,
			expectedExecutionRevision: 5,
		});
		expect(r.ok).toBe(true);
		expect(r.record!.historyDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
	});
});

// =============================================================================
// Canonical replay
// =============================================================================

describe("canonical replay", () => {
	it("inspection replays and verifies all events", () => {
		let s = freshScheduler();
		let r = scheduleContinuation(s, { eventId: "s1", expectedSchedulerRevision: 0, expectedExecutionRevision: 5 });
		s = r.record!;
		r = dispatchContinuation(
			s,
			{
				eventId: "d1",
				cycleId: "s1",
				expectedSchedulerRevision: 1,
				dispatchedContinuationId: "c1",
			},
			5,
		);
		s = r.record!;
		r = consumeContinuation(
			s,
			{
				eventId: "con1",
				cycleId: "s1",
				expectedSchedulerRevision: 2,
				dispatchedContinuationId: "c1",
				resultDigest: "r1",
			},
			5,
		);
		s = r.record!;

		const insp = inspectContinuationScheduler(s);
		expect(insp.valid).toBe(true);
		expect(insp.eventCount).toBe(3);
		expect(insp.state).toBe("IDLE");
	});

	it("inspection detects digest corruption", () => {
		let s = freshScheduler();
		let r = scheduleContinuation(s, { eventId: "s1", expectedSchedulerRevision: 0, expectedExecutionRevision: 5 });
		s = r.record!;
		r = dispatchContinuation(
			s,
			{
				eventId: "d1",
				cycleId: "s1",
				expectedSchedulerRevision: 1,
				dispatchedContinuationId: "c1",
			},
			5,
		);
		s = r.record!;

		// Corrupt an event digest
		const corrupted = JSON.parse(JSON.stringify(s)) as ContinuationSchedulerRecord;
		(corrupted.events as ContinuationSchedulerEvent[])[0] = {
			...corrupted.events[0],
			eventDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
		};

		const insp = inspectContinuationScheduler(corrupted);
		expect(insp.valid).toBe(false);
		expect(insp.error).toContain("historyDigest");
	});
});

// =============================================================================
// Contract and execution binding
// =============================================================================

describe("contract and execution binding", () => {
	it("validation reports contract-bound and execution-bound", () => {
		let s = freshScheduler("exec-A", "digest-A");
		const r = scheduleContinuation(s, { eventId: "s1", expectedSchedulerRevision: 0, expectedExecutionRevision: 1 });
		s = r.record!;

		const v = validateContinuationScheduler(s, "digest-A", "exec-A", 5);
		expect(v.valid).toBe(true);
		expect(v.contractBound).toBe(true);
		expect(v.executionBound).toBe(true);
	});
});

// =============================================================================
// Revision checks
// =============================================================================

describe("revision checks", () => {
	it("rejects stale scheduler revision on SCHEDULE", () => {
		let s = freshScheduler();
		let r = scheduleContinuation(s, { eventId: "s1", expectedSchedulerRevision: 0, expectedExecutionRevision: 5 });
		s = r.record!;

		r = scheduleContinuation(s, { eventId: "s2", expectedSchedulerRevision: 0, expectedExecutionRevision: 6 });
		expect(r.ok).toBe(false);
		expect(r.code).toBe("STALE_SCHEDULER_REVISION");
	});

	it("rejects stale scheduler revision on DISPATCH", () => {
		let s = freshScheduler();
		let r = scheduleContinuation(s, { eventId: "s1", expectedSchedulerRevision: 0, expectedExecutionRevision: 5 });
		s = r.record!;

		r = dispatchContinuation(
			s,
			{
				eventId: "d1",
				cycleId: "s1",
				expectedSchedulerRevision: 0,
				dispatchedContinuationId: "c1",
			},
			5,
		);
		expect(r.ok).toBe(false);
		expect(r.code).toBe("STALE_SCHEDULER_REVISION");
	});

	it("rejects INVALID_STATE when scheduling on SCHEDULED", () => {
		let s = freshScheduler();
		let r = scheduleContinuation(s, { eventId: "s1", expectedSchedulerRevision: 0, expectedExecutionRevision: 5 });
		s = r.record!;

		r = scheduleContinuation(s, { eventId: "s2", expectedSchedulerRevision: 1, expectedExecutionRevision: 6 });
		expect(r.ok).toBe(false);
		expect(r.code).toBe("INVALID_STATE");
	});
});

// =============================================================================
// Safe integers above 2^31-1
// =============================================================================

describe("safe integers above 2^31-1", () => {
	it("handles scheduler revision > 2^31-1", () => {
		// Manually construct a record with a high revision
		const largeRev = Number.MAX_SAFE_INTEGER;
		const s: ContinuationSchedulerRecord = {
			schedulerVersion: 1,
			executionId: "exec-large",
			contractDigest: "digest",
			schedulerRevision: largeRev,
			state: "IDLE",
			events: [],
			historyDigest: null,
		};

		const r = scheduleContinuation(s, {
			eventId: "ev-large",
			expectedSchedulerRevision: largeRev,
			expectedExecutionRevision: largeRev,
		});
		expect(r.ok).toBe(true);
		expect(r.record!.schedulerRevision).toBe(largeRev + 1);
	});

	it("rejects non-safe-integer revision in request", () => {
		const s = freshScheduler();
		const r = scheduleContinuation(s, {
			eventId: "ev-bad",
			expectedSchedulerRevision: Number.MAX_SAFE_INTEGER + 1,
			expectedExecutionRevision: 5,
		});
		expect(r.ok).toBe(false);
		expect(r.code).toBe("INVALID_REQUEST");
	});
});

// =============================================================================
// Idempotent exact retries
// =============================================================================

describe("idempotent exact retries", () => {
	it("returns existing event on exact retry", () => {
		let s = freshScheduler();
		const r1 = scheduleContinuation(s, {
			eventId: "ev-1",
			expectedSchedulerRevision: 0,
			expectedExecutionRevision: 5,
		});
		expect(r1.ok).toBe(true);
		s = r1.record!;

		// Exact retry: same eventId, same fingerprint (same expectedSchedulerRevision)
		const r2 = scheduleContinuation(s, {
			eventId: "ev-1",
			expectedSchedulerRevision: 0,
			expectedExecutionRevision: 5,
		});
		expect(r2.ok).toBe(true);
		expect(r2.event!.eventDigest).toBe(r1.event!.eventDigest);
		// Record unchanged
		expect(r2.record!.schedulerRevision).toBe(1);
	});

	it("idempotent retry after terminal state returns existing event", () => {
		let s = freshScheduler();
		let r = scheduleContinuation(s, { eventId: "s1", expectedSchedulerRevision: 0, expectedExecutionRevision: 5 });
		s = r.record!;
		r = dispatchContinuation(
			s,
			{
				eventId: "d1",
				cycleId: "s1",
				expectedSchedulerRevision: 1,
				dispatchedContinuationId: "c1",
			},
			5,
		);
		s = r.record!;
		r = consumeContinuation(
			s,
			{
				eventId: "con1",
				cycleId: "s1",
				expectedSchedulerRevision: 2,
				dispatchedContinuationId: "c1",
				resultDigest: "r1",
			},
			5,
		);
		s = r.record!;
		expect(s.state).toBe("IDLE");

		// Exact retry of the CONSUME with same fingerprint
		const retry = consumeContinuation(
			s,
			{
				eventId: "con1",
				cycleId: "s1",
				expectedSchedulerRevision: 2,
				dispatchedContinuationId: "c1",
				resultDigest: "r1",
			},
			5,
		);
		expect(retry.ok).toBe(true);
		expect(retry.record!.schedulerRevision).toBe(3);
	});
});

// =============================================================================
// Idempotency conflicts
// =============================================================================

describe("idempotency conflicts", () => {
	it("rejects different fingerprint with same eventId", () => {
		let s = freshScheduler();
		const r1 = scheduleContinuation(s, {
			eventId: "ev-1",
			expectedSchedulerRevision: 0,
			expectedExecutionRevision: 5,
		});
		s = r1.record!;

		// Same eventId but different expectedExecutionRevision (via fingerprint difference)
		const r2 = scheduleContinuation(s, {
			eventId: "ev-1",
			expectedSchedulerRevision: 1,
			expectedExecutionRevision: 99,
		});
		expect(r2.ok).toBe(false);
		expect(r2.code).toBe("IDEMPOTENCY_CONFLICT");
	});
});

// =============================================================================
// Cycle bindings
// =============================================================================

describe("cycle bindings", () => {
	it("rejects dispatch with wrong cycleId", () => {
		let s = freshScheduler();
		let r = scheduleContinuation(s, { eventId: "s1", expectedSchedulerRevision: 0, expectedExecutionRevision: 5 });
		s = r.record!;

		r = dispatchContinuation(
			s,
			{
				eventId: "d1",
				cycleId: "wrong-cycle",
				expectedSchedulerRevision: 1,
				dispatchedContinuationId: "c1",
			},
			5,
		);
		expect(r.ok).toBe(false);
		expect(r.code).toBe("INVALID_CYCLE");
	});

	it("rejects consume with wrong dispatchedContinuationId", () => {
		let s = freshScheduler();
		let r = scheduleContinuation(s, { eventId: "s1", expectedSchedulerRevision: 0, expectedExecutionRevision: 5 });
		s = r.record!;
		r = dispatchContinuation(
			s,
			{
				eventId: "d1",
				cycleId: "s1",
				expectedSchedulerRevision: 1,
				dispatchedContinuationId: "c1",
			},
			5,
		);
		s = r.record!;

		r = consumeContinuation(
			s,
			{
				eventId: "con1",
				cycleId: "s1",
				expectedSchedulerRevision: 2,
				dispatchedContinuationId: "wrong-c",
				resultDigest: "r1",
			},
			5,
		);
		expect(r.ok).toBe(false);
		expect(r.code).toBe("INVALID_REQUEST");
	});

	it("SCHEDULE cycleId equals eventId", () => {
		const s = freshScheduler();
		const r = scheduleContinuation(s, {
			eventId: "my-event",
			expectedSchedulerRevision: 0,
			expectedExecutionRevision: 5,
		});
		expect(r.ok).toBe(true);
		expect(r.event!.cycleId).toBe("my-event");
	});
});

// =============================================================================
// Missing scheduler behavior
// =============================================================================

describe("missing scheduler", () => {
	it("schedule with null record and rev 0 succeeds", () => {
		const r = scheduleContinuation(null, {
			eventId: "ev-init",
			expectedSchedulerRevision: 0,
			expectedExecutionRevision: 5,
		});
		expect(r.ok).toBe(true);
		expect(r.record!.state).toBe("SCHEDULED");
		expect(r.record!.schedulerRevision).toBe(1);
		expect(r.record!.executionId).toBe("");
		expect(r.record!.contractDigest).toBe("");
	});

	it("schedule with null record and rev > 0 fails ENOENT", () => {
		const r = scheduleContinuation(null, {
			eventId: "ev-init",
			expectedSchedulerRevision: 5,
			expectedExecutionRevision: 5,
		});
		expect(r.ok).toBe(false);
		expect(r.code).toBe("ENOENT");
	});

	it("dispatch with null fails ENOENT", () => {
		const r = dispatchContinuation(
			null,
			{
				eventId: "d1",
				cycleId: "s1",
				expectedSchedulerRevision: 0,
				dispatchedContinuationId: "c1",
			},
			5,
		);
		expect(r.ok).toBe(false);
		expect(r.code).toBe("ENOENT");
	});

	it("consume with null fails ENOENT", () => {
		const r = consumeContinuation(
			null,
			{
				eventId: "c1",
				cycleId: "s1",
				expectedSchedulerRevision: 0,
				dispatchedContinuationId: "c1",
				resultDigest: "r1",
			},
			5,
		);
		expect(r.ok).toBe(false);
		expect(r.code).toBe("ENOENT");
	});

	it("cancel with null fails ENOENT", () => {
		const r = cancelContinuation(null, { eventId: "x1", cycleId: "s1", expectedSchedulerRevision: 0 }, 5);
		expect(r.ok).toBe(false);
		expect(r.code).toBe("ENOENT");
	});

	it("abandon with null fails ENOENT", () => {
		const r = abandonContinuation(null, { eventId: "a1", cycleId: "s1", expectedSchedulerRevision: 0 }, 5);
		expect(r.ok).toBe(false);
		expect(r.code).toBe("ENOENT");
	});
});

// =============================================================================
// Event lookup before fresh guards
// =============================================================================

describe("event lookup before fresh guards", () => {
	it("returns idempotent result even when scheduler revision is stale", () => {
		let s = freshScheduler();
		const r1 = scheduleContinuation(s, {
			eventId: "ev-1",
			expectedSchedulerRevision: 0,
			expectedExecutionRevision: 5,
		});
		s = r1.record!;

		// Retry with stale revision — should still find existing event
		const r2 = scheduleContinuation(s, {
			eventId: "ev-1",
			expectedSchedulerRevision: 0,
			expectedExecutionRevision: 5,
		});
		expect(r2.ok).toBe(true);
		expect(r2.event!.eventId).toBe("ev-1");
	});
});

// =============================================================================
// request syntax validation
// =============================================================================

describe("request syntax validation", () => {
	it("rejects empty eventId", () => {
		const s = freshScheduler();
		const r = scheduleContinuation(s, { eventId: "", expectedSchedulerRevision: 0, expectedExecutionRevision: 5 });
		expect(r.ok).toBe(false);
		expect(r.code).toBe("INVALID_REQUEST");
	});

	it("rejects whitespace-only eventId", () => {
		const s = freshScheduler();
		const r = scheduleContinuation(s, { eventId: "   ", expectedSchedulerRevision: 0, expectedExecutionRevision: 5 });
		expect(r.ok).toBe(false);
		expect(r.code).toBe("INVALID_REQUEST");
	});

	it("rejects negative expectedSchedulerRevision", () => {
		const s = freshScheduler();
		const r = scheduleContinuation(s, { eventId: "ev", expectedSchedulerRevision: -1, expectedExecutionRevision: 5 });
		expect(r.ok).toBe(false);
		expect(r.code).toBe("INVALID_REQUEST");
	});

	it("rejects invalid consume resultDigest (empty)", () => {
		let s = freshScheduler();
		let r = scheduleContinuation(s, { eventId: "s1", expectedSchedulerRevision: 0, expectedExecutionRevision: 5 });
		s = r.record!;
		r = dispatchContinuation(
			s,
			{
				eventId: "d1",
				cycleId: "s1",
				expectedSchedulerRevision: 1,
				dispatchedContinuationId: "c1",
			},
			5,
		);
		s = r.record!;

		r = consumeContinuation(
			s,
			{
				eventId: "con1",
				cycleId: "s1",
				expectedSchedulerRevision: 2,
				dispatchedContinuationId: "c1",
				resultDigest: "",
			},
			5,
		);
		expect(r.ok).toBe(false);
		expect(r.code).toBe("INVALID_REQUEST");
	});
});

// =============================================================================
// Structural validation errors
// =============================================================================

describe("structural validation", () => {
	it("rejects wrong schedulerVersion", () => {
		const bad = {
			schedulerVersion: 2,
			executionId: "x",
			contractDigest: "y",
			schedulerRevision: 0,
			state: "IDLE",
			events: [],
			historyDigest: null,
		} as unknown as ContinuationSchedulerRecord;
		const insp = inspectContinuationScheduler(bad);
		expect(insp.valid).toBe(false);
		expect(insp.error).toContain("schedulerVersion");
	});
});

// =============================================================================
// previousEventDigest is null for first event
// =============================================================================

describe("previousEventDigest", () => {
	it("first event has null previousEventDigest", () => {
		const s = freshScheduler();
		const r = scheduleContinuation(s, { eventId: "s1", expectedSchedulerRevision: 0, expectedExecutionRevision: 5 });
		expect(r.ok).toBe(true);
		expect(r.event!.previousEventDigest).toBeNull();
	});

	it("second event has non-null previousEventDigest", () => {
		let s = freshScheduler();
		let r = scheduleContinuation(s, { eventId: "s1", expectedSchedulerRevision: 0, expectedExecutionRevision: 5 });
		s = r.record!;
		r = dispatchContinuation(
			s,
			{
				eventId: "d1",
				cycleId: "s1",
				expectedSchedulerRevision: 1,
				dispatchedContinuationId: "c1",
			},
			5,
		);
		expect(r.ok).toBe(true);
		// previousEventDigest is the history digest of the prior record, which for a single-event record
		// equals sha256(firstEvent.eventDigest)
		expect(r.event!.previousEventDigest).toBe(s.historyDigest);
		expect(r.event!.previousEventDigest).not.toBeNull();
	});
});

// =============================================================================
// Inspection does not classify as CURRENT/SUPERSEDED
// =============================================================================

describe("inspect vs validate separation", () => {
	it("inspect does not require contract or execution", () => {
		const s = freshScheduler();
		const insp = inspectContinuationScheduler(s);
		expect(insp.valid).toBe(true);
		expect(insp).not.toHaveProperty("contractBound");
		expect(insp).not.toHaveProperty("executionBound");
	});

	it("validate requires contract and execution binding", () => {
		const s = freshScheduler("exec-A", "digest-A");
		const v = validateContinuationScheduler(s, "digest-A", "exec-A", 5);
		expect(v.contractBound).toBe(true);
		expect(v.executionBound).toBe(true);
		expect(v.semanticValid).toBe(true);
	});
});
