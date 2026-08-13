/**
 * Completion Gate — Jensen-owned completion decision.
 *
 * The model proposes FINAL_CANDIDATE; this gate decides ACCEPT or REJECT from
 * durable ledger state and authoritative evidence. A model cannot mark a
 * missing criterion as passed by asserting it: criterion state is derived from
 * the Requirement Ledger, where SATISFIED requires authoritative evidence from
 * a trusted (Jensen-held) context.
 */

import type { MissionContractV1, RequirementLedgerV1 } from "../long-horizon/index.js";
import { deriveRequirementLedgerSummary } from "../long-horizon/index.js";
import type { TrustedValidationContext } from "../long-horizon/trusted-context.js";
import type { CompletionGateResult } from "./types.js";

export function evaluateCompletionGate(
	contract: MissionContractV1,
	ledger: RequirementLedgerV1,
	validationContext: TrustedValidationContext,
): CompletionGateResult {
	const summary = deriveRequirementLedgerSummary(contract, ledger, validationContext);

	if (summary.completionCandidate) {
		return {
			decision: "accept",
			reasons: ["all acceptance criteria satisfied with authoritative evidence"],
			missingCriterionIds: [],
			blockedBy: [],
			completedCriterionIds: contract.requirements.map((r) => r.id),
		};
	}

	const completedCriterionIds: string[] = [];
	const missingCriterionIds: string[] = [];

	for (const requirement of contract.requirements) {
		const entry = ledger.requirements.find((r) => r.requirementId === requirement.id);
		if (!entry || entry.initialNotApplicable) continue;
		if (entry.status === "SATISFIED") {
			completedCriterionIds.push(requirement.id);
		} else {
			missingCriterionIds.push(requirement.id);
		}
	}

	// A SATISFIED requirement without authoritative evidence is still incomplete.
	for (const requirement of contract.requirements) {
		const entry = ledger.requirements.find((r) => r.requirementId === requirement.id);
		if (!entry || entry.status !== "SATISFIED") continue;
		const hasAuthoritative = ledger.evidence.some(
			(ev) =>
				ev.requirementIds.includes(requirement.id) &&
				ev.effectiveAuthority !== "agent-claim" &&
				ev.status === "pass",
		);
		if (!hasAuthoritative && !missingCriterionIds.includes(requirement.id)) {
			missingCriterionIds.push(requirement.id);
		}
	}

	return {
		decision: "reject",
		reasons: summary.completionBlockers ?? ["completion not ready"],
		missingCriterionIds,
		blockedBy: [...summary.blockedRequirements, ...summary.failedRequirements],
		completedCriterionIds,
	};
}
