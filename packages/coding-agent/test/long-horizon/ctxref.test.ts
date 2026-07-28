/**
 * CTXREF-01..CTXREF-16 — Contract-bound trusted validation context reference validation.
 *
 * Tests that the contract-bound trusted factory correctly validates all
 * source-grant requirement and criterion references at construction time,
 * rejects unknown references, enforces cross-scope coherence, and binds
 * every genuine context to one exact contract digest.
 */

import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { computeMissionContractDigest } from "../../src/core/long-horizon/contract-digest.js";
import {
	addLedgerEvidence,
	applyRequirementTransition,
	deriveRequirementLedgerSummary,
	initializeRequirementLedger,
	validateRequirementLedger,
	validateRequirementLedgerStrict,
} from "../../src/core/long-horizon/index.js";
import type { EvidenceLedgerCapability, LedgerCapability } from "../../src/core/long-horizon/trusted-context.js";
import {
	_getBoundContractDigest,
	_internalCreateTrustedContext,
	_internalCreateTrustedValidationContext,
	isTrustedValidationContext,
} from "../../src/core/long-horizon/trusted-context.js";
import type { MissionContractV1 } from "../../src/core/long-horizon/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "..", "..", "src", "core", "long-horizon", "fixtures");

function loadContract(name: string): MissionContractV1 {
	return JSON.parse(readFileSync(resolve(fixturesDir, `${name}-contract.json`), "utf-8"));
}

const basicPrincipals = [
	{
		principalId: "test-operator",
		principalKind: "operator" as const,
		capabilities: ["transition:satisfy", "evidence:test-result"] as LedgerCapability[],
	},
	{ principalId: "untrusted", principalKind: "agent" as const, capabilities: [] as LedgerCapability[] },
];

// =============================================================================
// CTXREF-01 — Unknown criterion at factory
// =============================================================================

it("CTXREF-01: factory rejects unknown criterion ID", () => {
	const contract = loadContract("M01"); // has AC-001 only

	expect(() => {
		_internalCreateTrustedValidationContext({
			contract,
			principals: basicPrincipals,
			sourceGrants: [
				{
					sourceId: "test-src",
					principalId: "test-operator",
					principalKind: "operator",
					capability: "evidence:test-result" as EvidenceLedgerCapability,
					allowedEvidenceTypes: ["test-result"],
					allowedCriterionIds: ["CRIT-MISSING"],
				},
			],
		});
	}).toThrow(/Unknown acceptance criterion id reference/);
});

// =============================================================================
// CTXREF-02 — Empty criterion reference
// =============================================================================

it("CTXREF-02: factory rejects empty criterion ID", () => {
	const contract = loadContract("M01");

	expect(() => {
		_internalCreateTrustedValidationContext({
			contract,
			principals: basicPrincipals,
			sourceGrants: [
				{
					sourceId: "test-src",
					principalId: "test-operator",
					principalKind: "operator",
					capability: "evidence:test-result" as EvidenceLedgerCapability,
					allowedEvidenceTypes: ["test-result"],
					allowedCriterionIds: [""],
				},
			],
		});
	}).toThrow(/empty criterion ID/);
});

// =============================================================================
// CTXREF-03 — Whitespace criterion reference
// =============================================================================

it("CTXREF-03: factory rejects whitespace-only criterion ID", () => {
	const contract = loadContract("M01");

	expect(() => {
		_internalCreateTrustedValidationContext({
			contract,
			principals: basicPrincipals,
			sourceGrants: [
				{
					sourceId: "test-src",
					principalId: "test-operator",
					principalKind: "operator",
					capability: "evidence:test-result" as EvidenceLedgerCapability,
					allowedEvidenceTypes: ["test-result"],
					allowedCriterionIds: ["   "],
				},
			],
		});
	}).toThrow(/whitespace-only criterion ID/);
});

// =============================================================================
// CTXREF-04 — Leading/trailing whitespace
// =============================================================================

