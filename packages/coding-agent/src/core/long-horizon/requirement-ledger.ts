/**
 * Requirement Ledger v1 — core operations.
 *
 * Pure, filesystem-independent, provider-neutral ledger operations.
 * All functions are immutable — they return new ledger instances.
 *
 * Mutation Model:
 *   - Every accepted mutation (evidence or transition) increments revision by 1.
 *   - Evidence gets addedAtRevision = ledger.revision + 1.
 *   - Transitions require an explicit, caller-supplied transitionId.
 *   - Global mutation sequence: evidence and transition revisions interleave.
 *
 * Trust Model (LH-1 hardened):
 *   - Authorization is derived from TrustedLedgerMutationContext, not payload fields.
 *   - The default untrusted context (agent, no capabilities) can only record claims
 *     and perform non-privileged workflow transitions.
 *   - SATISFIED requires transition:satisfy capability.
 *   - Runtime NOT_APPLICABLE requires transition:not-applicable capability.
 *   - Authoritative evidence requires matching evidence capability.
 *   - Evidence freshness after regression enforced.
 *
 * Validation Model (LH-1 hardened, principal/source fixes applied):
 *   - Authoritative validation requires a TrustedValidationContext.
 *   - Trust checks are ALWAYS enforced when a context is provided.
 *   - Stored verified provenance is verified against the context registry
 *     using exact (principalId + principalKind) tuples.
 *   - Source verification requires explicit trusted evidence-source grants.
 *   - Contract evidence policy is re-evaluated during replay.
 *   - Criterion evidence requirements are re-evaluated during replay.
 *   - Missing required sources fail closed.
 *   - Separate structural inspection is available for untrusted callers.
 */

import { computeMissionContractDigest } from "./contract-digest.js";
import type { RequirementEvaluationStatus } from "./domain-types.js";
import { validateMissionContract } from "./mission-contract-schema.js";
import {
	authorizeTransition,
	checkEvidenceFreshnessAfterRegression,
	isSatisfactionAuthorized,
	validateTransition,
} from "./transition-policy.js";
import type {
	TrustedLedgerMutationContext,
	TrustedPrincipalKind,
	TrustedValidationContext,
} from "./trusted-context.js";
import {
	_getBoundContractDigest,
	deriveEffectiveAuthority,
	getUntrustedContext,
	isSourceRequiredForEvidence,
	isTrustedValidationContext,
} from "./trusted-context.js";
import type {
	LedgerEvidenceRecord,
	LedgerEvidenceRequest,
	MissionContractV1,
	OperationResult,
	RequirementLedgerEntry,
	RequirementLedgerV1,
	RequirementTransition,
	StructuralLedgerInspection,
	TransitionRequest,
} from "./types.js";

// =============================================================================
// Initialize ledger from contract
// =============================================================================

export function initializeRequirementLedger(contract: MissionContractV1): OperationResult<RequirementLedgerV1> {
	const validation = validateMissionContract(contract);
	if (!validation.valid) {
		return {
			ok: false,
			error: `Invalid contract: ${validation.errors.map((e) => e.message).join("; ")}`,
			code: "INVALID_CONTRACT",
		};
	}

	const digest = computeMissionContractDigest(contract);

	const entries: RequirementLedgerEntry[] = contract.requirements.map((req) => {
		const initialNotApplicable = req.initialApplicability === "NOT_APPLICABLE";
		const status: RequirementEvaluationStatus = initialNotApplicable ? "NOT_APPLICABLE" : "UNASSESSED";

		return {
			requirementId: req.id,
			status,
			workstreamId: req.workstreamId,
			initialNotApplicable,
			notApplicableRationale: initialNotApplicable
				? (req.rationale ?? "Declared NOT_APPLICABLE in contract")
				: undefined,
		};
	});

	const ledger: RequirementLedgerV1 = {
		ledgerVersion: 1,
		missionId: contract.missionId,
		contractVersion: contract.contractVersion,
		contractRevision: contract.revision,
		contractDigest: digest,
		revision: 0,
		requirements: entries,
		evidence: [],
		transitions: [],
	};

	return { ok: true, value: ledger };
}

// =============================================================================
// Build global mutation revision sequence for validation
// =============================================================================

interface MutationSlot {
	revision: number;
	type: "evidence" | "transition";
	id: string;
}

function buildMutationSequence(ledger: RequirementLedgerV1): MutationSlot[] {
	const slots: MutationSlot[] = [];

	for (const ev of ledger.evidence) {
		slots.push({ revision: ev.addedAtRevision, type: "evidence", id: ev.id });
	}

	for (const tx of ledger.transitions) {
		slots.push({ revision: tx.ledgerRevisionAfter, type: "transition", id: tx.id });
	}

	slots.sort((a, b) => a.revision - b.revision);
	return slots;
}

// =============================================================================
// Internal structural-only validation (no trust checks)
// =============================================================================

/**
 * Validate ledger structure only — contract binding, mutation sequence,
 * state reconstruction. Does NOT verify principal provenance, capability
 * grants, or evidence authority. Used by mutation pre-condition checks.
 */
