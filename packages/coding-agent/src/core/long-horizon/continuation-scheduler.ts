/**
 * LH-3 Mission Continuation Scheduler v1.
 *
 * Freezes the exact continuation identity, cycle bindings, revision
 * guards, and event digests for a single Mission Execution. The
 * scheduler is a deterministic, replayable event log that can be
 * independently verified without the caller runtime.
 *
 * Every mutation produces a single immutable ContinuationSchedulerEvent
 * with a SHA-256 digest computed over its ordered fields. Events form
 * a hash chain via previousEventDigest. The aggregate history digest
 * covers the full event sequence.
 *
 * Threat Model:
 *   The unkeyed event hash chain and semantic replay protect against
 *   accidental mutation, partial rewriting, internally inconsistent
 *   rewriting, broken ordering, and broken replay. They do not claim
 *   protection against a privileged writer capable of rewriting the
 *   complete record and all digests consistently.
 */

import { createHash } from "crypto";
import { toCanonicalJson } from "./canonical-json.js";

// =============================================================================
// Schema constant
// =============================================================================

export const CONTINUATION_SCHEDULER_VERSION = 1 as const;

// =============================================================================
// Public types
// =============================================================================

export type ContinuationSchedulerState = "IDLE" | "SCHEDULED" | "DISPATCHED";

export type ContinuationSchedulerEventKind = "SCHEDULE" | "DISPATCH" | "CONSUME" | "CANCEL" | "ABANDON";

export interface ContinuationSchedulerRecord {
	readonly schedulerVersion: 1;
	readonly executionId: string;
	readonly contractDigest: string;
	readonly schedulerRevision: number;
	readonly state: ContinuationSchedulerState;
	readonly events: readonly ContinuationSchedulerEvent[];
	readonly historyDigest: string | null;
}

export interface ContinuationSchedulerEvent {
	readonly eventId: string;
	readonly kind: ContinuationSchedulerEventKind;
	readonly cycleId: string;
	readonly requestSchedulerRevision: number;
	readonly observedExecutionRevision: number;
	readonly fromState: ContinuationSchedulerState;
	readonly toState: ContinuationSchedulerState;
	readonly revisionBefore: number;
	readonly revisionAfter: number;
	readonly previousEventDigest: string | null;
	readonly eventDigest: string;
	readonly createdAt: string;

	// Conditional — present only when applicable
	readonly expectedExecutionRevision?: number;
	readonly dispatchedContinuationId?: string;
	readonly resultDigest?: string;
}

// =============================================================================
// Request types
// =============================================================================

export interface ScheduleContinuationRequest {
	readonly eventId: string;
	readonly expectedSchedulerRevision: number;
	readonly expectedExecutionRevision: number;
}

export interface DispatchContinuationRequest {
	readonly eventId: string;
	readonly cycleId: string;
	readonly expectedSchedulerRevision: number;
	readonly dispatchedContinuationId: string;
}

export interface ConsumeContinuationRequest {
	readonly eventId: string;
	readonly cycleId: string;
	readonly expectedSchedulerRevision: number;
	readonly dispatchedContinuationId: string;
	readonly resultDigest: string;
}

export interface CancelContinuationRequest {
	readonly eventId: string;
	readonly cycleId: string;
	readonly expectedSchedulerRevision: number;
}

export interface AbandonContinuationRequest {
	readonly eventId: string;
	readonly cycleId: string;
	readonly expectedSchedulerRevision: number;
}

export type ContinuationSchedulerRequest =
	| ScheduleContinuationRequest
	| DispatchContinuationRequest
	| ConsumeContinuationRequest
	| CancelContinuationRequest
	| AbandonContinuationRequest;

// =============================================================================
// Error codes
// =============================================================================

export type ContinuationSchedulerErrorCode =
	| "IDEMPOTENCY_CONFLICT"
	| "STALE_SCHEDULER_REVISION"
	| "INVALID_STATE"
	| "INVALID_CYCLE"
	| "CYCLE_NOT_SUPERSEDED"
	| "CYCLE_SUPERSEDED"
	| "EXECUTION_REVISION_MISMATCH"
	| "INVALID_REQUEST"
	| "CONTRACT_DIGEST_MISMATCH"
	| "ENOENT"
	| "INVALID_SCHEDULER_RECORD";

// =============================================================================
// Operation result
// =============================================================================

export interface ContinuationSchedulerResult {
	readonly ok: boolean;
	readonly record?: ContinuationSchedulerRecord;
	readonly event?: ContinuationSchedulerEvent;
	readonly error?: string;
	readonly code?: ContinuationSchedulerErrorCode;
}

// =============================================================================
// Inspection result
// =============================================================================

export interface ContinuationSchedulerInspection {
	readonly valid: boolean;
	readonly executionId: string;
	readonly contractDigest: string;
	readonly schedulerRevision: number;
	readonly state: ContinuationSchedulerState;
	readonly eventCount: number;
	readonly historyDigest: string | null;
	readonly error?: string;
}

// =============================================================================
// Validation result
// =============================================================================

export interface ContinuationSchedulerValidation {
	readonly valid: boolean;
	readonly schedulerRevision: number;
	readonly state: ContinuationSchedulerState;
	readonly eventCount: number;
	readonly contractBound: boolean;
	readonly executionBound: boolean;
	readonly semanticValid: boolean;
	readonly error?: string;
}

// =============================================================================
// Construction
// =============================================================================

export function initializeContinuationScheduler(
	executionId: string,
	contractDigest: string,
): ContinuationSchedulerRecord {
	return {
		schedulerVersion: 1,
		executionId,
		contractDigest,
		schedulerRevision: 0,
		state: "IDLE",
		events: [],
		historyDigest: null,
	};
}

// =============================================================================
// Mutation: SCHEDULE
// =============================================================================