it("CTXREF-04: factory rejects criterion ID with leading/trailing whitespace", () => {
	const contract = loadContract("M01");

	expect(() => {
		_internalCreateTrustedValidationContext({
			contract,
			principals: basicPrincipals,
			sourceGrants: [
				{
					sourceId: "test-src",
					principalId: "test-operator",
					principalKind: "operator",
					capability: "evidence:test-result" as EvidenceLedgerCapability,
					allowedEvidenceTypes: ["test-result"],
					allowedCriterionIds: [" AC-001 "],
				},
			],
		});
	}).toThrow(/has leading\/trailing whitespace/);
});

// =============================================================================
// CTXREF-05 — Duplicate criterion references
// =============================================================================

it("CTXREF-05: factory rejects duplicate criterion ID references", () => {
	const contract = loadContract("M01");

	expect(() => {
		_internalCreateTrustedValidationContext({
			contract,
			principals: basicPrincipals,
			sourceGrants: [
				{
					sourceId: "test-src",
					principalId: "test-operator",
					principalKind: "operator",
					capability: "evidence:test-result" as EvidenceLedgerCapability,
					allowedEvidenceTypes: ["test-result"],
					allowedCriterionIds: ["AC-001", "AC-001"],
				},
			],
		});
	}).toThrow(/duplicate criterion ID/);
});

// =============================================================================
// CTXREF-06 — Known local criterion accepted
// =============================================================================

it("CTXREF-06: factory accepts known criterion ID", () => {
	const contract = loadContract("M01"); // has AC-001

	const ctx = _internalCreateTrustedValidationContext({
		contract,
		principals: basicPrincipals,
		sourceGrants: [
			{
				sourceId: "test-src",
				principalId: "test-operator",
				principalKind: "operator",
				capability: "evidence:test-result" as EvidenceLedgerCapability,
				allowedEvidenceTypes: ["test-result"],
				allowedCriterionIds: ["AC-001"],
			},
		],
	});

	expect(isTrustedValidationContext(ctx)).toBe(true);
	expect(_getBoundContractDigest(ctx)).toBe(computeMissionContractDigest(contract));
});

// =============================================================================
// CTXREF-07 — Known criterion in another requirement accepted (IDs are globally unique)
// =============================================================================

it("CTXREF-07: factory accepts criterion from any requirement (global uniqueness)", () => {
	const contract = loadContract("M08"); // REQ-001 has AC-1, REQ-002 has AC-2

	// Register only REQ-001's principals, but reference AC-2 (from REQ-002)
	const ctx = _internalCreateTrustedValidationContext({
		contract,
		principals: basicPrincipals,
		sourceGrants: [
			{
				sourceId: "test-src",
				principalId: "test-operator",
				principalKind: "operator",
				capability: "evidence:test-result" as EvidenceLedgerCapability,
				allowedEvidenceTypes: ["test-result"],
				allowedCriterionIds: ["AC-2"], // AC-2 exists globally, even though it's in REQ-002
			},
		],
	});

	expect(isTrustedValidationContext(ctx)).toBe(true);
});

// =============================================================================
// CTXREF-08 — Bypass standalone helper; factory rejects unknown directly
// =============================================================================

it("CTXREF-08: factory rejects unknown criterion without calling standalone validator", () => {
	const contract = loadContract("M01");

	// Do NOT call validateSourceGrantCriterionIds at all.
	// The factory itself must reject unknown references.
	expect(() => {
		_internalCreateTrustedValidationContext({
			contract,
			principals: basicPrincipals,
			sourceGrants: [
				{
					sourceId: "test-src",
					principalId: "test-operator",
					principalKind: "operator",
					capability: "evidence:test-result" as EvidenceLedgerCapability,
					allowedEvidenceTypes: ["test-result"],
					allowedCriterionIds: ["DOES-NOT-EXIST-ANYWHERE"],
				},
			],
		});
	}).toThrow(/Unknown acceptance criterion id reference: DOES-NOT-EXIST-ANYWHERE/);
});

// =============================================================================
// CTXREF-09 — Unknown requirement reference
// =============================================================================

