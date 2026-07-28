/**
 * Canonical Transition Policy for Requirement Ledger v1.
 *
 * One single source of truth for all permitted state transitions.
 * No transition rule may be duplicated across this module, the CLI,
 * or any validator — all paths consult this policy.
 *
 * Authorization is now derived from the TrustedLedgerMutationContext,
 * not from serialized actor strings in the request payload.
 */

import type { RequirementEvaluationStatus } from "./domain-types.js";
import type { TrustedLedgerMutationContext } from "./trusted-context.js";
import { contextHasCapability } from "./trusted-context.js";
import type {
	AcceptanceCriterion,
	EvidenceRequirement,
	LedgerEvidenceRecord,
	MissionContractV1,
	RequirementLedgerV1,
	TransitionRequest,
} from "./types.js";

// =============================================================================
// Transition matrix — permitted transitions
// =============================================================================

/**
 * Map from current state to set of allowed next states.
 * Any transition not listed here is FORBIDDEN.
 */
const PERMITTED_TRANSITIONS: Record<RequirementEvaluationStatus, Set<RequirementEvaluationStatus>> = {
	UNASSESSED: new Set(["PENDING", "IN_PROGRESS", "IMPLEMENTED_UNVERIFIED", "NOT_APPLICABLE"]),
	PENDING: new Set(["IN_PROGRESS", "IMPLEMENTED_UNVERIFIED", "BLOCKED", "NOT_APPLICABLE"]),
	IN_PROGRESS: new Set(["IMPLEMENTED_UNVERIFIED", "BLOCKED", "FAILED"]),
	IMPLEMENTED_UNVERIFIED: new Set(["SATISFIED", "IN_PROGRESS", "FAILED", "BLOCKED"]),
	SATISFIED: new Set(["IMPLEMENTED_UNVERIFIED", "IN_PROGRESS", "FAILED"]),
	BLOCKED: new Set(["IN_PROGRESS", "PENDING", "FAILED", "NOT_APPLICABLE"]),
	NOT_APPLICABLE: new Set(["PENDING", "UNASSESSED"]),
	FAILED: new Set(["IN_PROGRESS", "PENDING", "BLOCKED"]),
};

// =============================================================================
// Forbidden completion paths
// =============================================================================

/** States that may NEVER transition directly to SATISFIED. */
const FORBIDDEN_DIRECT_SATISFIED: Set<RequirementEvaluationStatus> = new Set([
	"UNASSESSED",
	"PENDING",
	"IN_PROGRESS",
	"BLOCKED",
	"FAILED",
]);

// =============================================================================
// Transition validation result
// =============================================================================

export interface TransitionPolicyResult {
	permitted: boolean;
	reason?: string;
}

// =============================================================================
// Validate a proposed transition (structural only, no auth)
// =============================================================================

export function validateTransition(
	currentStatus: RequirementEvaluationStatus,
	request: TransitionRequest,
): TransitionPolicyResult {
	const toStatus = request.toStatus;

	// 1. Structural: is the transition in the matrix?
	const allowed = PERMITTED_TRANSITIONS[currentStatus];
	if (!allowed?.has(toStatus)) {
		return {
			permitted: false,
			reason: `Transition from ${currentStatus} to ${toStatus} is not permitted`,
		};
	}

	// 2. Completion boundary: SATISFIED only from IMPLEMENTED_UNVERIFIED
	if (toStatus === "SATISFIED" && currentStatus !== "IMPLEMENTED_UNVERIFIED") {
		return {
			permitted: false,
			reason: `SATISFIED requires prior IMPLEMENTED_UNVERIFIED state, got ${currentStatus}`,
		};
	}

	// 3. BLOCKED requires a reason
	if (toStatus === "BLOCKED" && !request.blockerReference && !request.reason) {
		return {
			permitted: false,
			reason: "Transition to BLOCKED requires a blocker reference or reason",
		};
	}

	// 4. FAILED requires a reason
	if (toStatus === "FAILED" && !request.reason) {
		return {
			permitted: false,
			reason: "Transition to FAILED requires a reason",
		};
	}

	return { permitted: true };
}

// =============================================================================
// Authorize a transition using trusted context (replaces actorType checks)
// =============================================================================

/**
 * Check if the transition is authorized given the trusted context.
 *
 * This replaces the old `actorType` field check.
 * Authorization is derived from the opaque trusted context, not from
 * serialized payload fields.
 */
