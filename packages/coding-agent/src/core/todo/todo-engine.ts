/**
 * Durable TODO coordination engine.
 *
 * The TODO subsystem is a coordination and progress-reporting facility. It is
 * NOT execution authority. This engine provides:
 *
 * - optimistic concurrency with a monotonically increasing revision;
 * - deterministic state hashing;
 * - internal bounded stale-revision read/rebase/retry;
 * - idempotent mutation intents;
 * - typed error taxonomy;
 * - progress-aware loop detection;
 * - a bounded, sanitized event log for operability and replay.
 *
 * It deliberately does not introduce a second TODO authority: it coordinates
 * around a single set of items/revision owned by the session.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Canonical status set. Tool surfaces expose the subset pending/in_progress/completed. */
export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled" | "blocked";

/** The runtime status stored on items (compatible with the existing session TodoItem). */
export type TodoItemStatus = "pending" | "in_progress" | "completed";

/** Item as stored/coordinated by the engine. Structurally compatible with the session TodoItem. */
export interface TodoItem {
	id?: string;
	content: string;
	activeForm: string;
	status: TodoItemStatus;
	version?: number;
	createdAt?: number;
	updatedAt?: number;
	completedAt?: number;
	ownerRunId?: string;
	ownerAgentId?: string;
}

/** Patch-style operation for todo_update. */
export interface TodoPatchOp {
	id: string;
	status?: TodoItemStatus;
	activeForm?: string;
	content?: string;
}

/** A fully-typed mutation intent. */
export interface TodoMutationIntent {
	intentId: string;
	idempotencyKey: string;
	scopeId: string;
	baseRevision: number;
	requestedBy: { toolCallId: string };
	operations: TodoPatchOp[];
	kind: "patch" | "replace_all";
	replaceItems?: TodoItem[];
	replaceStateHash?: string;
}

/** Typed recovery action for a TODO error. */
export type TodoRecoveryAction =
	| "internal_read_and_rebase"
	| "return_current_snapshot"
	| "manual_reconciliation"
	| "disable_todo_for_turn"
	| "none";

/** Typed TODO mutation error. */
export interface TodoMutationErrorInput {
	code:
		| "TODO_REVISION_STALE"
		| "TODO_REBASE_REQUIRED"
		| "TODO_REBASE_CONFLICT"
		| "TODO_ITEM_NOT_FOUND"
		| "TODO_ITEM_VERSION_CONFLICT"
		| "TODO_INVALID_STATUS_TRANSITION"
		| "TODO_DUPLICATE_INTENT"
		| "TODO_ALREADY_APPLIED"
		| "TODO_STATE_CORRUPT"
		| "TODO_SCOPE_MISMATCH"
		| "TODO_PERMISSION_DENIED"
		| "TODO_NO_PROGRESS_LOOP"
		| "TODO_TOOL_TEMPORARILY_DEGRADED";
	requestedRevision?: number;
	currentRevision?: number;
	intentId?: string;
	conflictItemIds?: string[];
	message?: string;
}

export interface TodoMutationError {
	code: TodoMutationErrorInput["code"];
	recoverable: boolean;
	runMustContinue: boolean;
	requestedRevision?: number;
	currentRevision?: number;
	intentId?: string;
	conflictItemIds?: string[];
	recoveryAction?: TodoRecoveryAction;
	message?: string;
}

export interface TodoRebaseResult {
	status: "not_needed" | "rebased" | "already_applied" | "conflict";
	originalRevision: number;
	currentRevision: number;
	appliedRevision?: number;
	preservedConcurrentChanges: string[];
	conflictItemIds: string[];
	reasonCodes: string[];
}

export interface TodoFailureFingerprint {
	scopeId: string;
	errorCode: string;
	intentHash: string;
	requestedRevision?: number;
	currentRevision?: number;
	conflictItemIds?: string[];
}

export type TodoEventType =
	| "TODO_STATE_READ"
	| "TODO_MUTATION_INTENT_CREATED"
	| "TODO_MUTATION_APPLY_STARTED"
	| "TODO_REVISION_STALE_DETECTED"
	| "TODO_INTERNAL_READ_COMPLETED"
	| "TODO_REBASE_STARTED"
	| "TODO_REBASE_SUCCEEDED"
	| "TODO_REBASE_CONFLICT"
	| "TODO_INTENT_ALREADY_APPLIED"
	| "TODO_MUTATION_COMMITTED"
	| "TODO_MUTATION_REJECTED"
	| "TODO_LOOP_CHAIN_STARTED"
	| "TODO_LOOP_CHAIN_RESET_BY_PROGRESS"
	| "TODO_NO_PROGRESS_LOOP_DETECTED"
	| "TODO_TOOL_DEGRADED"
	| "TODO_PROJECTION_DRIFT_DETECTED"
	| "TODO_PROJECTION_RECONCILED";

