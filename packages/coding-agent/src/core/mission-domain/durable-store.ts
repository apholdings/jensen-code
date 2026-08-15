/**
 * Durable Mission Store — domain-facing persistence port (2.4.0).
 *
 * Makes a first-class mission durable across Jensen process restarts. The pure
 * types and validation here depend only on the canonical mission domain (and no
 * process/provider/CLI/UI machinery), so a future background/orchestrator or
 * remote executor can use the same store contract without a SessionManager.
 *
 * Authority model (see Reliability Kernel):
 *   - The DurableMissionStore records the mission-domain lifecycle and result.
 *   - MissionRuntime / Completion Gate remain the sole authority for verified
 *     SUCCEEDED. Loading or saving a durable record can never upgrade a
 *     persisted state; SUCCEEDED only round-trips when it was previously
 *     verified, never inferred from exit code / output text / normal shutdown.
 */

import type { ExecutionLease, ExecutionLeaseProof } from "./execution-lease.js";
import type { MissionRequest } from "./mission-request.js";
import { validateMissionRequest } from "./mission-request.js";
import type { MissionResult } from "./mission-result.js";
import { isMissionExecutionOutcome } from "./mission-result.js";
import { isMissionState, isTerminalMissionState, type MissionState } from "./mission-state.js";

export const DURABLE_MISSION_SCHEMA_VERSION = 1 as const;

// =============================================================================
// Identity / record schema
// =============================================================================

/** How an execution attempt stopped being authoritative. */
export type DurableExecutionAttemptEndReason =
	| "COMPLETED"
	| "FAILED"
	| "CANCELLED"
	| "TIMED_OUT"
	| "CRASHED"
	| "INTERRUPTED";

/**
 * One concrete execution attempt.
 *
 * `attemptId` is the durable, coordinator-allocated identity of the attempt. It
 * is allocated and persisted BEFORE the executor is invoked, so a crash
 * immediately after launch can never erase the fact that an attempt began.
 *
 * `executionId` is the executor-scoped execution id, attached once the executor
 * confirms ownership. It MUST NOT be reused across restart+relaunch unless a
 * future executor can prove it adopted the exact same attempt
 * (ProcessMissionExecutor cannot, so it always allocates a new one).
 */
export interface DurableExecutionAttempt {
	attemptId: string;
	executionId?: string;
	startedAtMs: number;
	finishedAtMs?: number;
	endReason?: DurableExecutionAttemptEndReason;
	/** Present when ownership was lost (restart reconciliation). */
	recovery?: {
		reason: string;
		recoveredAtMs: number;
	};
}

/** One authoritative lifecycle transition, appended in order. */
export interface DurableMissionTransition {
	/** Monotonic transition sequence within a mission. */
	seq: number;
	from: MissionState;
	to: MissionState;
	atMs: number;
	reason?: string;
	executionId?: string;
	/** Durable attempt identity associated with this transition (LAUNCHING). */
	attemptId?: string;
}

/**
 * The durable record for one logical mission. `missionId` is stable across
 * restart; `currentExecutionId` names the current attempt (cleared on
 * reconciliation); `attempts` preserves prior attempt identity for auditability.
 */
export interface DurableMissionRecord {
	schemaVersion: 1;
	missionId: string;
	parentMissionId?: string;
	depth: number;
	/** Immutable once durably created. Conflicting re-create is rejected. */
	request: MissionRequest;
	/** Current authoritative lifecycle state. */
	state: MissionState;
	/** Durable identity of the currently-owned attempt (allocated before launch). */
	currentAttemptId?: string;
	/** Executor execution id of the current attempt, once launch returns. */
	currentExecutionId?: string;
	createdAtMs: number;
	updatedAtMs: number;
	startedAtMs?: number;
	finishedAtMs?: number;
	/** Terminal result, present only when `state` is terminal. */
	result?: MissionResult;
	/** The execution attempt that produced `result`. */
	resultExecutionId?: string;
	/** Ordered lifecycle transition history. */
	transitions: DurableMissionTransition[];
	/** Prior execution attempts, oldest first. */
	attempts: DurableExecutionAttempt[];
	/**
	 * Monotonic ownership epoch. Incremented on every execution-lease
	 * acquisition and every recovery revocation of an expired lease. It is kept
	 * on the record (not only inside `lease`) so it survives lease clearing and
	 * can never move backward.
	 */
	fencingToken: number;
	/**
	 * Current execution-ownership lease. Absent when no valid owner exists.
	 * Terminal records must never carry a lease (ownership is released).
	 */
	lease?: ExecutionLease;
	/** Monotonic generation for stale-update detection. */
	revision: number;
}

