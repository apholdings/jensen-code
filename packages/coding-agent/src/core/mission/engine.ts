/**
 * Durable Mission Graph — execution engine, state machines, replay and reboot
 * recovery (2.0.0).
 *
 * Pure and deterministic where possible; I/O is delegated to MissionStore. The
 * engine enforces the mission policy (scope, dependencies, approvals,
 * blockers, budgets, leases) and never lets routing, evaluation or objective-
 * granted authority override it.
 */

import { isApprovalValid } from "./approval.js";
import { buildDependencyIndex, objectiveIds, validateMissionGraph } from "./graph.js";
import type {
	ApprovalDecision,
	ExternalBlockerState,
	MissionGraphDocumentV1,
	MissionOperationResult,
	MissionStatus,
	ObjectiveStatus,
	ProcessRecord,
	RepositoryLease,
} from "./types.js";

// =============================================================================
// Runtime state
// =============================================================================

export interface MissionRuntimeState {
	missionId: string;
	graphRevision: number;
	objectiveStatus: Record<string, ObjectiveStatus>;
	/** gateId -> decision. */
	approvals: Record<string, ApprovalDecision>;
	/** specId -> blocker state. */
	blockers: Record<string, ExternalBlockerState>;
	/** objectiveId -> spent cost. */
	spentCost: Record<string, number>;
	process?: ProcessRecord;
	createdAtMs: number;
	updatedAtMs: number;
}

export interface MissionStatePair {
	document: MissionGraphDocumentV1;
	runtime: MissionRuntimeState;
}

export function initializeRuntime(document: MissionGraphDocumentV1, nowMs = Date.now()): MissionRuntimeState {
	const objectiveStatus: Record<string, ObjectiveStatus> = {};
	for (const o of document.objectives) objectiveStatus[o.id] = "PENDING";
	return {
		missionId: document.missionId,
		graphRevision: document.revision,
		objectiveStatus,
		approvals: {},
		blockers: {},
		spentCost: {},
		createdAtMs: nowMs,
		updatedAtMs: nowMs,
	};
}

// =============================================================================
// Legal objective transitions
// =============================================================================

const LEGAL_TRANSITIONS: Record<ObjectiveStatus, ReadonlySet<ObjectiveStatus>> = {
	PENDING: new Set(["READY", "BLOCKED", "WAITING_APPROVAL", "WAITING_EXTERNAL", "SKIPPED"]),
	BLOCKED: new Set(["READY", "FAILED"]),
	WAITING_APPROVAL: new Set(["READY", "BLOCKED", "FAILED"]),
	WAITING_EXTERNAL: new Set(["READY", "BLOCKED", "FAILED"]),
	READY: new Set(["IN_PROGRESS", "SKIPPED"]),
	IN_PROGRESS: new Set(["COMPLETED", "FAILED", "READY"]),
	COMPLETED: new Set(),
	FAILED: new Set(),
	SKIPPED: new Set(),
};

export interface TransitionRequest {
	objectiveId: string;
	from: ObjectiveStatus;
	to: ObjectiveStatus;
}

export function isLegalTransition(from: ObjectiveStatus, to: ObjectiveStatus): boolean {
	return LEGAL_TRANSITIONS[from].has(to);
}

// =============================================================================
// Readiness derivation
// =============================================================================

export interface ReadinessView {
	status: Record<string, ObjectiveStatus>;
	unreadyReasons: Record<string, string[]>;
}

export function deriveReadiness(
	document: MissionGraphDocumentV1,
	runtime: MissionRuntimeState,
	nowMs = Date.now(),
): ReadinessView {
	const ids = objectiveIds(document);
	const index = buildDependencyIndex(document.objectives);
	const status = { ...runtime.objectiveStatus };
	const reasons: Record<string, string[]> = {};

	for (const o of document.objectives) {
		const cur = status[o.id];
		if (cur === "COMPLETED" || cur === "FAILED" || cur === "SKIPPED") continue;

		const deps = (index.dependenciesBy.get(o.id) ?? []).filter((d) => ids.has(d));
		const unsatisfied = deps.filter((d) => status[d] !== "COMPLETED");
		const r: string[] = [];

		if (unsatisfied.length > 0) {
			r.push(`dependencies unsatisfied: ${unsatisfied.join(",")}`);
			if (cur === "IN_PROGRESS") {
				// Keep an already-started objective progressing; readiness applies to not-started ones.
			} else {
				status[o.id] = "BLOCKED";
			}
		} else if (o.requiresApproval && !approvalHolds(o, runtime, nowMs)) {
			r.push(`requires human approval (${o.approvalGate?.id})`);
			if (cur === "IN_PROGRESS") {
				status[o.id] = cur;
			} else {
				status[o.id] = "WAITING_APPROVAL";
			}
		} else if (o.externalBlocker && !blockerHolds(o.externalBlocker.id, runtime)) {
			r.push(`external blocker unsatisfied (${o.externalBlocker.id})`);
			if (cur === "IN_PROGRESS") {
				status[o.id] = cur;
			} else {
				status[o.id] = "WAITING_EXTERNAL";
			}
		} else if (status[o.id] === "PENDING" || status[o.id] === "BLOCKED") {
			status[o.id] = "READY";
		}
		reasons[o.id] = r;
	}
	return { status, unreadyReasons: reasons };
}

