/**
 * Scheduler Foundation — domain-facing persistence port (2.12.0).
 *
 * Pure types + validation only. No filesystem, process, provider, worker-daemon,
 * or remote-RPC machinery. The concrete file store writes one small record per
 * scheduling intent and keys it deterministically by mission (`intent_<missionId>`),
 * so there is at most one durable queue entry per mission.
 *
 * Authority model:
 *   - This store records pending scheduling intent and the deterministic
 *     decision outcome (ASSIGNED / UNSCHEDULABLE). It never fabricates a
 *     mission result, an executor runtime, or an assignment.
 */

import { validateMissionRequirements } from "../assignment/assignment-store.js";
import type { MissionRequirements } from "../assignment/assignment-types.js";
import { isSafeMissionId } from "../mission-domain/durable-store.js";
import {
	isSafeIntentId,
	isSchedulingIntentState,
	type SchedulingIntentRecord,
	type SchedulingIntentState,
} from "./scheduler-types.js";

export const SCHEDULER_SCHEMA_VERSION = 1 as const;

// =============================================================================
// Store port result types
// =============================================================================

export type SchedulingIntentCreateResult = { status: "created" } | { status: "conflict"; error: string };

export type SchedulingIntentLoadResult =
	| { status: "ok"; record: SchedulingIntentRecord }
	| { status: "missing" }
	| { status: "corrupt"; intentId: string; diagnostic: string };

/** A store-level atomic read-modify-write mutation (sync callback). */
export type SchedulingIntentMutation<T> =
	| { kind: "write"; next: SchedulingIntentRecord; value: T }
	| { kind: "noop"; value: T };

export type SchedulingIntentMutateResult<T> =
	| { status: "ok"; value: T }
	| { status: "missing" }
	| { status: "corrupt"; intentId: string; diagnostic: string };

export interface SchedulingIntentListRecordsResult {
	records: SchedulingIntentRecord[];
	corrupt: { intentId: string; diagnostic: string }[];
}

/**
 * Canonical scheduling-intent persistence port. Implementations must be
 * crash-conscious (atomic record replacement, schema validation on load,
 * deterministic corrupt handling) and must never fabricate a scheduled intent.
 */
export interface SchedulingIntentStore {
	readonly storeId: string;

	/** Create a record at a previously-absent intentId. Existing → conflict. */
	create(record: SchedulingIntentRecord): Promise<SchedulingIntentCreateResult>;
	load(intentId: string): Promise<SchedulingIntentLoadResult>;
	listIntents(): Promise<string[]>;
	listRecords(): Promise<SchedulingIntentListRecordsResult>;
	mutate<T>(
		intentId: string,
		mutation: (current: SchedulingIntentRecord) => SchedulingIntentMutation<T>,
	): Promise<SchedulingIntentMutateResult<T>>;
}

// =============================================================================
// Validation
// =============================================================================

export type SchedulingIntentParseResult =
	| { ok: true; record: SchedulingIntentRecord }
	| { ok: false; diagnostic: string };

function invalid(why: string): SchedulingIntentParseResult {
	return { ok: false, diagnostic: why };
}

function isSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value);
}

/**
 * Validate an untrusted persisted value into a SchedulingIntentRecord.
 * Corruption is surfaced structurally (`ok: false`), never silently dropped or
 * fabricated.
 */
export function parseSchedulingIntentRecord(value: unknown): SchedulingIntentParseResult {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid("record must be an object");
	const doc = value as Record<string, unknown>;

	if (doc.schemaVersion !== SCHEDULER_SCHEMA_VERSION) {
		return invalid(`unsupported schemaVersion: ${String(doc.schemaVersion)}`);
	}
	if (typeof doc.intentId !== "string" || !isSafeIntentId(doc.intentId)) {
		return invalid("intentId is missing or unsafe");
	}
	const intentId = doc.intentId;
	if (typeof doc.missionId !== "string" || !isSafeMissionId(doc.missionId)) {
		return invalid("missionId is missing or unsafe");
	}
	if (!isSchedulingIntentState(doc.state)) return invalid(`invalid intent state: ${String(doc.state)}`);
	const state = doc.state as SchedulingIntentState;

	if (!isSafeInteger(doc.priority)) return invalid("priority must be a safe integer");
	for (const key of ["createdAtMs", "updatedAtMs", "enqueuedAtMs"] as const) {
		if (!isSafeInteger(doc[key])) return invalid(`${key} must be a safe integer`);
	}
	if (!isSafeInteger(doc.revision) || (doc.revision as number) < 0)
		return invalid("revision must be a non-negative integer");

	if (doc.requirements !== undefined) {
		const err = validateMissionRequirements(doc.requirements);
		if (err) return invalid(`requirements: ${err}`);
	}

	// Assignment/state consistency. ASSIGNED is the only state that carries an
	// assignmentId; UNSCHEDULABLE must carry an explainable reason.
	if (state === "ASSIGNED") {
		if (typeof doc.assignmentId !== "string" || !isSafeIntentId(doc.assignmentId)) {
			return invalid("an ASSIGNED intent must carry a safe assignmentId");
		}
		if (doc.unschedulableReason !== undefined) {
			return invalid("an ASSIGNED intent must not carry an unschedulableReason");
		}
	} else {
		if (doc.assignmentId !== undefined) return invalid(`a ${state} intent must not carry an assignmentId`);
		if (state === "UNSCHEDULABLE" && typeof doc.unschedulableReason !== "string") {
			return invalid("an UNSCHEDULABLE intent must carry an unschedulableReason");
		}
	}
	if (doc.unschedulableReason !== undefined && typeof doc.unschedulableReason !== "string") {
		return invalid("unschedulableReason must be a string");
	}

	return {
		ok: true,
		record: {
			schemaVersion: SCHEDULER_SCHEMA_VERSION,
			intentId,
			missionId: doc.missionId as string,
			requirements: doc.requirements as MissionRequirements | undefined,
			priority: doc.priority as number,
			createdAtMs: doc.createdAtMs as number,
			updatedAtMs: doc.updatedAtMs as number,
			enqueuedAtMs: doc.enqueuedAtMs as number,
			state,
			assignmentId: doc.assignmentId as string | undefined,
			unschedulableReason: doc.unschedulableReason as string | undefined,
			revision: doc.revision as number,
		},
	};
}

// =============================================================================
// Record construction helper
// =============================================================================

export interface CreateSchedulingIntentRecordInput {
	intentId: string;
	missionId: string;
	requirements?: MissionRequirements;
	priority?: number;
	now?: number;
}

/** Build an initial PENDING intent record. */
export function createSchedulingIntentRecord(input: CreateSchedulingIntentRecordInput): SchedulingIntentRecord {
	if (!isSafeIntentId(input.intentId)) throw new Error(`Unsafe intent id: ${input.intentId}`);
	if (!isSafeMissionId(input.missionId)) throw new Error(`Unsafe mission id: ${input.missionId}`);
	const now = input.now ?? Date.now();
	return {
		schemaVersion: SCHEDULER_SCHEMA_VERSION,
		intentId: input.intentId,
		missionId: input.missionId,
		requirements: input.requirements,
		priority: input.priority ?? 0,
		createdAtMs: now,
		updatedAtMs: now,
		enqueuedAtMs: now,
		state: "PENDING",
		revision: 1,
	};
}
