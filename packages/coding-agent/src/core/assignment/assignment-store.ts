/**
 * Assignment Foundation — domain-facing persistence port (2.11.0).
 *
 * Pure types + validation only. No filesystem, process, provider, scheduler,
 * or worker-daemon machinery. The concrete file store writes one small record
 * per assignment and keeps the "current assignment" flag on the record itself;
 * the current-assignment invariant is enforced by the per-mission cross-process
 * mutation lock, not by a separate mutable pointer file.
 *
 * Authority model:
 *   - An assignment records logical designation (mission → executor).
 *   - It is never execution ownership, never runtime incarnation, and never a
 *     MissionResult. Canonical mission completion remains authoritative.
 */

import { isSafeExecutorId } from "../executor-registry/executor-registry-types.js";
import { isSafeMissionId } from "../mission-domain/durable-store.js";
import { isMissionState } from "../mission-domain/mission-state.js";
import {
	type AssignmentRecord,
	type AssignmentState,
	isActiveAssignmentState,
	isAssignmentState,
	isSafeAssignmentId,
} from "./assignment-types.js";

export const ASSIGNMENT_SCHEMA_VERSION = 1 as const;

// =============================================================================
// Store port result types
// =============================================================================

export type AssignmentLoadResult =
	| { status: "ok"; record: AssignmentRecord }
	| { status: "missing" }
	| { status: "corrupt"; assignmentId: string; diagnostic: string };

/** The assignment records for one mission, plus the current designation. */
export interface MissionAssignmentIndex {
	missionId: string;
	/** All assignments for the mission, oldest first. */
	records: AssignmentRecord[];
	/** The record with `current === true`, when one exists. */
	current?: AssignmentRecord;
}

/** A store-level atomic mutation of a mission's assignment history. */
export type AssignmentMutation<T> =
	| { kind: "write"; records: AssignmentRecord[]; value: T }
	| { kind: "noop"; value: T };

export type AssignmentMutateResult<T> = { status: "ok"; value: T } | { status: "corrupt"; diagnostic: string };

/** Bulk read result: all healthy records plus structurally-surfaced corrupt ids. */
export interface AssignmentListRecordsResult {
	records: AssignmentRecord[];
	corrupt: { assignmentId: string; diagnostic: string }[];
}

/**
 * Canonical assignment persistence port. Implementations must be crash-conscious
 * (atomic record replacement, schema validation on load, deterministic corrupt
 * handling) and must never fabricate a current assignment.
 */
export interface AssignmentStore {
	readonly storeId: string;

	/** Load a single assignment by its durable id. */
	load(assignmentId: string): Promise<AssignmentLoadResult>;

	/** All assignment ids (any mission), for scan-based listing. */
	listAssignments(): Promise<string[]>;

	/** Bulk load every healthy record and surface corrupt ids structurally. */
	listRecords(): Promise<AssignmentListRecordsResult>;

	/**
	 * Atomically mutate a mission's assignment history across processes. The
	 * callback receives the mission's current records (oldest first) and its
	 * current assignment, and returns the replacement record set. The store
	 * serializes mutations per mission and enforces the current invariant.
	 */
	mutate<T>(
		missionId: string,
		mutation: (index: MissionAssignmentIndex) => AssignmentMutation<T>,
	): Promise<AssignmentMutateResult<T>>;
}

// =============================================================================
// Validation
// =============================================================================

export type AssignmentParseResult = { ok: true; record: AssignmentRecord } | { ok: false; diagnostic: string };

function invalid(why: string): AssignmentParseResult {
	return { ok: false, diagnostic: why };
}

function isSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function validateMissionRequirements(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return "requirements must be an object";
	const r = value as Record<string, unknown>;
	if (r.platform !== undefined) {
		if (typeof r.platform !== "object" || r.platform === null || Array.isArray(r.platform))
			return "requirements.platform must be an object";
		const p = r.platform as Record<string, unknown>;
		if (p.os !== undefined && typeof p.os !== "string") return "requirements.platform.os must be a string";
		if (p.arch !== undefined && typeof p.arch !== "string") return "requirements.platform.arch must be a string";
	}
	for (const key of ["execution", "providers", "models", "tools", "specialized", "extra"] as const) {
		if (r[key] !== undefined && !isStringArray(r[key])) return `requirements.${key} must be a string array`;
	}
	if (r.labels !== undefined) {
		if (typeof r.labels !== "object" || r.labels === null || Array.isArray(r.labels))
			return "requirements.labels must be an object";
		const labels = r.labels as Record<string, unknown>;
		if (labels.required !== undefined && !isStringArray(labels.required))
			return "requirements.labels.required must be a string array";
		if (labels.excluded !== undefined && !isStringArray(labels.excluded))
			return "requirements.labels.excluded must be a string array";
	}
	return undefined;
}