export function scheduleContinuation(
	record: ContinuationSchedulerRecord | null,
	request: ScheduleContinuationRequest,
): ContinuationSchedulerResult {
	// 1. Request syntax validation
	const syntaxError = validateScheduleRequest(request);
	if (syntaxError) return syntaxError;

	// 2. Handle missing scheduler
	let isNullRecord = false;
	if (record === null) {
		if (request.expectedSchedulerRevision !== 0) {
			return errorResult(
				"ENOENT",
				`Scheduler not found; expectedSchedulerRevision must be 0, got ${request.expectedSchedulerRevision}`,
			);
		}
		record = initializeContinuationScheduler("", "");
		isNullRecord = true;
	}

	// 3. Structural integrity (skip for freshly constructed record from null)
	if (!isNullRecord) {
		const structError = validateSchedulerStructure(record);
		if (structError) return structError;
	}

	// 4. EventId lookup and idempotency
	const idemResult = checkIdempotency(record, request, "SCHEDULE");
	if (idemResult) return idemResult;

	// 5. Fresh guards
	if (record.schedulerRevision !== request.expectedSchedulerRevision) {
		return errorResult(
			"STALE_SCHEDULER_REVISION",
			`Expected scheduler revision ${request.expectedSchedulerRevision}, actual ${record.schedulerRevision}`,
		);
	}
	if (record.state !== "IDLE") {
		return errorResult("INVALID_STATE", `Expected IDLE but scheduler is ${record.state}`);
	}

	// SCHEDULE: observedExecutionRevision == expectedExecutionRevision
	const observedExecutionRevision = request.expectedExecutionRevision;

	// 7. Build event
	const eventId = request.eventId;
	const cycleId = eventId; // cycleId === eventId for SCHEDULE
	const fromState: ContinuationSchedulerState = "IDLE";
	const toState: ContinuationSchedulerState = "SCHEDULED";
	const revisionBefore = record.schedulerRevision;
	const revisionAfter = revisionBefore + 1;
	const previousEventDigest = record.historyDigest;

	const createdAt = new Date().toISOString();

	const event: ContinuationSchedulerEvent = {
		eventId,
		kind: "SCHEDULE",
		cycleId,
		requestSchedulerRevision: request.expectedSchedulerRevision,
		observedExecutionRevision,
		fromState,
		toState,
		revisionBefore,
		revisionAfter,
		previousEventDigest,
		eventDigest: "", // computed below
		createdAt,
		expectedExecutionRevision: request.expectedExecutionRevision,
	};

	const eventDigest = computeEventDigest(event);
	(event as { eventDigest: string }).eventDigest = eventDigest;

	const newEvents = [...record.events, event];
	const historyDigest = computeHistoryDigest(newEvents);

	const newRecord: ContinuationSchedulerRecord = {
		schedulerVersion: 1,
		executionId: record.executionId,
		contractDigest: record.contractDigest,
		schedulerRevision: revisionAfter,
		state: toState,
		events: newEvents,
		historyDigest,
	};

	return { ok: true, record: newRecord, event };
}

// =============================================================================
// Mutation: DISPATCH
// =============================================================================

export function dispatchContinuation(
	record: ContinuationSchedulerRecord | null,
	request: DispatchContinuationRequest,
	currentExecutionRevision: number,
): ContinuationSchedulerResult {
	// 1. Request syntax validation
	const syntaxError = validateDispatchRequest(request);
	if (syntaxError) return syntaxError;

	// 2. Missing scheduler → ENOENT
	if (record === null) {
		return errorResult("ENOENT", "Scheduler not found");
	}

	// 3. Structural integrity
	const structError = validateSchedulerStructure(record);
	if (structError) return structError;

	// 4. EventId lookup and idempotency
	const idemResult = checkIdempotency(record, request, "DISPATCH");
	if (idemResult) return idemResult;

	// 5. Fresh guards
	if (record.schedulerRevision !== request.expectedSchedulerRevision) {
		return errorResult(
			"STALE_SCHEDULER_REVISION",
			`Expected scheduler revision ${request.expectedSchedulerRevision}, actual ${record.schedulerRevision}`,
		);
	}
	if (record.state !== "SCHEDULED") {
		return errorResult("INVALID_STATE", `Expected SCHEDULED but scheduler is ${record.state}`);
	}

	// 6. Cycle validation: find the active SCHEDULE event
	const activeScheduleEvent = findActiveScheduleEvent(record);
	if (activeScheduleEvent === null) {
		return errorResult("INVALID_CYCLE", "No active SCHEDULE event found");
	}
	if (activeScheduleEvent.eventId !== request.cycleId) {
		return errorResult(
			"INVALID_CYCLE",
			`cycleId ${request.cycleId} does not match active SCHEDULE event ${activeScheduleEvent.eventId}`,
		);
	}

	// 7. Supersession guard
	if (currentExecutionRevision > activeScheduleEvent.expectedExecutionRevision!) {
		return errorResult(
			"CYCLE_SUPERSEDED",
			`Active cycle expectedExecutionRevision ${activeScheduleEvent.expectedExecutionRevision} is superseded by current execution revision ${currentExecutionRevision}`,
		);
	}
	if (currentExecutionRevision < activeScheduleEvent.expectedExecutionRevision!) {
		return errorResult(
			"EXECUTION_REVISION_MISMATCH",
			`Current execution revision ${currentExecutionRevision} is less than active expectedExecutionRevision ${activeScheduleEvent.expectedExecutionRevision}`,
		);
	}

	// DISPATCH: observedExecutionRevision == active expectedExecutionRevision
	const observedExecutionRevision = activeScheduleEvent.expectedExecutionRevision!;

	const fromState: ContinuationSchedulerState = "SCHEDULED";
	const toState: ContinuationSchedulerState = "DISPATCHED";
	const revisionBefore = record.schedulerRevision;
	const revisionAfter = revisionBefore + 1;
	const previousEventDigest = record.historyDigest;

	const createdAt = new Date().toISOString();

	const event: ContinuationSchedulerEvent = {
		eventId: request.eventId,
		kind: "DISPATCH",
		cycleId: request.cycleId,
		requestSchedulerRevision: request.expectedSchedulerRevision,
		observedExecutionRevision,
		fromState,
		toState,
		revisionBefore,
		revisionAfter,
		previousEventDigest,
		eventDigest: "",
		createdAt,
		dispatchedContinuationId: request.dispatchedContinuationId,
	};

	const eventDigest = computeEventDigest(event);
	(event as { eventDigest: string }).eventDigest = eventDigest;

	const newEvents = [...record.events, event];
	const historyDigest = computeHistoryDigest(newEvents);

	const newRecord: ContinuationSchedulerRecord = {
		schedulerVersion: 1,
		executionId: record.executionId,
		contractDigest: record.contractDigest,
		schedulerRevision: revisionAfter,
		state: toState,
		events: newEvents,
		historyDigest,
	};

	return { ok: true, record: newRecord, event };
}