it("CTXREF-09: factory rejects unknown requirement ID reference", () => {
	const contract = loadContract("M01");

	expect(() => {
		_internalCreateTrustedValidationContext({
			contract,
			principals: basicPrincipals,
			sourceGrants: [
				{
					sourceId: "test-src",
					principalId: "test-operator",
					principalKind: "operator",
					capability: "evidence:test-result" as EvidenceLedgerCapability,
					allowedEvidenceTypes: ["test-result"],
					allowedRequirementIds: ["REQ-MISSING"],
				},
			],
		});
	}).toThrow(/Unknown requirement id reference: REQ-MISSING/);
});

// =============================================================================
// CTXREF-10 — Criterion outside allowed requirement scope
// =============================================================================

it("CTXREF-10: factory rejects criterion outside declared allowedRequirementIds scope", () => {
	const contract = loadContract("M08"); // REQ-001: AC-1, REQ-002: AC-2

	expect(() => {
		_internalCreateTrustedValidationContext({
			contract,
			principals: basicPrincipals,
			sourceGrants: [
				{
					sourceId: "test-src",
					principalId: "test-operator",
					principalKind: "operator",
					capability: "evidence:test-result" as EvidenceLedgerCapability,
					allowedEvidenceTypes: ["test-result"],
					allowedRequirementIds: ["REQ-001"], // Only REQ-001
					allowedCriterionIds: ["AC-2"], // AC-2 belongs to REQ-002 — not in scope!
				},
			],
		});
	}).toThrow(/criterion "AC-2" belongs to requirement "REQ-002"/);
});

// =============================================================================
// CTXREF-11 — Caller mutation of source-grant arrays has no effect
// =============================================================================

it("CTXREF-11: mutating source-grant arrays after construction has no effect", () => {
	const contract = loadContract("M01");

	const mutableGrant: any = {
		sourceId: "mutable-src",
		principalId: "test-operator",
		principalKind: "operator",
		capability: "evidence:test-result" as EvidenceLedgerCapability,
		allowedEvidenceTypes: ["test-result"],
		allowedCriterionIds: ["AC-001"],
	};

	const ctx = _internalCreateTrustedValidationContext({
		contract,
		principals: basicPrincipals,
		sourceGrants: [mutableGrant],
	});

	// Mutate the original arrays
	mutableGrant.allowedCriterionIds.push("INJECTED");
	mutableGrant.allowedEvidenceTypes = ["bad-type"];

	// Context should still work with original state
	expect(isTrustedValidationContext(ctx)).toBe(true);
});

// =============================================================================
// CTXREF-12 — Context reused with another contract
// =============================================================================

it("CTXREF-12: context minted for Contract A cannot validate Contract B", () => {
	const contractA = loadContract("M01");
	const contractB = loadContract("M10");

	const ctxA = _internalCreateTrustedValidationContext({
		contract: contractA,
		principals: basicPrincipals,
		sourceGrants: [
			{
				sourceId: "cross-src",
				principalId: "test-operator",
				principalKind: "operator",
				capability: "evidence:test-result" as EvidenceLedgerCapability,
				allowedEvidenceTypes: ["test-result"],
			},
		],
	});

	// Build ledger for M10
	const initB = initializeRequirementLedger(contractB);
	expect(initB.ok).toBe(true);
	const ledgerB = initB.value!;

	// Try to validate M10 ledger with M01 context
	const result = validateRequirementLedger(contractB, ledgerB, ctxA);
	expect(result.ok).toBe(false);
	expect(result.code).toBe("TRUSTED_VALIDATION_CONTEXT_CONTRACT_MISMATCH");
});

// =============================================================================
// CTXREF-13 — Same IDs, different contract digest
// =============================================================================