export interface TodoEvent {
	type: TodoEventType;
	at: number;
	revision?: number;
	intentId?: string;
	requestedRevision?: number;
	currentRevision?: number;
	conflictItemIds?: string[];
	recoveryAction?: TodoRecoveryAction;
}

export interface TodoEngineState {
	currentRevision: number;
	progressEpoch: number;
	lastTodoReadRevision: number;
	snapshots: Array<{ revision: number; items: TodoItem[] }>;
	ledger: Array<{ idempotencyKey: string; applicationRevision: number; applied: boolean }>;
	events: TodoEvent[];
	chain: { fingerprint: TodoFailureFingerprint; consecutive: number; lastAt: number } | null;
}

export interface TodoEnginePersistence {
	load: () => TodoEngineState | undefined;
	save: (state: TodoEngineState) => void;
}

// ---------------------------------------------------------------------------
// Limits / bounds
// ---------------------------------------------------------------------------

export interface TodoEngineLimits {
	/** Retained snapshot history (for rebase base lookup). */
	maxSnapshots: number;
	/** Bounded idempotency ledger entries. */
	maxLedger: number;
	/** Bounded event log length. */
	maxEvents: number;
	/** Maximum internal rebase attempts per tool call. */
	maxInternalRebaseAttempts: number;
	/** Bounded excessive-failure threshold for a single chain. */
	maxNoProgressFailures: number;
}

export const DEFAULT_TODO_ENGINE_LIMITS: TodoEngineLimits = {
	maxSnapshots: 16,
	maxLedger: 256,
	maxEvents: 512,
	maxInternalRebaseAttempts: 1,
	maxNoProgressFailures: 3,
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function stableItemKey(items: TodoItem[]): string {
	return JSON.stringify(
		[...items]
			.sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""))
			.map((t) => ({
				id: t.id ?? "",
				content: t.content,
				activeForm: t.activeForm,
				status: t.status,
			})),
	);
}

/** Deterministic state hash of a set of items. */
export function computeStateHash(items: TodoItem[]): string {
	return createHash("sha256").update(stableItemKey(items)).digest("hex");
}

/** Allowed transitions from a status. */
export function allowedTransitions(from: TodoStatus): ReadonlySet<TodoStatus> {
	switch (from) {
		case "pending":
			return new Set(["pending", "in_progress", "completed", "cancelled", "blocked"]);
		case "in_progress":
			return new Set(["in_progress", "pending", "completed", "blocked", "cancelled"]);
		case "blocked":
			return new Set(["blocked", "pending", "in_progress", "cancelled"]);
		case "completed":
			return new Set(["completed"]);
		case "cancelled":
			return new Set(["cancelled"]);
		default:
			return new Set([from]);
	}
}

/**
 * Validate a single status transition.
 * Repeating the current status is idempotent (allowed).
 */
export function validateTransition(from: TodoStatus, to: TodoStatus): { ok: boolean; reason?: string } {
	if (from === to) return { ok: true };
	if (allowedTransitions(from).has(to)) return { ok: true };
	return {
		ok: false,
		reason: `cannot transition ${from} -> ${to} (${from} is terminal)`,
	};
}

// ---------------------------------------------------------------------------
// Failure fingerprint
// ---------------------------------------------------------------------------

export function fingerprintError(
	fp: Omit<TodoFailureFingerprint, "intentHash"> & { intentHash?: string },
): TodoFailureFingerprint {
	return {
		scopeId: fp.scopeId,
		errorCode: fp.errorCode,
		intentHash: fp.intentHash ?? "",
		requestedRevision: fp.requestedRevision,
		currentRevision: fp.currentRevision,
		conflictItemIds: fp.conflictItemIds,
	};
}

// ---------------------------------------------------------------------------
// Loop detection chain
// ---------------------------------------------------------------------------