// =============================================================================
// Mutation: CONSUME
// =============================================================================

export function consumeContinuation(
	record: ContinuationSchedulerRecord | null,
	request: ConsumeContinuationRequest,
	currentExecutionRevision: number,
): ContinuationSchedulerResult {
	// 1. Request syntax validation
	const syntaxError = validateConsumeRequest(request);
	if (syntaxError) return syntaxError;

	// 2. Missing scheduler → ENOENT
	if (record === null) {
		return errorResult("ENOENT", "Scheduler not found");
	}

	// 3. Structural integrity
	const structError = validateSchedulerStructure(record);
	if (structError) return structError;

	// 4. EventId lookup and idempotency
	const idemResult = checkIdempotency(record, request, "CONSUME");
	if (idemResult) return idemResult;

	// 5. Fresh guards
	if (record.schedulerRevision !== request.expectedSchedulerRevision) {
		return errorResult(
			"STALE_SCHEDULER_REVISION",
			`Expected scheduler revision ${request.expectedSchedulerRevision}, actual ${record.schedulerRevision}`,
		);
	}
	if (record.state !== "DISPATCHED") {
		return errorResult("INVALID_STATE", `Expected DISPATCHED but scheduler is ${record.state}`);
	}

	// 6. Cycle validation
	const activeScheduleEvent = findActiveScheduleEvent(record);
	if (activeScheduleEvent === null) {
		return errorResult("INVALID_CYCLE", "No active SCHEDULE event found");
	}
	if (activeScheduleEvent.eventId !== request.cycleId) {
		return errorResult(
			"INVALID_CYCLE",
			`cycleId ${request.cycleId} does not match active SCHEDULE event ${activeScheduleEvent.eventId}`,
		);
	}

	// 7. Supersession guard
	if (currentExecutionRevision > activeScheduleEvent.expectedExecutionRevision!) {
		return errorResult(
			"CYCLE_SUPERSEDED",
			`Active cycle expectedExecutionRevision ${activeScheduleEvent.expectedExecutionRevision} is superseded by current execution revision ${currentExecutionRevision}`,
		);
	}
	if (currentExecutionRevision < activeScheduleEvent.expectedExecutionRevision!) {
		return errorResult(
			"EXECUTION_REVISION_MISMATCH",
			`Current execution revision ${currentExecutionRevision} is less than active expectedExecutionRevision ${activeScheduleEvent.expectedExecutionRevision}`,
		);
	}

	// Find active DISPATCH event to verify dispatchedContinuationId
	const activeDispatchEvent = findActiveDispatchEvent(record);
	if (activeDispatchEvent === null) {
		return errorResult("INVALID_STATE", "No active DISPATCH event found");
	}
	if (activeDispatchEvent.dispatchedContinuationId !== request.dispatchedContinuationId) {
		return errorResult(
			"INVALID_REQUEST",
			`dispatchedContinuationId ${request.dispatchedContinuationId} does not match active DISPATCH event ${activeDispatchEvent.dispatchedContinuationId}`,
		);
	}

	// CONSUME: observedExecutionRevision == active expectedExecutionRevision
	const observedExecutionRevision = activeScheduleEvent.expectedExecutionRevision!;

	const fromState: ContinuationSchedulerState = "DISPATCHED";
	const toState: ContinuationSchedulerState = "IDLE";
	const revisionBefore = record.schedulerRevision;
	const revisionAfter = revisionBefore + 1;
	const previousEventDigest = record.historyDigest;

	const createdAt = new Date().toISOString();

	const event: ContinuationSchedulerEvent = {
		eventId: request.eventId,
		kind: "CONSUME",
		cycleId: request.cycleId,
		requestSchedulerRevision: request.expectedSchedulerRevision,
		observedExecutionRevision,
		fromState,
		toState,
		revisionBefore,
		revisionAfter,
		previousEventDigest,
		eventDigest: "",
		createdAt,
		dispatchedContinuationId: request.dispatchedContinuationId,
		resultDigest: request.resultDigest,
	};

	const eventDigest = computeEventDigest(event);
	(event as { eventDigest: string }).eventDigest = eventDigest;

	const newEvents = [...record.events, event];
	const historyDigest = computeHistoryDigest(newEvents);

	const newRecord: ContinuationSchedulerRecord = {
		schedulerVersion: 1,
		executionId: record.executionId,
		contractDigest: record.contractDigest,
		schedulerRevision: revisionAfter,
		state: toState,
		events: newEvents,
		historyDigest,
	};

	return { ok: true, record: newRecord, event };
}

// =============================================================================
// Mutation: CANCEL
// =============================================================================

export function cancelContinuation(
	record: ContinuationSchedulerRecord | null,
	request: CancelContinuationRequest,
	currentExecutionRevision: number,
): ContinuationSchedulerResult {
	// 1. Request syntax validation
	const syntaxError = validateCancelRequest(request);
	if (syntaxError) return syntaxError;

	// 2. Missing scheduler → ENOENT
	if (record === null) {
		return errorResult("ENOENT", "Scheduler not found");
	}

	// 3. Structural integrity
	const structError = validateSchedulerStructure(record);
	if (structError) return structError;

	// 4. EventId lookup and idempotency
	const idemResult = checkIdempotency(record, request, "CANCEL");
	if (idemResult) return idemResult;

	// 5. Fresh guards
	if (record.schedulerRevision !== request.expectedSchedulerRevision) {
		return errorResult(
			"STALE_SCHEDULER_REVISION",
			`Expected scheduler revision ${request.expectedSchedulerRevision}, actual ${record.schedulerRevision}`,
		);
	}
	if (record.state !== "SCHEDULED" && record.state !== "DISPATCHED") {
		return errorResult("INVALID_STATE", `Expected SCHEDULED or DISPATCHED but scheduler is ${record.state}`);
	}

	// 6. Cycle validation
	const activeScheduleEvent = findActiveScheduleEvent(record);
	if (activeScheduleEvent === null) {
		return errorResult("INVALID_CYCLE", "No active SCHEDULE event found");
	}
	if (activeScheduleEvent.eventId !== request.cycleId) {
		return errorResult(
			"INVALID_CYCLE",
			`cycleId ${request.cycleId} does not match active SCHEDULE event ${activeScheduleEvent.eventId}`,
		);
	}

	// CANCEL: observedExecutionRevision >= active expectedExecutionRevision
	if (currentExecutionRevision < activeScheduleEvent.expectedExecutionRevision!) {
		return errorResult(
			"EXECUTION_REVISION_MISMATCH",
			`Current execution revision ${currentExecutionRevision} is less than active expectedExecutionRevision ${activeScheduleEvent.expectedExecutionRevision}`,
		);
	}
	const observedExecutionRevision = currentExecutionRevision;

	const fromState = record.state;
	const toState: ContinuationSchedulerState = "IDLE";
	const revisionBefore = record.schedulerRevision;
	const revisionAfter = revisionBefore + 1;
	const previousEventDigest = record.historyDigest;

	const createdAt = new Date().toISOString();

	const event: ContinuationSchedulerEvent = {
		eventId: request.eventId,
		kind: "CANCEL",
		cycleId: request.cycleId,
		requestSchedulerRevision: request.expectedSchedulerRevision,
		observedExecutionRevision,
		fromState,
		toState,
		revisionBefore,
		revisionAfter,
		previousEventDigest,
		eventDigest: "",
		createdAt,
	};

	const eventDigest = computeEventDigest(event);
	(event as { eventDigest: string }).eventDigest = eventDigest;

	const newEvents = [...record.events, event];
	const historyDigest = computeHistoryDigest(newEvents);

	const newRecord: ContinuationSchedulerRecord = {
		schedulerVersion: 1,
		executionId: record.executionId,
		contractDigest: record.contractDigest,
		schedulerRevision: revisionAfter,
		state: toState,
		events: newEvents,
		historyDigest,
	};

	return { ok: true, record: newRecord, event };
}