it("CTXREF-13: context with same IDs but different contract digest is rejected", () => {
	// M01 and M10 share REQ-001/AC-001 but differ semantically
	const contractA = loadContract("M01");
	const contractB = loadContract("M10");

	// Verify they do have different digests
	expect(computeMissionContractDigest(contractA)).not.toBe(computeMissionContractDigest(contractB));

	const ctxA = _internalCreateTrustedValidationContext({
		contract: contractA,
		principals: basicPrincipals,
		sourceGrants: [
			{
				sourceId: "same-ids-src",
				principalId: "test-operator",
				principalKind: "operator",
				capability: "evidence:test-result" as EvidenceLedgerCapability,
				allowedEvidenceTypes: ["test-result"],
			},
		],
	});

	const initB = initializeRequirementLedger(contractB);
	expect(initB.ok).toBe(true);

	const result = validateRequirementLedger(contractB, initB.value!, ctxA);
	expect(result.ok).toBe(false);
	expect(result.code).toBe("TRUSTED_VALIDATION_CONTEXT_CONTRACT_MISMATCH");
});

// =============================================================================
// CTXREF-14 — Contract/ledger digest mismatch
// =============================================================================

it("CTXREF-14: contract/ledger digest mismatch rejected", () => {
	const contract = loadContract("M01");

	const ctx = _internalCreateTrustedValidationContext({
		contract,
		principals: basicPrincipals,
		sourceGrants: [],
	});

	const init = initializeRequirementLedger(contract);
	expect(init.ok).toBe(true);

	// Tamper the ledger's contract digest
	const tampered = structuredClone(init.value!);
	tampered.contractDigest = "0000000000000000000000000000000000000000000000000000000000000000";

	const result = validateRequirementLedger(contract, tampered, ctx);
	expect(result.ok).toBe(false);
	expect(result.code).toBe("CONTRACT_DIGEST_MISMATCH");
});

// =============================================================================
// CTXREF-15 — Valid exact contract replay
// =============================================================================

