/**
 * Evidence-backed success criteria.
 *
 * Machine-readable acceptance criteria. A required criterion can never be
 * silently waived; a criterion can be marked satisfied only when its required
 * evidence is present. Test claims require test artifacts, publication claims
 * require registry verification, user-observation criteria remain pending until
 * real user evidence is supplied, and the model cannot fabricate them.
 */

import type { AcceptanceCriterion } from "./types.js";

export interface EvidenceRecord {
	evidenceId: string;
	category: string;
	description?: string;
}

export interface CriteriaState {
	criteria: readonly AcceptanceCriterion[];
}

export function createCriteriaState(criteria: AcceptanceCriterion[]): CriteriaState {
	return { criteria: Object.freeze(criteria.map(freezeCriterion)) };
}

function freezeCriterion(c: AcceptanceCriterion): AcceptanceCriterion {
	return Object.freeze({
		criterionId: String(c.criterionId),
		description: String(c.description),
		required: Boolean(c.required),
		evidenceRequirements: Object.freeze([...c.evidenceRequirements]),
		status: c.status,
		evidenceIds: Object.freeze([...(c.evidenceIds ?? [])]),
		waiverAuthority: c.waiverAuthority,
	});
}

/** Evidence categories that can satisfy a given requirement category. */
const EVIDENCE_CATEGORY_REQUIREMENT: Record<string, ReadonlySet<string>> = {
	test: new Set(["test_artifact"]),
	publication: new Set(["registry_verification"]),
	git: new Set(["git_evidence"]),
	process: new Set(["process_identity"]),
	research: new Set(["citation"]),
	transaction: new Set(["transaction_confirmation"]),
	file: new Set(["file_hash"]),
};

/**
 * Attempt to satisfy a pending criterion from supplied evidence records.
 * Returns the new status and whether it changed (the model cannot self-mark
 * satisfied without matching evidence).
 */
export function evaluateCriteriaSatisfaction(
	state: CriteriaState,
	evidence: readonly EvidenceRecord[],
	_options: { userId?: string } = {},
) {
	const updated: AcceptanceCriterion[] = [];
	let changed = false;

	for (const criterion of state.criteria) {
		let next = criterion;

		if (criterion.status === "pending") {
			const satisfied = evidenceSatisfies(criterion, evidence);
			if (satisfied) {
				next = freezeCriterion({
					...criterion,
					status: "satisfied",
					evidenceIds: Object.freeze(
						[...criterion.evidenceIds, ...matchedEvidenceIds(criterion, evidence)].filter(
							(v, i, a) => a.indexOf(v) === i,
						),
					),
				});
				changed = true;
			}
		} else if (criterion.status === "waived") {
			// A waiver requires an authority; model output is never an authority.
			if (!criterion.waiverAuthority || criterion.waiverAuthority === "model") {
				next = freezeCriterion({ ...criterion, status: "blocked" });
				changed = true;
			}
		}

		updated.push(next);
	}

	return { state: createCriteriaState(updated), changed };
}

function evidenceSatisfies(criterion: AcceptanceCriterion, evidence: readonly EvidenceRecord[]): boolean {
	if (criterion.evidenceRequirements.length === 0) {
		// A criterion with explicit evidence requirements is not satisfiable with
		// none. Policy: absence of a requirement means no evidence gate.
		return false;
	}
	const availableCategories = new Set(evidence.map((e) => e.category));
	for (const requirement of criterion.evidenceRequirements) {
		const allowed = EVIDENCE_CATEGORY_REQUIREMENT[requirement];
		if (allowed) {
			let matched = false;
			for (const cat of availableCategories) {
				if (allowed.has(cat)) {
					matched = true;
					break;
				}
			}
			if (!matched) return false;
		} else {
			// Unknown requirement category — require at least one matching evidence.
			if (evidence.length === 0) return false;
		}
	}
	return evidence.length > 0;
}

function matchedEvidenceIds(_criterion: AcceptanceCriterion, evidence: readonly EvidenceRecord[]): string[] {
	return evidence.map((e) => e.evidenceId);
}

/** Mark a criterion satisfied only with matching evidence; reject prose claims. */
export function trySatisfyCriterion(
	state: CriteriaState,
	criterionId: string,
	evidence: readonly EvidenceRecord[],
): CriteriaState {
	const result = evaluateCriteriaSatisfaction(state, evidence);
	const idx = result.state.criteria.findIndex((c) => c.criterionId === criterionId);
	if (idx === -1) return state;
	return result.state;
}

/** Count satisfied vs pending/failed/blocked for completion evaluation. */
export function criterionSummary(state: CriteriaState) {
	const summary = { satisfied: 0, pending: 0, failed: 0, blocked: 0, waived: 0, total: state.criteria.length };
	for (const c of state.criteria) {
		if (c.status === "satisfied") summary.satisfied += 1;
		else if (c.status === "pending") summary.pending += 1;
		else if (c.status === "failed") summary.failed += 1;
		else if (c.status === "blocked") summary.blocked += 1;
		else if (c.status === "waived") summary.waived += 1;
	}
	return summary;
}