function validateRequirementLedgerStructure(
	contract: MissionContractV1,
	ledger: RequirementLedgerV1,
): OperationResult<boolean> {
	// Check contract binding
	const digest = computeMissionContractDigest(contract);
	if (ledger.contractDigest !== digest) {
		return {
			ok: false,
			error: `Contract digest mismatch: ledger has ${ledger.contractDigest}, contract computes ${digest}`,
			code: "CONTRACT_DIGEST_MISMATCH",
		};
	}

	if (ledger.ledgerVersion !== 1) {
		return { ok: false, error: "Ledger version must be 1", code: "INVALID_LEDGER" };
	}

	if (ledger.missionId !== contract.missionId) {
		return { ok: false, error: "Ledger missionId does not match contract", code: "INVALID_LEDGER" };
	}

	if (ledger.contractRevision !== contract.revision) {
		return { ok: false, error: "Ledger contractRevision does not match contract", code: "INVALID_LEDGER" };
	}

	// Every contract requirement must have a ledger entry
	const contractReqs = new Set(contract.requirements.map((r) => r.id));
	const ledgerReqs = new Set(ledger.requirements.map((r) => r.requirementId));

	for (const reqId of contractReqs) {
		if (!ledgerReqs.has(reqId)) {
			return { ok: false, error: `Ledger missing entry for requirement: ${reqId}`, code: "INVALID_LEDGER" };
		}
	}

	for (const reqId of ledgerReqs) {
		if (!contractReqs.has(reqId)) {
			return { ok: false, error: `Ledger has entry for unknown requirement: ${reqId}`, code: "INVALID_LEDGER" };
		}
	}

	const reqIdSet = new Set<string>();
	for (const entry of ledger.requirements) {
		if (reqIdSet.has(entry.requirementId)) {
			return {
				ok: false,
				error: `Duplicate ledger entry for requirement: ${entry.requirementId}`,
				code: "INVALID_LEDGER",
			};
		}
		reqIdSet.add(entry.requirementId);
	}

	const evIds = new Set<string>();
	for (const ev of ledger.evidence) {
		if (evIds.has(ev.id)) {
			return { ok: false, error: `Duplicate evidence id: ${ev.id}`, code: "INVALID_LEDGER" };
		}
		evIds.add(ev.id);

		if (!Number.isInteger(ev.addedAtRevision) || ev.addedAtRevision <= 0) {
			return {
				ok: false,
				error: `Evidence ${ev.id} has invalid addedAtRevision: ${ev.addedAtRevision}`,
				code: "INVALID_LEDGER",
			};
		}

		if (ev.addedAtRevision > ledger.revision) {
			return {
				ok: false,
				error: `Evidence ${ev.id} has addedAtRevision ${ev.addedAtRevision} > ledger.revision ${ledger.revision}`,
				code: "INVALID_LEDGER",
			};
		}

		for (const reqId of ev.requirementIds) {
			if (!contractReqs.has(reqId)) {
				return {
					ok: false,
					error: `Evidence ${ev.id} references unknown requirement: ${reqId}`,
					code: "INVALID_LEDGER",
				};
			}
		}
	}

	const txIds = new Set<string>();
	for (const tx of ledger.transitions) {
		if (txIds.has(tx.id)) {
			return { ok: false, error: `Duplicate transition id: ${tx.id}`, code: "INVALID_LEDGER" };
		}
		txIds.add(tx.id);

		if (!contractReqs.has(tx.requirementId)) {
			return {
				ok: false,
				error: `Transition ${tx.id} references unknown requirement: ${tx.requirementId}`,
				code: "INVALID_LEDGER",
			};
		}

		if (tx.ledgerRevisionAfter !== tx.ledgerRevisionBefore + 1) {
			return {
				ok: false,
				error: `Transition ${tx.id} has non-sequential revision change from ${tx.ledgerRevisionBefore} to ${tx.ledgerRevisionAfter}`,
				code: "INVALID_LEDGER",
			};
		}

		for (const evId of tx.evidenceIds) {
			const ev = ledger.evidence.find((e) => e.id === evId);
			if (!ev) {
				return {
					ok: false,
					error: `Transition ${tx.id} references unknown evidence: ${evId}`,
					code: "UNKNOWN_EVIDENCE",
				};
			}
			if (ev.addedAtRevision >= tx.ledgerRevisionAfter) {
				return {
					ok: false,
					error: `Transition ${tx.id} at revision ${tx.ledgerRevisionAfter} references evidence ${evId} added at revision ${ev.addedAtRevision} (evidence must exist before the transition)`,
					code: "INVALID_TRANSITION",
				};
			}
		}
	}

	// Global mutation sequence
	const mutationSeq = buildMutationSequence(ledger);

	const seenRevisions = new Set<number>();
	for (const slot of mutationSeq) {
		if (seenRevisions.has(slot.revision)) {
			return {
				ok: false,
				error: `Duplicate mutation revision ${slot.revision}: ${slot.type} ${slot.id}`,
				code: "INVALID_LEDGER",
			};
		}
		seenRevisions.add(slot.revision);
	}

	if (mutationSeq.length > 0) {
		if (mutationSeq[0].revision !== 1) {
			return {
				ok: false,
				error: `First mutation is at revision ${mutationSeq[0].revision}, expected 1`,
				code: "INVALID_LEDGER",
			};
		}

		for (let i = 1; i < mutationSeq.length; i++) {
			if (mutationSeq[i].revision !== mutationSeq[i - 1].revision + 1) {
				return {
					ok: false,
					error: `Gap in mutation sequence between revision ${mutationSeq[i - 1].revision} and ${mutationSeq[i].revision}`,
					code: "INVALID_LEDGER",
				};
			}
		}

		const last = mutationSeq[mutationSeq.length - 1];
		if (last.revision !== ledger.revision) {
			return {
				ok: false,
				error: `Last mutation at revision ${last.revision} but ledger.revision is ${ledger.revision}`,
				code: "INVALID_LEDGER",
			};
		}
	}

	const totalMutations = ledger.evidence.length + ledger.transitions.length;
	if (ledger.revision !== totalMutations) {
		return {
			ok: false,
			error: `Ledger revision ${ledger.revision} does not match total mutations ${totalMutations} (${ledger.evidence.length} evidence + ${ledger.transitions.length} transitions)`,
			code: "INVALID_LEDGER",
		};
	}

	// State reconstruction
	const initialStates = new Map<string, RequirementEvaluationStatus>();
	for (const req of contract.requirements) {
		const initialNotApplicable = req.initialApplicability === "NOT_APPLICABLE";
		initialStates.set(req.id, initialNotApplicable ? "NOT_APPLICABLE" : "UNASSESSED");
	}

	const reconstructedStates = new Map(initialStates);

	for (const slot of mutationSeq) {
		if (slot.type === "transition") {
			const tx = ledger.transitions.find((t) => t.id === slot.id)!;
			const currentState = reconstructedStates.get(tx.requirementId);

			if (currentState !== tx.fromStatus) {
				return {
					ok: false,
					error: `Transition ${tx.id} at revision ${slot.revision} has fromStatus "${tx.fromStatus}" but reconstructed state is "${currentState}"`,
					code: "INVALID_LEDGER",
				};
			}

			reconstructedStates.set(tx.requirementId, tx.toStatus);
		}
	}

	for (const entry of ledger.requirements) {
		const reconstructed = reconstructedStates.get(entry.requirementId);
		if (reconstructed !== entry.status) {
			return {
				ok: false,
				error: `Requirement ${entry.requirementId} has snapshot status "${entry.status}" but mutation history reconstructs to "${reconstructed}"`,
				code: "INVALID_LEDGER",
			};
		}
	}

	return { ok: true, value: true };
}

// =============================================================================
// Untrusted structural inspection — no trust checks, no completionCandidate
// =============================================================================

/**
 * Inspect a ledger's structural state without any trust verification.
 *
 * This is the untrusted inspection path. It validates structural integrity
 * (contract binding, mutation sequence, state reconstruction) but does NOT
 * verify principal provenance, capability grants, or evidence authority.
 *
 * completionCandidate is always "unavailable".
 */
export function inspectRequirementLedgerStructure(
	contract: MissionContractV1,
	ledger: RequirementLedgerV1,
): StructuralLedgerInspection {
	const validationResult = validateRequirementLedgerStructure(contract, ledger);

	const stateCounts: Record<string, number> = {};
	let applicableCount = 0;

	for (const entry of ledger.requirements) {
		if (entry.initialNotApplicable) continue;
		applicableCount++;
		const s = entry.status;
		stateCounts[s] = (stateCounts[s] ?? 0) + 1;
	}

	const blockedRequirements = ledger.requirements.filter((r) => r.status === "BLOCKED").map((r) => r.requirementId);
	const failedRequirements = ledger.requirements.filter((r) => r.status === "FAILED").map((r) => r.requirementId);

	return {
		missionId: contract.missionId,
		contractDigest: ledger.contractDigest,
		ledgerRevision: ledger.revision,
		totalRequirements: contract.requirements.length,
		applicableRequirements: applicableCount,
		structurallyValid: validationResult.ok,
		stateCounts,
		blockedRequirements,
		failedRequirements,
		completionCandidate: "unavailable",
		trustVerified: false,
	};
}