function validateCompatibilityItem(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return "compatibility item must be an object";
	const item = value as Record<string, unknown>;
	if (typeof item.kind !== "string") return "compatibility item.kind must be a string";
	if (typeof item.requirement !== "string") return "compatibility item.requirement must be a string";
	if (item.observed !== undefined && typeof item.observed !== "string" && !Array.isArray(item.observed))
		return "compatibility item.observed must be a string or string array";
	return undefined;
}

function validateCompatibility(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return "compatibility must be an object";
	const c = value as Record<string, unknown>;
	if (typeof c.compatible !== "boolean") return "compatibility.compatible must be a boolean";
	if (!Array.isArray(c.satisfied) || !Array.isArray(c.unsatisfied) || !Array.isArray(c.warnings))
		return "compatibility lists must be arrays";
	for (const list of [c.satisfied, c.unsatisfied]) {
		for (const entry of list) {
			const err = validateCompatibilityItem(entry);
			if (err) return err;
		}
	}
	if (!c.warnings.every((w) => typeof w === "string")) return "compatibility.warnings must be strings";
	return undefined;
}

function validateRuntimeObservation(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return "runtime observation must be an object";
	const r = value as Record<string, unknown>;
	if (!isSafeInteger(r.runtimeEpoch)) return "runtime observation.runtimeEpoch must be a safe integer";
	if (!isSafeInteger(r.observedAtMs)) return "runtime observation.observedAtMs must be a safe integer";
	if (r.runtimeInstanceId !== undefined && typeof r.runtimeInstanceId !== "string")
		return "runtime observation.runtimeInstanceId must be a string";
	const statuses = new Set(["REGISTERED", "ONLINE", "STALE", "OFFLINE", "RETIRED", "UNKNOWN"]);
	if (typeof r.status !== "string" || !statuses.has(r.status)) return "runtime observation.status is invalid";
	return undefined;
}

function validateOwnerIdentity(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return "executionOwnerIdentity must be an object";
	const o = value as Record<string, unknown>;
	if (typeof o.executorId !== "string" || o.executorId.length === 0)
		return "executionOwnerIdentity.executorId must be a string";
	if (typeof o.runtimeInstanceId !== "string" || o.runtimeInstanceId.length === 0)
		return "executionOwnerIdentity.runtimeInstanceId must be a string";
	if (!isSafeInteger(o.runtimeEpoch)) return "executionOwnerIdentity.runtimeEpoch must be a safe integer";
	if (typeof o.ownerId !== "string" || o.ownerId.length === 0)
		return "executionOwnerIdentity.ownerId must be a string";
	return undefined;
}

/**
 * Validate an untrusted persisted value into an AssignmentRecord. Corruption is
 * surfaced structurally (`ok: false`), never silently dropped or fabricated.
 */
