/**
 * Ledger Summary — deterministic mission status snapshot.
 *
 * Computes comprehensive summaries from contract + ledger.
 * Pure, no side effects, no provider dependency.
 *
 * LH-1 Hardened:
 *   - Authoritative summary requires a TrustedValidationContext.
 *   - Trust checks are always enforced (not optional).
 *   - completionCandidate only available through trusted path.
 *   - Structural inspection path cannot produce completionCandidate.
 */

import { computeMissionContractDigest } from "./contract-digest.js";
import { inspectRequirementLedgerStructure, validateRequirementLedger } from "./requirement-ledger.js";
import type { TrustedValidationContext } from "./trusted-context.js";
import { _getBoundContractDigest, isTrustedValidationContext } from "./trusted-context.js";
import type { LedgerSummary, MissionContractV1, RequirementLedgerV1, WorkstreamSummary } from "./types.js";

// =============================================================================
// Untrusted structural inspection — never produces completionCandidate=true
// =============================================================================

/**
 * Inspect ledger structure without trust verification.
 *
 * completionCandidate is always "unavailable". This path is for
 * generic CLI and untrusted callers. Use deriveRequirementLedgerSummary
 * with a TrustedValidationContext for authoritative completion.
 */
export const inspectLedgerStructure: typeof inspectRequirementLedgerStructure = inspectRequirementLedgerStructure;

// =============================================================================
// Authoritative summary — REQUIRES TrustedValidationContext
// =============================================================================

/**
 * Derive a deterministic ledger summary with full trust verification.
 *
 * The validationContext is MANDATORY. Trust and freshness checks are always enforced.
 *
 * completionCandidate is true only when:
 *   - Ledger passes structural and trust validation
 *   - Every applicable requirement == SATISFIED
 *   - All privileged principals verified against the trust registry
 *   - All capabilities verified
 *   - No stale post-regression satisfaction
 */
export function deriveRequirementLedgerSummary(
	contract: MissionContractV1,
	ledger: RequirementLedgerV1,
	validationContext: TrustedValidationContext,
): LedgerSummary {
	// === RUNTIME CONTEXT GUARD ===
	// A genuine TrustedValidationContext is MANDATORY for authoritative summary.
	// Plain objects, Proxies, JSON-derived objects, and Object.assign copies
	// are rejected at runtime.
	if (!isTrustedValidationContext(validationContext)) {
		// Return a summary that unambiguously reports completion as unavailable.
		// Typed callers should use the guard before calling; this is defense-in-depth.
		return {
			missionId: contract.missionId,
			contractRevision: contract.revision,
			contractDigest: ledger.contractDigest,
			ledgerRevision: ledger.revision,
			totalRequirements: contract.requirements.length,
			applicableRequirements: 0,
			stateCounts: {},
			explicitCount: 0,
			inferredCount: 0,
			workstreamSummaries: [],
			blockedRequirements: [],
			failedRequirements: [],
			requirementsLackingAuthoritativeEvidence: [],
			completionCandidate: false,
			completionBlockers: ["TRUSTED_VALIDATION_CONTEXT_REQUIRED"],
		};
	}

	const completionBlockers: string[] = [];

	// === CONTRACT-BINDING GUARD ===
	// Every genuine TrustedValidationContext is bound to exactly one
	// Mission Contract digest. A context minted for Contract A must not
	// validate Contract B.
	const contextDigest2 = _getBoundContractDigest(validationContext);
	if (contextDigest2 !== undefined) {
		const contractDigest2 = computeMissionContractDigest(contract);
		if (contextDigest2 !== contractDigest2) {
			completionBlockers.push(
				`TRUSTED_VALIDATION_CONTEXT_CONTRACT_MISMATCH: context bound to ${contextDigest2} but contract computes ${contractDigest2}`,
			);
		}
	}

	// Always enforce trust and freshness
	const ledgerValid = validateRequirementLedger(contract, ledger, validationContext);

	if (!ledgerValid.ok) {
		completionBlockers.push(`Ledger validation failed: ${ledgerValid.error}`);
	}

	const stateCounts: LedgerSummary["stateCounts"] = {};
	let applicableCount = 0;

	for (const entry of ledger.requirements) {
		if (entry.initialNotApplicable) continue;
		applicableCount++;
		const s = entry.status;
		stateCounts[s] = (stateCounts[s] ?? 0) + 1;
	}

	let explicitCount = 0;
	let inferredCount = 0;
	for (const req of contract.requirements) {
		const entry = ledger.requirements.find((r) => r.requirementId === req.id);
		if (entry?.initialNotApplicable) continue;
		if (req.kind === "EXPLICIT") explicitCount++;
		else inferredCount++;
	}

	const wsMap = new Map<string, { title: string; total: number; satisfied: number }>();
	for (const ws of contract.workstreams) {
		wsMap.set(ws.id, { title: ws.title, total: 0, satisfied: 0 });
	}
	for (const req of contract.requirements) {
		const entry = ledger.requirements.find((r) => r.requirementId === req.id);
		if (entry?.initialNotApplicable) continue;
		const ws = wsMap.get(req.workstreamId);
		if (ws) {
			ws.total++;
			if (entry?.status === "SATISFIED") ws.satisfied++;
		}
	}
	const workstreamSummaries: WorkstreamSummary[] = Array.from(wsMap.entries()).map(([id, data]) => ({
		workstreamId: id,
		title: data.title,
		totalRequirements: data.total,
		satisfiedCount: data.satisfied,
	}));

	const blockedRequirements = ledger.requirements.filter((r) => r.status === "BLOCKED").map((r) => r.requirementId);
	const failedRequirements = ledger.requirements.filter((r) => r.status === "FAILED").map((r) => r.requirementId);

	const requirementsLackingAuthoritativeEvidence = findRequirementsLackingEvidence(contract, ledger);

	// Completion candidate: always computed with trust
	const completionCandidate = computeCompletionCandidate(contract, ledger, ledgerValid.ok, completionBlockers);

	return {
		missionId: contract.missionId,
		contractRevision: contract.revision,
		contractDigest: ledger.contractDigest,
		ledgerRevision: ledger.revision,
		totalRequirements: contract.requirements.length,
		applicableRequirements: applicableCount,
		stateCounts,
		explicitCount,
		inferredCount,
		workstreamSummaries,
		blockedRequirements,
		failedRequirements,
		requirementsLackingAuthoritativeEvidence,
		completionCandidate,
		completionBlockers: completionBlockers.length > 0 ? completionBlockers : undefined,
	};
}