export function authorizeTransition(
	_currentStatus: RequirementEvaluationStatus,
	request: TransitionRequest,
	context: TrustedLedgerMutationContext,
): TransitionPolicyResult {
	const toStatus = request.toStatus;

	// SATISFIED: requires transition:satisfy capability
	if (toStatus === "SATISFIED") {
		if (!contextHasCapability(context, "transition:satisfy")) {
			return {
				permitted: false,
				reason: "SATISFIED transition requires transition:satisfy capability; untrusted context lacks it",
			};
		}
	}

	// Runtime NOT_APPLICABLE: requires transition:not-applicable capability
	// (Initial contract NOT_APPLICABLE does not go through this path)
	if (toStatus === "NOT_APPLICABLE") {
		if (!contextHasCapability(context, "transition:not-applicable")) {
			return {
				permitted: false,
				reason: "Runtime NOT_APPLICABLE requires transition:not-applicable capability; untrusted context lacks it",
			};
		}
	}

	return { permitted: true };
}

// =============================================================================
// SATISFIED boundary enforcement (criterion-level)
// =============================================================================

/**
 * Check if the satisfaction boundary is violated.
 * Called when a transition to SATISFIED is attempted.
 *
 * This enforces EVERY acceptance criterion defined in the contract
 * for the target requirement using ONLY the evidence IDs explicitly
 * referenced in the transition request (request.evidenceIds).
 *
 * Unreferenced evidence elsewhere in the ledger CANNOT authorize
 * the transition. This ensures mutation-time authorization and
 * historical replay use the same canonical evidence set.
 *
 * Authorization is derived from context, not from actorType.
 */
export function isSatisfactionAuthorized(
	request: TransitionRequest,
	ledger: RequirementLedgerV1,
	contract: MissionContractV1,
	context: TrustedLedgerMutationContext,
): TransitionPolicyResult {
	// Must have transition:satisfy capability
	if (!contextHasCapability(context, "transition:satisfy")) {
		return {
			permitted: false,
			reason: "Agent cannot self-authorize SATISFIED; authoritative evidence from a trusted source required",
		};
	}

	// Evidence must be present
	if (request.evidenceIds.length === 0) {
		return {
			permitted: false,
			reason: "SATISFIED requires at least one evidence reference",
		};
	}

	// Reject duplicate evidence IDs in the request
	const seenEvidenceIds = new Set<string>();
	for (const evId of request.evidenceIds) {
		if (seenEvidenceIds.has(evId)) {
			return {
				permitted: false,
				reason: `Duplicate evidence id in transition request: ${evId}`,
			};
		}
		seenEvidenceIds.add(evId);
	}

	// Resolve all evidence records from ONLY the request's evidenceIds
	const resolvedEvidence: LedgerEvidenceRecord[] = [];
	for (const evId of request.evidenceIds) {
		const evRecord = ledger.evidence.find((e) => e.id === evId);
		if (!evRecord) {
			return {
				permitted: false,
				reason: `Evidence ${evId} not found in ledger`,
			};
		}
		if (evRecord.effectiveAuthority === "agent-claim") {
			return {
				permitted: false,
				reason: `Evidence ${evId} is an agent claim — non-authoritative`,
			};
		}
		if (evRecord.status !== "pass") {
			return {
				permitted: false,
				reason: `Evidence ${evId} has status "${evRecord.status}" — must be "pass"`,
			};
		}
		// Evidence must bind to the target requirement
		if (!evRecord.requirementIds.includes(request.requirementId)) {
			return {
				permitted: false,
				reason: `Evidence ${evId} does not reference requirement ${request.requirementId}`,
			};
		}
		// Evidence must exist before the transition revision
		// (checked at a higher level in applyRequirementTransition)
		resolvedEvidence.push(evRecord);
	}

	// =========================================================================
	// CRITERION-LEVEL ENFORCEMENT
	// Every acceptance criterion for this requirement must be independently
	// satisfied by at least one piece of evidence named in request.evidenceIds.
	// =========================================================================

	const requirement = contract.requirements.find((r) => r.id === request.requirementId);
	if (!requirement) {
		return {
			permitted: false,
			reason: `Requirement ${request.requirementId} not found in contract`,
		};
	}

	if (requirement.acceptanceCriteria.length === 0) {
		return {
			permitted: false,
			reason: `Requirement ${request.requirementId} has no acceptance criteria`,
		};
	}

	// Evaluate each criterion using ONLY the resolved evidence set (same as
	// what will be persisted in transition.evidenceIds).
	for (const criterion of requirement.acceptanceCriteria) {
		const satisfied = isCriterionSatisfied(criterion, resolvedEvidence, request.requirementId);
		if (!satisfied.permitted) {
			return satisfied;
		}
	}

	return { permitted: true };
}

// =============================================================================
// Evidence freshness after regression check
// =============================================================================

/**
 * When a requirement exits SATISFIED through regression, record the regression
 * revision. A later transition back to SATISFIED must use evidence where every
 * criterion has at least one piece of evidence added AFTER the regression.
 */