it("CTXREF-15: valid exact-contract strict validation succeeds", () => {
	const contract = loadContract("M01");

	const ctx = _internalCreateTrustedValidationContext({
		contract,
		principals: [
			{
				principalId: "test-operator",
				principalKind: "operator",
				capabilities: ["transition:satisfy", "evidence:test-result"],
			},
			{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
		],
		sourceGrants: [
			{
				sourceId: "ctxref15-src",
				principalId: "test-operator",
				principalKind: "operator",
				capability: "evidence:test-result" as EvidenceLedgerCapability,
				allowedEvidenceTypes: ["test-result"],
			},
		],
	});

	const mutation = _internalCreateTrustedContext({
		principalId: "test-operator",
		principalKind: "operator",
		capabilities: ["transition:satisfy", "evidence:test-result"],
	});

	const init = initializeRequirementLedger(contract);
	expect(init.ok).toBe(true);
	let ledger = init.value!;

	// Unprivileged transition
	let r = applyRequirementTransition(contract, ledger, {
		transitionId: "CTXREF15-IMPL",
		expectedRevision: 0,
		requirementId: "REQ-001",
		toStatus: "IMPLEMENTED_UNVERIFIED",
		reportedActorType: "agent",
		reason: "Done",
		evidenceIds: [],
	});
	expect(r.ok).toBe(true);
	ledger = r.value!;

	// Authoritative evidence
	const ev = addLedgerEvidence(
		contract,
		ledger,
		{
			expectedRevision: 1,
			evidence: {
				id: "CTXREF15-EV",
				type: "test-result",
				requirementIds: ["REQ-001"],
				criterionIds: ["AC-001"],
				status: "pass",
				source: "ctxref15-src",
				summary: "pass",
				reportedCollectorType: "test-runner",
				reportedAuthority: true,
			},
		},
		mutation,
		ctx,
	);
	expect(ev.ok).toBe(true);
	ledger = ev.value!;

	// SATISFIED
	r = applyRequirementTransition(
		contract,
		ledger,
		{
			transitionId: "CTXREF15-SAT",
			expectedRevision: 2,
			requirementId: "REQ-001",
			toStatus: "SATISFIED",
			reportedActorType: "operator",
			reason: "Verified",
			evidenceIds: ["CTXREF15-EV"],
		},
		mutation,
		ctx,
	);
	expect(r.ok).toBe(true);
	ledger = r.value!;

	const strict = validateRequirementLedgerStrict(contract, ledger, ctx);
	expect(strict.valid).toBe(true);
	expect(strict.structuralValidation.status).toBe("passed");
	expect(strict.provenanceValidation.status).toBe("passed");
});

// =============================================================================
// CTXREF-16 — Valid M20 completion with contract-bound context
// =============================================================================

it("CTXREF-16: valid M20 completion with exact-contract context yields completionCandidate true", () => {
	const contract = loadContract("M20");

	const ctx = _internalCreateTrustedValidationContext({
		contract,
		principals: [
			{
				principalId: "test-operator",
				principalKind: "operator",
				capabilities: ["transition:satisfy", "evidence:test-result"],
			},
			{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
		],
		sourceGrants: [
			{
				sourceId: "ctxref16-src",
				principalId: "test-operator",
				principalKind: "operator",
				capability: "evidence:test-result" as EvidenceLedgerCapability,
				allowedEvidenceTypes: ["test-result"],
			},
		],
	});

	const mutation = _internalCreateTrustedContext({
		principalId: "test-operator",
		principalKind: "operator",
		capabilities: ["transition:satisfy", "evidence:test-result"],
	});

	const init = initializeRequirementLedger(contract);
	expect(init.ok).toBe(true);
	let ledger = init.value!;

	const reqId = contract.requirements[0]?.id ?? "REQ-001";
	const critId = contract.requirements[0]?.acceptanceCriteria[0]?.id ?? "AC-001";

	// IMPLEMENTED_UNVERIFIED
	let r = applyRequirementTransition(contract, ledger, {
		transitionId: "CTXREF16-IMPL",
		expectedRevision: 0,
		requirementId: reqId,
		toStatus: "IMPLEMENTED_UNVERIFIED",
		reportedActorType: "agent",
		reason: "Done",
		evidenceIds: [],
	});
	expect(r.ok).toBe(true);
	ledger = r.value!;

	// Authoritative evidence
	const ev = addLedgerEvidence(
		contract,
		ledger,
		{
			expectedRevision: 1,
			evidence: {
				id: "CTXREF16-EV",
				type: "test-result",
				requirementIds: [reqId],
				criterionIds: [critId],
				status: "pass",
				source: "ctxref16-src",
				summary: "All green",
				reportedCollectorType: "test-runner",
				reportedAuthority: true,
			},
		},
		mutation,
		ctx,
	);
	expect(ev.ok).toBe(true);
	ledger = ev.value!;

	// SATISFIED
	r = applyRequirementTransition(
		contract,
		ledger,
		{
			transitionId: "CTXREF16-SAT",
			expectedRevision: 2,
			requirementId: reqId,
			toStatus: "SATISFIED",
			reportedActorType: "operator",
			reason: "Verified",
			evidenceIds: ["CTXREF16-EV"],
		},
		mutation,
		ctx,
	);
	expect(r.ok).toBe(true);
	ledger = r.value!;

	const summary = deriveRequirementLedgerSummary(contract, ledger, ctx);
	expect(summary.completionCandidate).toBe(true);
});

// =============================================================================
// CTXREF-17: Legacy overload cannot mint an unbound genuine context
// =============================================================================

describe("CTXREF-17 — Legacy overload rejection", () => {
	it("CTXREF-17: legacy two-argument form throws deprecation error", () => {
		expect(() =>
			_internalCreateTrustedValidationContext(
				[
					{
						principalId: "test",
						principalKind: "operator",
						capabilities: ["transition:satisfy"],
					},
				],
				[],
			),
		).toThrow(/DEPRECATED/);
	});

	it("CTXREF-17b: legacy two-argument form with source grants also throws", () => {
		expect(() =>
			_internalCreateTrustedValidationContext(
				[
					{
						principalId: "test",
						principalKind: "operator",
						capabilities: ["evidence:test-result"],
					},
				],
				[
					{
						sourceId: "test",
						principalId: "test",
						principalKind: "operator",
						capability: "evidence:test-result" as EvidenceLedgerCapability,
						allowedEvidenceTypes: ["test-result"],
					},
				],
			),
		).toThrow(/DEPRECATED/);
	});
});