// =============================================================================
// Completion Candidate — hardened
// =============================================================================

function computeCompletionCandidate(
	contract: MissionContractV1,
	ledger: RequirementLedgerV1,
	ledgerValid: boolean,
	blockers: string[],
): boolean {
	if (!ledgerValid) return false;

	for (const entry of ledger.requirements) {
		if (entry.initialNotApplicable) continue;
		if (entry.status !== "SATISFIED") {
			blockers.push(`Requirement ${entry.requirementId} is ${entry.status}, not SATISFIED`);
			return false;
		}
	}

	for (const req of contract.requirements) {
		const entry = ledger.requirements.find((r) => r.requirementId === req.id);
		if (!entry || entry.initialNotApplicable) continue;

		const hasAuthEvidence = ledger.evidence.some(
			(ev) => ev.requirementIds.includes(req.id) && ev.effectiveAuthority !== "agent-claim" && ev.status === "pass",
		);

		if (!hasAuthEvidence) {
			blockers.push(`Requirement ${req.id} is SATISFIED but lacks authoritative evidence`);
			return false;
		}

		for (const criterion of req.acceptanceCriteria) {
			const criterionEvidence = ledger.evidence.some(
				(ev) =>
					ev.requirementIds.includes(req.id) &&
					ev.criterionIds.includes(criterion.id) &&
					ev.effectiveAuthority !== "agent-claim" &&
					ev.status === "pass",
			);

			if (!criterionEvidence) {
				blockers.push(`Requirement ${req.id}: criterion "${criterion.id}" has no authoritative evidence`);
				return false;
			}
		}

		if (entry.latestRegressionRevision !== undefined) {
			const lastSatTx = [...ledger.transitions]
				.reverse()
				.find((t) => t.requirementId === req.id && t.toStatus === "SATISFIED");

			if (lastSatTx) {
				let allFresh = true;
				for (const criterion of req.acceptanceCriteria) {
					const hasFresh = lastSatTx.evidenceIds.some((evId) => {
						const ev = ledger.evidence.find((e) => e.id === evId);
						return (
							ev?.criterionIds.includes(criterion.id) && ev.addedAtRevision > entry.latestRegressionRevision!
						);
					});

					if (!hasFresh) {
						allFresh = false;
						blockers.push(
							`Requirement ${req.id}: criterion "${criterion.id}" uses stale evidence after regression`,
						);
					}
				}
				if (!allFresh) return false;
			}
		}
	}

	return true;
}

// =============================================================================
// Evidence lacking detection
// =============================================================================

function findRequirementsLackingEvidence(contract: MissionContractV1, ledger: RequirementLedgerV1): string[] {
	const lacking: string[] = [];

	for (const req of contract.requirements) {
		const entry = ledger.requirements.find((r) => r.requirementId === req.id);
		if (!entry || entry.initialNotApplicable) continue;
		if (entry.status !== "SATISFIED") continue;

		const hasAuthEvidence = ledger.evidence.some(
			(ev) => ev.requirementIds.includes(req.id) && ev.effectiveAuthority !== "agent-claim" && ev.status === "pass",
		);

		if (!hasAuthEvidence) {
			lacking.push(req.id);
		}
	}

	return lacking;
}
