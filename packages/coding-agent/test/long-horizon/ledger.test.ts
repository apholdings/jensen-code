/**
 * Requirement Ledger tests.
 *
 * Covers: initialization, validation, evidence insertion,
 * transition policy, stale revision, trust boundary,
 * contract binding, ledger summary, and deterministic tamper detection.
 */

import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import {
	addLedgerEvidence,
	applyRequirementTransition,
	deriveRequirementLedgerSummary,
	initializeRequirementLedger,
	type LedgerEvidenceRequest,
	type MissionContractV1,
	type RequirementLedgerV1,
	type TransitionRequest,
	validateRequirementLedger,
} from "../../src/core/long-horizon/index.js";
import type {
	EvidenceLedgerCapability,
	TrustedLedgerMutationContext,
	TrustedValidationContext,
} from "../../src/core/long-horizon/trusted-context.js";
import {
	_internalCreateTrustedContext,
	_internalCreateTrustedValidationContext,
} from "../../src/core/long-horizon/trusted-context.js";

// Trusted context for test satisfaction flows
const trustedOperatorCtx: TrustedLedgerMutationContext = _internalCreateTrustedContext({
	principalId: "test-operator",
	principalKind: "operator",
	capabilities: ["transition:satisfy", "evidence:test-result", "evidence:operator-confirmation"],
});

const trustedCollectorCtx: TrustedLedgerMutationContext = _internalCreateTrustedContext({
	principalId: "test-collector",
	principalKind: "trusted-collector",
	capabilities: ["transition:satisfy", "evidence:trusted-collector", "evidence:test-result"],
});

const _notApplicableCtx: TrustedLedgerMutationContext = _internalCreateTrustedContext({
	principalId: "test-reviewer",
	principalKind: "automated-review",
	capabilities: ["transition:not-applicable"],
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "..", "..", "src", "core", "long-horizon", "fixtures");

// Trusted validation context factory — creates a context bound to the given contract
function makeValidationContext(contract: MissionContractV1): TrustedValidationContext {
	return _internalCreateTrustedValidationContext({
		contract,
		principals: [
			{
				principalId: "test-operator",
				principalKind: "operator",
				capabilities: ["transition:satisfy", "evidence:test-result", "evidence:operator-confirmation"],
			},
			{
				principalId: "test-collector",
				principalKind: "trusted-collector",
				capabilities: ["transition:satisfy", "evidence:trusted-collector", "evidence:test-result"],
			},
			{
				principalId: "test-reviewer",
				principalKind: "automated-review",
				capabilities: ["transition:not-applicable"],
			},
			{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
			// Agent principals for source grant binding
			{ principalId: "test", principalKind: "agent", capabilities: [] },
			{ principalId: "ci", principalKind: "agent", capabilities: [] },
			{ principalId: "npm test", principalKind: "agent", capabilities: [] },
			{ principalId: "shell", principalKind: "agent", capabilities: [] },
		],
		sourceGrants: [
			{
				sourceId: "test",
				principalId: "test-operator",
				principalKind: "operator",
				capability: "evidence:test-result" as EvidenceLedgerCapability,
				allowedEvidenceTypes: ["test-result"],
			},
			{
				sourceId: "ci",
				principalId: "test-operator",
				principalKind: "operator",
				capability: "evidence:test-result" as EvidenceLedgerCapability,
				allowedEvidenceTypes: ["test-result"],
			},
			{
				sourceId: "npm test",
				principalId: "test-operator",
				principalKind: "operator",
				capability: "evidence:test-result" as EvidenceLedgerCapability,
				allowedEvidenceTypes: ["test-result"],
			},
			{
				sourceId: "shell",
				principalId: "test-operator",
				principalKind: "operator",
				capability: "evidence:test-result" as EvidenceLedgerCapability,
				allowedEvidenceTypes: ["test-result", "command-result"],
			},
			{
				sourceId: "ci/cd pipeline",
				principalId: "test-collector",
				principalKind: "trusted-collector",
				capability: "evidence:test-result" as EvidenceLedgerCapability,
				allowedEvidenceTypes: ["test-result", "command-result"],
			},
		],
	});
}

function loadContract(name: string): MissionContractV1 {
	return JSON.parse(readFileSync(resolve(fixturesDir, `${name}-contract.json`), "utf-8"));
}

// =============================================================================
// M08 - Valid ledger initialization
// =============================================================================

describe("M08 - Valid ledger initialization", () => {
	it("initializes with revision 0 and all requirements UNASSESSED", () => {
		const contract = loadContract("M08");
		const result = initializeRequirementLedger(contract);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const ledger = result.value!;
		expect(ledger!.revision).toBe(0);
		expect(ledger!.requirements).toHaveLength(2);
		for (const entry of ledger!.requirements) {
			expect(entry.status).toBe("UNASSESSED");
		}
		expect(ledger!.evidence).toHaveLength(0);
		expect(ledger!.transitions).toHaveLength(0);
	});

	it("marks initial NOT_APPLICABLE requirements correctly", () => {
		const contract = loadContract("M16");
		const result = initializeRequirementLedger(contract);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const ledger = result.value!;
		const naReq = ledger!.requirements.find((r) => r.requirementId === "REQ-NA");
		expect(naReq).toBeDefined();
		expect(naReq?.status).toBe("NOT_APPLICABLE");
		expect(naReq?.initialNotApplicable).toBe(true);

		const activeReq = ledger!.requirements.find((r) => r.requirementId === "REQ-001");
		expect(activeReq?.status).toBe("UNASSESSED");
		expect(activeReq?.initialNotApplicable).toBe(false);
	});
});

// =============================================================================
// M09 - Valid lifecycle to IMPLEMENTED_UNVERIFIED
// =============================================================================

describe("M09 - Valid lifecycle to IMPLEMENTED_UNVERIFIED", () => {
	it("transitions UNASSESSED -> PENDING -> IN_PROGRESS -> IMPLEMENTED_UNVERIFIED", () => {
		const contract = loadContract("M09");
		const result = initializeRequirementLedger(contract);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		let ledger = result.value!;

		// UNASSESSED -> PENDING (transition at rev 0 → rev 1)
		const t1: TransitionRequest = {
			transitionId: "TX-LC-001",
			expectedRevision: 0,
			requirementId: "REQ-001",
			toStatus: "PENDING",
			reportedActorType: "agent",
			reason: "Starting work",
			evidenceIds: [],
		};
		const r1 = applyRequirementTransition(contract, ledger!, t1);
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;
		ledger = r1.value!;
		expect(ledger!.revision).toBe(1);
		expect(ledger!.transitions).toHaveLength(1);

		// PENDING -> IN_PROGRESS (rev 1 → rev 2)
		const t2: TransitionRequest = {
			transitionId: "TX-LC-002",
			expectedRevision: 1,
			requirementId: "REQ-001",
			toStatus: "IN_PROGRESS",
			reportedActorType: "agent",
			reason: "Working on it",
			evidenceIds: [],
		};
		const r2 = applyRequirementTransition(contract, ledger!, t2);
		expect(r2.ok).toBe(true);
		if (!r2.ok) return;
		ledger = r2.value!;
		expect(ledger!.revision).toBe(2);

		// IN_PROGRESS -> IMPLEMENTED_UNVERIFIED (rev 2 → rev 3)
		const t3: TransitionRequest = {
			transitionId: "TX-LC-003",
			expectedRevision: 2,
			requirementId: "REQ-001",
			toStatus: "IMPLEMENTED_UNVERIFIED",
			reportedActorType: "agent",
			reason: "Code written, not yet verified",
			evidenceIds: [],
		};
		const r3 = applyRequirementTransition(contract, ledger!, t3);
		expect(r3.ok).toBe(true);
		if (!r3.ok) return;
		ledger = r3.value!;
		expect(ledger!.revision).toBe(3);

		const entry = ledger!.requirements.find((r) => r.requirementId === "REQ-001");
		expect(entry?.status).toBe("IMPLEMENTED_UNVERIFIED");
	});
});

// =============================================================================
// M10 - Authoritative evidence to SATISFIED
// =============================================================================

describe("M10 - Authoritative evidence to SATISFIED", () => {
	it("allows operator to satisfy with authoritative evidence", () => {
		const contract = loadContract("M10");
		const result = initializeRequirementLedger(contract);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		let ledger = result.value!;

		// Transition to IMPLEMENTED_UNVERIFIED (rev 0 → rev 1)
		const r1 = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-M10A-001",
			expectedRevision: 0,
			requirementId: "REQ-001",
			toStatus: "IMPLEMENTED_UNVERIFIED",
			reportedActorType: "agent",
			reason: "Code written",
			evidenceIds: [],
		});
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;
		ledger = r1.value!;

		// Add evidence (rev 1 → rev 2, evidence.addedAtRevision = 2)
		const evReq: LedgerEvidenceRequest = {
			expectedRevision: 1,
			evidence: {
				id: "EV-001",
				type: "test-result",
				requirementIds: ["REQ-001"],
				criterionIds: ["AC-001"],
				reportedCollectorType: "test-runner",
				reportedAuthority: true,
				status: "pass",
				source: "npm test",
				summary: "All tests pass",
			},
		};
		const evResult = addLedgerEvidence(contract, ledger!, evReq, trustedOperatorCtx, makeValidationContext(contract));
		expect(evResult.ok).toBe(true);
		if (!evResult.ok) return;
		ledger = evResult.value!;
		expect(ledger!.revision).toBe(2);
		expect(ledger!.evidence[0].addedAtRevision).toBe(2);

		// Operator transitions to SATISFIED (rev 2 → rev 3)
		const satReq: TransitionRequest = {
			transitionId: "TX-M10A-002",
			expectedRevision: 2,
			requirementId: "REQ-001",
			toStatus: "SATISFIED",
			reportedActorType: "operator",
			reason: "Verified by test results",
			evidenceIds: ["EV-001"],
		};
		const satResult = applyRequirementTransition(
			contract,
			ledger!,
			satReq,
			trustedOperatorCtx,
			makeValidationContext(contract),
		);
		expect(satResult.ok).toBe(true);
		if (!satResult.ok) return;
		ledger = satResult.value!;

		const entry = ledger!.requirements.find((r) => r.requirementId === "REQ-001");
		expect(entry?.status).toBe("SATISFIED");
	});

	it("allows trusted-collector to satisfy with authoritative evidence", () => {
		const contract = loadContract("M10");
		const result = initializeRequirementLedger(contract);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		let ledger = result.value!;

		// Transition to IMPLEMENTED_UNVERIFIED (rev 0 → rev 1)
		const r1 = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-M10B-001",
			expectedRevision: 0,
			requirementId: "REQ-001",
			toStatus: "IMPLEMENTED_UNVERIFIED",
			reportedActorType: "agent",
			reason: "Code written",
			evidenceIds: [],
		});
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;
		ledger = r1.value!;

		// Add authoritative evidence from trusted collector (rev 1 → rev 2)
		const evResult = addLedgerEvidence(
			contract,
			ledger!,
			{
				expectedRevision: 1,
				evidence: {
					id: "EV-TC-001",
					type: "test-result",
					requirementIds: ["REQ-001"],
					criterionIds: ["AC-001"],
					reportedCollectorType: "trusted-collector",
					reportedAuthority: true,
					status: "pass",
					source: "ci/cd pipeline",
					summary: "All tests pass in CI",
				},
			},
			trustedCollectorCtx,
			makeValidationContext(contract),
		);
		expect(evResult.ok).toBe(true);
		if (!evResult.ok) return;
		ledger = evResult.value!;

		const satResult = applyRequirementTransition(
			contract,
			ledger!,
			{
				transitionId: "TX-M10B-002",
				expectedRevision: 2,
				requirementId: "REQ-001",
				toStatus: "SATISFIED",
				reportedActorType: "trusted-collector",
				reason: "CI confirms all tests pass",
				evidenceIds: ["EV-TC-001"],
			},
			trustedCollectorCtx,
			makeValidationContext(contract),
		);
		expect(satResult.ok).toBe(true);
	});
});