export function checkEvidenceFreshnessAfterRegression(
	request: TransitionRequest,
	ledger: RequirementLedgerV1,
	contract: MissionContractV1,
	latestRegressionRevision: number | undefined,
): TransitionPolicyResult {
	if (request.toStatus !== "SATISFIED") return { permitted: true };
	if (latestRegressionRevision === undefined) return { permitted: true };

	const requirement = contract.requirements.find((r) => r.id === request.requirementId);
	if (!requirement) return { permitted: true };

	// For each acceptance criterion, check if at least one referenced evidence
	// was added AFTER the regression revision.
	for (const criterion of requirement.acceptanceCriteria) {
		const criterionEvidenceIds = request.evidenceIds.filter((evId) => {
			const ev = ledger.evidence.find((e) => e.id === evId);
			return ev?.criterionIds.includes(criterion.id);
		});

		const hasFresh = criterionEvidenceIds.some((evId) => {
			const ev = ledger.evidence.find((e) => e.id === evId);
			return ev && ev.addedAtRevision > latestRegressionRevision;
		});

		if (!hasFresh) {
			return {
				permitted: false,
				reason: `Criterion "${criterion.id}": no evidence added after regression at revision ${latestRegressionRevision}`,
			};
		}
	}

	return { permitted: true };
}

/**
 * Verify that an acceptance criterion is satisfied by at least one
 * evidence record in the ledger that fulfills every required-evidence
 * constraint.
 */
function isCriterionSatisfied(
	criterion: AcceptanceCriterion,
	evidence: LedgerEvidenceRecord[],
	requirementId: string,
): TransitionPolicyResult {
	const matchingCriterionEvidence = evidence.filter(
		(ev) => ev.requirementIds.includes(requirementId) && ev.criterionIds.includes(criterion.id),
	);

	if (matchingCriterionEvidence.length === 0) {
		return {
			permitted: false,
			reason: `Criterion "${criterion.id}": no evidence in ledger`,
		};
	}

	// Find at least one evidence record that meets ALL evidence requirements for this criterion
	for (const evRecord of matchingCriterionEvidence) {
		const meetsAll = criterion.requiredEvidence.every((req) => evidenceMeetsRequirement(evRecord, req));

		if (meetsAll) {
			return { permitted: true };
		}
	}

	return {
		permitted: false,
		reason: `Criterion "${criterion.id}": no evidence satisfies all required evidence constraints`,
	};
}

/**
 * Check if a single evidence record meets a single EvidenceRequirement.
 */
function evidenceMeetsRequirement(evRecord: LedgerEvidenceRecord, requirement: EvidenceRequirement): boolean {
	// Evidence must have passing status
	if (evRecord.status !== "pass") {
		return false;
	}

	// Agent claims are never authoritative
	if (evRecord.effectiveAuthority === "agent-claim") {
		return false;
	}

	// allowedTypes: evidence type must be in the allowed set
	if (requirement.allowedTypes && requirement.allowedTypes.length > 0) {
		if (!requirement.allowedTypes.includes(evRecord.type)) {
			return false;
		}
	}

	// minAuthority: effective authority must meet the minimum
	if (requirement.minAuthority) {
		if (!authorityMeetsMinimum(evRecord.effectiveAuthority, requirement.minAuthority)) {
			return false;
		}
	}

	// requiredCollectorClass: check verified principal kind (not collectorType string)
	if (requirement.requiredCollectorClass) {
		if (evRecord.verifiedPrincipalKind !== requirement.requiredCollectorClass) {
			return false;
		}
	}

	return true;
}

/**
 * Authority hierarchy: whether `actual` meets or exceeds `minimum`.
 *
 * Hierarchy (lowest to highest):
 *   agent-claim < repository-observation < command-result < test-result
 *   < runtime-observation < operator-confirmation < trusted-collector
 */
function authorityMeetsMinimum(actual: string, minimum: string): boolean {
	const ranks: Record<string, number> = {
		"agent-claim": 0,
		"repository-observation": 1,
		"command-result": 2,
		"test-result": 3,
		"runtime-observation": 4,
		"operator-confirmation": 5,
		"trusted-collector": 6,
	};

	const actualRank = ranks[actual] ?? -1;
	const minRank = ranks[minimum] ?? -1;

	return actualRank >= minRank;
}

/**
 * Get all permitted next states from a given state.
 */
export function getPermittedTransitions(
	currentStatus: RequirementEvaluationStatus,
): ReadonlySet<RequirementEvaluationStatus> {
	return PERMITTED_TRANSITIONS[currentStatus] ?? new Set();
}

/**
 * Check if a direct transition to SATISFIED is forbidden from a given state.
 */
export function isForbiddenDirectSatisfied(currentStatus: RequirementEvaluationStatus): boolean {
	return FORBIDDEN_DIRECT_SATISFIED.has(currentStatus);
}