// =============================================================================
// Mutation: ABANDON
// =============================================================================

export function abandonContinuation(
	record: ContinuationSchedulerRecord | null,
	request: AbandonContinuationRequest,
	currentExecutionRevision: number,
): ContinuationSchedulerResult {
	// 1. Request syntax validation
	const syntaxError = validateAbandonRequest(request);
	if (syntaxError) return syntaxError;

	// 2. Missing scheduler → ENOENT
	if (record === null) {
		return errorResult("ENOENT", "Scheduler not found");
	}

	// 3. Structural integrity
	const structError = validateSchedulerStructure(record);
	if (structError) return structError;

	// 4. EventId lookup and idempotency
	const idemResult = checkIdempotency(record, request, "ABANDON");
	if (idemResult) return idemResult;

	// 5. Fresh guards
	if (record.schedulerRevision !== request.expectedSchedulerRevision) {
		return errorResult(
			"STALE_SCHEDULER_REVISION",
			`Expected scheduler revision ${request.expectedSchedulerRevision}, actual ${record.schedulerRevision}`,
		);
	}
	if (record.state !== "SCHEDULED" && record.state !== "DISPATCHED") {
		return errorResult("INVALID_STATE", `Expected SCHEDULED or DISPATCHED but scheduler is ${record.state}`);
	}

	// 6. Cycle validation
	const activeScheduleEvent = findActiveScheduleEvent(record);
	if (activeScheduleEvent === null) {
		return errorResult("INVALID_CYCLE", "No active SCHEDULE event found");
	}
	if (activeScheduleEvent.eventId !== request.cycleId) {
		return errorResult(
			"INVALID_CYCLE",
			`cycleId ${request.cycleId} does not match active SCHEDULE event ${activeScheduleEvent.eventId}`,
		);
	}

	// ABANDON: observedExecutionRevision > active expectedExecutionRevision
	if (currentExecutionRevision < activeScheduleEvent.expectedExecutionRevision!) {
		return errorResult(
			"EXECUTION_REVISION_MISMATCH",
			`Current execution revision ${currentExecutionRevision} is less than active expectedExecutionRevision ${activeScheduleEvent.expectedExecutionRevision}`,
		);
	}
	if (currentExecutionRevision === activeScheduleEvent.expectedExecutionRevision!) {
		return errorResult(
			"CYCLE_NOT_SUPERSEDED",
			`Current execution revision ${currentExecutionRevision} equals active expectedExecutionRevision; cycle is not superseded`,
		);
	}
	const observedExecutionRevision = currentExecutionRevision;

	const fromState = record.state;
	const toState: ContinuationSchedulerState = "IDLE";
	const revisionBefore = record.schedulerRevision;
	const revisionAfter = revisionBefore + 1;
	const previousEventDigest = record.historyDigest;

	const createdAt = new Date().toISOString();

	const event: ContinuationSchedulerEvent = {
		eventId: request.eventId,
		kind: "ABANDON",
		cycleId: request.cycleId,
		requestSchedulerRevision: request.expectedSchedulerRevision,
		observedExecutionRevision,
		fromState,
		toState,
		revisionBefore,
		revisionAfter,
		previousEventDigest,
		eventDigest: "",
		createdAt,
	};

	const eventDigest = computeEventDigest(event);
	(event as { eventDigest: string }).eventDigest = eventDigest;

	const newEvents = [...record.events, event];
	const historyDigest = computeHistoryDigest(newEvents);

	const newRecord: ContinuationSchedulerRecord = {
		schedulerVersion: 1,
		executionId: record.executionId,
		contractDigest: record.contractDigest,
		schedulerRevision: revisionAfter,
		state: toState,
		events: newEvents,
		historyDigest,
	};

	return { ok: true, record: newRecord, event };
}

// =============================================================================
// Inspection
// =============================================================================

export function inspectContinuationScheduler(record: ContinuationSchedulerRecord): ContinuationSchedulerInspection {
	const structError = validateSchedulerStructure(record);
	if (structError) {
		return {
			valid: false,
			executionId: "",
			contractDigest: "",
			schedulerRevision: 0,
			state: "IDLE",
			eventCount: 0,
			historyDigest: null,
			error: structError.error,
		};
	}

	// Replay events to verify structural consistency
	const replayError = replayAndVerifyEvents(record.events);
	if (replayError) {
		return {
			valid: false,
			executionId: record.executionId,
			contractDigest: record.contractDigest,
			schedulerRevision: record.schedulerRevision,
			state: record.state,
			eventCount: record.events.length,
			historyDigest: record.historyDigest,
			error: replayError,
		};
	}

	return {
		valid: true,
		executionId: record.executionId,
		contractDigest: record.contractDigest,
		schedulerRevision: record.schedulerRevision,
		state: record.state,
		eventCount: record.events.length,
		historyDigest: record.historyDigest,
	};
}