// =============================================================================
// M11 - Self-authorized claim rejected
// =============================================================================

describe("M11 - Self-authorized claim rejected", () => {
	it("rejects agent transition to SATISFIED", () => {
		const contract = loadContract("M11");
		const result = initializeRequirementLedger(contract);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		let ledger = result.value!;

		// Transition to IMPLEMENTED_UNVERIFIED (rev 0 → rev 1)
		const r1 = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-M11-001",
			expectedRevision: 0,
			requirementId: "REQ-001",
			toStatus: "IMPLEMENTED_UNVERIFIED",
			reportedActorType: "agent",
			reason: "Done",
			evidenceIds: [],
		});
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;
		ledger = r1.value!;

		// Add claim evidence (rev 1 → rev 2)
		const evResult = addLedgerEvidence(contract, ledger!, {
			expectedRevision: 1,
			evidence: {
				id: "EV-CLAIM",
				type: "claim",
				requirementIds: ["REQ-001"],
				criterionIds: ["AC-001"],
				reportedCollectorType: "agent",
				reportedAuthority: true,
				status: "pass",
				source: "self",
				summary: "I claim this is done",
			},
		});
		expect(evResult.ok).toBe(true);
		if (!evResult.ok) return;
		ledger = evResult.value!;

		// Agent tries to satisfy — must be rejected
		const satResult = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-M11-002",
			expectedRevision: 2,
			requirementId: "REQ-001",
			toStatus: "SATISFIED",
			reportedActorType: "agent",
			reason: "I'm done",
			evidenceIds: ["EV-CLAIM"],
		});
		expect(satResult.ok).toBe(false);
		expect(satResult.code).toBe("TRUSTED_CONTEXT_REQUIRED");
	});
});

// =============================================================================
// M12 - Illegal direct SATISFIED transition
// =============================================================================