// =============================================================================
// Store port
// =============================================================================

export type DurableMissionCreateResult =
	| { status: "created" }
	| { status: "idempotent"; record: DurableMissionRecord }
	| { status: "conflict"; error: string };

export type DurableMissionLoadResult =
	| { status: "ok"; record: DurableMissionRecord }
	| { status: "missing" }
	| { status: "corrupt"; missionId: string; diagnostic: string };

export type DurableMissionSaveResult =
	| { status: "saved" }
	| { status: "stale"; expectedRevision: number; actualRevision: number | undefined }
	| { status: "stale_owner"; leaseId: string; fencingToken: number }
	| { status: "lease_not_found" };

export interface DurableMissionSaveOptions {
	/** Optional optimistic-concurrency guard: reject if on-disk revision differs. */
	expectedRevision?: number;
	/**
	 * Execution-authoritative mutation proof. When present the store verifies,
	 * inside the cross-process critical section, that the current on-disk lease
	 * still matches this proof (leaseId + fencingToken) and is not expired.
	 */
	leaseProof?: ExecutionLeaseProof;
}

/**
 * A store-level atomic read-modify-write mutation.
 *
 * The callback receives the currently-persisted record and must be synchronous
 * (pure record → next record / value) so the cross-process critical section is
 * never held across model inference or other slow work.
 */
export type DurableMissionMutation<T> =
	| { kind: "write"; next: DurableMissionRecord; value: T }
	| { kind: "noop"; value: T };

export type DurableMissionMutateResult<T> =
	| { status: "ok"; value: T }
	| { status: "missing" }
	| { status: "corrupt"; missionId: string; diagnostic: string };

/**
 * Canonical mission persistence port. Implementations must be crash-conscious
 * (atomic record replacement, schema validation on load, deterministic corrupt
 * handling) and must never fabricate a default successful state.
 */
export interface DurableMissionStore {
	readonly storeId: string;

	create(record: DurableMissionRecord): Promise<DurableMissionCreateResult>;

	/** Load a record. Missing and corrupt are distinguished structurally. */
	load(missionId: string): Promise<DurableMissionLoadResult>;

	save(record: DurableMissionRecord, options?: DurableMissionSaveOptions): Promise<DurableMissionSaveResult>;

	/**
	 * Atomically mutate a persisted record across processes. The mutation
	 * callback is invoked only when a valid record exists; missing and corrupt
	 * states are surfaced structurally and never passed to the callback.
	 */
	mutate<T>(
		missionId: string,
		mutation: (current: DurableMissionRecord) => DurableMissionMutation<T>,
	): Promise<DurableMissionMutateResult<T>>;

	listMissions(): Promise<string[]>;

	/** Healthy, non-terminal (recoverable) mission ids. */
	listNonterminalMissions(): Promise<string[]>;

	listChildren(parentMissionId: string): Promise<string[]>;
}

// =============================================================================
// Request equality (duplicate-create idempotency vs conflict)
// =============================================================================

/**
 * Deterministic structural JSON string used for canonical comparison of
 * immutable requests. Object keys are sorted so field insertion order cannot
 * hide a semantic difference.
 */