// =============================================================================
// Authoritative ledger validation — REQUIRES TrustedValidationContext
// =============================================================================

/**
 * Validate a ledger against its contract with full trust verification.
 *
 * The validationContext is MANDATORY for this function.
 * All trust and freshness checks are always enforced.
 *
 * The context's registry is used to verify:
 *   - Every stored verifiedPrincipalId/verifiedPrincipalKind is known
 *   - Every stored verifiedCapability was actually granted (exact tuple)
 *   - Every evidence source matches a trusted grant
 *   - Contract evidence policy is enforced
 *   - Criterion evidence requirements are enforced
 *   - Stored effectiveAuthority is consistent with verified capability
 */
export function validateRequirementLedger(
	contract: MissionContractV1,
	ledger: RequirementLedgerV1,
	validationContext: TrustedValidationContext,
): OperationResult<boolean> {
	// === RUNTIME CONTEXT GUARD ===
	// TypeScript signatures are NOT a security boundary.
	// A plain object, Proxy, JSON-derived object, or Object.assign copy
	// must be rejected at runtime, not merely type-checked at compile time.
	if (!isTrustedValidationContext(validationContext)) {
		return {
			ok: false,
			error: "A genuine TrustedValidationContext is required. This context is not in the trusted registry WeakSet.",
			code: "TRUSTED_VALIDATION_CONTEXT_REQUIRED",
		};
	}

	// === CONTRACT-BINDING GUARD ===
	// Every genuine TrustedValidationContext is bound to exactly one
	// Mission Contract digest. A context minted for Contract A must not
	// validate Contract B, even when IDs happen to overlap.
	const contextDigest = _getBoundContractDigest(validationContext);
	if (contextDigest !== undefined) {
		const contractDigest = computeMissionContractDigest(contract);
		if (contextDigest !== contractDigest) {
			return {
				ok: false,
				error: `TrustedValidationContext is bound to contract digest ${contextDigest} but the supplied contract computes ${contractDigest}`,
				code: "TRUSTED_VALIDATION_CONTEXT_CONTRACT_MISMATCH",
			};
		}
		// Also verify ledger contract digest matches
		if (ledger.contractDigest !== contractDigest) {
			return {
				ok: false,
				error: `Ledger contract digest ${ledger.contractDigest} does not match contract digest ${contractDigest}`,
				code: "CONTRACT_DIGEST_MISMATCH",
			};
		}
	}

	// =========================================================================
	// Phase 1: Structural checks (always run)
	// =========================================================================

	const structuralResult = runStructuralChecks(contract, ledger);
	if (!structuralResult.ok) {
		return structuralResult;
	}

	// =========================================================================
	// Phase 2: Trust replay — provenance, policy, and source verification
	// =========================================================================

	// Helper: find contract requirement
	const contractReqs = new Set(contract.requirements.map((r) => r.id));

	// --- Evidence trust replay ---
	const evIds = new Set<string>();
	for (const ev of ledger.evidence) {
		if (evIds.has(ev.id)) {
			return { ok: false, error: `Duplicate evidence id: ${ev.id}`, code: "INVALID_LEDGER" };
		}
		evIds.add(ev.id);

		for (const reqId of ev.requirementIds) {
			if (!contractReqs.has(reqId)) {
				return {
					ok: false,
					error: `Evidence ${ev.id} references unknown requirement: ${reqId}`,
					code: "INVALID_LEDGER",
				};
			}
		}

		// --- PRINCIPAL VERIFICATION: exact tuple ---
		if (!validationContext.verifyPrincipal(ev.verifiedPrincipalId, ev.verifiedPrincipalKind)) {
			return {
				ok: false,
				error: `Evidence ${ev.id}: unknown verified principal ${ev.verifiedPrincipalId}/${ev.verifiedPrincipalKind}`,
				code: "AUTHORIZATION_FAILED",
			};
		}

		// --- CAPABILITY VERIFICATION: exact tuple ---
		if (ev.effectiveAuthority !== "agent-claim" && ev.verifiedCapability) {
			if (
				!validationContext.verifyCapability(
					ev.verifiedPrincipalId,
					ev.verifiedPrincipalKind as TrustedPrincipalKind,
					ev.verifiedCapability,
				)
			) {
				return {
					ok: false,
					error: `Evidence ${ev.id}: capability ${ev.verifiedCapability} not granted to principal ${ev.verifiedPrincipalId}/${ev.verifiedPrincipalKind}`,
					code: "AUTHORIZATION_FAILED",
				};
			}

			// Verify effectiveAuthority is consistent with the claimed capability
			const expectedAuthority = capabilityToAuthoritySimple(ev.verifiedCapability);
			if (expectedAuthority && ev.effectiveAuthority !== expectedAuthority) {
				return {
					ok: false,
					error: `Evidence ${ev.id}: effectiveAuthority "${ev.effectiveAuthority}" inconsistent with verified capability "${ev.verifiedCapability}" (tampered provenance)`,
					code: "INVALID_LEDGER",
				};
			}
		}

		// Non-agent-claim evidence requires non-agent verified principal
		if (ev.effectiveAuthority !== "agent-claim" && ev.verifiedPrincipalKind === "agent") {
			return {
				ok: false,
				error: `Evidence ${ev.id}: effectiveAuthority ${ev.effectiveAuthority} but verifiedPrincipalKind is agent (tampered provenance)`,
				code: "INVALID_LEDGER",
			};
		}

		// --- SOURCE VERIFICATION ---
		// Determine if source is required
		const sourceRequired = isSourceRequiredForEvidence({
			effectiveAuthority: ev.effectiveAuthority,
			contractAuthoritativeSources: contract.evidencePolicy.authoritativeSources,
		});

		if (sourceRequired && (!ev.source || ev.source.trim().length === 0)) {
			return {
				ok: false,
				error: `Evidence ${ev.id}: authoritative source required but source is empty or missing`,
				code: "AUTHORITATIVE_SOURCE_REQUIRED",
			};
		}

		// Verify source via trusted grant when present
		if (ev.source && ev.source.trim().length > 0) {
			if (
				!validationContext.verifyEvidenceSource({
					sourceId: ev.source,
					principalId: ev.verifiedPrincipalId,
					principalKind: ev.verifiedPrincipalKind as TrustedPrincipalKind,
					capability: ev.verifiedCapability ?? "evidence:test-result",
					evidenceType: ev.type,
					collectorClass: ev.reportedCollectorType,
					requirementIds: ev.requirementIds,
					criterionIds: ev.criterionIds,
				})
			) {
				return {
					ok: false,
					error: `Evidence ${ev.id}: source "${ev.source}" does not match a trusted grant for principal ${ev.verifiedPrincipalId}/${ev.verifiedPrincipalKind}`,
					code: "UNKNOWN_AUTHORITATIVE_SOURCE",
				};
			}
		}

		// --- CONTRACT EVIDENCE POLICY REPLAY ---
		const policyCheck = checkContractEvidencePolicy(contract, ev);
		if (!policyCheck.ok) {
			return policyCheck;
		}

		// --- CRITERION EVIDENCE REQUIREMENT REPLAY ---
		const criterionCheck = checkCriterionEvidenceRequirements(contract, ev);
		if (!criterionCheck.ok) {
			return criterionCheck;
		}
	}

	// --- Transition trust replay ---
	const txIds = new Set<string>();
	for (const tx of ledger.transitions) {
		if (txIds.has(tx.id)) {
			return { ok: false, error: `Duplicate transition id: ${tx.id}`, code: "INVALID_LEDGER" };
		}
		txIds.add(tx.id);

		if (!contractReqs.has(tx.requirementId)) {
			return {
				ok: false,
				error: `Transition ${tx.id} references unknown requirement: ${tx.requirementId}`,
				code: "INVALID_LEDGER",
			};
		}

		if (tx.ledgerRevisionAfter !== tx.ledgerRevisionBefore + 1) {
			return {
				ok: false,
				error: `Transition ${tx.id} has non-sequential revision change from ${tx.ledgerRevisionBefore} to ${tx.ledgerRevisionAfter}`,
				code: "INVALID_LEDGER",
			};
		}

		for (const evId of tx.evidenceIds) {
			const ev = ledger.evidence.find((e) => e.id === evId);
			if (!ev) {
				return {
					ok: false,
					error: `Transition ${tx.id} references unknown evidence: ${evId}`,
					code: "UNKNOWN_EVIDENCE",
				};
			}
			if (ev.addedAtRevision >= tx.ledgerRevisionAfter) {
				return {
					ok: false,
					error: `Transition ${tx.id} at revision ${tx.ledgerRevisionAfter} references evidence ${evId} added at revision ${ev.addedAtRevision} (evidence must exist before the transition)`,
					code: "INVALID_TRANSITION",
				};
			}
		}

		// --- PRINCIPAL VERIFICATION: exact tuple ---
		if (!validationContext.verifyPrincipal(tx.verifiedPrincipalId, tx.verifiedPrincipalKind)) {
			return {
				ok: false,
				error: `Transition ${tx.id}: unknown verified principal ${tx.verifiedPrincipalId}/${tx.verifiedPrincipalKind}`,
				code: "AUTHORIZATION_FAILED",
			};
		}

		// SATISFIED transitions require non-agent principal
		if (tx.toStatus === "SATISFIED" && tx.verifiedPrincipalKind === "agent") {
			return {
				ok: false,
				error: `Transition ${tx.id}: SATISFIED with agent verifiedPrincipalKind (tampered provenance)`,
				code: "INVALID_LEDGER",
			};
		}

		// --- CAPABILITY VERIFICATION: exact tuple ---
		if (tx.verifiedCapability) {
			if (
				!validationContext.verifyCapability(
					tx.verifiedPrincipalId,
					tx.verifiedPrincipalKind as TrustedPrincipalKind,
					tx.verifiedCapability,
				)
			) {
				return {
					ok: false,
					error: `Transition ${tx.id}: capability ${tx.verifiedCapability} not granted to principal ${tx.verifiedPrincipalId}/${tx.verifiedPrincipalKind}`,
					code: "AUTHORIZATION_FAILED",
				};
			}
		}

		// SATISFIED must have transition:satisfy
		if (tx.toStatus === "SATISFIED" && tx.verifiedCapability !== "transition:satisfy") {
			return {
				ok: false,
				error: `Transition ${tx.id}: SATISFIED with verifiedCapability "${tx.verifiedCapability}" — expected "transition:satisfy" (tampered provenance)`,
				code: "INVALID_LEDGER",
			};
		}

		// Runtime NOT_APPLICABLE must have transition:not-applicable
		if (tx.toStatus === "NOT_APPLICABLE" && tx.fromStatus !== "UNASSESSED") {
			if (tx.verifiedCapability !== "transition:not-applicable") {
				return {
					ok: false,
					error: `Transition ${tx.id}: runtime NOT_APPLICABLE with verifiedCapability "${tx.verifiedCapability}" — expected "transition:not-applicable" (tampered provenance)`,
					code: "INVALID_LEDGER",
				};
			}
		}

		// --- CRITERION REPLAY for SATISFIED transitions ---
		if (tx.toStatus === "SATISFIED") {
			const req = contract.requirements.find((r) => r.id === tx.requirementId);
			if (req) {
				for (const criterion of req.acceptanceCriteria) {
					const satCheck = replayCriterionSatisfaction(contract, ledger, tx, criterion, req);
					if (!satCheck.ok) return satCheck;
				}
			}
		}
	}

	// --- Global mutation sequence ---
	const mutationSeq = buildMutationSequence(ledger);

	const seenRevisions = new Set<number>();
	for (const slot of mutationSeq) {
		if (seenRevisions.has(slot.revision)) {
			return {
				ok: false,
				error: `Duplicate mutation revision ${slot.revision}: ${slot.type} ${slot.id}`,
				code: "INVALID_LEDGER",
			};
		}
		seenRevisions.add(slot.revision);
	}

	if (mutationSeq.length > 0) {
		if (mutationSeq[0].revision !== 1) {
			return {
				ok: false,
				error: `First mutation is at revision ${mutationSeq[0].revision}, expected 1`,
				code: "INVALID_LEDGER",
			};
		}

		for (let i = 1; i < mutationSeq.length; i++) {
			if (mutationSeq[i].revision !== mutationSeq[i - 1].revision + 1) {
				return {
					ok: false,
					error: `Gap in mutation sequence between revision ${mutationSeq[i - 1].revision} and ${mutationSeq[i].revision}`,
					code: "INVALID_LEDGER",
				};
			}
		}

		const last = mutationSeq[mutationSeq.length - 1];
		if (last.revision !== ledger.revision) {
			return {
				ok: false,
				error: `Last mutation at revision ${last.revision} but ledger.revision is ${ledger.revision}`,
				code: "INVALID_LEDGER",
			};
		}
	}

	const totalMutations = ledger.evidence.length + ledger.transitions.length;
	if (ledger.revision !== totalMutations) {
		return {
			ok: false,
			error: `Ledger revision ${ledger.revision} does not match total mutations ${totalMutations} (${ledger.evidence.length} evidence + ${ledger.transitions.length} transitions)`,
			code: "INVALID_LEDGER",
		};
	}

	// --- State reconstruction ---
	const initialStates = new Map<string, RequirementEvaluationStatus>();
	for (const req of contract.requirements) {
		const initialNotApplicable = req.initialApplicability === "NOT_APPLICABLE";
		initialStates.set(req.id, initialNotApplicable ? "NOT_APPLICABLE" : "UNASSESSED");
	}

	const reconstructedStates = new Map(initialStates);

	for (const slot of mutationSeq) {
		if (slot.type === "transition") {
			const tx = ledger.transitions.find((t) => t.id === slot.id)!;
			const currentState = reconstructedStates.get(tx.requirementId);

			if (currentState !== tx.fromStatus) {
				return {
					ok: false,
					error: `Transition ${tx.id} at revision ${slot.revision} has fromStatus "${tx.fromStatus}" but reconstructed state is "${currentState}"`,
					code: "INVALID_LEDGER",
				};
			}

			reconstructedStates.set(tx.requirementId, tx.toStatus);
		}
	}

	for (const entry of ledger.requirements) {
		const reconstructed = reconstructedStates.get(entry.requirementId);
		if (reconstructed !== entry.status) {
			return {
				ok: false,
				error: `Requirement ${entry.requirementId} has snapshot status "${entry.status}" but mutation history reconstructs to "${reconstructed}"`,
				code: "INVALID_LEDGER",
			};
		}
	}

	// --- Evidence freshness after regression (always enforced) ---
	for (const entry of ledger.requirements) {
		if (entry.status !== "SATISFIED") continue;
		if (entry.latestRegressionRevision === undefined) continue;

		const lastSatTx = [...ledger.transitions]
			.reverse()
			.find((t) => t.requirementId === entry.requirementId && t.toStatus === "SATISFIED");

		if (!lastSatTx) continue;

		const requirement = contract.requirements.find((r) => r.id === entry.requirementId);
		if (!requirement) continue;

		for (const criterion of requirement.acceptanceCriteria) {
			const hasFresh = lastSatTx.evidenceIds.some((evId) => {
				const ev = ledger.evidence.find((e) => e.id === evId);
				return ev?.criterionIds.includes(criterion.id) && ev.addedAtRevision > entry.latestRegressionRevision!;
			});

			if (!hasFresh) {
				return {
					ok: false,
					error: `Requirement ${entry.requirementId}: criterion "${criterion.id}" satisfied with stale evidence after regression at revision ${entry.latestRegressionRevision}`,
					code: "STALE_EVIDENCE_AFTER_REGRESSION",
				};
			}
		}
	}

	return { ok: true, value: true };
}