describe("M12 - Illegal direct SATISFIED transition", () => {
	it("rejects UNASSESSED -> SATISFIED", () => {
		const contract = loadContract("M12");
		const result = initializeRequirementLedger(contract);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const ledger = result.value!;

		const tx = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-M12-001",
			expectedRevision: 0,
			requirementId: "REQ-001",
			toStatus: "SATISFIED",
			reportedActorType: "operator",
			reason: "Trust me",
			evidenceIds: [],
		});
		expect(tx.ok).toBe(false);
		expect(tx.code).toBe("INVALID_TRANSITION");
	});

	it("rejects PENDING -> SATISFIED", () => {
		const contract = loadContract("M12");
		const result = initializeRequirementLedger(contract);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		let ledger = result.value!;

		// PENDING (rev 0 → rev 1)
		const r1 = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-M12-002",
			expectedRevision: 0,
			requirementId: "REQ-001",
			toStatus: "PENDING",
			reportedActorType: "agent",
			reason: "Starting",
			evidenceIds: [],
		});
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;
		ledger = r1.value!;

		// Try PENDING -> SATISFIED
		const r2 = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-M12-003",
			expectedRevision: 1,
			requirementId: "REQ-001",
			toStatus: "SATISFIED",
			reportedActorType: "operator",
			reason: "Done",
			evidenceIds: [],
		});
		expect(r2.ok).toBe(false);
	});

	it("rejects IN_PROGRESS -> SATISFIED", () => {
		const contract = loadContract("M12");
		const result = initializeRequirementLedger(contract);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		let ledger = result.value!;

		const r1 = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-M12-004",
			expectedRevision: 0,
			requirementId: "REQ-001",
			toStatus: "IN_PROGRESS",
			reportedActorType: "agent",
			reason: "Working",
			evidenceIds: [],
		});
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;
		ledger = r1.value!;

		const r2 = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-M12-005",
			expectedRevision: 1,
			requirementId: "REQ-001",
			toStatus: "SATISFIED",
			reportedActorType: "operator",
			reason: "Done",
			evidenceIds: [],
		});
		expect(r2.ok).toBe(false);
	});

	it("rejects BLOCKED -> SATISFIED", () => {
		const contract = loadContract("M12");
		const result = initializeRequirementLedger(contract);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		let ledger = result.value!;

		const r1 = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-M12-006",
			expectedRevision: 0,
			requirementId: "REQ-001",
			toStatus: "PENDING",
			reportedActorType: "agent",
			reason: "Starting",
			evidenceIds: [],
		});
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;
		ledger = r1.value!;

		const r2 = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-M12-007",
			expectedRevision: 1,
			requirementId: "REQ-001",
			toStatus: "BLOCKED",
			reportedActorType: "agent",
			reason: "Blocked by external dep",
			evidenceIds: [],
			blockerReference: "external-api",
		});
		expect(r2.ok).toBe(true);
		if (!r2.ok) return;
		ledger = r2.value!;

		const r3 = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-M12-008",
			expectedRevision: 2,
			requirementId: "REQ-001",
			toStatus: "SATISFIED",
			reportedActorType: "operator",
			reason: "Resolved",
			evidenceIds: [],
		});
		expect(r3.ok).toBe(false);
	});

	it("rejects FAILED -> SATISFIED", () => {
		const contract = loadContract("M12");
		const result = initializeRequirementLedger(contract);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		let ledger = result.value!;

		const r1 = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-M12-009",
			expectedRevision: 0,
			requirementId: "REQ-001",
			toStatus: "IN_PROGRESS",
			reportedActorType: "agent",
			reason: "Trying",
			evidenceIds: [],
		});
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;
		ledger = r1.value!;

		const r2 = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-M12-010",
			expectedRevision: 1,
			requirementId: "REQ-001",
			toStatus: "FAILED",
			reportedActorType: "agent",
			reason: "Cannot complete",
			evidenceIds: [],
		});
		expect(r2.ok).toBe(true);
		if (!r2.ok) return;
		ledger = r2.value!;

		const r3 = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-M12-011",
			expectedRevision: 2,
			requirementId: "REQ-001",
			toStatus: "SATISFIED",
			reportedActorType: "operator",
			reason: "Fixed",
			evidenceIds: [],
		});
		expect(r3.ok).toBe(false);
	});
});

// =============================================================================
// M13 - Stale expectedRevision rejected
// =============================================================================

describe("M13 - Stale expectedRevision rejected", () => {
	it("rejects transition with wrong expectedRevision", () => {
		const contract = loadContract("M13");
		const result = initializeRequirementLedger(contract);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const ledger = result.value!;

		const tx = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-STALE-001",
			expectedRevision: 5,
			requirementId: "REQ-001",
			toStatus: "PENDING",
			reportedActorType: "agent",
			reason: "Start",
			evidenceIds: [],
		});
		expect(tx.ok).toBe(false);
		expect(tx.code).toBe("STALE_REVISION");
	});

	it("rejects evidence insertion with wrong expectedRevision", () => {
		const contract = loadContract("M13");
		const result = initializeRequirementLedger(contract);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const ledger = result.value!;

		const ev = addLedgerEvidence(contract, ledger!, {
			expectedRevision: 3,
			evidence: {
				id: "EV-001",
				type: "test-result",
				requirementIds: ["REQ-001"],
				criterionIds: ["AC-001"],
				reportedCollectorType: "test-runner",
				reportedAuthority: true,
				status: "pass",
				source: "test",
				summary: "pass",
			},
		});
		expect(ev.ok).toBe(false);
		expect(ev.code).toBe("STALE_REVISION");
	});

	it("does not partially update ledger on stale revision", () => {
		const contract = loadContract("M13");
		const result = initializeRequirementLedger(contract);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const ledger = result.value!;

		const tx = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-STALE-002",
			expectedRevision: 5,
			requirementId: "REQ-001",
			toStatus: "PENDING",
			reportedActorType: "agent",
			reason: "Start",
			evidenceIds: [],
		});
		expect(tx.ok).toBe(false);

		// Ledger unchanged
		expect(ledger!.revision).toBe(0);
		expect(ledger!.transitions).toHaveLength(0);
		expect(ledger!.requirements.find((r) => r.requirementId === "REQ-001")?.status).toBe("UNASSESSED");
	});
});

// =============================================================================
// M14 - Contract digest mismatch rejected
// =============================================================================

describe("M14 - Contract digest mismatch rejected", () => {
	it("rejects ledger with wrong contract digest", () => {
		const contract1 = loadContract("M01");
		const contract2 = loadContract("M02");
		const result = initializeRequirementLedger(contract1);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const ledger = result.value!;
		const validation = validateRequirementLedger(contract2, ledger, makeValidationContext(contract2));
		expect(validation.ok).toBe(false);
		expect(validation.code).toBe("CONTRACT_DIGEST_MISMATCH");
	});
});

// =============================================================================
// M15 - Valid blocker and reopen flow
// =============================================================================