export function stableStringify(value: unknown): string {
	if (value === undefined) return "null";
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	// Omit keys whose value is `undefined`: JSON round-trips drop them, so an
	// explicitly-undefined optional field is canonically identical to an absent
	// one (they are the same immutable request).
	const keys = Object.keys(record)
		.filter((key) => record[key] !== undefined)
		.sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

/** Structural equality of two immutable MissionRequests. */
export function missionRequestsEqual(a: MissionRequest, b: MissionRequest): boolean {
	return stableStringify(a) === stableStringify(b);
}

// =============================================================================
// Validation
// =============================================================================

export type DurableMissionParseResult = { ok: true; record: DurableMissionRecord } | { ok: false; diagnostic: string };

const EXECUTION_END_REASONS: ReadonlySet<string> = new Set<string>([
	"COMPLETED",
	"FAILED",
	"CANCELLED",
	"TIMED_OUT",
	"CRASHED",
	"INTERRUPTED",
]);

/**
 * A missionId is used as a file path component by the concrete store. Reject
 * anything that could escape the store root or inject a path separator.
 */
export function isSafeMissionId(value: string): boolean {
	return /^[A-Za-z0-9._-]+$/u.test(value) && value !== "." && value !== "..";
}

function invalid(why: string): DurableMissionParseResult {
	return { ok: false, diagnostic: why };
}

function isSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value);
}

function validateResult(result: unknown, missionId: string, state: MissionState): string | undefined {
	if (typeof result !== "object" || result === null) return "result must be an object";
	const r = result as Record<string, unknown>;
	if (r.missionId !== missionId) return "result.missionId does not match record.missionId";
	if (r.state !== state) return "result.state does not match record.state";
	if (r.success !== (state === "SUCCEEDED")) return "result.success is inconsistent with result.state";
	if (!isMissionExecutionOutcome(r.executionOutcome)) return "result.executionOutcome is invalid";
	if (!Array.isArray(r.evidenceRefs)) return "result.evidenceRefs must be an array";
	if (!Array.isArray(r.failures)) return "result.failures must be an array";
	const verification = r.verification;
	if (typeof verification !== "object" || verification === null) return "result.verification must be an object";
	const vstatus = (verification as Record<string, unknown>).status;
	if (vstatus !== "verified" && vstatus !== "unverified" && vstatus !== "failed") {
		return "result.verification.status is invalid";
	}
	const diagnostics = r.executorDiagnostics;
	if (typeof diagnostics !== "object" || diagnostics === null || Array.isArray(diagnostics)) {
		return "result.executorDiagnostics must be an object";
	}
	return undefined;
}

/**
 * Validate an untrusted persisted value into a DurableMissionRecord.
 *
 * Corruption is surfaced structurally (`ok: false`) rather than silently
 * becoming a missing record or — worse — a fabricated success.
 */