// =============================================================================
// Structural checks subset (shared path) — returns on first error
// =============================================================================

function runStructuralChecks(contract: MissionContractV1, ledger: RequirementLedgerV1): OperationResult<boolean> {
	const digest = computeMissionContractDigest(contract);
	if (ledger.contractDigest !== digest) {
		return {
			ok: false,
			error: `Contract digest mismatch: ledger has ${ledger.contractDigest}, contract computes ${digest}`,
			code: "CONTRACT_DIGEST_MISMATCH",
		};
	}

	if (ledger.ledgerVersion !== 1) {
		return { ok: false, error: "Ledger version must be 1", code: "INVALID_LEDGER" };
	}

	if (ledger.missionId !== contract.missionId) {
		return { ok: false, error: "Ledger missionId does not match contract", code: "INVALID_LEDGER" };
	}

	if (ledger.contractRevision !== contract.revision) {
		return { ok: false, error: "Ledger contractRevision does not match contract", code: "INVALID_LEDGER" };
	}

	const contractReqs = new Set(contract.requirements.map((r) => r.id));
	const ledgerReqs = new Set(ledger.requirements.map((r) => r.requirementId));

	for (const reqId of contractReqs) {
		if (!ledgerReqs.has(reqId)) {
			return { ok: false, error: `Ledger missing entry for requirement: ${reqId}`, code: "INVALID_LEDGER" };
		}
	}

	for (const reqId of ledgerReqs) {
		if (!contractReqs.has(reqId)) {
			return { ok: false, error: `Ledger has entry for unknown requirement: ${reqId}`, code: "INVALID_LEDGER" };
		}
	}

	return { ok: true, value: true };
}