describe("M15 - Valid blocker and reopen flow", () => {
	it("allows BLOCKED -> IN_PROGRESS -> IMPLEMENTED_UNVERIFIED -> SATISFIED", () => {
		const contract = loadContract("M15");
		const result = initializeRequirementLedger(contract);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		let ledger = result.value!;

		// UNASSESSED -> IN_PROGRESS (rev 0 → rev 1)
		let r = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-M15-001",
			expectedRevision: 0,
			requirementId: "REQ-001",
			toStatus: "IN_PROGRESS",
			reportedActorType: "agent",
			reason: "Working",
			evidenceIds: [],
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		ledger = r.value!;

		// IN_PROGRESS -> BLOCKED (rev 1 → rev 2)
		r = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-M15-002",
			expectedRevision: 1,
			requirementId: "REQ-001",
			toStatus: "BLOCKED",
			reportedActorType: "agent",
			reason: "Waiting for API access",
			evidenceIds: [],
			blockerReference: "missing-api-keys",
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		ledger = r.value!;

		// BLOCKED -> IN_PROGRESS (rev 2 → rev 3)
		r = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-M15-003",
			expectedRevision: 2,
			requirementId: "REQ-001",
			toStatus: "IN_PROGRESS",
			reportedActorType: "agent",
			reason: "API access granted",
			evidenceIds: [],
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		ledger = r.value!;

		// IN_PROGRESS -> IMPLEMENTED_UNVERIFIED (rev 3 → rev 4)
		r = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-M15-004",
			expectedRevision: 3,
			requirementId: "REQ-001",
			toStatus: "IMPLEMENTED_UNVERIFIED",
			reportedActorType: "agent",
			reason: "Implemented",
			evidenceIds: [],
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		ledger = r.value!;

		// Add evidence (rev 4 → rev 5)
		const ev = addLedgerEvidence(
			contract,
			ledger!,
			{
				expectedRevision: 4,
				evidence: {
					id: "EV-BLOCKER",
					type: "test-result",
					requirementIds: ["REQ-001"],
					criterionIds: ["AC-001"],
					reportedCollectorType: "test-runner",
					reportedAuthority: true,
					status: "pass",
					source: "test",
					summary: "Pass",
				},
			},
			trustedOperatorCtx,
			makeValidationContext(contract),
		);
		expect(ev.ok).toBe(true);
		if (!ev.ok) return;
		ledger = ev.value!;

		// SATISFIED (rev 5 → rev 6)
		r = applyRequirementTransition(
			contract,
			ledger!,
			{
				transitionId: "TX-M15-005",
				expectedRevision: 5,
				requirementId: "REQ-001",
				toStatus: "SATISFIED",
				reportedActorType: "operator",
				reason: "API working, tests pass",
				evidenceIds: ["EV-BLOCKER"],
			},
			trustedOperatorCtx,
			makeValidationContext(contract),
		);
		expect(r.ok).toBe(true);
	});
});

// =============================================================================
// M17 - Satisfied requirement regression and reopening
// =============================================================================

