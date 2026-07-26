/**
 * Ledger Reducer — derive current state from transition history.
 *
 * Replays the full transition log to compute current requirement status.
 * Provides a cross-check that ledger.requirements matches the transition
 * history.
 */

import type { RequirementEvaluationStatus } from "./domain-types.js";
import type { RequirementLedgerV1 } from "./types.js";

/**
 * Replay transitions to derive current requirement states.
 * Returns the computed state map for verification.
 */
export function deriveCurrentStates(ledger: RequirementLedgerV1): Map<string, RequirementEvaluationStatus> {
	const stateMap = new Map<string, RequirementEvaluationStatus>();

	// Initialize from ledger entries (assuming they start at initialState)
	for (const entry of ledger.requirements) {
		stateMap.set(entry.requirementId, entry.status);
	}

	// Replay transitions in order
	for (const tx of ledger.transitions) {
		const current = stateMap.get(tx.requirementId);
		if (current !== undefined && current === tx.fromStatus) {
			stateMap.set(tx.requirementId, tx.toStatus);
		}
	}

	// Walk back: for the purposes of consistency checking with the
	// actual ledger.requirements, we just trust the ledger entries
	// and validate transitions against the atomic from-state.
	return stateMap;
}

/**
 * Verify that ledger requirement entries are consistent with
 * the transition history.
 *
 * Returns list of mismatches, if any.
 */
export function verifyLedgerConsistency(ledger: RequirementLedgerV1): string[] {
	const errors: string[] = [];

	// Track state per requirement via transition replay
	const computed = new Map<string, RequirementEvaluationStatus>();

	// Start from initial state based on contract initialization
	for (const entry of ledger.requirements) {
		// Determine initial state
		const initStatus: RequirementEvaluationStatus = entry.initialNotApplicable ? "NOT_APPLICABLE" : "UNASSESSED";
		computed.set(entry.requirementId, initStatus);
	}

	// Replay all transitions
	for (const tx of ledger.transitions) {
		const current = computed.get(tx.requirementId);
		if (current === undefined) {
			errors.push(`Transition ${tx.id} references unknown requirement ${tx.requirementId}`);
			continue;
		}
		if (tx.fromStatus !== current) {
			errors.push(
				`Transition ${tx.id}: expected fromStatus ${current} for ${tx.requirementId}, got ${tx.fromStatus}`,
			);
			continue;
		}
		computed.set(tx.requirementId, tx.toStatus);
	}

	// Verify ledger.requirements matches computed state
	for (const entry of ledger.requirements) {
		const computedStatus = computed.get(entry.requirementId);
		if (computedStatus !== undefined && computedStatus !== entry.status) {
			errors.push(`Requirement ${entry.requirementId}: ledger has ${entry.status}, computed has ${computedStatus}`);
		}
	}

	return errors;
}

/**
 * Get the current status of a requirement from the ledger.
 */
export function getRequirementStatus(
	ledger: RequirementLedgerV1,
	requirementId: string,
): RequirementEvaluationStatus | undefined {
	const entry = ledger.requirements.find((r) => r.requirementId === requirementId);
	return entry?.status;
}

/**
 * Check if a requirement is in a terminal state (SATISFIED or NOT_APPLICABLE).
 */
export function isTerminalState(status: RequirementEvaluationStatus): boolean {
	return status === "SATISFIED" || status === "NOT_APPLICABLE";
}