interface FailureChain {
	fingerprint: TodoFailureFingerprint;
	consecutive: number;
	lastAt: number;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class TodoEngine {
	readonly scopeId: string;
	readonly limits: TodoEngineLimits;

	private snapshots = new Map<number, TodoItem[]>();
	private lastTodoReadRevision = -1;
	private ledger = new Map<string, { applicationRevision: number; applied: boolean }>();
	private events: TodoEvent[] = [];
	private chain: FailureChain | null = null;
	private progressEpoch = 0;
	private currentRevision = 0;
	private readonly persistence?: TodoEnginePersistence;

	constructor(
		scopeId: string,
		limits: Partial<TodoEngineLimits> = {},
		private readonly now: () => number = Date.now,
		persistence?: TodoEnginePersistence,
	) {
		this.scopeId = scopeId;
		this.limits = { ...DEFAULT_TODO_ENGINE_LIMITS, ...limits };
		this.persistence = persistence;
		this.restore(persistence?.load());
	}

	private restore(state: TodoEngineState | undefined): void {
		if (!state) return;
		this.currentRevision = state.currentRevision;
		this.progressEpoch = state.progressEpoch;
		this.lastTodoReadRevision = state.lastTodoReadRevision;
		for (const snapshot of state.snapshots.slice(-this.limits.maxSnapshots)) {
			this.snapshots.set(
				snapshot.revision,
				snapshot.items.map((item) => ({ ...item })),
			);
		}
		for (const entry of state.ledger.slice(-this.limits.maxLedger)) {
			this.ledger.set(entry.idempotencyKey, {
				applicationRevision: entry.applicationRevision,
				applied: entry.applied,
			});
		}
		this.events = state.events.slice(-this.limits.maxEvents).map((event) => ({ ...event }));
		this.chain = state.chain ? { ...state.chain, fingerprint: { ...state.chain.fingerprint } } : null;
	}

	private persist(): void {
		this.persistence?.save({
			currentRevision: this.currentRevision,
			progressEpoch: this.progressEpoch,
			lastTodoReadRevision: this.lastTodoReadRevision,
			snapshots: [...this.snapshots.entries()].map(([revision, items]) => ({
				revision,
				items: items.map((item) => ({ ...item })),
			})),
			ledger: [...this.ledger.entries()].map(([idempotencyKey, value]) => ({ idempotencyKey, ...value })),
			events: this.events.map((event) => ({ ...event })),
			chain: this.chain ? { ...this.chain, fingerprint: { ...this.chain.fingerprint } } : null,
		});
	}

	// -- progress epoch ------------------------------------------------------

	/** Record authoritative non-TODO progress; breaks any failure chain. */
	recordProgress(): void {
		this.progressEpoch++;
		if (this.chain) {
			this.emit("TODO_LOOP_CHAIN_RESET_BY_PROGRESS");
			this.chain = null;
		}
		this.persist();
	}

	/**
	 * Record a todo read. Only counts as progress if the read returned a
	 * newer revision than the last observed revision (identical reads do not
	 * reset the chain).
	 */
	recordTodoRead(revision: number): void {
		if (revision > this.lastTodoReadRevision) {
			this.lastTodoReadRevision = revision;
			this.currentRevision = Math.max(this.currentRevision, revision);
			this.recordProgress();
		}
	}

	getProgressEpoch(): number {
		return this.progressEpoch;
	}

	// -- snapshot history ----------------------------------------------------

	recordReadSnapshot(revision: number, items: TodoItem[]): void {
		this.currentRevision = Math.max(this.currentRevision, revision);
		if (this.snapshots.size >= this.limits.maxSnapshots) {
			const oldest = [...this.snapshots.keys()].sort((a, b) => a - b)[0];
			if (oldest !== undefined) this.snapshots.delete(oldest);
		}
		this.snapshots.set(
			revision,
			items.map((t) => ({ ...t })),
		);
		this.persist();
	}

	recordState(revision: number, items: TodoItem[]): void {
		this.currentRevision = revision;
		this.recordReadSnapshot(revision, items);
	}

	getCurrentRevision(): number {
		return this.currentRevision;
	}

	private getSnapshot(revision: number): TodoItem[] | undefined {
		return this.snapshots.get(revision)?.map((t) => ({ ...t }));
	}

	// -- idempotency ---------------------------------------------------------

	/**
	 * Look up a previously applied intent by idempotency key.
	 * Returns true if the exact key was already applied.
	 */
	lookupApplied(idempotencyKey: string): boolean {
		return this.ledger.get(idempotencyKey)?.applied === true;
	}

	recordApplied(idempotencyKey: string, applicationRevision: number): void {
		if (this.ledger.size >= this.limits.maxLedger) {
			const oldest = this.ledger.keys().next().value;
			if (oldest !== undefined) this.ledger.delete(oldest as string);
		}
		this.ledger.set(idempotencyKey, { applicationRevision, applied: true });
		this.currentRevision = Math.max(this.currentRevision, applicationRevision);
		this.persist();
	}

	// -- events --------------------------------------------------------------

	emit(event: Omit<TodoEvent, "at"> | TodoEventType): void {
		const resolved: Omit<TodoEvent, "at"> = typeof event === "string" ? { type: event } : event;
		this.events.push({ ...resolved, at: this.now() });
		if (this.events.length > this.limits.maxEvents) {
			this.events = this.events.slice(-this.limits.maxEvents);
		}
		this.persist();
	}

	getEvents(limit = 50): TodoEvent[] {
		return this.events.slice(-limit).map((e) => ({ ...e }));
	}

	// -- loop detection ------------------------------------------------------

	/**
	 * Register a failure and return whether the chain should be treated as a
	 * genuine no-progress loop (model-requested, consecutive, same fingerprint).
	 */
	registerFailure(fp: TodoFailureFingerprint): { blocked: boolean; consecutive: number } {
		if (this.chain && this.sameFingerprint(this.chain.fingerprint, fp)) {
			this.chain.consecutive++;
			this.chain.lastAt = this.now();
		} else {
			this.chain = {
				fingerprint: { ...fp },
				consecutive: 1,
				lastAt: this.now(),
			};
			this.emit({
				type: "TODO_LOOP_CHAIN_STARTED",
				intentId: fp.intentHash,
				currentRevision: fp.currentRevision,
			});
		}

		const blocked = this.chain.consecutive >= this.limits.maxNoProgressFailures;
		if (blocked) {
			this.emit({
				type: "TODO_NO_PROGRESS_LOOP_DETECTED",
				currentRevision: fp.currentRevision,
				requestedRevision: fp.requestedRevision,
				intentId: fp.intentHash,
			});
		}
		this.persist();
		return { blocked, consecutive: this.chain.consecutive };
	}

	/** Reset the failure chain (self-healing path, e.g. internal rebase success). */
	resetFailureChain(): void {
		if (this.chain) {
			this.emit("TODO_LOOP_CHAIN_RESET_BY_PROGRESS");
			this.chain = null;
			this.persist();
		}
	}

	private sameFingerprint(a: TodoFailureFingerprint, b: TodoFailureFingerprint): boolean {
		return (
			a.scopeId === b.scopeId &&
			a.errorCode === b.errorCode &&
			a.intentHash === b.intentHash &&
			a.requestedRevision === b.requestedRevision &&
			a.currentRevision === b.currentRevision &&
			JSON.stringify(a.conflictItemIds ?? []) === JSON.stringify(b.conflictItemIds ?? [])
		);
	}

	isBlocked(): boolean {
		return this.chain !== null && this.chain.consecutive >= this.limits.maxNoProgressFailures;
	}

	// -- rebase --------------------------------------------------------------

	/**
	 * Deterministic, operation-aware rebase of a patch intent against the
	 * current state. Uses the retained base snapshot when available to avoid
	 * clobbering concurrent edits; otherwise applies conservative rules.
	 */
	rebase(
		baseRevision: number,
		currentRevision: number,
		currentItems: TodoItem[],
		ops: TodoPatchOp[],
	): TodoRebaseResult {
		const base = this.getSnapshot(baseRevision);
		const preserved: string[] = [];
		const conflicts: string[] = [];
		const reasons: string[] = [];
		const byId = new Map<string, TodoItem>();
		for (const item of currentItems) {
			if (item.id) byId.set(item.id, item);
		}
		const baseById = new Map<string, TodoItem>();
		for (const item of base ?? []) {
			if (item.id) baseById.set(item.id, item);
		}

		for (const op of ops) {
			const current = byId.get(op.id);
			if (!current) {
				conflicts.push(op.id);
				reasons.push("TODO_ITEM_NOT_FOUND");
				continue;
			}
			// Status
			if (op.status !== undefined) {
				if (current.status === op.status) {
					// repeated transition -> idempotent
					continue;
				}
				const baseItem = baseById.get(op.id);
				const baseStatus = baseItem?.status;
				// If the status field was not concurrently changed (base == current
				// for that field) we can safely apply the transition; otherwise the
				// item was concurrently moved and we treat it as a conflict.
				if (baseStatus !== undefined && baseStatus !== current.status && baseStatus !== op.status) {
					conflicts.push(op.id);
					reasons.push("TODO_ITEM_VERSION_CONFLICT");
					continue;
				}
				const allowed = validateTransition(current.status, op.status);
				if (!allowed.ok) {
					conflicts.push(op.id);
					reasons.push(allowed.reason ?? "TODO_INVALID_STATUS_TRANSITION");
					continue;
				}
				if (baseStatus === undefined && current.status !== op.status) {
					// No base: apply only if current unchanged since it's the only writer
					// path. Conservative: allow forward transitions.
				}
			}
			// Content
			if (op.content !== undefined) {
				if (current.content === op.content) {
					continue; // already applied
				}
				const baseItem = baseById.get(op.id);
				const baseContent = baseItem?.content;
				if (baseContent !== undefined && baseContent === current.content) {
					// content unchanged by any concurrent writer -> model may set it
					preserved.push(op.id);
				} else if (baseContent !== undefined && baseContent !== current.content) {
					// content was edited concurrently -> conflict
					conflicts.push(op.id);
					reasons.push("TODO_ITEM_VERSION_CONFLICT");
					continue;
				} else {
					// No base: conservative conflict for content edits we cannot verify
					conflicts.push(op.id);
					reasons.push("TODO_REBASE_CONFLICT");
					continue;
				}
			}
			// activeForm: applies unless concurrently changed on the same item
			if (op.activeForm !== undefined && op.activeForm !== current.activeForm) {
				const baseItem = baseById.get(op.id);
				const baseActive = baseItem?.activeForm;
				if (baseActive !== undefined && baseActive !== current.activeForm && baseActive !== op.activeForm) {
					conflicts.push(op.id);
					reasons.push("TODO_ITEM_VERSION_CONFLICT");
					continue;
				}
				preserved.push(op.id);
			}
		}

		if (conflicts.length > 0) {
			return {
				status: "conflict",
				originalRevision: baseRevision,
				currentRevision,
				preservedConcurrentChanges: preserved,
				conflictItemIds: conflicts,
				reasonCodes: reasons,
			};
		}

		const hasActualChange = ops.some((op) => {
			const cur = byId.get(op.id);
			if (!cur) return false;
			if (op.status !== undefined && op.status !== cur.status) return true;
			if (op.activeForm !== undefined && op.activeForm !== cur.activeForm) return true;
			if (op.content !== undefined && op.content !== cur.content) return true;
			return false;
		});

		return {
			status: hasActualChange ? "rebased" : "already_applied",
			originalRevision: baseRevision,
			currentRevision,
			appliedRevision: currentRevision + (hasActualChange ? 1 : 0),
			preservedConcurrentChanges: preserved,
			conflictItemIds: [],
			reasonCodes: [],
		};
	}

	// -- typed errors --------------------------------------------------------

	typedError(input: TodoMutationErrorInput): TodoMutationError {
		return {
			code: input.code,
			recoverable: codeRecoverable(input.code),
			runMustContinue: true,
			requestedRevision: input.requestedRevision,
			currentRevision: input.currentRevision,
			intentId: input.intentId,
			conflictItemIds: input.conflictItemIds,
			recoveryAction: recoveryFor(input),
			message: input.message,
		};
	}

	getDiagnostics() {
		return {
			scopeId: this.scopeId,
			progressEpoch: this.progressEpoch,
			lastTodoReadRevision: this.lastTodoReadRevision,
			snapshotCount: this.snapshots.size,
			ledgerCount: this.ledger.size,
			eventCount: this.events.length,
			chainActive: this.chain !== null,
			chainConsecutive: this.chain?.consecutive ?? 0,
			isLoopBlocked: this.isBlocked(),
		};
	}
}

function codeRecoverable(code: TodoMutationErrorInput["code"]): boolean {
	switch (code) {
		case "TODO_STATE_CORRUPT":
			return false;
		default:
			return true;
	}
}

function recoveryFor(input: TodoMutationErrorInput): TodoRecoveryAction {
	switch (input.code) {
		case "TODO_REVISION_STALE":
			return "internal_read_and_rebase";
		case "TODO_REBASE_CONFLICT":
		case "TODO_ITEM_NOT_FOUND":
		case "TODO_ITEM_VERSION_CONFLICT":
		case "TODO_SCOPE_MISMATCH":
			return "return_current_snapshot";
		case "TODO_INVALID_STATUS_TRANSITION":
			return "return_current_snapshot";
		case "TODO_ALREADY_APPLIED":
			return "none";
		case "TODO_NO_PROGRESS_LOOP":
		case "TODO_TOOL_TEMPORARILY_DEGRADED":
			return "disable_todo_for_turn";
		default:
			return "none";
	}
}

/** Derive a stable intent hash from the operations for fingerprinting. */
export function hashIntent(ops: TodoPatchOp[]): string {
	return createHash("sha256")
		.update(JSON.stringify(ops.map((o) => ({ id: o.id, s: o.status, a: o.activeForm, c: o.content }))))
		.digest("hex");
}

/** Generate a bounded, non-secret intent id. */
export function generateIntentId(seed: string, now: number): string {
	return createHash("sha256").update(`${seed}|${now}`).digest("hex").slice(0, 16);
}