// =============================================================================
// Contract evidence policy check during replay
// =============================================================================

function checkContractEvidencePolicy(contract: MissionContractV1, ev: LedgerEvidenceRecord): OperationResult<boolean> {
	// Agent claims are never authoritative — policy doesn't apply
	if (ev.effectiveAuthority === "agent-claim") {
		return { ok: true, value: true };
	}

	const policy = contract.evidencePolicy;

	// When contract declares authoritative sources, evidence must match
	if (policy.authoritativeSources && policy.authoritativeSources.length > 0) {
		if (!policy.authoritativeSources.includes(ev.effectiveAuthority)) {
			return {
				ok: false,
				error: `Evidence ${ev.id}: effectiveAuthority "${ev.effectiveAuthority}" not in contract authoritativeSources [${policy.authoritativeSources.join(", ")}]`,
				code: "CONTRACT_EVIDENCE_POLICY_VIOLATION",
			};
		}
	}

	// Check evidence policy rules
	if (policy.rules) {
		for (const rule of policy.rules) {
			// Rule applies if evidence type matches
			if (rule.allowedTypes && !rule.allowedTypes.includes(ev.type)) {
				continue; // Rule doesn't apply to this type
			}

			// Check minAuthority
			if (rule.minAuthority) {
				const authRank = authorityRank(ev.effectiveAuthority);
				const requiredRank = authorityRank(rule.minAuthority);
				if (authRank < requiredRank) {
					return {
						ok: false,
						error: `Evidence ${ev.id}: authority "${ev.effectiveAuthority}" below rule "${rule.id}" minAuthority "${rule.minAuthority}"`,
						code: "CONTRACT_EVIDENCE_POLICY_VIOLATION",
					};
				}
			}

			// Check requiredCollectorClass
			if (rule.requiredCollectorClass && ev.reportedCollectorType !== rule.requiredCollectorClass) {
				return {
					ok: false,
					error: `Evidence ${ev.id}: collector "${ev.reportedCollectorType}" does not match rule "${rule.id}" requiredCollectorClass "${rule.requiredCollectorClass}"`,
					code: "CONTRACT_EVIDENCE_POLICY_VIOLATION",
				};
			}
		}
	}

	return { ok: true, value: true };
}

// =============================================================================
// Criterion evidence requirement replay
// =============================================================================

function checkCriterionEvidenceRequirements(
	contract: MissionContractV1,
	ev: LedgerEvidenceRecord,
): OperationResult<boolean> {
	for (const reqId of ev.requirementIds) {
		const requirement = contract.requirements.find((r) => r.id === reqId);
		if (!requirement) continue;

		for (const critId of ev.criterionIds) {
			const criterion = requirement.acceptanceCriteria.find((c) => c.id === critId);
			if (!criterion) continue;

			for (const evReq of criterion.requiredEvidence) {
				// Check allowedTypes
				if (evReq.allowedTypes && evReq.allowedTypes.length > 0) {
					if (!evReq.allowedTypes.includes(ev.type)) {
						return {
							ok: false,
							error: `Evidence ${ev.id}: type "${ev.type}" not in criterion "${critId}" allowedTypes [${evReq.allowedTypes.join(", ")}]`,
							code: "CRITERION_EVIDENCE_POLICY_VIOLATION",
						};
					}
				}

				// Check minAuthority
				if (evReq.minAuthority && evReq.minAuthority !== "agent-claim") {
					const authRank1 = authorityRank(ev.effectiveAuthority);
					const requiredRank1 = authorityRank(evReq.minAuthority);
					if (authRank1 < requiredRank1) {
						return {
							ok: false,
							error: `Evidence ${ev.id}: authority "${ev.effectiveAuthority}" below criterion "${critId}" minAuthority "${evReq.minAuthority}"`,
							code: "CRITERION_EVIDENCE_POLICY_VIOLATION",
						};
					}
				}

				// Check requiredCollectorClass
				if (evReq.requiredCollectorClass && ev.reportedCollectorType !== evReq.requiredCollectorClass) {
					return {
						ok: false,
						error: `Evidence ${ev.id}: collector "${ev.reportedCollectorType}" does not match criterion "${critId}" requiredCollectorClass "${evReq.requiredCollectorClass}"`,
						code: "CRITERION_EVIDENCE_POLICY_VIOLATION",
					};
				}

				// Check minPassingStatus
				if (evReq.minPassingStatus === "pass" && ev.status !== "pass") {
					return {
						ok: false,
						error: `Evidence ${ev.id}: status "${ev.status}" does not meet criterion "${critId}" minPassingStatus "pass"`,
						code: "CRITERION_EVIDENCE_POLICY_VIOLATION",
					};
				}
			}
		}
	}

	return { ok: true, value: true };
}

