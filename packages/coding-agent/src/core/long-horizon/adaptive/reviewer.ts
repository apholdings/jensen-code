/**
 * Independent reviewer role.
 *
 * A bounded reviewer that receives a structured, evidence-scoped packet (not
 * raw logs or secrets) and returns structured, addressable findings. The
 * reviewer cannot execute mutating tools by default, cannot authorize scope
 * expansion, cannot publish, cannot override deterministic readiness, and
 * cannot waive user-required criteria.
 */

import type { AcceptanceCriterion, ReviewFinding, ReviewFindingKind, ReviewReport } from "./types.js";

export interface ReviewPacket {
	objective: string;
	criteria: readonly AcceptanceCriterion[];
	executionSummary: readonly { key: string; value: string }[];
	diffSummary?: string;
	evidenceSummaries: readonly { evidenceId: string; summary: string }[];
	warnings: string[];
	budgetState?: string;
	allowMutatingTools: boolean;
}

export interface ReviewerPermissions {
	canExecuteMutatingTools: boolean;
	canExpandScope: boolean;
	canPublish: boolean;
	canWaiveCriteria: boolean;
	canOverrideReadiness: boolean;
}

export const DEFAULT_REVIEWER_PERMISSIONS: ReviewerPermissions = {
	canExecuteMutatingTools: false,
	canExpandScope: false,
	canPublish: false,
	canWaiveCriteria: false,
	canOverrideReadiness: false,
};

/** Normalize raw reviewer findings into a bounded, addressable report. */
export function normalizeFindings(
	packet: ReviewPacket,
	raw: Array<{ kind?: string; summary?: string; references?: string[] }>,
): ReviewReport {
	const validKinds: ReadonlySet<ReviewFindingKind> = new Set([
		"approve",
		"request_specific_correction",
		"identify_missing_evidence",
		"identify_contradiction",
		"block",
	]);
	const findings: ReviewFinding[] = [];
	for (let i = 0; i < raw.length; i += 1) {
		const kind = validKinds.has(raw[i].kind as ReviewFindingKind)
			? (raw[i].kind as ReviewFindingKind)
			: "request_specific_correction";
		if (!raw[i].summary) continue;
		findings.push(
			Object.freeze({
				findingId: `finding-${i + 1}`,
				kind,
				summary: String(raw[i].summary),
				references: Object.freeze([...(raw[i].references ?? [])]),
			}),
		);
	}
	if (findings.length === 0) {
		findings.push(
			Object.freeze({
				findingId: "finding-1",
				kind: "request_specific_correction",
				summary: "No actionable findings provided.",
				references: Object.freeze([]),
			}),
		);
	}
	return { reviewId: `review-${packet.evidenceSummaries.length}`, findings: Object.freeze(findings) };
}

/** Whether the report contains an explicit approval. */
export function reviewsApprove(report: ReviewReport): boolean {
	return report.findings.some((f) => f.kind === "approve");
}

/** Aggregate verdict: only explicit approvals count, never implicit. */
export function aggregateVerdict(report: ReviewReport): "approve" | "correction" | "block" {
	if (report.findings.some((f) => f.kind === "block")) return "block";
	if (report.findings.some((f) => f.kind === "approve")) return "approve";
	return "correction";
}

/**
 * Enforce that a reviewer's findings cannot expand authority. A release
 * approval is only honored when the reviewer is explicitly permitted to publish
 * and all required criteria are satisfied.
 */
export function applyReviewerAuthority(
	report: ReviewReport,
	permissions: ReviewerPermissions,
	requiredCriteriaSatisfied: boolean,
): { publishApproved: boolean; authorityExpanded: boolean } {
	const approve = reviewsApprove(report);
	const publishApproved = approve && permissions.canPublish && requiredCriteriaSatisfied;
	return {
		publishApproved,
		authorityExpanded: approve && !permissions.canPublish,
	};
}