// =============================================================================
// Validation (contract-bound + execution-bound)
// =============================================================================

export function validateContinuationScheduler(
	record: ContinuationSchedulerRecord,
	contractDigest: string,
	executionId: string,
	_executionRevision: number,
): ContinuationSchedulerValidation {
	const contractBound = record.contractDigest === contractDigest;
	const executionBound = record.executionId === executionId;

	const structError = validateSchedulerStructure(record);
	if (structError) {
		return {
			valid: false,
			schedulerRevision: record.schedulerRevision,
			state: record.state,
			eventCount: record.events.length,
			contractBound,
			executionBound,
			semanticValid: false,
			error: structError.error,
		};
	}

	const replayError = replayAndVerifyEvents(record.events);
	const semanticValid = replayError === null;

	const valid = contractBound && executionBound && semanticValid;

	let error: string | undefined;
	if (!valid) {
		const parts: string[] = [];
		if (!contractBound) parts.push("contract digest mismatch");
		if (!executionBound) parts.push("execution ID mismatch");
		if (!semanticValid) parts.push(replayError ?? "semantic validation failed");
		error = parts.join("; ");
	}

	return {
		valid,
		schedulerRevision: record.schedulerRevision,
		state: record.state,
		eventCount: record.events.length,
		contractBound,
		executionBound,
		semanticValid,
		error,
	};
}

// =============================================================================
// Replay and verification
// =============================================================================

function replayAndVerifyEvents(events: readonly ContinuationSchedulerEvent[]): string | null {
	let expectedRevision = 0;
	let expectedState: ContinuationSchedulerState = "IDLE";
	let expectedCycleId: string | null = null;
	let expectedDispatchedContinuationId: string | null = null;
	let expectedObservedExecutionRevision: number | null = null;
	let previousEventDigest: string | null = null;
	const seenEventIds = new Set<string>();

	for (let i = 0; i < events.length; i++) {
		const event = events[i];

		// Verify event digest
		const computedDigest = computeEventDigest(event);
		if (computedDigest !== event.eventDigest) {
			return `Event ${i} (${event.eventId}): digest mismatch — expected ${computedDigest}, got ${event.eventDigest}`;
		}

		// Verify previousEventDigest chaining
		if (event.previousEventDigest !== previousEventDigest) {
			return `Event ${i} (${event.eventId}): previousEventDigest mismatch — expected ${previousEventDigest}, got ${event.previousEventDigest}`;
		}

		// Verify no duplicate eventId
		if (seenEventIds.has(event.eventId)) {
			return `Event ${i}: duplicate eventId ${event.eventId}`;
		}
		seenEventIds.add(event.eventId);

		// Verify revision progression
		if (event.revisionBefore !== expectedRevision) {
			return `Event ${i} (${event.eventId}): revisionBefore ${event.revisionBefore} != expected ${expectedRevision}`;
		}
		if (event.revisionAfter !== event.revisionBefore + 1) {
			return `Event ${i} (${event.eventId}): revisionAfter ${event.revisionAfter} != revisionBefore + 1 (${event.revisionBefore + 1})`;
		}

		// Verify state machine
		if (event.fromState !== expectedState) {
			return `Event ${i} (${event.eventId}): fromState ${event.fromState} != expected ${expectedState}`;
		}

		switch (event.kind) {
			case "SCHEDULE": {
				if (event.fromState !== "IDLE")
					return `Event ${i}: SCHEDULE fromState must be IDLE, got ${event.fromState}`;
				if (event.toState !== "SCHEDULED")
					return `Event ${i}: SCHEDULE toState must be SCHEDULED, got ${event.toState}`;
				if (event.cycleId !== event.eventId) {
					return `Event ${i}: SCHEDULE cycleId (${event.cycleId}) must equal eventId (${event.eventId})`;
				}
				if (event.expectedExecutionRevision === undefined) {
					return `Event ${i}: SCHEDULE missing expectedExecutionRevision`;
				}
				if (event.observedExecutionRevision !== event.expectedExecutionRevision) {
					return `Event ${i}: SCHEDULE observedExecutionRevision (${event.observedExecutionRevision}) != expectedExecutionRevision (${event.expectedExecutionRevision})`;
				}
				expectedCycleId = event.cycleId;
				expectedObservedExecutionRevision = event.expectedExecutionRevision;
				expectedDispatchedContinuationId = null;
				expectedState = "SCHEDULED";
				break;
			}
			case "DISPATCH": {
				if (event.fromState !== "SCHEDULED")
					return `Event ${i}: DISPATCH fromState must be SCHEDULED, got ${event.fromState}`;
				if (event.toState !== "DISPATCHED")
					return `Event ${i}: DISPATCH toState must be DISPATCHED, got ${event.toState}`;
				if (event.cycleId !== expectedCycleId) {
					return `Event ${i}: DISPATCH cycleId (${event.cycleId}) != active cycle (${expectedCycleId})`;
				}
				if (event.observedExecutionRevision !== expectedObservedExecutionRevision) {
					return `Event ${i}: DISPATCH observedExecutionRevision (${event.observedExecutionRevision}) != active expectedExecutionRevision (${expectedObservedExecutionRevision})`;
				}
				if (event.dispatchedContinuationId === undefined) {
					return `Event ${i}: DISPATCH missing dispatchedContinuationId`;
				}
				expectedDispatchedContinuationId = event.dispatchedContinuationId;
				expectedState = "DISPATCHED";
				break;
			}
			case "CONSUME": {
				if (event.fromState !== "DISPATCHED")
					return `Event ${i}: CONSUME fromState must be DISPATCHED, got ${event.fromState}`;
				if (event.toState !== "IDLE") return `Event ${i}: CONSUME toState must be IDLE, got ${event.toState}`;
				if (event.cycleId !== expectedCycleId) {
					return `Event ${i}: CONSUME cycleId (${event.cycleId}) != active cycle (${expectedCycleId})`;
				}
				if (event.observedExecutionRevision !== expectedObservedExecutionRevision) {
					return `Event ${i}: CONSUME observedExecutionRevision (${event.observedExecutionRevision}) != active expectedExecutionRevision (${expectedObservedExecutionRevision})`;
				}
				if (event.dispatchedContinuationId !== expectedDispatchedContinuationId) {
					return `Event ${i}: CONSUME dispatchedContinuationId (${event.dispatchedContinuationId}) != active (${expectedDispatchedContinuationId})`;
				}
				if (event.resultDigest === undefined || event.resultDigest.trim().length === 0) {
					return `Event ${i}: CONSUME missing or empty resultDigest`;
				}
				expectedCycleId = null;
				expectedObservedExecutionRevision = null;
				expectedDispatchedContinuationId = null;
				expectedState = "IDLE";
				break;
			}
			case "CANCEL": {
				if (event.fromState !== "SCHEDULED" && event.fromState !== "DISPATCHED") {
					return `Event ${i}: CANCEL fromState must be SCHEDULED or DISPATCHED, got ${event.fromState}`;
				}
				if (event.toState !== "IDLE") return `Event ${i}: CANCEL toState must be IDLE, got ${event.toState}`;
				if (event.cycleId !== expectedCycleId) {
					return `Event ${i}: CANCEL cycleId (${event.cycleId}) != active cycle (${expectedCycleId})`;
				}
				if (
					expectedObservedExecutionRevision !== null &&
					event.observedExecutionRevision < expectedObservedExecutionRevision
				) {
					return `Event ${i}: CANCEL observedExecutionRevision (${event.observedExecutionRevision}) < active expectedExecutionRevision (${expectedObservedExecutionRevision})`;
				}
				expectedCycleId = null;
				expectedObservedExecutionRevision = null;
				expectedDispatchedContinuationId = null;
				expectedState = "IDLE";
				break;
			}
			case "ABANDON": {
				if (event.fromState !== "SCHEDULED" && event.fromState !== "DISPATCHED") {
					return `Event ${i}: ABANDON fromState must be SCHEDULED or DISPATCHED, got ${event.fromState}`;
				}
				if (event.toState !== "IDLE") return `Event ${i}: ABANDON toState must be IDLE, got ${event.toState}`;
				if (event.cycleId !== expectedCycleId) {
					return `Event ${i}: ABANDON cycleId (${event.cycleId}) != active cycle (${expectedCycleId})`;
				}
				if (
					expectedObservedExecutionRevision !== null &&
					event.observedExecutionRevision <= expectedObservedExecutionRevision
				) {
					return `Event ${i}: ABANDON observedExecutionRevision (${event.observedExecutionRevision}) must be > active expectedExecutionRevision (${expectedObservedExecutionRevision})`;
				}
				expectedCycleId = null;
				expectedObservedExecutionRevision = null;
				expectedDispatchedContinuationId = null;
				expectedState = "IDLE";
				break;
			}
			default:
				return `Event ${i}: unknown kind ${(event as ContinuationSchedulerEvent).kind}`;
		}

		expectedRevision = event.revisionAfter;
		// Compute history digest of all events up to and including this one
		// This becomes the expected previousEventDigest for the NEXT event
		const eventsUpToHere = events.slice(0, i + 1);
		const expectedHistoryDigest = computeHistoryDigest(eventsUpToHere);
		previousEventDigest = expectedHistoryDigest;
	}

	// Verify final history digest matches the running computation
	if (events.length > 0) {
		const finalHistoryDigest = computeHistoryDigest(events);
		if (finalHistoryDigest !== previousEventDigest) {
			// previousEventDigest holds the history digest of all events
			// This check is redundant but serves as a sanity check
		}
	}

	return null;
}