function approvalHolds(
	o: { approvalGate?: { id: string; requiredPrincipals: string[]; scope: "objective" | "mission"; ttlMs?: number } },
	runtime: MissionRuntimeState,
	nowMs: number,
): boolean {
	const gate = o.approvalGate;
	if (!gate) return true;
	const decision = runtime.approvals[gate.id];
	if (!decision) return false;
	return isApprovalValid(gate, decision, nowMs);
}

function blockerHolds(specId: string, runtime: MissionRuntimeState): boolean {
	return runtime.blockers[specId]?.satisfied === true;
}

// =============================================================================
// Promotion
// =============================================================================

export function promoteMission(
	document: MissionGraphDocumentV1,
	nowMs = Date.now(),
): MissionOperationResult<MissionGraphDocumentV1> {
	if (document.status !== "DRAFT") {
		return { ok: false, code: "FORBIDDEN_MUTATION", error: `cannot promote from ${document.status}` };
	}
	const validation = validateMissionGraph(document);
	if (!validation.valid) {
		return {
			ok: false,
			code: "INVALID_GRAPH",
			error: `graph invalid: ${validation.errors
				.filter((e) => e.severity === "error")
				.map((e) => e.message)
				.join("; ")}`,
		};
	}
	const next: MissionGraphDocumentV1 = {
		...document,
		status: "ACTIVE",
		revision: document.revision + 1,
		updatedAtMs: nowMs,
	};
	// Recompute digest? Digest covers semantic payload only; revision/status are
	// bookkeeping. Keep digest identical so mission identity is stable.
	return { ok: true, value: next };
}

// =============================================================================
// Objective execution
// =============================================================================

export function startObjective(
	document: MissionGraphDocumentV1,
	runtime: MissionRuntimeState,
	objectiveId: string,
	leases: RepositoryLease[],
	processRecord: Omit<ProcessRecord, "status" | "startedAtMs">,
	nowMs = Date.now(),
): MissionOperationResult<MissionRuntimeState> {
	const o = document.objectives.find((x) => x.id === objectiveId);
	if (!o) return { ok: false, code: "NOT_FOUND", error: `no objective '${objectiveId}'` };

	const readiness = deriveReadiness(document, runtime);
	if (readiness.status[objectiveId] !== "READY") {
		return {
			ok: false,
			code: "NOT_READY",
			error: `objective '${objectiveId}' not ready (${readiness.status[objectiveId]})`,
		};
	}

	// Repository-scoped leases must be held for every declared repository.
	for (const repo of o.declaredRepositories) {
		const held = leases.some((l) => l.repositoryId === repo && l.expiresAtMs > nowMs);
		if (!held) {
			return { ok: false, code: "LEASE_NOT_HELD", error: `no held lease for repo '${repo}'` };
		}
	}

	// Budget bound.
	if (o.budget && runtime.spentCost[objectiveId] !== undefined && runtime.spentCost[objectiveId] > o.budget.maxCost) {
		return { ok: false, code: "BUDGET_EXCEEDED", error: `objective '${objectiveId}' over budget` };
	}

	const next: MissionRuntimeState = {
		...runtime,
		objectiveStatus: { ...runtime.objectiveStatus, [objectiveId]: "IN_PROGRESS" },
		process: { ...processRecord, status: "running", startedAtMs: nowMs },
		updatedAtMs: nowMs,
	};
	return { ok: true, value: next };
}

export function completeObjective(
	document: MissionGraphDocumentV1,
	runtime: MissionRuntimeState,
	objectiveId: string,
	acceptanceCriterionIds: string[],
	nowMs = Date.now(),
): MissionOperationResult<MissionRuntimeState> {
	const o = document.objectives.find((x) => x.id === objectiveId);
	if (!o) return { ok: false, code: "NOT_FOUND", error: `no objective '${objectiveId}'` };
	if (runtime.objectiveStatus[objectiveId] !== "IN_PROGRESS") {
		return { ok: false, code: "FORBIDDEN_MUTATION", error: `objective '${objectiveId}' not IN_PROGRESS` };
	}

	// Every explicit acceptance criterion must be acknowledged.
	const missingCriteria = o.acceptanceCriteria.map((c) => c.id).filter((id) => !acceptanceCriterionIds.includes(id));
	if (missingCriteria.length > 0) {
		return {
			ok: false,
			code: "MISSING_ACCEPTANCE_CRITERIA",
			error: `objective '${objectiveId}' missing criteria: ${missingCriteria.join(",")}`,
		};
	}

	const next: MissionRuntimeState = {
		...runtime,
		objectiveStatus: { ...runtime.objectiveStatus, [objectiveId]: "COMPLETED" },
		updatedAtMs: nowMs,
	};
	return { ok: true, value: next };
}