export function parseAssignmentRecord(value: unknown): AssignmentParseResult {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid("record must be an object");
	const doc = value as Record<string, unknown>;

	if (doc.schemaVersion !== ASSIGNMENT_SCHEMA_VERSION) {
		return invalid(`unsupported schemaVersion: ${String(doc.schemaVersion)}`);
	}
	if (typeof doc.assignmentId !== "string" || !isSafeAssignmentId(doc.assignmentId))
		return invalid("assignmentId is missing or unsafe");
	const assignmentId = doc.assignmentId;

	if (typeof doc.missionId !== "string" || !isSafeMissionId(doc.missionId))
		return invalid("missionId is missing or unsafe");
	if (typeof doc.executorId !== "string" || !isSafeExecutorId(doc.executorId))
		return invalid("executorId is missing or unsafe");

	if (!isSafeInteger(doc.createdAtMs) || !isSafeInteger(doc.updatedAtMs))
		return invalid("timestamps must be safe integers");
	if (!isSafeInteger(doc.revision) || (doc.revision as number) < 0)
		return invalid("revision must be a non-negative integer");
	if (typeof doc.current !== "boolean") return invalid("current must be a boolean");

	if (!isAssignmentState(doc.state)) return invalid(`invalid assignment state: ${String(doc.state)}`);
	const state = doc.state as AssignmentState;

	// Current/invariant consistency: only an active (non-terminal) assignment can
	// be current; a terminal assignment must never be current.
	if (doc.current === true && !isActiveAssignmentState(state)) {
		return invalid(`a ${state} assignment cannot be current`);
	}
	if (doc.current === false && state === "ASSIGNED") {
		return invalid("an ASSIGNED record must be current (ASSIGNED implies designation)");
	}

	if (doc.assignedBy !== undefined && typeof doc.assignedBy !== "string")
		return invalid("assignedBy must be a string when present");
	if (doc.requirementsSnapshot !== undefined) {
		const err = validateMissionRequirements(doc.requirementsSnapshot);
		if (err) return invalid(`requirementsSnapshot: ${err}`);
	}
	if (doc.compatibilitySnapshot !== undefined) {
		const err = validateCompatibility(doc.compatibilitySnapshot);
		if (err) return invalid(`compatibilitySnapshot: ${err}`);
	}
	if (doc.executorRuntimeAtAssignment !== undefined) {
		const err = validateRuntimeObservation(doc.executorRuntimeAtAssignment);
		if (err) return invalid(`executorRuntimeAtAssignment: ${err}`);
	}
	for (const key of ["acceptedAtMs", "executionStartedAtMs", "completedAtMs", "releasedAtMs"] as const) {
		if (doc[key] !== undefined && !isSafeInteger(doc[key])) return invalid(`${key} must be a safe integer`);
	}
	for (const key of ["consumedByAttemptId", "consumedByExecutionId"] as const) {
		if (doc[key] !== undefined && typeof doc[key] !== "string")
			return invalid(`${key} must be a string when present`);
	}
	for (const key of ["supersededByAssignmentId", "supersedesAssignmentId"] as const) {
		if (doc[key] !== undefined && (typeof doc[key] !== "string" || !isSafeAssignmentId(doc[key])))
			return invalid(`${key} must be a safe assignment id when present`);
	}
	if (doc.executionOwnerIdentity !== undefined) {
		const err = validateOwnerIdentity(doc.executionOwnerIdentity);
		if (err) return invalid(`executionOwnerIdentity: ${err}`);
	}
	if (doc.terminalMissionState !== undefined && !isMissionState(doc.terminalMissionState))
		return invalid("terminalMissionState is invalid");
	if (doc.reason !== undefined && typeof doc.reason !== "string")
		return invalid("reason must be a string when present");

	return {
		ok: true,
		record: {
			schemaVersion: ASSIGNMENT_SCHEMA_VERSION,
			assignmentId,
			missionId: doc.missionId as string,
			executorId: doc.executorId as string,
			createdAtMs: doc.createdAtMs as number,
			updatedAtMs: doc.updatedAtMs as number,
			state,
			current: doc.current as boolean,
			assignedBy: doc.assignedBy as string | undefined,
			requirementsSnapshot: doc.requirementsSnapshot as AssignmentRecord["requirementsSnapshot"],
			compatibilitySnapshot: doc.compatibilitySnapshot as AssignmentRecord["compatibilitySnapshot"],
			executorRuntimeAtAssignment:
				doc.executorRuntimeAtAssignment as AssignmentRecord["executorRuntimeAtAssignment"],
			acceptedAtMs: doc.acceptedAtMs as number | undefined,
			executionStartedAtMs: doc.executionStartedAtMs as number | undefined,
			completedAtMs: doc.completedAtMs as number | undefined,
			releasedAtMs: doc.releasedAtMs as number | undefined,
			consumedByAttemptId: doc.consumedByAttemptId as string | undefined,
			consumedByExecutionId: doc.consumedByExecutionId as string | undefined,
			supersededByAssignmentId: doc.supersededByAssignmentId as string | undefined,
			supersedesAssignmentId: doc.supersedesAssignmentId as string | undefined,
			executionOwnerIdentity: doc.executionOwnerIdentity as AssignmentRecord["executionOwnerIdentity"],
			terminalMissionState: doc.terminalMissionState as AssignmentRecord["terminalMissionState"],
			reason: doc.reason as string | undefined,
			revision: doc.revision as number,
		},
	};
}

// =============================================================================
// Record construction helper
// =============================================================================

export interface CreateAssignmentRecordInput {
	assignmentId: string;
	missionId: string;
	executorId: string;
	now?: number;
	assignedBy?: string;
	requirementsSnapshot?: AssignmentRecord["requirementsSnapshot"];
	compatibilitySnapshot?: AssignmentRecord["compatibilitySnapshot"];
	executorRuntimeAtAssignment?: AssignmentRecord["executorRuntimeAtAssignment"];
}

/** Build an initial ASSIGNED + current record. */
export function createAssignmentRecord(input: CreateAssignmentRecordInput): AssignmentRecord {
	if (!isSafeAssignmentId(input.assignmentId)) throw new Error(`Unsafe assignment id: ${input.assignmentId}`);
	if (!isSafeMissionId(input.missionId)) throw new Error(`Unsafe mission id: ${input.missionId}`);
	if (!isSafeExecutorId(input.executorId)) throw new Error(`Unsafe executor id: ${input.executorId}`);
	const now = input.now ?? Date.now();
	return {
		schemaVersion: ASSIGNMENT_SCHEMA_VERSION,
		assignmentId: input.assignmentId,
		missionId: input.missionId,
		executorId: input.executorId,
		createdAtMs: now,
		updatedAtMs: now,
		state: "ASSIGNED",
		current: true,
		assignedBy: input.assignedBy,
		requirementsSnapshot: input.requirementsSnapshot,
		compatibilitySnapshot: input.compatibilitySnapshot,
		executorRuntimeAtAssignment: input.executorRuntimeAtAssignment,
		revision: 1,
	};
}

/** True when a record represents a canonical terminal assignment outcome. */
export function isTerminalAssignmentRecord(record: AssignmentRecord): boolean {
	return !isActiveAssignmentState(record.state);
}