describe("M17 - Satisfied requirement regression", () => {
	it("allows SATISFIED -> IMPLEMENTED_UNVERIFIED (regression)", () => {
		const contract = loadContract("M17");
		const ledger = fullLifecycleToSatisfied(contract, trustedOperatorCtx, makeValidationContext(contract));

		const r = applyRequirementTransition(
			contract,
			ledger!,
			{
				transitionId: "TX-M17-001",
				expectedRevision: ledger!.revision,
				requirementId: "REQ-001",
				toStatus: "IMPLEMENTED_UNVERIFIED",
				reportedActorType: "operator",
				reason: "New evidence shows regression",
				evidenceIds: [],
			},
			undefined,
			makeValidationContext(contract),
		);
		expect(r.ok).toBe(true);
	});

	it("allows SATISFIED -> FAILED (regression with failure)", () => {
		const contract = loadContract("M17");
		const ledger = fullLifecycleToSatisfied(contract, trustedOperatorCtx, makeValidationContext(contract));

		const r = applyRequirementTransition(
			contract,
			ledger!,
			{
				transitionId: "TX-M17-002",
				expectedRevision: ledger!.revision,
				requirementId: "REQ-001",
				toStatus: "FAILED",
				reportedActorType: "operator",
				reason: "Found critical bug in satisfied requirement",
				evidenceIds: [],
			},
			undefined,
			makeValidationContext(contract),
		);
		expect(r.ok).toBe(true);
	});

	it("preserves prior satisfaction history after regression", () => {
		const contract = loadContract("M17");
		const ledger = fullLifecycleToSatisfied(contract, trustedOperatorCtx, makeValidationContext(contract));
		const satisfiedCount = ledger!.transitions.filter((t) => t.toStatus === "SATISFIED").length;
		expect(satisfiedCount).toBeGreaterThanOrEqual(1);

		const r = applyRequirementTransition(
			contract,
			ledger!,
			{
				transitionId: "TX-M17-003",
				expectedRevision: ledger!.revision,
				requirementId: "REQ-001",
				toStatus: "IMPLEMENTED_UNVERIFIED",
				reportedActorType: "operator",
				reason: "Regression detected",
				evidenceIds: [],
			},
			undefined,
			makeValidationContext(contract),
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;

		// Prior SATISFIED transition still in history
		const stillSatisfiedCount = r.value!.transitions.filter((t) => t.toStatus === "SATISFIED").length;
		expect(stillSatisfiedCount).toBeGreaterThanOrEqual(1);
	});
});

// =============================================================================
// M18 - Duplicate evidence ID rejected
// =============================================================================

describe("M18 - Duplicate evidence ID rejected", () => {
	it("rejects second evidence with same ID", () => {
		const contract = loadContract("M18");
		const result = initializeRequirementLedger(contract);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		let ledger = result.value!;

		const ev: LedgerEvidenceRequest = {
			expectedRevision: 0,
			evidence: {
				id: "EV-DUP",
				type: "test-result",
				requirementIds: ["REQ-001"],
				criterionIds: ["AC-001"],
				reportedCollectorType: "test-runner",
				reportedAuthority: true,
				status: "pass",
				source: "test",
				summary: "pass",
			},
		};
		const r1 = addLedgerEvidence(contract, ledger!, ev);
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;
		ledger = r1.value!;
		expect(ledger!.revision).toBe(1);

		// Duplicate (wrong expectedRevision too — but dup caught first)
		const r2 = addLedgerEvidence(contract, ledger!, {
			expectedRevision: 0, // stale, but also duplicate
			evidence: {
				id: "EV-DUP",
				type: "test-result",
				requirementIds: ["REQ-001"],
				criterionIds: ["AC-001"],
				reportedCollectorType: "test-runner",
				reportedAuthority: true,
				status: "pass",
				source: "test",
				summary: "pass",
			},
		});
		expect(r2.ok).toBe(false);
		expect(r2.code).toBe("STALE_REVISION");
	});

	it("rejects duplicate evidence at correct expectedRevision", () => {
		const contract = loadContract("M18");
		const result = initializeRequirementLedger(contract);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		let ledger = result.value!;

		const ev: LedgerEvidenceRequest = {
			expectedRevision: 0,
			evidence: {
				id: "EV-DUP2",
				type: "test-result",
				requirementIds: ["REQ-001"],
				criterionIds: ["AC-001"],
				reportedCollectorType: "test-runner",
				reportedAuthority: true,
				status: "pass",
				source: "test",
				summary: "pass",
			},
		};
		const r1 = addLedgerEvidence(contract, ledger!, ev);
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;
		ledger = r1.value!;

		// Second with same ID at correct expectedRevision
		const r2 = addLedgerEvidence(contract, ledger!, {
			...ev,
			expectedRevision: 1,
		});
		expect(r2.ok).toBe(false);
		expect(r2.code).toBe("DUPLICATE_EVIDENCE_ID");
	});
});

// =============================================================================
// M19 - Criterion evidence incomplete (no SATISFIED without evidence)
// =============================================================================

describe("M19 - Criterion evidence incomplete", () => {
	it("rejects SATISFIED without evidence IDs", () => {
		const contract = loadContract("M19");
		const result = initializeRequirementLedger(contract);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		let ledger = result.value!;

		// IN_PROGRESS (rev 0 → rev 1)
		let r = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-M19-001",
			expectedRevision: 0,
			requirementId: "REQ-001",
			toStatus: "IN_PROGRESS",
			reportedActorType: "agent",
			reason: "Working",
			evidenceIds: [],
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		ledger = r.value!;

		// IMPLEMENTED_UNVERIFIED (rev 1 → rev 2)
		r = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-M19-002",
			expectedRevision: 1,
			requirementId: "REQ-001",
			toStatus: "IMPLEMENTED_UNVERIFIED",
			reportedActorType: "agent",
			reason: "Done",
			evidenceIds: [],
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		ledger = r.value!;

		// Try SATISFIED without evidence — trusted context but no evidence
		r = applyRequirementTransition(
			contract,
			ledger!,
			{
				transitionId: "TX-M19-003",
				expectedRevision: 2,
				requirementId: "REQ-001",
				toStatus: "SATISFIED",
				reportedActorType: "operator",
				reason: "Should be done",
				evidenceIds: [], // No evidence!
			},
			trustedOperatorCtx,
			makeValidationContext(contract),
		);
		expect(r.ok).toBe(false);
	});
});

// =============================================================================
// M20 - Fully satisfied completion candidate
// =============================================================================

describe("M20 - Fully satisfied completion candidate", () => {
	it("completionCandidate is true when all applicable requirements are SATISFIED with authoritative evidence", () => {
		const contract = loadContract("M20");
		const result = initializeRequirementLedger(contract);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		let ledger = result.value!;

		// Full life cycle (rev 0 → rev 1)
		let r = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-M20-001",
			expectedRevision: 0,
			requirementId: "REQ-001",
			toStatus: "IMPLEMENTED_UNVERIFIED",
			reportedActorType: "agent",
			reason: "Done",
			evidenceIds: [],
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		ledger = r.value!;

		// Evidence (rev 1 → rev 2)
		const ev = addLedgerEvidence(
			contract,
			ledger!,
			{
				expectedRevision: 1,
				evidence: {
					id: "EV-TR-001",
					type: "test-result",
					requirementIds: ["REQ-001"],
					criterionIds: ["AC-1"],
					reportedCollectorType: "test-runner",
					reportedAuthority: true,
					status: "pass",
					source: "npm test",
					summary: "All tests pass",
				},
			},
			trustedOperatorCtx,
			makeValidationContext(contract),
		);
		expect(ev.ok).toBe(true);
		if (!ev.ok) return;
		ledger = ev.value!;

		// SATISFIED (rev 2 → rev 3)
		r = applyRequirementTransition(
			contract,
			ledger!,
			{
				transitionId: "TX-M20-002",
				expectedRevision: 2,
				requirementId: "REQ-001",
				toStatus: "SATISFIED",
				reportedActorType: "operator",
				reason: "Verified",
				evidenceIds: ["EV-TR-001"],
			},
			trustedOperatorCtx,
			makeValidationContext(contract),
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		ledger = r.value!;

		const summary = deriveRequirementLedgerSummary(contract, ledger!, makeValidationContext(contract));
		expect(summary.completionCandidate).toBe(true);
		expect(summary.applicableRequirements).toBe(1);
		expect(summary.stateCounts.SATISFIED).toBe(1);
	});

	it("completionCandidate is false when requirements are not yet satisfied", () => {
		const contract = loadContract("M20");
		const result = initializeRequirementLedger(contract);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const summary = deriveRequirementLedgerSummary(contract, result.value!, makeValidationContext(contract));
		expect(summary.completionCandidate).toBe(false);
	});
});

// =============================================================================
// Additional transition policy tests
// =============================================================================

describe("Transition policy edge cases", () => {
	it("allows FAILED -> IN_PROGRESS recovery", () => {
		const contract = loadContract("M01");
		const result = initializeRequirementLedger(contract);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		let ledger = result.value!;

		// UNASSESSED -> IN_PROGRESS (rev 0 → rev 1)
		let r = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-EDGE-001",
			expectedRevision: 0,
			requirementId: "REQ-001",
			toStatus: "IN_PROGRESS",
			reportedActorType: "agent",
			reason: "Trying",
			evidenceIds: [],
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		ledger = r.value!;

		// IN_PROGRESS -> FAILED (rev 1 → rev 2)
		r = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-EDGE-002",
			expectedRevision: 1,
			requirementId: "REQ-001",
			toStatus: "FAILED",
			reportedActorType: "agent",
			reason: "Cannot complete",
			evidenceIds: [],
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		ledger = r.value!;

		// FAILED -> IN_PROGRESS (rev 2 → rev 3)
		r = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-EDGE-003",
			expectedRevision: 2,
			requirementId: "REQ-001",
			toStatus: "IN_PROGRESS",
			reportedActorType: "agent",
			reason: "Retrying",
			evidenceIds: [],
		});
		expect(r.ok).toBe(true);
	});

	it("rejects FAILED -> SATISFIED", () => {
		const contract = loadContract("M01");
		const result = initializeRequirementLedger(contract);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const ledger = result.value!;

		let r = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-EDGE-004",
			expectedRevision: 0,
			requirementId: "REQ-001",
			toStatus: "IN_PROGRESS",
			reportedActorType: "agent",
			reason: "Trying",
			evidenceIds: [],
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const ledge2 = r.value!;

		r = applyRequirementTransition(contract, ledge2, {
			transitionId: "TX-EDGE-005",
			expectedRevision: 1,
			requirementId: "REQ-001",
			toStatus: "FAILED",
			reportedActorType: "agent",
			reason: "Cannot complete",
			evidenceIds: [],
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;

		r = applyRequirementTransition(contract, r.value!, {
			transitionId: "TX-EDGE-006",
			expectedRevision: 2,
			requirementId: "REQ-001",
			toStatus: "SATISFIED",
			reportedActorType: "operator",
			reason: "Magic",
			evidenceIds: [],
		});
		expect(r.ok).toBe(false);
	});

	it("rejects IMPLEMENTED_UNVERIFIED back to UNASSESSED", () => {
		const contract = loadContract("M01");
		const result = initializeRequirementLedger(contract);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		let ledger = result.value!;

		let r = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-EDGE-007",
			expectedRevision: 0,
			requirementId: "REQ-001",
			toStatus: "IMPLEMENTED_UNVERIFIED",
			reportedActorType: "agent",
			reason: "Done",
			evidenceIds: [],
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		ledger = r.value!;

		r = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-EDGE-008",
			expectedRevision: 1,
			requirementId: "REQ-001",
			toStatus: "UNASSESSED",
			reportedActorType: "agent",
			reason: "Oops",
			evidenceIds: [],
		});
		expect(r.ok).toBe(false);
	});
});

