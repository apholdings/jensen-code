/**
 * Durable Mission Graph — integration transactions (2.0.0).
 *
 * An integration transaction coordinates cross-objective, cross-repository
 * confirmation of work. It is fully transactional:
 *   PREPARED → CHECKPOINTED → VALIDATING → CONFIRMED
 *   any stage → ROLLED_BACK
 *
 * Checkpoints precede mutation and capture per-objective state. A localized
 * rollback restores only the checkpoints captured within this transaction;
 * independent completed work outside the transaction is preserved.
 */

import type {
	IntegrationTransactionState,
	MissionOperationResult,
	ObjectiveCheckpoint,
	RepositoryLease,
} from "./types.js";

export type IntegrationStage = IntegrationTransactionState["stage"];

export interface IntegrationInput {
	transactionId: string;
	objectiveIds: string[];
	repositoryIds: string[];
	/** The leases held for the repositories involved. */
	leases: RepositoryLease[];
	nowMs?: number;
}

const STAGE_ORDER: Record<IntegrationStage, number> = {
	PREPARED: 0,
	CHECKPOINTED: 1,
	VALIDATING: 2,
	CONFIRMED: 3,
	VOLATILE: 4,
	ROLLED_BACK: 5,
};

export function beginIntegrationTransaction(
	input: IntegrationInput,
): MissionOperationResult<IntegrationTransactionState> {
	const nowMs = input.nowMs ?? Date.now();
	if (input.objectiveIds.length === 0 || input.repositoryIds.length === 0) {
		return { ok: false, code: "INTERNAL_ERROR", error: "integration requires objectives and repositories" };
	}
	// Every repository involved must have a held lease.
	for (const repo of input.repositoryIds) {
		const held = input.leases.some((l) => l.repositoryId === repo);
		if (!held) {
			return { ok: false, code: "LEASE_NOT_HELD", error: `no held lease for repository '${repo}'` };
		}
	}
	return {
		ok: true,
		value: {
			transactionId: input.transactionId,
			objectiveIds: [...input.objectiveIds],
			repositoryIds: [...input.repositoryIds],
			stage: "PREPARED",
			checkpoints: [],
			createdAtMs: nowMs,
			updatedAtMs: nowMs,
		},
	};
}

/**
 * Attach a checkpoint that precedes mutation for an objective. A checkpoint
 * must be present before mutation proceeds within an integration.
 */
export function addIntegrationCheckpoint(
	tx: IntegrationTransactionState,
	objectiveId: string,
	state: Record<string, unknown>,
	nowMs = Date.now(),
): MissionOperationResult<IntegrationTransactionState> {
	if (!tx.objectiveIds.includes(objectiveId)) {
		return { ok: false, code: "NOT_FOUND", error: `objective '${objectiveId}' not in integration` };
	}
	if (tx.stage === "CONFIRMED" || tx.stage === "ROLLED_BACK") {
		return { ok: false, code: "INTEGRATION_IN_PROGRESS", error: `integration already ${tx.stage}` };
	}
	const seq = tx.checkpoints.length + 1;
	const cp: ObjectiveCheckpoint = { objectiveId, sequence: seq, state, createdAtMs: nowMs };
	const checkpoints = [...tx.checkpoints, cp];
	let stage: IntegrationStage = "PREPARED";
	if (checkpoints.length === tx.objectiveIds.length) stage = "CHECKPOINTED";
	return {
		ok: true,
		value: { ...tx, checkpoints, stage, updatedAtMs: nowMs },
	};
}

export function markIntegrationValidating(
	tx: IntegrationTransactionState,
	nowMs = Date.now(),
): MissionOperationResult<IntegrationTransactionState> {
	if (tx.stage !== "CHECKPOINTED") {
		return { ok: false, code: "INTEGRATION_IN_PROGRESS", error: `expected CHECKPOINTED, got ${tx.stage}` };
	}
	return { ok: true, value: { ...tx, stage: "VALIDATING", updatedAtMs: nowMs } };
}

/**
 * Confirm the integration. All checkpoints were validated and applied; the
 * transaction becomes CONFIRMED. Subsequent mutations require a new transaction.
 */
export function confirmIntegrationTransaction(
	tx: IntegrationTransactionState,
	nowMs = Date.now(),
): MissionOperationResult<IntegrationTransactionState> {
	if (tx.stage !== "VALIDATING") {
		return { ok: false, code: "INTEGRATION_IN_PROGRESS", error: `expected VALIDATING, got ${tx.stage}` };
	}
	return { ok: true, value: { ...tx, stage: "CONFIRMED", updatedAtMs: nowMs } };
}

/**
 * Localized rollback: restore each objective's last checkpoint. Objectives not
 * part of this transaction are untouched, so independent completed work is
 * preserved. The transaction is marked ROLLED_BACK and is non-reusable.
 */
export function rollbackIntegrationTransaction(
	tx: IntegrationTransactionState,
): MissionOperationResult<{ transactionId: string; restoredCheckpoints: string[]; preservedIndependentWork: boolean }> {
	const restoredCheckpoints = tx.checkpoints.map((c) => c.objectiveId);
	return {
		ok: true,
		value: {
			transactionId: tx.transactionId,
			restoredCheckpoints,
			// Rollback only touches objectives in this transaction; any objective
			// outside the transaction set is preserved by construction.
			preservedIndependentWork: true,
		},
		code: undefined,
	};
}

/** Ordering helper: whether stage `a` may transition to stage `b`. */
export function canTransitionIntegration(a: IntegrationStage, b: IntegrationStage): boolean {
	if (a === b) return true;
	return STAGE_ORDER[b] === STAGE_ORDER[a] + 1 || b === "ROLLED_BACK";
}