// =============================================================================
// Shared SATISFIED Evaluator — canonical single source of truth
// =============================================================================

/**
 * Evaluate whether a set of evidence records satisfies every acceptance
 * criterion for a requirement.
 *
 * This is the ONE canonical evaluator used by:
 *   - Mutation-time authorization (through isSatisfactionAuthorized)
 *   - Historical authoritative replay (replayCriterionSatisfaction)
 *   - Completion assessment
 *
 * It evaluates only the evidence explicitly provided — it does NOT
 * consult the full ledger. The caller is responsible for resolving
 * the canonical evidence set (transition.evidenceIds) into records
 * before calling this function.
 *
 * @returns An OperationResult<boolean> with specific typed failures
 *          for missing criteria, missing evidence rules, stale evidence,
 *          and policy violations.
 */
export function evaluateSatisfiedTransition(params: {
	requirement: import("./types.js").MissionRequirement;
	evidenceRecords: LedgerEvidenceRecord[];
	latestRegressionRevision?: number;
}): OperationResult<boolean> {
	const { requirement, evidenceRecords, latestRegressionRevision } = params;

	if (requirement.acceptanceCriteria.length === 0) {
		return {
			ok: false,
			error: `Requirement ${requirement.id} has no acceptance criteria`,
			code: "MISSING_ACCEPTANCE_CRITERIA",
		};
	}

	for (const criterion of requirement.acceptanceCriteria) {
		const matching = evidenceRecords.filter(
			(ev) => ev.criterionIds.includes(criterion.id) && ev.requirementIds.includes(requirement.id),
		);

		if (matching.length === 0) {
			return {
				ok: false,
				error: `Criterion "${criterion.id}": no evidence in the canonical evidence set`,
				code: "UNKNOWN_CRITERION",
			};
		}

		// Freshness check: if there was a regression, at least one evidence
		// for this criterion must have been added after regression
		if (latestRegressionRevision !== undefined) {
			const hasFresh = matching.some((ev) => ev.addedAtRevision > latestRegressionRevision);
			if (!hasFresh) {
				return {
					ok: false,
					error: `Criterion "${criterion.id}": no evidence added after regression at revision ${latestRegressionRevision}`,
					code: "STALE_EVIDENCE_AFTER_REGRESSION",
				};
			}
		}

		// Find at least one evidence record that meets ALL required-evidence constraints
		let satisfied = false;
		for (const evRecord of matching) {
			if (evRecord.status !== "pass") continue;
			if (evRecord.effectiveAuthority === "agent-claim") continue;

			const meetsAll = criterion.requiredEvidence.every((req) => evidenceMeetsRequirementReplay(evRecord, req));
			if (meetsAll) {
				satisfied = true;
				break;
			}
		}

		if (!satisfied) {
			return {
				ok: false,
				error: `Criterion "${criterion.id}": no evidence satisfies all required evidence constraints`,
				code: "CRITERION_EVIDENCE_POLICY_VIOLATION",
			};
		}
	}

	return { ok: true, value: true };
}

/**
 * Check if a single evidence record meets a single EvidenceRequirement
 * during replay evaluation.
 */
function evidenceMeetsRequirementReplay(
	evRecord: LedgerEvidenceRecord,
	requirement: import("./types.js").EvidenceRequirement,
): boolean {
	if (evRecord.status !== "pass") return false;
	if (evRecord.effectiveAuthority === "agent-claim") return false;

	if (requirement.allowedTypes && requirement.allowedTypes.length > 0) {
		if (!requirement.allowedTypes.includes(evRecord.type)) return false;
	}

	if (requirement.minAuthority) {
		if (!authorityMeetsMinimumReplay(evRecord.effectiveAuthority, requirement.minAuthority)) {
			return false;
		}
	}

	if (requirement.requiredCollectorClass) {
		if (evRecord.verifiedPrincipalKind !== requirement.requiredCollectorClass) return false;
	}

	if (requirement.minPassingStatus === "pass" && evRecord.status !== "pass") return false;

	return true;
}