export function parseDurableMissionRecord(value: unknown): DurableMissionParseResult {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return invalid("record must be an object");
	}
	const doc = value as Record<string, unknown>;

	if (doc.schemaVersion !== DURABLE_MISSION_SCHEMA_VERSION) {
		return invalid(`unsupported schemaVersion: ${String(doc.schemaVersion)}`);
	}
	if (typeof doc.missionId !== "string" || !isSafeMissionId(doc.missionId)) {
		return invalid("missionId is missing or unsafe");
	}
	const missionId = doc.missionId;

	if (
		doc.parentMissionId !== undefined &&
		(typeof doc.parentMissionId !== "string" || !isSafeMissionId(doc.parentMissionId))
	) {
		return invalid("parentMissionId is unsafe");
	}
	if (!isSafeInteger(doc.depth) || doc.depth < 0) return invalid("depth must be a non-negative integer");

	if (typeof doc.request !== "object" || doc.request === null || Array.isArray(doc.request)) {
		return invalid("request must be an object");
	}
	const requestValidation = validateMissionRequest(doc.request as MissionRequest);
	if (!requestValidation.valid) {
		return invalid(`invalid mission request: ${requestValidation.errors.join(", ")}`);
	}
	const request = requestValidation.request;

	if (!isMissionState(doc.state)) return invalid(`invalid mission state: ${String(doc.state)}`);
	const state = doc.state;

	if (!isSafeInteger(doc.createdAtMs) || !isSafeInteger(doc.updatedAtMs)) {
		return invalid("timestamps must be safe integers");
	}
	if (doc.startedAtMs !== undefined && !isSafeInteger(doc.startedAtMs))
		return invalid("startedAtMs must be a safe integer");
	if (doc.finishedAtMs !== undefined && !isSafeInteger(doc.finishedAtMs))
		return invalid("finishedAtMs must be a safe integer");
	if (!isSafeInteger(doc.revision) || doc.revision < 0) return invalid("revision must be a non-negative integer");

	if (!Array.isArray(doc.transitions)) return invalid("transitions must be an array");
	const transitions: DurableMissionTransition[] = [];
	for (const entry of doc.transitions) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry))
			return invalid("transition must be an object");
		const t = entry as Record<string, unknown>;
		if (!isSafeInteger(t.seq)) return invalid("transition.seq must be a safe integer");
		if (!isMissionState(t.from) || !isMissionState(t.to)) return invalid("transition from/to must be valid states");
		if (!isSafeInteger(t.atMs)) return invalid("transition.atMs must be a safe integer");
		transitions.push({
			seq: t.seq as number,
			from: t.from as MissionState,
			to: t.to as MissionState,
			atMs: t.atMs as number,
			reason: typeof t.reason === "string" ? t.reason : undefined,
			executionId: typeof t.executionId === "string" ? t.executionId : undefined,
			attemptId: typeof t.attemptId === "string" ? t.attemptId : undefined,
		});
	}

	if (!Array.isArray(doc.attempts)) return invalid("attempts must be an array");
	const attempts: DurableExecutionAttempt[] = [];
	for (const entry of doc.attempts) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry))
			return invalid("attempt must be an object");
		const a = entry as Record<string, unknown>;
		if (typeof a.attemptId !== "string" || a.attemptId.length === 0)
			return invalid("attempt.attemptId must be a string");
		if (a.executionId !== undefined && (typeof a.executionId !== "string" || a.executionId.length === 0))
			return invalid("attempt.executionId must be a string when present");
		if (!isSafeInteger(a.startedAtMs)) return invalid("attempt.startedAtMs must be a safe integer");
		if (a.finishedAtMs !== undefined && !isSafeInteger(a.finishedAtMs))
			return invalid("attempt.finishedAtMs must be a safe integer");
		if (a.endReason !== undefined && !EXECUTION_END_REASONS.has(String(a.endReason))) {
			return invalid(`invalid attempt.endReason: ${String(a.endReason)}`);
		}
		let recovery: DurableExecutionAttempt["recovery"];
		if (a.recovery !== undefined) {
			if (typeof a.recovery !== "object" || a.recovery === null || Array.isArray(a.recovery)) {
				return invalid("attempt.recovery must be an object");
			}
			const rec = a.recovery as Record<string, unknown>;
			if (typeof rec.reason !== "string" || !isSafeInteger(rec.recoveredAtMs)) {
				return invalid("attempt.recovery must contain reason and recoveredAtMs");
			}
			recovery = { reason: rec.reason, recoveredAtMs: rec.recoveredAtMs as number };
		}
		attempts.push({
			attemptId: a.attemptId,
			executionId: a.executionId as string | undefined,
			startedAtMs: a.startedAtMs as number,
			finishedAtMs: a.finishedAtMs as number | undefined,
			endReason: a.endReason as DurableExecutionAttemptEndReason | undefined,
			recovery,
		});
	}

	// Current-attempt pointers: optional strings when present; a terminal record
	// must not carry a current attempt (ownership is always released on terminal).
	if (
		doc.currentAttemptId !== undefined &&
		(typeof doc.currentAttemptId !== "string" || doc.currentAttemptId.length === 0)
	)
		return invalid("currentAttemptId must be a string when present");
	if (
		doc.currentExecutionId !== undefined &&
		(typeof doc.currentExecutionId !== "string" || doc.currentExecutionId.length === 0)
	)
		return invalid("currentExecutionId must be a string when present");

	// Fencing epoch + lease. `fencingToken` defaults to 0 for records written
	// before ownership landed (backward compatible on load); when present it must
	// be a non-negative safe integer. A lease is optional and must be structurally
	// sound; it can never fabricate a newer fence than the record itself.
	const fencingToken = doc.fencingToken === undefined ? 0 : (doc.fencingToken as number);
	if (!isSafeInteger(fencingToken) || fencingToken < 0) return invalid("fencingToken must be a non-negative integer");

	let lease: ExecutionLease | undefined;
	if (doc.lease !== undefined) {
		if (typeof doc.lease !== "object" || doc.lease === null || Array.isArray(doc.lease)) {
			return invalid("lease must be an object");
		}
		const l = doc.lease as Record<string, unknown>;
		if (typeof l.ownerId !== "string" || l.ownerId.length === 0)
			return invalid("lease.ownerId must be a non-empty string");
		if (typeof l.leaseId !== "string" || l.leaseId.length === 0)
			return invalid("lease.leaseId must be a non-empty string");
		if (!isSafeInteger(l.fencingToken) || (l.fencingToken as number) < 0)
			return invalid("lease.fencingToken must be a non-negative integer");
		if (!isSafeInteger(l.acquiredAtMs) || !isSafeInteger(l.renewedAtMs) || !isSafeInteger(l.expiresAtMs))
			return invalid("lease timestamps must be safe integers");
		if ((l.renewedAtMs as number) < (l.acquiredAtMs as number))
			return invalid("lease.renewedAtMs must be >= acquiredAtMs");
		if ((l.expiresAtMs as number) < (l.renewedAtMs as number))
			return invalid("lease.expiresAtMs must be >= renewedAtMs");
		if ((l.fencingToken as number) !== fencingToken)
			return invalid("lease.fencingToken must equal record.fencingToken");
		lease = {
			ownerId: l.ownerId as string,
			leaseId: l.leaseId as string,
			fencingToken: l.fencingToken as number,
			acquiredAtMs: l.acquiredAtMs as number,
			renewedAtMs: l.renewedAtMs as number,
			expiresAtMs: l.expiresAtMs as number,
		};
	}

	// Terminal/result consistency: a terminal record must carry a matching
	// result; a non-terminal record must not carry a result. Terminal records
	// also must not carry a lease (ownership is always released on terminal).
	if (isTerminalMissionState(state)) {
		if (doc.currentAttemptId !== undefined || doc.currentExecutionId !== undefined) {
			return invalid("terminal record must not carry a current attempt");
		}
		if (lease !== undefined) {
			return invalid("terminal record must not carry an execution lease");
		}
		const resultError = validateResult(doc.result, missionId, state);
		if (resultError) return invalid(resultError);
		if (doc.resultExecutionId !== undefined && typeof doc.resultExecutionId !== "string") {
			return invalid("resultExecutionId must be a string when present");
		}
	} else if (doc.result !== undefined || doc.resultExecutionId !== undefined) {
		return invalid("non-terminal record must not carry a terminal result");
	}

	const record: DurableMissionRecord = {
		schemaVersion: DURABLE_MISSION_SCHEMA_VERSION,
		missionId,
		parentMissionId: doc.parentMissionId as string | undefined,
		depth: doc.depth as number,
		request,
		state,
		currentAttemptId: doc.currentAttemptId as string | undefined,
		currentExecutionId: doc.currentExecutionId as string | undefined,
		createdAtMs: doc.createdAtMs as number,
		updatedAtMs: doc.updatedAtMs as number,
		startedAtMs: doc.startedAtMs as number | undefined,
		finishedAtMs: doc.finishedAtMs as number | undefined,
		result: doc.result as MissionResult | undefined,
		resultExecutionId: doc.resultExecutionId as string | undefined,
		transitions,
		attempts,
		fencingToken,
		lease,
		revision: doc.revision as number,
	};

	return { ok: true, record };
}

// =============================================================================
// Record construction helper
// =============================================================================

export interface CreateDurableMissionRecordInput {
	request: MissionRequest;
	/** Now override for deterministic construction. */
	now?: number;
}

/**
 * Build an initial durable record at CREATED state with no execution attempt.
 * Validation is the caller's responsibility (use `validateMissionRequest`).
 */
export function createDurableMissionRecord(input: CreateDurableMissionRecordInput): DurableMissionRecord {
	const now = input.now ?? Date.now();
	const request = input.request;
	return {
		schemaVersion: DURABLE_MISSION_SCHEMA_VERSION,
		missionId: request.missionId,
		parentMissionId: request.parentMissionId,
		depth: request.depth,
		request,
		state: "CREATED",
		createdAtMs: request.createdAtMs,
		updatedAtMs: now,
		transitions: [],
		attempts: [],
		fencingToken: 0,
		revision: 1,
	};
}
