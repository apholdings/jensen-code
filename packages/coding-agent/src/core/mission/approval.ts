/**
 * Durable Mission Graph — human approval gates & external blockers (2.0.0).
 *
 * Human approval nodes cannot be auto-approved. A decision is only valid when
 * granted by a verified principal listed on the gate, for the gate's scope,
 * before its expiry. External blockers require concrete evidence to be marked
 * satisfied — satisfaction cannot be fabricated.
 */

import type {
	ApprovalDecision,
	ApprovalGateSpec,
	ExternalBlockerSpec,
	ExternalBlockerState,
	MissionOperationResult,
} from "./types.js";

export interface ApproveInput {
	gate: ApprovalGateSpec;
	/** Objective attempting the approval (for no-self-approval scope check). */
	objectiveId: string;
	principal: string;
	approved: boolean;
	nowMs: number;
	reason?: string;
}

export type ValidateResult<T> = MissionOperationResult<T>;

/**
 * Evaluate an approval decision request against a gate.
 *
 * Rejections:
 *  - SELF_APPROVAL when the objective approves its own gate
 *  - APPROVAL_NOT_GRANTED when the principal is not required/listed
 *  - APPROVAL_EXPIRED when ttlMs is set and nowMs exceeds expiry window
 */
export function evaluateApproval(input: ApproveInput): ValidateResult<ApprovalDecision> {
	const { gate, objectiveId, principal, approved, nowMs, reason } = input;

	// An objective can never approve its own gate (even if listed).
	if (gate.requiredPrincipals.includes(objectiveId)) {
		return { ok: false, code: "SELF_APPROVAL", error: `objective '${objectiveId}' cannot approve its own gate` };
	}

	if (!gate.requiredPrincipals.includes(principal)) {
		return {
			ok: false,
			code: "APPROVAL_NOT_GRANTED",
			error: `principal '${principal}' is not authorized for gate '${gate.id}'`,
		};
	}

	let expiresAtMs: number | undefined;
	if (gate.ttlMs !== undefined && approved) {
		// An approval is valid for `ttlMs` from the moment it is recorded.
		expiresAtMs = nowMs + gate.ttlMs;
	}

	return {
		ok: true,
		value: {
			gateId: gate.id,
			approved,
			principal,
			expiresAtMs,
			reason,
			recordedAtMs: nowMs,
		},
	};
}

/**
 * Determine whether a previously recorded approval decision is still valid now:
 * it must be approved, granted by a listed principal, and not expired.
 */
export function isApprovalValid(gate: ApprovalGateSpec, decision: ApprovalDecision, nowMs: number): boolean {
	if (!decision.approved) return false;
	if (!gate.requiredPrincipals.includes(decision.principal)) return false;
	if (decision.expiresAtMs !== undefined && nowMs > decision.expiresAtMs) return false;
	if (gate.ttlMs !== undefined && decision.recordedAtMs + gate.ttlMs < nowMs) return false;
	return true;
}

// =============================================================================
// External blockers
// =============================================================================

/**
 * Mark an external blocker satisfied given evidence.
 *
 * Rejections:
 *  - BLOCKER_WITHOUT_EVIDENCE when no evidence reference is provided
 *  - BLOCKER_UNSATISFIED when the evidence reference is not in `satisfiedOn`
 *
 * Satisfaction can only come from a concrete evidence reference listed on the
 * spec — it cannot be fabricated.
 */
export function satisfyExternalBlocker(
	spec: ExternalBlockerSpec,
	evidenceReference: string | undefined,
	nowMs = Date.now(),
): ValidateResult<ExternalBlockerState> {
	if (spec.evidenceRequired && !evidenceReference) {
		return {
			ok: false,
			code: "BLOCKER_WITHOUT_EVIDENCE",
			error: `external blocker '${spec.id}' requires evidence`,
		};
	}
	if (!spec.satisfiedOn.includes(evidenceReference ?? "")) {
		return {
			ok: false,
			code: "BLOCKER_UNSATISFIED",
			error: `evidence '${evidenceReference}' does not satisfy blocker '${spec.id}'`,
		};
	}
	return {
		ok: true,
		value: {
			specId: spec.id,
			satisfied: true,
			evidenceReference,
			satisfiedAtMs: nowMs,
		},
	};
}
