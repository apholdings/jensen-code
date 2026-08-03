/**
 * Independent completion-readiness gate.
 *
 * A deterministic evaluator that aggregates success criteria, budget state,
 * transaction state, test state, job state, provider state, stall state,
 * unresolved risks, and review/release state into a single
 * `CompletionReadiness`. Completion is blocked if any required criterion is
 * pending/failed, a required transaction is unconfirmed, authoritative tests
 * failed, required jobs are unresolved, release artifacts are unverified,
 * accounting is inconsistent, required review is absent, or the final-response
 * reserve is unavailable.
 *
 * A model reviewer may add findings but can never force readiness to true.
 */

import { criterionSummary } from "./criteria.js";
import type { AcceptanceCriterion, CompletionReadiness } from "./types.js";

export interface ReadinessInput {
	criteria: readonly AcceptanceCriterion[];
	satisfiedCriterionIds: string[];
	transactionConfirmed: boolean;
	requiredTransaction: boolean;
	testsFailed: boolean;
	jobsResolved: boolean;
	requiredJobs: boolean;
	releaseArtifactsVerified: boolean;
	requiredReleaseVerification: boolean;
	budgetAccountingConsistent: boolean;
	requiredReviewPresent: boolean;
	requiredReview: boolean;
	finalResponseReserveAvailable: boolean;
	warnings?: string[];
	evidenceIds?: string[];
}

export function evaluateCompletionReadiness(input: ReadinessInput): CompletionReadiness {
	const blockers: string[] = [];
	const warnings = [...(input.warnings ?? [])];
	const evidenceIds = [...(input.evidenceIds ?? [])];

	const summary = criterionSummary({ criteria: input.criteria });

	for (const c of input.criteria) {
		if (c.required && (c.status === "pending" || c.status === "failed")) {
			blockers.push(`REQUIRED_CRITERION_${c.status.toUpperCase()}:${c.criterionId}`);
		}
		if (c.status === "blocked") {
			blockers.push(`CRITERION_BLOCKED:${c.criterionId}`);
		}
		if (c.status === "waived" && (!c.waiverAuthority || c.waiverAuthority === "model")) {
			blockers.push(`CRITERION_WAIVED_NO_AUTHORITY:${c.criterionId}`);
		}
	}

	if (input.requiredTransaction && !input.transactionConfirmed) {
		blockers.push("REQUIRED_TRANSACTION_UNCONFIRMED");
	}
	if (input.testsFailed) {
		blockers.push("AUTHORITATIVE_TESTS_FAILED");
	}
	if (input.requiredJobs && !input.jobsResolved) {
		blockers.push("REQUIRED_JOB_UNRESOLVED");
	}
	if (input.requiredReleaseVerification && !input.releaseArtifactsVerified) {
		blockers.push("RELEASE_ARTIFACTS_UNVERIFIED");
	}
	if (!input.budgetAccountingConsistent) {
		blockers.push("BUDGET_ACCOUNTING_INCONSISTENT");
	}
	if (input.requiredReview && !input.requiredReviewPresent) {
		blockers.push("REQUIRED_INDEPENDENT_REVIEW_ABSENT");
	}
	if (!input.finalResponseReserveAvailable) {
		blockers.push("FINAL_RESPONSE_RESERVE_UNAVAILABLE");
	}

	const satisfiedCriteria = input.criteria.filter((c) => c.status === "satisfied").map((c) => c.criterionId);
	const pendingCriteria = input.criteria.filter((c) => c.status === "pending").map((c) => c.criterionId);

	if (summary.satisfied === 0 && input.criteria.length === 0) {
		blockers.push("NO_CRITERIA_DEFINED");
	}

	return {
		ready: blockers.length === 0,
		blockers: Object.freeze([...blockers]),
		warnings: Object.freeze([...warnings]),
		satisfiedCriteria: Object.freeze([...satisfiedCriteria]),
		pendingCriteria: Object.freeze([...pendingCriteria]),
		evidenceIds: Object.freeze([...evidenceIds]),
	};
}

/**
 * A model reviewer can add findings but cannot force readiness to true. The
 * readiness output is recomputed deterministically from state each time.
 */
export function cannotOverrideReadiness(
	_modelForcedReady: boolean,
	evaluated: CompletionReadiness,
): CompletionReadiness {
	// Ignore any model assertion; the deterministic evaluation is authoritative.
	return evaluated;
}