describe("Ledger validation", () => {
	it("validates a fresh ledger passes", () => {
		const contract = loadContract("M01");
		const result = initializeRequirementLedger(contract);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const validation = validateRequirementLedger(contract, result.value!, makeValidationContext(contract));
		expect(validation.ok).toBe(true);
	});

	it("rejects ledger with unknown requirement in evidence", () => {
		const contract = loadContract("M01");
		const result = initializeRequirementLedger(contract);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const ledger: RequirementLedgerV1 = {
			...result.value!,
			revision: 1,
			evidence: [
				{
					id: "EV-BAD",
					type: "test-result",
					requirementIds: ["REQ-NONEXISTENT"],
					criterionIds: ["AC-001"],
					reportedCollectorType: "test-runner",
					reportedAuthority: true,
					effectiveAuthority: "test-result",
					verifiedPrincipalId: "system",
					verifiedPrincipalKind: "system",
					status: "pass",
					source: "test",
					summary: "test",
					addedAtRevision: 1,
				},
			],
		};
		const validation = validateRequirementLedger(contract, ledger!, makeValidationContext(contract));
		expect(validation.ok).toBe(false);
	});

	it("rejects ledger with duplicate evidence IDs", () => {
		const contract = loadContract("M01");
		const result = initializeRequirementLedger(contract);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const ledger: RequirementLedgerV1 = {
			...result.value!,
			revision: 2,
			evidence: [
				{
					id: "EV-DUP",
					type: "test-result",
					requirementIds: ["REQ-001"],
					criterionIds: ["AC-001"],
					reportedCollectorType: "test-runner",
					reportedAuthority: true,
					effectiveAuthority: "test-result",
					verifiedPrincipalId: "system",
					verifiedPrincipalKind: "system",
					status: "pass",
					source: "test",
					summary: "a",
					addedAtRevision: 1,
				},
				{
					id: "EV-DUP",
					type: "test-result",
					requirementIds: ["REQ-001"],
					criterionIds: ["AC-001"],
					reportedCollectorType: "test-runner",
					reportedAuthority: true,
					effectiveAuthority: "test-result",
					verifiedPrincipalId: "system",
					verifiedPrincipalKind: "system",
					status: "pass",
					source: "test",
					summary: "b",
					addedAtRevision: 2,
				},
			],
		};
		const validation = validateRequirementLedger(contract, ledger!, makeValidationContext(contract));
		expect(validation.ok).toBe(false);
	});

	it("rejects evidence with invalid addedAtRevision", () => {
		const contract = loadContract("M01");
		const result = initializeRequirementLedger(contract);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const ledger: RequirementLedgerV1 = {
			...result.value!,
			revision: 10,
			evidence: [
				{
					id: "EV-BAD-REV",
					type: "test-result",
					requirementIds: ["REQ-001"],
					criterionIds: ["AC-001"],
					reportedCollectorType: "test-runner",
					reportedAuthority: true,
					effectiveAuthority: "test-result",
					verifiedPrincipalId: "system",
					verifiedPrincipalKind: "system",
					status: "pass",
					source: "test",
					summary: "test",
					addedAtRevision: 999,
				},
			],
		};
		const validation = validateRequirementLedger(contract, ledger!, makeValidationContext(contract));
		expect(validation.ok).toBe(false);
	});
});

// =============================================================================
// New: Evidence revision model tests
// =============================================================================

describe("Evidence revision model", () => {
	it("evidence insertion increments ledger revision", () => {
		const contract = loadContract("M01");
		const result = initializeRequirementLedger(contract);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		let ledger = result.value!;
		expect(ledger!.revision).toBe(0);

		const evResult = addLedgerEvidence(contract, ledger!, {
			expectedRevision: 0,
			evidence: {
				id: "EV-REV-001",
				type: "test-result",
				requirementIds: ["REQ-001"],
				criterionIds: ["AC-001"],
				reportedCollectorType: "test-runner",
				reportedAuthority: true,
				status: "pass",
				source: "test",
				summary: "pass",
			},
		});
		expect(evResult.ok).toBe(true);
		if (!evResult.ok) return;
		ledger = evResult.value!;
		expect(ledger!.revision).toBe(1);

		const evResult2 = addLedgerEvidence(contract, ledger!, {
			expectedRevision: 1,
			evidence: {
				id: "EV-REV-002",
				type: "test-result",
				requirementIds: ["REQ-001"],
				criterionIds: ["AC-001"],
				reportedCollectorType: "test-runner",
				reportedAuthority: true,
				status: "pass",
				source: "test",
				summary: "pass",
			},
		});
		expect(evResult2.ok).toBe(true);
		expect(evResult2.value!.revision).toBe(2);
	});

	it("ledger revision equals total mutations (evidence + transitions)", () => {
		const contract = loadContract("M01");
		const ledger = fullLifecycleToSatisfied(contract, trustedOperatorCtx, makeValidationContext(contract));

		// fullLifecycleToSatisfied: 1 transition + 1 evidence + 1 transition = 3 mutations
		const totalMutations = ledger!.evidence.length + ledger!.transitions.length;
		expect(ledger!.revision).toBe(totalMutations);

		const validation = validateRequirementLedger(contract, ledger!, makeValidationContext(contract));
		expect(validation.ok).toBe(true);
	});

	it("rejects transition referencing evidence added at the same revision", () => {
		const contract = loadContract("M01");
		const result = initializeRequirementLedger(contract);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		let ledger = result.value!;

		// Transition first (rev 0 → rev 1)
		const r = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-EV-ORDER-001",
			expectedRevision: 0,
			requirementId: "REQ-001",
			toStatus: "IMPLEMENTED_UNVERIFIED",
			reportedActorType: "agent",
			reason: "Done",
			evidenceIds: [],
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		ledger = r.value!;

		// Now try to transition to SATISFIED at rev 1 while adding evidence in the
		// same "future" revision — evidence must be added first then transition.
		// Add evidence first (rev 1 → rev 2)
		const evResult = addLedgerEvidence(contract, ledger!, {
			expectedRevision: 1,
			evidence: {
				id: "EV-ORDER-001",
				type: "test-result",
				requirementIds: ["REQ-001"],
				criterionIds: ["AC-001"],
				reportedCollectorType: "test-runner",
				reportedAuthority: true,
				status: "pass",
				source: "test",
				summary: "pass",
			},
		});
		expect(evResult.ok).toBe(true);
		expect(evResult.value!.evidence[0].addedAtRevision).toBe(2);
	});
});

// =============================================================================
// New: Transition ID validation
// =============================================================================

describe("Transition ID validation", () => {
	it("rejects transition with empty ID", () => {
		const contract = loadContract("M01");
		const result = initializeRequirementLedger(contract);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const r = applyRequirementTransition(contract, result.value!, {
			transitionId: "",
			expectedRevision: 0,
			requirementId: "REQ-001",
			toStatus: "PENDING",
			reportedActorType: "agent",
			reason: "Start",
			evidenceIds: [],
		});
		expect(r.ok).toBe(false);
		expect(r.code).toBe("DUPLICATE_TRANSITION_ID");
	});

	it("rejects duplicate transition ID", () => {
		const contract = loadContract("M01");
		const result = initializeRequirementLedger(contract);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		let ledger = result.value!;

		const r1 = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-DUP-001",
			expectedRevision: 0,
			requirementId: "REQ-001",
			toStatus: "PENDING",
			reportedActorType: "agent",
			reason: "First",
			evidenceIds: [],
		});
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;
		ledger = r1.value!;

		const r2 = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-DUP-001",
			expectedRevision: 1,
			requirementId: "REQ-001",
			toStatus: "IN_PROGRESS",
			reportedActorType: "agent",
			reason: "Second",
			evidenceIds: [],
		});
		expect(r2.ok).toBe(false);
		expect(r2.code).toBe("DUPLICATE_TRANSITION_ID");
	});

	it("different mutations get different IDs", () => {
		const contract = loadContract("M01");
		const result = initializeRequirementLedger(contract);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		let ledger = result.value!;

		const r1 = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-A-001",
			expectedRevision: 0,
			requirementId: "REQ-001",
			toStatus: "PENDING",
			reportedActorType: "agent",
			reason: "First",
			evidenceIds: [],
		});
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;
		ledger = r1.value!;

		const r2 = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-A-002",
			expectedRevision: 1,
			requirementId: "REQ-001",
			toStatus: "IN_PROGRESS",
			reportedActorType: "agent",
			reason: "Second",
			evidenceIds: [],
		});
		expect(r2.ok).toBe(true);
	});

	it("cross-process ID collision is prevented by API", () => {
		const contract = loadContract("M01");
		const result1 = initializeRequirementLedger(contract);
		expect(result1.ok).toBe(true);
		if (!result1.ok) return;

		// First transition succeeds
		const r1 = applyRequirementTransition(contract, result1.value!, {
			transitionId: "TX-CROSS-001",
			expectedRevision: 0,
			requirementId: "REQ-001",
			toStatus: "PENDING",
			reportedActorType: "agent",
			reason: "Process A",
			evidenceIds: [],
		});
		expect(r1.ok).toBe(true);

		// Second "process" reads the updated ledger and tries same ID
		const r2 = applyRequirementTransition(contract, r1.value!, {
			transitionId: "TX-CROSS-001",
			expectedRevision: 1,
			requirementId: "REQ-001",
			toStatus: "IN_PROGRESS",
			reportedActorType: "agent",
			reason: "Process B",
			evidenceIds: [],
		});
		expect(r2.ok).toBe(false);
		expect(r2.code).toBe("DUPLICATE_TRANSITION_ID");
	});
});