// =============================================================================
// Digest computation
// =============================================================================

function computeEventDigest(event: ContinuationSchedulerEvent): string {
	const canonical: Record<string, unknown> = {};

	// Required fields (in sorted-key order, always present)
	canonical.cycleId = event.cycleId;
	canonical.eventId = event.eventId;
	canonical.fromState = event.fromState;
	canonical.kind = event.kind;
	canonical.observedExecutionRevision = event.observedExecutionRevision;
	canonical.previousEventDigest = event.previousEventDigest;
	canonical.requestSchedulerRevision = event.requestSchedulerRevision;
	canonical.revisionAfter = event.revisionAfter;
	canonical.revisionBefore = event.revisionBefore;
	canonical.toState = event.toState;

	// Conditional fields — include only when present
	if (event.expectedExecutionRevision !== undefined) {
		canonical.expectedExecutionRevision = event.expectedExecutionRevision;
	}
	if (event.dispatchedContinuationId !== undefined) {
		canonical.dispatchedContinuationId = event.dispatchedContinuationId;
	}
	if (event.resultDigest !== undefined) {
		canonical.resultDigest = event.resultDigest;
	}

	// Excluded from digest: createdAt, eventDigest

	const json = toCanonicalJson(canonical);
	const hash = createHash("sha256");
	hash.update(json, "utf-8");
	return `sha256:${hash.digest("hex")}`;
}

function computeHistoryDigest(events: readonly ContinuationSchedulerEvent[]): string | null {
	if (events.length === 0) return null;

	const concatenated = events.map((e) => e.eventDigest).join("");
	const hash = createHash("sha256");
	hash.update(concatenated, "utf-8");
	return `sha256:${hash.digest("hex")}`;
}

// =============================================================================
// Event lookup helpers
// =============================================================================

function findActiveScheduleEvent(record: ContinuationSchedulerRecord): ContinuationSchedulerEvent | null {
	// The active SCHEDULE event is the last SCHEDULE in the events array
	// that hasn't been consumed/cancelled/abandoned
	for (let i = record.events.length - 1; i >= 0; i--) {
		if (record.events[i].kind === "SCHEDULE") {
			// Check if this cycle is still active (not consumed, cancelled, or abandoned)
			const cycleId = record.events[i].eventId;
			let closed = false;
			for (let j = i + 1; j < record.events.length; j++) {
				if (
					record.events[j].cycleId === cycleId &&
					(record.events[j].kind === "CONSUME" ||
						record.events[j].kind === "CANCEL" ||
						record.events[j].kind === "ABANDON")
				) {
					closed = true;
					break;
				}
			}
			if (!closed) return record.events[i];
		}
	}
	return null;
}

