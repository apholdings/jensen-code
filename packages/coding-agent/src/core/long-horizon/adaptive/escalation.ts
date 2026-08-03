/**
 * Bounded model escalation.
 *
 * Escalation is a separate, bounded decision from a strategy pivot. It moves
 * the same task to a stronger/compatible model for reasons such as a required
 * capability, repeated schema failure, independent review, or a high-risk
 * release gate. Escalation REQUIRES structured evidence and policy permission.
 * A model can recommend escalation but can never authorize it.
 */

import type { EscalationRequest, StallState } from "./types.js";

export type EscalationReasonCode =
	| "capability_mismatch"
	| "repeated_schema_failure"
	| "independent_review_required"
	| "high_risk_release_gate"
	| "complex_cross_repository_failure"
	| "stall_after_distinct_strategies";

/** Reasons that are forbidden for escalation. */
export const FORBIDDEN_ESCALATION_REASONS: ReadonlyArray<EscalationReasonCode | string> = [
	"model_requested_more_expensive",
	"more_tokens_might_help",
	"unspecified_difficulty",
	"user_authorization_missing",
	"policy_denied",
];

export interface EscalationBudget {
	maxModelEscalations: number;
}

export interface EscalationContext {
	usedEscalations: number;
	maxModelEscalations: number;
	policyAllows: boolean;
	remainingBudget: number;
	stall?: StallState;
	failureEvidenceCount: number;
	distinctStrategiesAttempted: number;
	forcedReasons?: string[];
}

export interface EscalationDecision {
	allowed: boolean;
	reasonCodes: string[];
	blockedCodes: string[];
	toProvider?: string;
	toModel?: string;
}

/**
 * Evaluate an escalation request against policy and evidence. An escalation is
 * allowed only if: escalation budget remains, policy permits, allowed reasons
 * are present, and the aliasing of two equivalent models is not requested.
 */
export function evaluateEscalation(request: EscalationRequest, ctx: EscalationContext): EscalationDecision {
	const blockedCodes: string[] = [];
	const reasonCodes: string[] = [];

	if (request.fromProvider === request.toProvider && request.fromModel === request.toModel) {
		blockedCodes.push("ESCALATION_NOOP");
	}

	for (const reason of request.reasonCodes) {
		if (FORBIDDEN_ESCALATION_REASONS.includes(reason)) {
			blockedCodes.push(`FORBIDDEN_REASON:${reason}`);
		} else {
			reasonCodes.push(reason);
		}
	}

	if (ctx.usedEscalations >= ctx.maxModelEscalations) {
		blockedCodes.push("ESCALATION_BUDGET_EXHAUSTED");
	}
	if (!ctx.policyAllows) {
		blockedCodes.push("POLICY_DENIED");
	}
	if (ctx.remainingBudget <= 0) {
		blockedCodes.push("NO_BUDGET");
	}

	// Evidence-based reasons must be backed by structured evidence.
	const evidenceBacked = validateEvidence(request.reasonCodes as EscalationReasonCode[], ctx);
	if (!evidenceBacked) {
		blockedCodes.push("ESCALATION_LACKS_EVIDENCE");
	}

	const allowed = blockedCodes.length === 0 && reasonCodes.length > 0;
	return {
		allowed,
		reasonCodes,
		blockedCodes,
		toProvider: allowed ? request.toProvider : undefined,
		toModel: allowed ? request.toModel : undefined,
	};
}

function validateEvidence(reasons: string[], ctx: EscalationContext): boolean {
	if (reasons.includes("independent_review_required")) return true;
	if (reasons.includes("high_risk_release_gate")) return true;
	if (reasons.includes("capability_mismatch")) return false; // requires explicit capability mismatch evidence
	if (reasons.includes("repeated_schema_failure")) return ctx.failureEvidenceCount >= 2;
	if (reasons.includes("complex_cross_repository_failure")) return ctx.failureEvidenceCount >= 2;
	if (reasons.includes("stall_after_distinct_strategies")) return ctx.distinctStrategiesAttempted >= 2;
	return false;
}