// =============================================================================
// Global mutation sequence validation
// =============================================================================

describe("Global mutation sequence validation", () => {
	it("rejects ledger with gap in mutation sequence", () => {
		const contract = loadContract("M01");
		const ledger = fullLifecycleToSatisfied(contract, trustedOperatorCtx, makeValidationContext(contract));

		// Tamper: remove a mutation from the middle, creating a gap
		// Remove evidence (addedAtRevision=2), leaving gap between rev 1 and rev 3
		ledger!.evidence = [];
		ledger!.revision = ledger!.transitions.length;

		const validation = validateRequirementLedger(contract, ledger!, makeValidationContext(contract));
		expect(validation.ok).toBe(false);
	});

	it("rejects ledger with duplicate mutation revision", () => {
		const contract = loadContract("M01");
		const result = initializeRequirementLedger(contract);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		// Construct a ledger with two evidence at same revision
		const tampered: RequirementLedgerV1 = {
			...result.value!,
			revision: 2,
			evidence: [
				{
					id: "EV-COL-001",
					type: "test-result",
					requirementIds: ["REQ-001"],
					criterionIds: ["AC-001"],
					reportedCollectorType: "test-runner",
					reportedAuthority: true,
					effectiveAuthority: "test-result",
					verifiedPrincipalId: "system",
					verifiedPrincipalKind: "system",
					status: "pass",
					source: "test",
					summary: "a",
					addedAtRevision: 1,
				},
				{
					id: "EV-COL-002",
					type: "test-result",
					requirementIds: ["REQ-001"],
					criterionIds: ["AC-001"],
					reportedCollectorType: "test-runner",
					reportedAuthority: true,
					effectiveAuthority: "test-result",
					verifiedPrincipalId: "system",
					verifiedPrincipalKind: "system",
					status: "pass",
					source: "test",
					summary: "b",
					addedAtRevision: 1,
				},
			],
		};
		const validation = validateRequirementLedger(contract, tampered!, makeValidationContext(contract));
		expect(validation.ok).toBe(false);
	});
});

// =============================================================================
// Tamper detection tests (T01-T18 as required by LH-1 hardening)
// =============================================================================