function authorityMeetsMinimumReplay(actual: string, minimum: string): boolean {
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

// =============================================================================
// Criterion satisfaction replay for SATISFIED transitions
// =============================================================================

function replayCriterionSatisfaction(
	_contract: MissionContractV1,
	ledger: RequirementLedgerV1,
	tx: RequirementTransition,
	_criterion: import("./types.js").AcceptanceCriterion,
	requirement: import("./types.js").MissionRequirement,
): OperationResult<boolean> {
	// Resolve evidence from the transition's canonical evidence set
	const evidenceRecords: LedgerEvidenceRecord[] = [];
	for (const evId of tx.evidenceIds) {
		const ev = ledger.evidence.find((e) => e.id === evId);
		if (ev) evidenceRecords.push(ev);
	}

	return evaluateSatisfiedTransition({
		requirement,
		evidenceRecords,
	});
}

// =============================================================================
// Authority ranking for minAuthority comparison
// =============================================================================

function authorityRank(authority: string): number {
	switch (authority) {
		case "agent-claim":
			return 0;
		case "repository-observation":
			return 1;
		case "command-result":
			return 2;
		case "test-result":
			return 3;
		case "runtime-observation":
			return 4;
		case "operator-confirmation":
			return 5;
		case "trusted-collector":
			return 6;
		default:
			return 0;
	}
}

// =============================================================================
// Authoritative ledger validation — returns rich result type
// =============================================================================

/**
 * Authoritative validation returning a typed result with truthful semantics.
 *
 * Unlike validateRequirementLedger which returns a generic OperationResult,
 * this returns an AuthoritativeLedgerValidationResult whose types prove
 * that trust verification was attempted against a genuine registry.
 *
 * Fields:
 *   - structuralValidation: "passed" or { status: "failed", code, message }
 *   - provenanceValidation: "passed", { status: "failed", code, message }, or "not-reached"
 *
 * Structural failure cannot report structural validity true.
 * Provenance failure cannot report provenance validity true.
 * Provenance not executed is distinguishable from provenance passed.
 */
export function validateRequirementLedgerStrict(
	contract: MissionContractV1,
	ledger: RequirementLedgerV1,
	validationContext: TrustedValidationContext,
): import("./types.js").AuthoritativeLedgerValidationResult {
	const result = validateRequirementLedger(contract, ledger, validationContext);

	if (!result.ok) {
		const code = result.code ?? "INTERNAL_ERROR";
		const message = result.error ?? "Unknown error";

		// Distinguish structural from provenance/capability/source failures
		const isStructural =
			code === "CONTRACT_DIGEST_MISMATCH" ||
			code === "INVALID_LEDGER" ||
			code === "INVALID_CONTRACT" ||
			code === "INVALID_TRANSITION" ||
			code === "STALE_REVISION" ||
			code === "STALE_EVIDENCE_AFTER_REGRESSION" ||
			code === "UNKNOWN_REQUIREMENT" ||
			code === "UNKNOWN_CRITERION" ||
			code === "UNKNOWN_EVIDENCE" ||
			code === "UNKNOWN_SEMANTIC_FIELD" ||
			code === "DUPLICATE_EVIDENCE_ID" ||
			code === "DUPLICATE_TRANSITION_ID" ||
			code === "INTERNAL_REPLAY_INVARIANT_VIOLATION" ||
			code === "INTERNAL_ERROR";

		const isProvenance =
			code === "AUTHORIZATION_FAILED" ||
			code === "UNKNOWN_AUTHORITATIVE_SOURCE" ||
			code === "AUTHORITATIVE_SOURCE_REQUIRED" ||
			code === "SOURCE_PRINCIPAL_MISMATCH" ||
			code === "SOURCE_EVIDENCE_CAPABILITY_MISMATCH" ||
			code === "SOURCE_COLLECTOR_MISMATCH" ||
			code === "SOURCE_EVIDENCE_TYPE_MISMATCH" ||
			code === "SOURCE_REQUIREMENT_MISMATCH" ||
			code === "SOURCE_CRITERION_MISMATCH" ||
			code === "CONTRACT_EVIDENCE_POLICY_VIOLATION" ||
			code === "CRITERION_EVIDENCE_POLICY_VIOLATION" ||
			code === "TRUSTED_VALIDATION_CONTEXT_REQUIRED";

		if (isStructural) {
			return {
				valid: false,
				trustVerified: true,
				structuralValidation: { status: "failed", code, message },
				provenanceValidation: { status: "not-reached" },
			};
		}

		if (isProvenance) {
			return {
				valid: false,
				trustVerified: true,
				structuralValidation: { status: "passed" },
				provenanceValidation: { status: "failed", code, message },
			};
		}

		// Unknown codes: both failed (conservative)
		return {
			valid: false,
			trustVerified: true,
			structuralValidation: { status: "failed", code, message },
			provenanceValidation: { status: "not-reached" },
		};
	}

	return {
		valid: true,
		trustVerified: true,
		structuralValidation: { status: "passed" },
		provenanceValidation: { status: "passed" },
	};
}

// =============================================================================
// Add evidence to ledger — increments revision
// =============================================================================

export function addLedgerEvidence(
	contract: MissionContractV1,
	ledger: RequirementLedgerV1,
	request: LedgerEvidenceRequest,
	context?: TrustedLedgerMutationContext,
	validationContext?: TrustedValidationContext,
): OperationResult<RequirementLedgerV1> {
	const ctx = context ?? getUntrustedContext();

	if (request.expectedRevision !== ledger.revision) {
		return {
			ok: false,
			error: `Stale revision: expected ${request.expectedRevision}, current ${ledger.revision}`,
			code: "STALE_REVISION",
		};
	}

	// Validate ledger (structural only — pre-condition for evidence)
	const valid = validateRequirementLedgerStructure(contract, ledger);
	if (!valid.ok) {
		return { ok: false, error: valid.error ?? "Invalid ledger", code: valid.code ?? "INVALID_LEDGER" };
	}

	if (ledger.evidence.some((e) => e.id === request.evidence.id)) {
		return {
			ok: false,
			error: `Duplicate evidence id: ${request.evidence.id}`,
			code: "DUPLICATE_EVIDENCE_ID",
		};
	}

	const effectiveAuthority = deriveEffectiveAuthority(ctx, request.evidence.type);

	const contractReqs = new Set(contract.requirements.map((r) => r.id));
	for (const reqId of request.evidence.requirementIds) {
		if (!contractReqs.has(reqId)) {
			return {
				ok: false,
				error: `Evidence references unknown requirement: ${reqId}`,
				code: "UNKNOWN_REQUIREMENT",
			};
		}
	}

	const newRevision = ledger.revision + 1;

	const evidenceRecord: LedgerEvidenceRecord = {
		id: request.evidence.id,
		type: request.evidence.type,
		requirementIds: request.evidence.requirementIds,
		criterionIds: request.evidence.criterionIds,
		status: request.evidence.status,
		source: request.evidence.source,
		summary: request.evidence.summary,
		digest: request.evidence.digest,
		claimText: request.evidence.claimText,

		reportedCollectorType: request.evidence.reportedCollectorType ?? "agent",
		reportedAuthority: request.evidence.reportedAuthority ?? false,

		effectiveAuthority,
		verifiedPrincipalId: ctx.principalId,
		verifiedPrincipalKind: ctx.principalKind,
		verifiedCapability:
			effectiveAuthority !== "agent-claim" ? deriveCapabilityFromAuthority(effectiveAuthority) : undefined,

		addedAtRevision: newRevision,
		metadata: request.evidence.metadata,
	};

	const newLedger: RequirementLedgerV1 = {
		...ledger,
		revision: newRevision,
		evidence: [...ledger.evidence, evidenceRecord],
	};

	// =========================================================================
	// MUTATION CLOSURE GATE — authoritative evidence insertion
	// Privileged operations MUST have a genuine TrustedValidationContext.
	// =========================================================================
	if (effectiveAuthority !== "agent-claim") {
		if (!validationContext || !isTrustedValidationContext(validationContext)) {
			return {
				ok: false,
				error: "A genuine TrustedValidationContext is required for authoritative evidence insertion",
				code: "TRUSTED_VALIDATION_CONTEXT_REQUIRED",
			};
		}
		const closureResult = validateRequirementLedger(contract, newLedger, validationContext);
		if (!closureResult.ok) {
			return {
				ok: false,
				error: `Mutation closure replay failed: ${closureResult.error}`,
				code: "INTERNAL_REPLAY_INVARIANT_VIOLATION",
			};
		}
	}

	return { ok: true, value: newLedger };
}

// =============================================================================
// Apply transition to ledger — increments revision
// =============================================================================

export function applyRequirementTransition(
	contract: MissionContractV1,
	ledger: RequirementLedgerV1,
	request: TransitionRequest,
	context?: TrustedLedgerMutationContext,
	validationContext?: TrustedValidationContext,
): OperationResult<RequirementLedgerV1> {
	const ctx = context ?? getUntrustedContext();

	if (!request.transitionId || request.transitionId.trim().length === 0) {
		return {
			ok: false,
			error: "transitionId is required (must be non-empty)",
			code: "DUPLICATE_TRANSITION_ID",
		};
	}

	if (request.expectedRevision !== ledger.revision) {
		return {
			ok: false,
			error: `Stale revision: expected ${request.expectedRevision}, current ${ledger.revision}`,
			code: "STALE_REVISION",
		};
	}

	// Validate ledger (structural only — pre-condition for transition)
	const valid = validateRequirementLedgerStructure(contract, ledger);
	if (!valid.ok) {
		return { ok: false, error: valid.error ?? "Invalid ledger", code: valid.code ?? "INVALID_LEDGER" };
	}

	if (ledger.transitions.some((t) => t.id === request.transitionId)) {
		return {
			ok: false,
			error: `Duplicate transition id: ${request.transitionId}`,
			code: "DUPLICATE_TRANSITION_ID",
		};
	}

	const entryIdx = ledger.requirements.findIndex((r) => r.requirementId === request.requirementId);
	if (entryIdx === -1) {
		return {
			ok: false,
			error: `Unknown requirement: ${request.requirementId}`,
			code: "UNKNOWN_REQUIREMENT",
		};
	}

	const currentEntry = ledger.requirements[entryIdx];
	const currentStatus = currentEntry.status;

	const policy = validateTransition(currentStatus, request);
	if (!policy.permitted) {
		return {
			ok: false,
			error: policy.reason ?? "Transition not permitted",
			code: "INVALID_TRANSITION",
		};
	}

	const authCheck = authorizeTransition(currentStatus, request, ctx);
	if (!authCheck.permitted) {
		return {
			ok: false,
			error: authCheck.reason ?? "Transition not authorized",
			code: "TRUSTED_CONTEXT_REQUIRED",
		};
	}

	const newRevision = ledger.revision + 1;
	for (const evId of request.evidenceIds) {
		const ev = ledger.evidence.find((e) => e.id === evId);
		if (!ev) {
			return {
				ok: false,
				error: `Evidence ${evId} not found in ledger`,
				code: "UNKNOWN_EVIDENCE",
			};
		}
		if (ev.addedAtRevision >= newRevision) {
			return {
				ok: false,
				error: `Evidence ${evId} added at revision ${ev.addedAtRevision} — must exist before transition at revision ${newRevision}`,
				code: "INVALID_TRANSITION",
			};
		}
	}

	if (request.toStatus === "SATISFIED") {
		const authCheck2 = isSatisfactionAuthorized(request, ledger, contract, ctx);
		if (!authCheck2.permitted) {
			return {
				ok: false,
				error: authCheck2.reason ?? "Satisfaction not authorized",
				code: "SELF_AUTH_SATISFIED",
			};
		}

		const freshnessCheck = checkEvidenceFreshnessAfterRegression(
			request,
			ledger,
			contract,
			currentEntry.latestRegressionRevision,
		);
		if (!freshnessCheck.permitted) {
			return {
				ok: false,
				error: freshnessCheck.reason ?? "Evidence not fresh after regression",
				code: "STALE_EVIDENCE_AFTER_REGRESSION",
			};
		}
	}

	if (request.toStatus === "NOT_APPLICABLE" && !request.reason) {
		return {
			ok: false,
			error: "Transition to NOT_APPLICABLE requires a reason",
			code: "NOT_APPLICABLE_AUTHORITY",
		};
	}

	const transition: RequirementTransition = {
		id: request.transitionId,
		ledgerRevisionBefore: ledger.revision,
		ledgerRevisionAfter: newRevision,
		requirementId: request.requirementId,
		fromStatus: currentStatus,
		toStatus: request.toStatus,

		reportedActorType: request.reportedActorType ?? "agent",
		reportedActorId: request.reportedActorId,

		verifiedPrincipalId: ctx.principalId,
		verifiedPrincipalKind: ctx.principalKind,
		verifiedCapability:
			request.toStatus === "SATISFIED"
				? "transition:satisfy"
				: request.toStatus === "NOT_APPLICABLE" && currentStatus !== "UNASSESSED"
					? "transition:not-applicable"
					: undefined,

		reason: request.reason,
		evidenceIds: request.evidenceIds,
		blockerReference: request.blockerReference,
		metadata: request.metadata,
	};

	const newEntries = [...ledger.requirements];
	const updatedEntry: RequirementLedgerEntry = {
		...currentEntry,
		status: request.toStatus,
	};

	if (currentStatus === "SATISFIED" && request.toStatus !== "SATISFIED") {
		updatedEntry.latestRegressionRevision = newRevision;
	}

	newEntries[entryIdx] = updatedEntry;

	const newLedger: RequirementLedgerV1 = {
		...ledger,
		revision: newRevision,
		requirements: newEntries,
		transitions: [...ledger.transitions, transition],
	};

	// =========================================================================
	// MUTATION CLOSURE GATE
	// After a privileged mutation (SATISFIED, regression, NOT_APPLICABLE),
	// validate the returned ledger through authoritative replay before
	// returning success. This ensures any accepted mutation produces a
	// ledger that immediately passes strict authoritative validation
	// under the same trusted context.
	// Privileged operations MUST have a genuine TrustedValidationContext.
	// =========================================================================
	const isPrivileged =
		request.toStatus === "SATISFIED" ||
		String(currentStatus) === "SATISFIED" ||
		request.toStatus === "NOT_APPLICABLE";

	if (isPrivileged) {
		if (!validationContext || !isTrustedValidationContext(validationContext)) {
			return {
				ok: false,
				error: "A genuine TrustedValidationContext is required for privileged transitions",
				code: "TRUSTED_VALIDATION_CONTEXT_REQUIRED",
			};
		}
		const closureResult = validateRequirementLedger(contract, newLedger, validationContext);
		if (!closureResult.ok) {
			return {
				ok: false,
				error: `Mutation closure replay failed: ${closureResult.error}`,
				code: "INTERNAL_REPLAY_INVARIANT_VIOLATION",
			};
		}
	}

	return { ok: true, value: newLedger };
}

// =============================================================================
// Helpers
// =============================================================================

function deriveCapabilityFromAuthority(authority: string): string | undefined {
	switch (authority) {
		case "test-result":
			return "evidence:test-result";
		case "command-result":
			return "evidence:command-result";
		case "repository-observation":
			return "evidence:repository-observation";
		case "runtime-observation":
			return "evidence:runtime-observation";
		case "operator-confirmation":
			return "evidence:operator-confirmation";
		case "trusted-collector":
			return "evidence:trusted-collector";
		default:
			return undefined;
	}
}

function capabilityToAuthoritySimple(capability: string): string | undefined {
	switch (capability) {
		case "evidence:repository-observation":
			return "repository-observation";
		case "evidence:command-result":
			return "command-result";
		case "evidence:test-result":
			return "test-result";
		case "evidence:runtime-observation":
			return "runtime-observation";
		case "evidence:operator-confirmation":
			return "operator-confirmation";
		case "evidence:trusted-collector":
			return "trusted-collector";
		default:
			return undefined;
	}
}