function findActiveDispatchEvent(record: ContinuationSchedulerRecord): ContinuationSchedulerEvent | null {
	for (let i = record.events.length - 1; i >= 0; i--) {
		if (record.events[i].kind === "DISPATCH") {
			// Check if this dispatch is still active (the cycle hasn't been consumed/cancelled/abandoned yet)
			const cycleId = record.events[i].cycleId;
			let closed = false;
			for (let j = i + 1; j < record.events.length; j++) {
				if (
					record.events[j].cycleId === cycleId &&
					(record.events[j].kind === "CONSUME" ||
						record.events[j].kind === "CANCEL" ||
						record.events[j].kind === "ABANDON")
				) {
					closed = true;
					break;
				}
			}
			if (!closed) return record.events[i];
		}
	}
	return null;
}

// =============================================================================
// Idempotency
// =============================================================================

function checkIdempotency(
	record: ContinuationSchedulerRecord,
	request: ContinuationSchedulerRequest,
	kind: ContinuationSchedulerEventKind,
): ContinuationSchedulerResult | null {
	// Check if an event with this eventId already exists
	const existingEvent = record.events.find((e) => e.eventId === request.eventId);
	if (!existingEvent) return null;

	// EventId exists — verify fingerprint matches using the explicit kind
	const fingerprint = computeRequestFingerprint(request, kind);

	// Also check kind matches
	if (existingEvent.kind !== fingerprint.kind) {
		return errorResult(
			"IDEMPOTENCY_CONFLICT",
			`eventId ${request.eventId} exists with kind ${existingEvent.kind}, request is ${fingerprint.kind}`,
		);
	}

	// Verify fingerprint matches exactly
	if (fingerprint.kind === "SCHEDULE") {
		const f = fingerprint as {
			kind: "SCHEDULE";
			cycleId: string;
			requestSchedulerRevision: number;
			expectedExecutionRevision: number;
		};
		if (
			existingEvent.cycleId !== f.cycleId ||
			existingEvent.requestSchedulerRevision !== f.requestSchedulerRevision ||
			existingEvent.expectedExecutionRevision !== f.expectedExecutionRevision
		) {
			return errorResult("IDEMPOTENCY_CONFLICT", `eventId ${request.eventId} exists with different fingerprint`);
		}
	} else if (fingerprint.kind === "DISPATCH") {
		const f = fingerprint as {
			kind: "DISPATCH";
			cycleId: string;
			requestSchedulerRevision: number;
			dispatchedContinuationId: string;
		};
		if (
			existingEvent.cycleId !== f.cycleId ||
			existingEvent.requestSchedulerRevision !== f.requestSchedulerRevision ||
			existingEvent.dispatchedContinuationId !== f.dispatchedContinuationId
		) {
			return errorResult("IDEMPOTENCY_CONFLICT", `eventId ${request.eventId} exists with different fingerprint`);
		}
	} else if (fingerprint.kind === "CONSUME") {
		const f = fingerprint as {
			kind: "CONSUME";
			cycleId: string;
			requestSchedulerRevision: number;
			dispatchedContinuationId: string;
			resultDigest: string;
		};
		if (
			existingEvent.cycleId !== f.cycleId ||
			existingEvent.requestSchedulerRevision !== f.requestSchedulerRevision ||
			existingEvent.dispatchedContinuationId !== f.dispatchedContinuationId ||
			existingEvent.resultDigest !== f.resultDigest
		) {
			return errorResult("IDEMPOTENCY_CONFLICT", `eventId ${request.eventId} exists with different fingerprint`);
		}
	} else if (fingerprint.kind === "CANCEL") {
		const f = fingerprint as { kind: "CANCEL"; cycleId: string; requestSchedulerRevision: number };
		if (
			existingEvent.cycleId !== f.cycleId ||
			existingEvent.requestSchedulerRevision !== f.requestSchedulerRevision
		) {
			return errorResult("IDEMPOTENCY_CONFLICT", `eventId ${request.eventId} exists with different fingerprint`);
		}
	} else if (fingerprint.kind === "ABANDON") {
		const f = fingerprint as { kind: "ABANDON"; cycleId: string; requestSchedulerRevision: number };
		if (
			existingEvent.cycleId !== f.cycleId ||
			existingEvent.requestSchedulerRevision !== f.requestSchedulerRevision
		) {
			return errorResult("IDEMPOTENCY_CONFLICT", `eventId ${request.eventId} exists with different fingerprint`);
		}
	}

	// Exact retry — return the existing event unchanged
	return { ok: true, record, event: existingEvent };
}

function computeRequestFingerprint(
	request: ContinuationSchedulerRequest,
	kind: ContinuationSchedulerEventKind,
): { kind: ContinuationSchedulerEventKind } & Record<string, unknown> {
	// Use the explicit kind to determine the fingerprint, not structurally-ambiguous type guards
	if (kind === "SCHEDULE") {
		const r = request as ScheduleContinuationRequest;
		return {
			kind: "SCHEDULE",
			cycleId: r.eventId,
			requestSchedulerRevision: r.expectedSchedulerRevision,
			expectedExecutionRevision: r.expectedExecutionRevision,
		};
	}
	if (kind === "DISPATCH") {
		const r = request as DispatchContinuationRequest;
		return {
			kind: "DISPATCH",
			cycleId: r.cycleId,
			requestSchedulerRevision: r.expectedSchedulerRevision,
			dispatchedContinuationId: r.dispatchedContinuationId,
		};
	}
	if (kind === "CONSUME") {
		const r = request as ConsumeContinuationRequest;
		return {
			kind: "CONSUME",
			cycleId: r.cycleId,
			requestSchedulerRevision: r.expectedSchedulerRevision,
			dispatchedContinuationId: r.dispatchedContinuationId,
			resultDigest: r.resultDigest,
		};
	}
	if (kind === "CANCEL") {
		const r = request as CancelContinuationRequest;
		return {
			kind: "CANCEL",
			cycleId: r.cycleId,
			requestSchedulerRevision: r.expectedSchedulerRevision,
		};
	}
	// ABANDON
	const r = request as AbandonContinuationRequest;
	return {
		kind: "ABANDON",
		cycleId: r.cycleId,
		requestSchedulerRevision: r.expectedSchedulerRevision,
	};
}

// =============================================================================
// Syntactic request validation
// =============================================================================