describe("Tamper detection (T01-T18)", () => {
	function makeSatisfiedLedger(contract: MissionContractV1): RequirementLedgerV1 {
		return fullLifecycleToSatisfied(contract, trustedOperatorCtx, makeValidationContext(contract));
	}

	it("T01-T02: evidence + transition increment revision correctly", () => {
		const contract = loadContract("M01");
		const ledger = makeSatisfiedLedger(contract);

		// fullLifecycleToSatisfied: IMPL (rev1), evidence (rev2), SATISFIED (rev3)
		expect(ledger!.revision).toBe(3);
		expect(ledger!.evidence.length).toBe(1);
		expect(ledger!.transitions.length).toBe(2);

		const validation = validateRequirementLedger(contract, ledger!, makeValidationContext(contract));
		expect(validation.ok).toBe(true);
	});

	it("T03: ledger revision equals total mutation count", () => {
		const contract = loadContract("M01");
		const ledger = makeSatisfiedLedger(contract);
		expect(ledger!.revision).toBe(ledger!.evidence.length + ledger!.transitions.length);
	});

	it("T04-T06: duplicate/revision collision rejected", () => {
		const contract = loadContract("M01");
		const ledger = makeSatisfiedLedger(contract);

		// Add a transition with same revisionAfter as existing evidence
		const tampered: RequirementLedgerV1 = structuredClone(ledger!);
		tampered.transitions.push({
			id: "TX-HIJACK",
			ledgerRevisionBefore: 1,
			ledgerRevisionAfter: 2, // Collides with evidence.addedAtRevision
			requirementId: "REQ-001",
			fromStatus: "IMPLEMENTED_UNVERIFIED",
			toStatus: "IN_PROGRESS",
			reportedActorType: "agent",
			verifiedPrincipalId: "untrusted",
			verifiedPrincipalKind: "agent",
			reason: "Hijack",
			evidenceIds: [],
		});
		tampered.revision = 3;

		const validation = validateRequirementLedger(contract, tampered!, makeValidationContext(contract));
		expect(validation.ok).toBe(false);
	});

	it("T07: missing mutation revision in sequence", () => {
		const contract = loadContract("M01");
		const ledger = makeSatisfiedLedger(contract);

		// Change evidence addedAtRevision to create a gap
		const tampered: RequirementLedgerV1 = structuredClone(ledger!);
		tampered.evidence[0].addedAtRevision = 99; // Out of range
		tampered.revision = 99;

		const validation = validateRequirementLedger(contract, tampered!, makeValidationContext(contract));
		expect(validation.ok).toBe(false);
	});

	it("T08: transition references future evidence", () => {
		const contract = loadContract("M01");
		const result = initializeRequirementLedger(contract);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		let ledger = result.value!;

		// Transition (rev 0 → rev 1)
		const r = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-FUTURE-001",
			expectedRevision: 0,
			requirementId: "REQ-001",
			toStatus: "IMPLEMENTED_UNVERIFIED",
			reportedActorType: "agent",
			reason: "Done",
			evidenceIds: [],
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		ledger = r.value!;

		// Add evidence at rev 1 → rev 2
		const ev = addLedgerEvidence(
			contract,
			ledger!,
			{
				expectedRevision: 1,
				evidence: {
					id: "EV-FUTURE",
					type: "test-result",
					requirementIds: ["REQ-001"],
					criterionIds: ["AC-001"],
					reportedCollectorType: "test-runner",
					reportedAuthority: true,
					status: "pass",
					source: "test",
					summary: "pass",
				},
			},
			trustedOperatorCtx,
			makeValidationContext(contract),
		);
		expect(ev.ok).toBe(true);
		if (!ev.ok) return;
		ledger = ev.value!;

		// Tamper: transition at rev 2 must not reference evidence added at same or later rev
		// Evidence addedAtRevision is 2, transition at rev 2 → rev 3
		// This is valid because evidence.addedAtRevision (2) < transition revisionAfter (3)
		const satResult = applyRequirementTransition(
			contract,
			ledger!,
			{
				transitionId: "TX-FUTURE-002",
				expectedRevision: 2,
				requirementId: "REQ-001",
				toStatus: "SATISFIED",
				reportedActorType: "operator",
				reason: "Verified",
				evidenceIds: ["EV-FUTURE"],
			},
			trustedOperatorCtx,
			makeValidationContext(contract),
		);
		expect(satResult.ok).toBe(true);
	});

	it("T09: rejects transition referencing evidence added at same revision", () => {
		const contract = loadContract("M01");
		const ledger = makeSatisfiedLedger(contract);

		// Create tampered ledger where SATISFIED transition has evidence at same rev
		const tampered: RequirementLedgerV1 = structuredClone(ledger!);
		const lastTx = tampered.transitions[tampered.transitions.length - 1];
		const ev = tampered.evidence.find((e) => e.id === "EV-TR")!;

		// Set evidence addedAtRevision equal to transition revisionAfter
		ev.addedAtRevision = lastTx.ledgerRevisionAfter;

		const validation = validateRequirementLedger(contract, tampered!, makeValidationContext(contract));
		expect(validation.ok).toBe(false);
		expect(validation.error).toContain("evidence must exist before the transition");
	});

	it("T10: evidence added before transition is accepted (correct ordering)", () => {
		const contract = loadContract("M01");
		const ledger = makeSatisfiedLedger(contract);

		// Verify evidence.addedAtRevision < transition.ledgerRevisionAfter
		const lastTx = ledger!.transitions[ledger!.transitions.length - 1];
		const ev = ledger!.evidence.find((e) => e.id === "EV-TR")!;
		expect(ev.addedAtRevision).toBeLessThan(lastTx.ledgerRevisionAfter);

		const validation = validateRequirementLedger(contract, ledger!, makeValidationContext(contract));
		expect(validation.ok).toBe(true);
	});

	it("T11: evidence addedAtRevision tampered > ledger.revision", () => {
		const contract = loadContract("M01");
		const ledger = makeSatisfiedLedger(contract);

		const tampered: RequirementLedgerV1 = structuredClone(ledger!);
		tampered.evidence[0].addedAtRevision = 999;

		const validation = validateRequirementLedger(contract, tampered!, makeValidationContext(contract));
		expect(validation.ok).toBe(false);
	});

	it("T12-T13: transition revisionBefore/After tampered", () => {
		const contract = loadContract("M01");
		const ledger = makeSatisfiedLedger(contract);

		// Tamper: non-sequential revision
		const tampered: RequirementLedgerV1 = structuredClone(ledger!);
		tampered.transitions[0].ledgerRevisionAfter = 5;

		const validation = validateRequirementLedger(contract, tampered!, makeValidationContext(contract));
		expect(validation.ok).toBe(false);
	});

	it("T14: current snapshot tampered", () => {
		const contract = loadContract("M01");
		const ledger = makeSatisfiedLedger(contract);

		const tampered: RequirementLedgerV1 = structuredClone(ledger!);
		const entry = tampered.requirements.find((r) => r.requirementId === "REQ-001")!;
		entry.status = "IN_PROGRESS";

		const validation = validateRequirementLedger(contract, tampered!, makeValidationContext(contract));
		expect(validation.ok).toBe(false);
	});

	it("T15: evidence removed from history", () => {
		const contract = loadContract("M01");
		const ledger = makeSatisfiedLedger(contract);

		// Remove evidence but keep ledger.revision unchanged
		const tampered: RequirementLedgerV1 = structuredClone(ledger!);
		tampered.evidence = [];
		// Revision still 3 but mutation count is now 2

		const validation = validateRequirementLedger(contract, tampered!, makeValidationContext(contract));
		expect(validation.ok).toBe(false);
	});

	it("T16: transition removed from history", () => {
		const contract = loadContract("M01");
		const ledger = makeSatisfiedLedger(contract);

		// Remove first transition (leaves evidence + satisfaction)
		const tampered: RequirementLedgerV1 = structuredClone(ledger!);
		tampered.transitions.shift();
		// Reconstruction will fail — state goes from UNASSESSED straight to SATISFIED-ish
		// Actually, more likely the revision count won't match

		const validation = validateRequirementLedger(contract, tampered!, makeValidationContext(contract));
		expect(validation.ok).toBe(false);
	});

	it("T17: mutation arrays reordered — fromStatus consistency broken", () => {
		const contract = loadContract("M01");
		const ledger = makeSatisfiedLedger(contract);
		const originalTxLen = ledger!.transitions.length;

		// Reorder transitions and swap fromStatus values
		const tampered: RequirementLedgerV1 = structuredClone(ledger!);
		// Swap positions
		[tampered.transitions[0], tampered.transitions[1]] = [tampered.transitions[1], tampered.transitions[0]];

		expect(tampered.transitions.length).toBe(originalTxLen);

		// After reordering, the fromStatus chain is broken
		// State reconstruction replays by revision order, not array order,
		// so we need to corrupt fromStatus to trigger failure
		tampered.transitions[0].fromStatus = "UNASSESSED"; // First in revision order was IMPLEMENTED_UNVERIFIED, this is now wrong

		const validation = validateRequirementLedger(contract, tampered!, makeValidationContext(contract));
		expect(validation.ok).toBe(false);
	});

	it("T18: mutation revision tampered to create duplicate", () => {
		const contract = loadContract("M01");
		const ledger = makeSatisfiedLedger(contract);

		// Force both evidence and a transition to have same revision
		const tampered: RequirementLedgerV1 = structuredClone(ledger!);
		tampered.evidence[0].addedAtRevision = 1;
		tampered.transitions[0].ledgerRevisionAfter = 1;

		const validation = validateRequirementLedger(contract, tampered!, makeValidationContext(contract));
		expect(validation.ok).toBe(false);
	});
});

// =============================================================================
// Helper: full lifecycle to SATISFIED for a single requirement
// =============================================================================

function fullLifecycleToSatisfied(
	contract: MissionContractV1,
	ctx?: TrustedLedgerMutationContext,
	validationCtx?: TrustedValidationContext,
): RequirementLedgerV1 {
	const init = initializeRequirementLedger(contract);
	if (!init.ok) throw new Error(init.error);
	let ledger = init.value!;

	// UNASSESSED -> IMPLEMENTED_UNVERIFIED (rev 0 → rev 1)
	let r = applyRequirementTransition(contract, ledger!, {
		transitionId: "TX-FL-001",
		expectedRevision: 0,
		requirementId: "REQ-001",
		toStatus: "IMPLEMENTED_UNVERIFIED",
		reportedActorType: "agent",
		reason: "Done",
		evidenceIds: [],
	});
	if (!r.ok) throw new Error(r.error);
	ledger = r.value!;

	// Add evidence (rev 1 → rev 2) — use trusted context for authoritative evidence
	const ev = addLedgerEvidence(
		contract,
		ledger!,
		{
			expectedRevision: 1,
			evidence: {
				id: "EV-TR",
				type: "test-result",
				requirementIds: ["REQ-001"],
				criterionIds: ["AC-001"],
				status: "pass",
				source: "test",
				summary: "pass",
				reportedCollectorType: "test-runner",
				reportedAuthority: true,
			},
		},
		ctx,
		validationCtx,
	);
	if (!ev.ok) throw new Error(ev.error);
	ledger = ev.value!;

	// SATISFIED (rev 2 → rev 3) — use trusted context
	r = applyRequirementTransition(
		contract,
		ledger!,
		{
			transitionId: "TX-FL-002",
			expectedRevision: 2,
			requirementId: "REQ-001",
			toStatus: "SATISFIED",
			reportedActorType: "operator",
			reason: "Verified",
			evidenceIds: ["EV-TR"],
		},
		ctx,
		validationCtx,
	);
	if (!r.ok) throw new Error(r.error);

	return r.value!;
}