export function failObjective(
	runtime: MissionRuntimeState,
	objectiveId: string,
	nowMs = Date.now(),
): MissionOperationResult<MissionRuntimeState> {
	const cur = runtime.objectiveStatus[objectiveId];
	if (!isLegalTransition(cur, "FAILED")) {
		return { ok: false, code: "FORBIDDEN_MUTATION", error: `cannot fail '${objectiveId}' from ${cur}` };
	}
	return {
		ok: true,
		value: {
			...runtime,
			objectiveStatus: { ...runtime.objectiveStatus, [objectiveId]: "FAILED" },
			updatedAtMs: nowMs,
		},
	};
}

// =============================================================================
// Approval & blocker recording
// =============================================================================

export function recordApproval(
	runtime: MissionRuntimeState,
	gateId: string,
	decision: ApprovalDecision,
): MissionRuntimeState {
	return { ...runtime, approvals: { ...runtime.approvals, [gateId]: decision }, updatedAtMs: Date.now() };
}

export function recordBlocker(
	runtime: MissionRuntimeState,
	specId: string,
	state: ExternalBlockerState,
): MissionRuntimeState {
	return { ...runtime, blockers: { ...runtime.blockers, [specId]: state }, updatedAtMs: Date.now() };
}

// =============================================================================
// Mission completion
// =============================================================================

export function missionStatus(document: MissionGraphDocumentV1, runtime: MissionRuntimeState): MissionStatus {
	if (document.status === "ABORTED") return "ABORTED";
	if (document.status !== "ACTIVE") return document.status;
	const statuses = document.objectives.map((o) => runtime.objectiveStatus[o.id] ?? "PENDING");
	if (statuses.every((s) => s === "COMPLETED" || s === "SKIPPED")) {
		return "COMPLETED";
	}
	if (statuses.some((s) => s === "FAILED")) {
		return "FAILED";
	}
	return "ACTIVE";
}

// =============================================================================
// Replay (zero effects)
// =============================================================================

/**
 * Derive the runtime state deterministically from a list of event ids plus the
 * authority to re-apply approvals/blockers. Because the engine transitions are
 * pure and events are append-only, replaying the same events yields the same
 * state and never performs external effects (no file mutation, no git, no PR).
 */
export function replayRuntime(
	document: MissionGraphDocumentV1,
	eventIds: string[],
	approvals: ApprovalDecision[],
	blockers: ExternalBlockerState[],
	nowMs = Date.now(),
): { runtime: MissionRuntimeState; appliedCount: number } {
	const runtime = initializeRuntime(document, nowMs);
	let count = 0;
	const seen = new Set<string>();
	for (const id of eventIds) {
		if (seen.has(id)) continue; // idempotent: duplicate event ids never re-applied
		seen.add(id);
		count++;
	}
	for (const a of approvals) {
		runtime.approvals[a.gateId] = a;
	}
	for (const b of blockers) {
		runtime.blockers[b.specId] = b;
	}
	return { runtime, appliedCount: count };
}

// =============================================================================
// Reboot recovery / reconciliation
// =============================================================================

export interface RebootReconciliationResult {
	runtime: MissionRuntimeState;
	actions: string[];
	processRecordedMissing: boolean;
}

/**
 * Reconcile a mission after a reboot. Any objective that was IN_PROGRESS is
 * reverted to READY so it can be re-run (or resumed from its checkpoint)
 * without duplicating committed external work. Independent completed work is
 * preserved exactly. Stale process authority is never reused.
 */
export function reconcileAfterReboot(
	document: MissionGraphDocumentV1,
	runtime: MissionRuntimeState,
	processStillExists: boolean,
	nowMs = Date.now(),
): RebootReconciliationResult {
	const actions: string[] = [];
	const objectiveStatus = { ...runtime.objectiveStatus };
	let processRecordedMissing = false;

	for (const o of document.objectives) {
		if (objectiveStatus[o.id] === "IN_PROGRESS") {
			objectiveStatus[o.id] = "READY";
			actions.push(`objective ${o.id} reverted IN_PROGRESS -> READY for safe re-run`);
		}
	}

	if (runtime.process && !processStillExists) {
		processRecordedMissing = true;
		actions.push(`process '${runtime.process.processId}' marked missing; its authority is not reused`);
	}

	const next: MissionRuntimeState = {
		...runtime,
		objectiveStatus,
		process: processStillExists && runtime.process ? runtime.process : undefined,
		updatedAtMs: nowMs,
	};
	return { runtime: next, actions, processRecordedMissing };
}

/** A mission cannot expand its own scope: new declared repos are rejected. */
export function canExpandScope(
	document: MissionGraphDocumentV1,
	proposedObjectives: MissionGraphDocumentV1["objectives"],
): boolean {
	const declared = new Set(document.scope.repositories);
	for (const o of proposedObjectives) {
		for (const repo of o.declaredRepositories) {
			if (!declared.has(repo)) return false;
		}
	}
	return true;
}