function validateScheduleRequest(request: ScheduleContinuationRequest): ContinuationSchedulerResult | null {
	if (!request.eventId || typeof request.eventId !== "string" || request.eventId.trim().length === 0) {
		return errorResult("INVALID_REQUEST", "eventId is required and must be a non-empty string");
	}
	if (!Number.isSafeInteger(request.expectedSchedulerRevision) || request.expectedSchedulerRevision < 0) {
		return errorResult("INVALID_REQUEST", "expectedSchedulerRevision must be a non-negative safe integer");
	}
	if (!Number.isSafeInteger(request.expectedExecutionRevision) || request.expectedExecutionRevision < 0) {
		return errorResult("INVALID_REQUEST", "expectedExecutionRevision must be a non-negative safe integer");
	}
	return null;
}

function validateDispatchRequest(request: DispatchContinuationRequest): ContinuationSchedulerResult | null {
	if (!request.eventId || typeof request.eventId !== "string" || request.eventId.trim().length === 0) {
		return errorResult("INVALID_REQUEST", "eventId is required and must be a non-empty string");
	}
	if (!request.cycleId || typeof request.cycleId !== "string" || request.cycleId.trim().length === 0) {
		return errorResult("INVALID_REQUEST", "cycleId is required and must be a non-empty string");
	}
	if (!Number.isSafeInteger(request.expectedSchedulerRevision) || request.expectedSchedulerRevision < 0) {
		return errorResult("INVALID_REQUEST", "expectedSchedulerRevision must be a non-negative safe integer");
	}
	if (
		!request.dispatchedContinuationId ||
		typeof request.dispatchedContinuationId !== "string" ||
		request.dispatchedContinuationId.trim().length === 0
	) {
		return errorResult("INVALID_REQUEST", "dispatchedContinuationId is required and must be a non-empty string");
	}
	return null;
}

function validateConsumeRequest(request: ConsumeContinuationRequest): ContinuationSchedulerResult | null {
	if (!request.eventId || typeof request.eventId !== "string" || request.eventId.trim().length === 0) {
		return errorResult("INVALID_REQUEST", "eventId is required and must be a non-empty string");
	}
	if (!request.cycleId || typeof request.cycleId !== "string" || request.cycleId.trim().length === 0) {
		return errorResult("INVALID_REQUEST", "cycleId is required and must be a non-empty string");
	}
	if (!Number.isSafeInteger(request.expectedSchedulerRevision) || request.expectedSchedulerRevision < 0) {
		return errorResult("INVALID_REQUEST", "expectedSchedulerRevision must be a non-negative safe integer");
	}
	if (
		!request.dispatchedContinuationId ||
		typeof request.dispatchedContinuationId !== "string" ||
		request.dispatchedContinuationId.trim().length === 0
	) {
		return errorResult("INVALID_REQUEST", "dispatchedContinuationId is required and must be a non-empty string");
	}
	if (!request.resultDigest || typeof request.resultDigest !== "string" || request.resultDigest.trim().length === 0) {
		return errorResult("INVALID_REQUEST", "resultDigest is required and must be a non-empty string");
	}
	return null;
}

function validateCancelRequest(request: CancelContinuationRequest): ContinuationSchedulerResult | null {
	if (!request.eventId || typeof request.eventId !== "string" || request.eventId.trim().length === 0) {
		return errorResult("INVALID_REQUEST", "eventId is required and must be a non-empty string");
	}
	if (!request.cycleId || typeof request.cycleId !== "string" || request.cycleId.trim().length === 0) {
		return errorResult("INVALID_REQUEST", "cycleId is required and must be a non-empty string");
	}
	if (!Number.isSafeInteger(request.expectedSchedulerRevision) || request.expectedSchedulerRevision < 0) {
		return errorResult("INVALID_REQUEST", "expectedSchedulerRevision must be a non-negative safe integer");
	}
	return null;
}

function validateAbandonRequest(request: AbandonContinuationRequest): ContinuationSchedulerResult | null {
	if (!request.eventId || typeof request.eventId !== "string" || request.eventId.trim().length === 0) {
		return errorResult("INVALID_REQUEST", "eventId is required and must be a non-empty string");
	}
	if (!request.cycleId || typeof request.cycleId !== "string" || request.cycleId.trim().length === 0) {
		return errorResult("INVALID_REQUEST", "cycleId is required and must be a non-empty string");
	}
	if (!Number.isSafeInteger(request.expectedSchedulerRevision) || request.expectedSchedulerRevision < 0) {
		return errorResult("INVALID_REQUEST", "expectedSchedulerRevision must be a non-negative safe integer");
	}
	return null;
}

// =============================================================================
// Structural validation
// =============================================================================

function validateSchedulerStructure(record: ContinuationSchedulerRecord): ContinuationSchedulerResult | null {
	if (record.schedulerVersion !== 1) {
		return errorResult("INVALID_SCHEDULER_RECORD", `schedulerVersion must be 1, got ${record.schedulerVersion}`);
	}
	if (typeof record.executionId !== "string" || record.executionId.trim().length === 0) {
		return errorResult("INVALID_SCHEDULER_RECORD", "executionId must be a non-empty string");
	}
	if (typeof record.contractDigest !== "string" || record.contractDigest.trim().length === 0) {
		return errorResult("INVALID_SCHEDULER_RECORD", "contractDigest must be a non-empty string");
	}
	if (!Number.isSafeInteger(record.schedulerRevision) || record.schedulerRevision < 0) {
		return errorResult("INVALID_SCHEDULER_RECORD", "schedulerRevision must be a non-negative safe integer");
	}
	const validStates: ReadonlySet<string> = new Set(["IDLE", "SCHEDULED", "DISPATCHED"]);
	if (!validStates.has(record.state)) {
		return errorResult(
			"INVALID_SCHEDULER_RECORD",
			`state must be IDLE, SCHEDULED, or DISPATCHED, got ${record.state}`,
		);
	}
	if (!Array.isArray(record.events)) {
		return errorResult("INVALID_SCHEDULER_RECORD", "events must be an array");
	}
	if (record.historyDigest !== null && typeof record.historyDigest !== "string") {
		return errorResult("INVALID_SCHEDULER_RECORD", "historyDigest must be null or a string");
	}

	// Verify historyDigest matches events
	const expectedHistoryDigest = computeHistoryDigest(record.events);
	if (record.historyDigest !== expectedHistoryDigest) {
		return errorResult("INVALID_SCHEDULER_RECORD", "historyDigest does not match events");
	}

	return null;
}

// =============================================================================
// Helpers
// =============================================================================

function errorResult(code: ContinuationSchedulerErrorCode, error: string): ContinuationSchedulerResult {
	return { ok: false, code, error };
}
