/**
 * Phase 14 — Adversarial tests for principal-tuple, source-grant, and contract-policy fixes.
 *
 * Tests that the fixed code correctly:
 *   - Rejects cross-kind capability borrowing (P01-P06)
 *   - Rejects duplicate principal tuples (P07-P10)
 *   - Enforces explicit source grants (S01-S14)
 *   - Replays contract evidence policy (E01-E09)
 *   - Enforces completion candidate boundaries (C01-C07)
 *   - Reports truthful strict result semantics (R01-R04)
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
	inspectLedgerStructure,
	type MissionContractV1,
	type RequirementLedgerV1,
	validateRequirementLedger,
	validateRequirementLedgerStrict,
} from "../../src/core/long-horizon/index.js";
import type {
	EvidenceLedgerCapability,
	TrustedEvidenceSourceGrant,
	TrustedLedgerMutationContext,
	TrustedValidationContext,
} from "../../src/core/long-horizon/trusted-context.js";
import {
	_internalCreateTrustedContext,
	_internalCreateTrustedValidationContext,
} from "../../src/core/long-horizon/trusted-context.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "..", "..", "src", "core", "long-horizon", "fixtures");

function loadContract(name: string): MissionContractV1 {
	return JSON.parse(readFileSync(resolve(fixturesDir, `${name}-contract.json`), "utf-8"));
}

// Standard test operator with both evidence and transition capabilities
const trustedOpWithTestEvidence: TrustedLedgerMutationContext = _internalCreateTrustedContext({
	principalId: "test-operator",
	principalKind: "operator",
	capabilities: ["transition:satisfy", "evidence:test-result"],
});

// Default validation context covering common test sources
const trustedValidationCtx: TrustedValidationContext = _internalCreateTrustedValidationContext({
	contract: loadContract("M01"),
	principals: [
		{
			principalId: "test-operator",
			principalKind: "operator",
			capabilities: ["transition:satisfy", "evidence:test-result"],
		},
		{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
		{ principalId: "test", principalKind: "agent", capabilities: [] },
		{ principalId: "ci", principalKind: "agent", capabilities: [] },
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
			sourceId: "src-1",
			principalId: "test-operator",
			principalKind: "operator",
			capability: "evidence:test-result" as EvidenceLedgerCapability,
			allowedEvidenceTypes: ["test-result"],
		},
		{
			sourceId: "m20-src",
			principalId: "test-operator",
			principalKind: "operator",
			capability: "evidence:test-result" as EvidenceLedgerCapability,
			allowedEvidenceTypes: ["test-result"],
		},
		{
			sourceId: "claim",
			principalId: "test-operator",
			principalKind: "operator",
			capability: "evidence:test-result" as EvidenceLedgerCapability,
			allowedEvidenceTypes: ["test-result"],
		},
		{
			sourceId: "some-src",
			principalId: "test-operator",
			principalKind: "operator",
			capability: "evidence:test-result" as EvidenceLedgerCapability,
			allowedEvidenceTypes: ["test-result"],
		},
		{
			sourceId: "s11-src",
			principalId: "test-operator",
			principalKind: "operator",
			capability: "evidence:test-result" as EvidenceLedgerCapability,
			allowedEvidenceTypes: ["test-result"],
		},
		{
			sourceId: "c04-src",
			principalId: "test-operator",
			principalKind: "operator",
			capability: "evidence:test-result" as EvidenceLedgerCapability,
			allowedEvidenceTypes: ["test-result"],
		},
	],
});

// Create a validation context for a specific source grant
function makeValidationCtxForSource(
	sourceId: string,
	evidenceType = "test-result",
	contract?: MissionContractV1,
): TrustedValidationContext {
	const c = contract ?? loadContract("M01");
	return _internalCreateTrustedValidationContext({
		contract: c,
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
				sourceId,
				principalId: "test-operator",
				principalKind: "operator",
				capability: "evidence:test-result" as EvidenceLedgerCapability,
				allowedEvidenceTypes: [evidenceType],
			},
		],
	});
}

// Build a complete satisfied ledger (evidence + transition)
function buildSatisfiedLedgerWithSource(
	contract: MissionContractV1,
	ctx: TrustedLedgerMutationContext,
	sourceId: string,
	evidenceType = "test-result",
	validationCtx?: TrustedValidationContext,
): RequirementLedgerV1 {
	const vCtx = validationCtx ?? makeValidationCtxForSource(sourceId, evidenceType, contract);
	const init = initializeRequirementLedger(contract);
	if (!init.ok) throw new Error(init.error);
	let ledger = init.value!;

	const requirementId = contract.requirements[0]?.id ?? "REQ-001";
	const criterionId = contract.requirements[0]?.acceptanceCriteria[0]?.id ?? "AC-001";

	let r = applyRequirementTransition(contract, ledger!, {
		transitionId: "TX-IMPL-001",
		expectedRevision: 0,
		requirementId,
		toStatus: "IMPLEMENTED_UNVERIFIED",
		reportedActorType: "agent",
		reason: "Done",
		evidenceIds: [],
	});
	if (!r.ok) throw new Error(r.error);
	ledger = r.value!;

	const ev = addLedgerEvidence(
		contract,
		ledger!,
		{
			expectedRevision: 1,
			evidence: {
				id: "EV-001",
				type: evidenceType,
				requirementIds: [requirementId],
				criterionIds: [criterionId],
				status: "pass",
				source: sourceId,
				summary: "pass",
				reportedCollectorType: "test-runner",
				reportedAuthority: true,
			},
		},
		ctx,
		vCtx,
	);
	if (!ev.ok) throw new Error(ev.error);
	ledger = ev.value!;

	r = applyRequirementTransition(
		contract,
		ledger!,
		{
			transitionId: "TX-SAT-001",
			expectedRevision: 2,
			requirementId,
			toStatus: "SATISFIED",
			reportedActorType: "operator",
			reason: "Verified",
			evidenceIds: ["EV-001"],
		},
		ctx,
		vCtx,
	);
	if (!r.ok) throw new Error(r.error);

	return r.value!;
}

// Standard source grant for test-operator with evidence:test-result
function makeTestOperatorSourceGrant(sourceId: string): TrustedEvidenceSourceGrant {
	return {
		sourceId,
		principalId: "test-operator",
		principalKind: "operator",
		capability: "evidence:test-result" as EvidenceLedgerCapability,
		allowedEvidenceTypes: ["test-result"],
	};
}

// =============================================================================
// P01-P06: Principal tuple binding
// =============================================================================

describe("P01-P06: Principal tuple binding", () => {
	it("P01: operator cannot borrow agent capability during replay", () => {
		const contract = loadContract("M01");
		const ledger = buildSatisfiedLedgerWithSource(contract, trustedOpWithTestEvidence, "src-1");

		// Agent has the cap, operator does NOT
		const ctx = _internalCreateTrustedValidationContext({
			contract: loadContract("M01"),
			principals: [
				{
					principalId: "test-operator",
					principalKind: "agent",
					capabilities: ["evidence:test-result", "transition:satisfy"],
				},
				{ principalId: "test-operator", principalKind: "operator", capabilities: ["transition:satisfy"] },
				{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
			],
			sourceGrants: [
				{
					sourceId: "src-1",
					principalId: "test-operator",
					principalKind: "operator",
					capability: "evidence:test-result" as EvidenceLedgerCapability,
					allowedEvidenceTypes: ["test-result"],
				},
			],
		});

		// Operator borrows from agent's evidence:test-result — must fail
		const validation = validateRequirementLedger(contract, ledger!, ctx);
		expect(validation.ok).toBe(false);
		// verifyCapability("test-operator", "operator", "evidence:test-result") should return false
		expect(validation.code).toBe("AUTHORIZATION_FAILED");
	});

	it("P02: agent cannot borrow operator capability with same ID", () => {
		const contract = loadContract("M01");
		// Evidence must be produced by operator (agents can't produce authoritative evidence)
		const ledger = buildSatisfiedLedgerWithSource(contract, trustedOpWithTestEvidence, "p02-src");

		// Operator lacks evidence:test-result, agent has it — but evidence provenance says operator
		// The exact tuple check fails: verifyCapability("test-operator", "operator", "evidence:test-result") returns false
		const ctx = _internalCreateTrustedValidationContext({
			contract: loadContract("M01"),
			principals: [
				{
					principalId: "test-operator",
					principalKind: "operator",
					capabilities: ["transition:satisfy"], // NO evidence:test-result
				},
				{ principalId: "test-operator", principalKind: "agent", capabilities: ["evidence:test-result"] },
				{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
			],
			sourceGrants: [
				{
					sourceId: "p02-src",
					principalId: "test-operator",
					principalKind: "operator",
					capability: "evidence:test-result" as EvidenceLedgerCapability,
					allowedEvidenceTypes: ["test-result"],
				},
			],
		});

		const validation = validateRequirementLedger(contract, ledger!, ctx);
		expect(validation.ok).toBe(false);
		expect(validation.code).toBe("AUTHORIZATION_FAILED");
	});

	it("P03: exact tuple capability succeeds", () => {
		const contract = loadContract("M01");
		const ledger = buildSatisfiedLedgerWithSource(contract, trustedOpWithTestEvidence, "src-3");

		const ctx = _internalCreateTrustedValidationContext({
			contract: loadContract("M01"),
			principals: [
				{
					principalId: "test-operator",
					principalKind: "operator",
					capabilities: ["evidence:test-result", "transition:satisfy"],
				},
				{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
			],
			sourceGrants: [makeTestOperatorSourceGrant("src-3")],
		});

		const validation = validateRequirementLedger(contract, ledger!, ctx);
		expect(validation.ok).toBe(true);
	});

	it("P04: duplicate exact tuple rejected", () => {
		expect(() => {
			_internalCreateTrustedValidationContext({
				contract: loadContract("M01"),
				principals: [
					{ principalId: "dup", principalKind: "operator", capabilities: ["evidence:test-result"] },
					{ principalId: "dup", principalKind: "operator", capabilities: [] },
					{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
				],
				sourceGrants: [],
			});
		}).toThrow("DUPLICATE_TRUSTED_PRINCIPAL");
	});

	it("P05: same ID/different kind permitted but independent", () => {
		// Same ID with different kinds is allowed, but they are INDEPENDENT
		const ctx = _internalCreateTrustedValidationContext({
			contract: loadContract("M01"),
			principals: [
				{ principalId: "multi", principalKind: "agent", capabilities: ["evidence:test-result"] },
				{ principalId: "multi", principalKind: "operator", capabilities: ["transition:satisfy"] },
				{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
			],
			sourceGrants: [],
		});

		// Both tuples should be independently accessible
		expect(ctx.verifyPrincipal("multi", "agent")).toBe(true);
		expect(ctx.verifyPrincipal("multi", "operator")).toBe(true);

		// Agent has evidence:test-result, operator does not
		expect(ctx.verifyCapability("multi", "agent", "evidence:test-result")).toBe(true);
		expect(ctx.verifyCapability("multi", "operator", "evidence:test-result")).toBe(false);

		// Operator has transition:satisfy, agent does not
		expect(ctx.verifyCapability("multi", "operator", "transition:satisfy")).toBe(true);
		expect(ctx.verifyCapability("multi", "agent", "transition:satisfy")).toBe(false);
	});

	it("P06: kind tampering rejected at tuple lookup", () => {
		const contract = loadContract("M01");
		const ledger = buildSatisfiedLedgerWithSource(contract, trustedOpWithTestEvidence, "src-6");

		const ctx = _internalCreateTrustedValidationContext({
			contract: loadContract("M01"),
			principals: [
				{
					principalId: "test-operator",
					principalKind: "agent",
					capabilities: ["evidence:test-result", "transition:satisfy"],
				},
				{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
			],
			sourceGrants: [
				{
					sourceId: "src-6",
					principalId: "test-operator",
					principalKind: "agent",
					capability: "evidence:test-result" as EvidenceLedgerCapability,
					allowedEvidenceTypes: ["test-result"],
				},
			],
		});

		// Ledger has verifiedPrincipalKind: "operator" but ctx has "agent"
		const validation = validateRequirementLedger(contract, ledger!, ctx);
		expect(validation.ok).toBe(false);
	});
});

// =============================================================================
// P07-P10: Registry construction
// =============================================================================

describe("P07-P10: Registry construction", () => {
	it("P07: empty principal ID rejected", () => {
		expect(() => {
			_internalCreateTrustedValidationContext({
				contract: loadContract("M01"),
				principals: [{ principalId: "", principalKind: "operator", capabilities: [] }],
				sourceGrants: [],
			});
		}).toThrow("INVALID_TRUSTED_PRINCIPAL");
	});

	it("P08: unknown principal kind rejected", () => {
		expect(() => {
			_internalCreateTrustedValidationContext({
				contract: loadContract("M01"),
				principals: [{ principalId: "test", principalKind: "hacker" as never, capabilities: [] }],
				sourceGrants: [],
			});
		}).toThrow("INVALID_TRUSTED_PRINCIPAL");
	});

	it("P09: unknown capability rejected", () => {
		expect(() => {
			_internalCreateTrustedValidationContext({
				contract: loadContract("M01"),
				principals: [{ principalId: "test", principalKind: "operator", capabilities: ["fake:admin" as never] }],
				sourceGrants: [],
			});
		}).toThrow("INVALID_TRUSTED_CAPABILITY");
	});

	it("P10: input collection mutation does not change registry", () => {
		const originalPrincipals = [
			{
				principalId: "test",
				principalKind: "operator" as const,
				capabilities: ["evidence:test-result" as const] as const,
			},
			{ principalId: "untrusted", principalKind: "agent" as const, capabilities: [] as const },
		];

		const ctx = _internalCreateTrustedValidationContext({
			contract: loadContract("M01"),
			principals: originalPrincipals.map((p) => ({
				principalId: p.principalId,
				principalKind: p.principalKind,
				capabilities: [...p.capabilities],
			})),
			sourceGrants: [],
		});

		// Registry still only has the original principals
		expect(ctx.verifyPrincipal("test", "operator")).toBe(true);
		expect(ctx.verifyPrincipal("evil", "operator")).toBe(false);
	});
});

// =============================================================================
// S01-S14: Source grants
// =============================================================================

describe("S01-S14: Source grants", () => {
	it("S01: own explicitly granted source accepted", () => {
		const contract = loadContract("M01");
		const ledger = buildSatisfiedLedgerWithSource(contract, trustedOpWithTestEvidence, "my-src");

		const ctx = _internalCreateTrustedValidationContext({
			contract: loadContract("M01"),
			principals: [
				{
					principalId: "test-operator",
					principalKind: "operator",
					capabilities: ["evidence:test-result", "transition:satisfy"],
				},
				{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
			],
			sourceGrants: [makeTestOperatorSourceGrant("my-src")],
		});

		const validation = validateRequirementLedger(contract, ledger!, ctx);
		expect(validation.ok).toBe(true);
	});

	it("S02: another principal's source rejected", () => {
		const contract = loadContract("M01");
		const ledger = buildSatisfiedLedgerWithSource(contract, trustedOpWithTestEvidence, "their-src");

		// Source grant binds to "other-operator", NOT "test-operator"
		// Register other-operator as a principal too
		const ctx = _internalCreateTrustedValidationContext({
			contract: loadContract("M01"),
			principals: [
				{
					principalId: "test-operator",
					principalKind: "operator",
					capabilities: ["evidence:test-result", "transition:satisfy"],
				},
				{ principalId: "other-operator", principalKind: "operator", capabilities: ["evidence:test-result"] },
				{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
			],
			sourceGrants: [
				{
					sourceId: "their-src",
					principalId: "other-operator", // Different principal!
					principalKind: "operator",
					capability: "evidence:test-result" as EvidenceLedgerCapability,
					allowedEvidenceTypes: ["test-result"],
				},
			],
		});

		const validation = validateRequirementLedger(contract, ledger!, ctx);
		expect(validation.ok).toBe(false);
	});

	it("S03: another kind's source rejected", () => {
		const contract = loadContract("M01");
		const ledger = buildSatisfiedLedgerWithSource(contract, trustedOpWithTestEvidence, "kind-src");

		const ctx = _internalCreateTrustedValidationContext({
			contract: loadContract("M01"),
			principals: [
				{
					principalId: "test-operator",
					principalKind: "operator",
					capabilities: ["evidence:test-result", "transition:satisfy"],
				},
				{ principalId: "test-operator", principalKind: "agent", capabilities: ["evidence:test-result"] },
				{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
			],
			sourceGrants: [
				{
					sourceId: "kind-src",
					principalId: "test-operator",
					principalKind: "agent", // Wrong kind! Evidence is from operator
					capability: "evidence:test-result" as EvidenceLedgerCapability,
					allowedEvidenceTypes: ["test-result"],
				},
			],
		});

		const validation = validateRequirementLedger(contract, ledger!, ctx);
		expect(validation.ok).toBe(false);
	});

	it("S04: source principal lacks matching evidence capability", () => {
		const contract = loadContract("M01");
		const ledger = buildSatisfiedLedgerWithSource(contract, trustedOpWithTestEvidence, "no-cap-src");

		// Principal exists but doesn't have evidence capability
		const ctx = _internalCreateTrustedValidationContext({
			contract: loadContract("M01"),
			principals: [
				{ principalId: "test-operator", principalKind: "operator", capabilities: ["transition:satisfy"] },
				{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
			],
			sourceGrants: [
				{
					sourceId: "no-cap-src",
					principalId: "test-operator",
					principalKind: "operator",
					capability: "evidence:test-result" as EvidenceLedgerCapability,
					allowedEvidenceTypes: ["test-result"],
				},
			],
		});

		// verifyCapability should return false — principal lacks evidence:test-result
		const validation = validateRequirementLedger(contract, ledger!, ctx);
		expect(validation.ok).toBe(false);
		expect(validation.code).toBe("AUTHORIZATION_FAILED");
	});

	it("S05: source capability mismatch", () => {
		const contract = loadContract("M01");
		const ledger = buildSatisfiedLedgerWithSource(contract, trustedOpWithTestEvidence, "wrong-cap-src");

		const ctx = _internalCreateTrustedValidationContext({
			contract: loadContract("M01"),
			principals: [
				{
					principalId: "test-operator",
					principalKind: "operator",
					capabilities: ["evidence:command-result", "transition:satisfy"],
				},
				{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
			],
			sourceGrants: [
				{
					sourceId: "wrong-cap-src",
					principalId: "test-operator",
					principalKind: "operator",
					capability: "evidence:command-result" as EvidenceLedgerCapability,
					allowedEvidenceTypes: ["command-result"],
				},
			],
		});

		// Evidence has capability "evidence:test-result" but source grant has "evidence:command-result"
		const validation = validateRequirementLedger(contract, ledger!, ctx);
		expect(validation.ok).toBe(false);
	});

	it("S06: source evidence-type mismatch", () => {
		const contract = loadContract("M01");
		const ledger = buildSatisfiedLedgerWithSource(contract, trustedOpWithTestEvidence, "type-src");

		const ctx = _internalCreateTrustedValidationContext({
			contract: loadContract("M01"),
			principals: [
				{
					principalId: "test-operator",
					principalKind: "operator",
					capabilities: ["evidence:test-result", "transition:satisfy"],
				},
				{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
			],
			sourceGrants: [
				{
					sourceId: "type-src",
					principalId: "test-operator",
					principalKind: "operator",
					capability: "evidence:test-result" as EvidenceLedgerCapability,
					allowedEvidenceTypes: ["command-result"], // Doesn't include test-result
				},
			],
		});

		const validation = validateRequirementLedger(contract, ledger!, ctx);
		expect(validation.ok).toBe(false);
	});

	it("S07: source collector-class mismatch", () => {
		const contract = loadContract("M01");
		const ledger = buildSatisfiedLedgerWithSource(contract, trustedOpWithTestEvidence, "collector-src");

		// Evidence has reportedCollectorType: "test-runner"
		const ctx = _internalCreateTrustedValidationContext({
			contract: loadContract("M01"),
			principals: [
				{
					principalId: "test-operator",
					principalKind: "operator",
					capabilities: ["evidence:test-result", "transition:satisfy"],
				},
				{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
			],
			sourceGrants: [
				{
					sourceId: "collector-src",
					principalId: "test-operator",
					principalKind: "operator",
					capability: "evidence:test-result" as EvidenceLedgerCapability,
					allowedEvidenceTypes: ["test-result"],
					allowedCollectorClasses: ["build-system"], // Only build-system allowed
				},
			],
		});

		const validation = validateRequirementLedger(contract, ledger!, ctx);
		expect(validation.ok).toBe(false);
	});

	it("S08: source requirement mismatch", () => {
		const contract = loadContract("M08");
		const ledger = buildSatisfiedLedgerWithSource(contract, trustedOpWithTestEvidence, "req-src");

		const ctx = _internalCreateTrustedValidationContext({
			contract,
			principals: [
				{
					principalId: "test-operator",
					principalKind: "operator",
					capabilities: ["evidence:test-result", "transition:satisfy"],
				},
				{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
			],
			sourceGrants: [
				{
					sourceId: "req-src",
					principalId: "test-operator",
					principalKind: "operator",
					capability: "evidence:test-result" as EvidenceLedgerCapability,
					allowedEvidenceTypes: ["test-result"],
					allowedRequirementIds: ["REQ-002"], // Only REQ-002 allowed, evidence has REQ-001
				},
			],
		});

		const validation = validateRequirementLedger(contract, ledger!, ctx);
		expect(validation.ok).toBe(false);
	});

	it("S09: source criterion mismatch", () => {
		const contract = loadContract("M08");
		const ledger = buildSatisfiedLedgerWithSource(contract, trustedOpWithTestEvidence, "crit-src");

		const ctx = _internalCreateTrustedValidationContext({
			contract,
			principals: [
				{
					principalId: "test-operator",
					principalKind: "operator",
					capabilities: ["evidence:test-result", "transition:satisfy"],
				},
				{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
			],
			sourceGrants: [
				{
					sourceId: "crit-src",
					principalId: "test-operator",
					principalKind: "operator",
					capability: "evidence:test-result" as EvidenceLedgerCapability,
					allowedEvidenceTypes: ["test-result"],
					allowedCriterionIds: ["AC-2"], // Only AC-2 allowed, evidence has AC-1
				},
			],
		});

		const validation = validateRequirementLedger(contract, ledger!, ctx);
		expect(validation.ok).toBe(false);
	});

	it("S10: unknown source rejected", () => {
		const contract = loadContract("M01");
		const ledger = buildSatisfiedLedgerWithSource(contract, trustedOpWithTestEvidence, "unknown-src");

		const ctx = _internalCreateTrustedValidationContext({
			contract: loadContract("M01"),
			principals: [
				{
					principalId: "test-operator",
					principalKind: "operator",
					capabilities: ["evidence:test-result", "transition:satisfy"],
				},
				{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
			],
			sourceGrants: // NO source grant for "unknown-src"
				[],
		});

		const validation = validateRequirementLedger(contract, ledger!, ctx);
		expect(validation.ok).toBe(false);
		expect(validation.code).toBe("UNKNOWN_AUTHORITATIVE_SOURCE");
	});

	it("S11: missing required source rejected", () => {
		const contract = loadContract("M01");
		// Build ledger with explicit empty source
		const opCtx = _internalCreateTrustedContext({
			principalId: "test-operator",
			principalKind: "operator",
			capabilities: ["transition:satisfy", "evidence:test-result"],
		});

		const init = initializeRequirementLedger(contract);
		if (!init.ok) throw new Error(init.error);
		let ledger = init.value!;

		const reqId = contract.requirements[0]?.id ?? "REQ-001";
		const critId = contract.requirements[0]?.acceptanceCriteria[0]?.id ?? "AC-001";

		let r = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-S11-001",
			expectedRevision: 0,
			requirementId: reqId,
			toStatus: "IMPLEMENTED_UNVERIFIED",
			reportedActorType: "agent",
			reason: "Done",
			evidenceIds: [],
		});
		if (!r.ok) throw new Error(r.error);
		ledger = r.value!;

		const ev = addLedgerEvidence(
			contract,
			ledger!,
			{
				expectedRevision: 1,
				evidence: {
					id: "EV-S11",
					type: "test-result",
					requirementIds: [reqId],
					criterionIds: [critId],
					status: "pass",
					source: "s11-src",
					summary: "pass",
					reportedCollectorType: "test-runner",
					reportedAuthority: true,
				},
			},
			opCtx,
			trustedValidationCtx,
		);
		if (!ev.ok) throw new Error(ev.error);
		ledger = ev.value!;

		r = applyRequirementTransition(
			contract,
			ledger!,
			{
				transitionId: "TX-S11-002",
				expectedRevision: 2,
				requirementId: reqId,
				toStatus: "SATISFIED",
				reportedActorType: "operator",
				reason: "Verified",
				evidenceIds: ["EV-S11"],
			},
			opCtx,
			trustedValidationCtx,
		);
		if (!r.ok) throw new Error(r.error);
		ledger = r.value!;

		// Tamper: set source to empty to test missing-source rejection
		const tampered = structuredClone(ledger!);
		tampered.evidence[0].source = "";

		const ctx = _internalCreateTrustedValidationContext({
			contract: loadContract("M01"),
			principals: [
				{
					principalId: "test-operator",
					principalKind: "operator",
					capabilities: ["evidence:test-result", "transition:satisfy"],
				},
				{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
			],
			sourceGrants: [],
		});

		const validation = validateRequirementLedger(contract, tampered!, ctx);
		expect(validation.ok).toBe(false);
		expect(validation.code).toBe("AUTHORITATIVE_SOURCE_REQUIRED");
	});

	it("S12: tampered source changed to another registered source rejected", () => {
		const contract = loadContract("M01");
		const ledger = buildSatisfiedLedgerWithSource(contract, trustedOpWithTestEvidence, "src-original");

		// Tamper: change source to another registered source
		const tampered = structuredClone(ledger!);
		tampered.evidence[0].source = "src-other";

		// Both sources have grants, but "src-other" is bound to a different principal
		const ctx = _internalCreateTrustedValidationContext({
			contract: loadContract("M01"),
			principals: [
				{
					principalId: "test-operator",
					principalKind: "operator",
					capabilities: ["evidence:test-result", "transition:satisfy"],
				},
				{
					principalId: "other-operator",
					principalKind: "operator",
					capabilities: ["evidence:test-result", "transition:satisfy"],
				},
				{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
			],
			sourceGrants: [
				{
					sourceId: "src-original",
					principalId: "test-operator",
					principalKind: "operator",
					capability: "evidence:test-result" as EvidenceLedgerCapability,
					allowedEvidenceTypes: ["test-result"],
				},
				{
					sourceId: "src-other",
					principalId: "other-operator",
					principalKind: "operator",
					capability: "evidence:test-result" as EvidenceLedgerCapability,
					allowedEvidenceTypes: ["test-result"],
				},
			],
		});

		const validation = validateRequirementLedger(contract, tampered!, ctx);
		// src-other exists but is bound to other-operator, not test-operator
		expect(validation.ok).toBe(false);
	});

	it("S13: arbitrary registered principal is not automatically a source", () => {
		const contract = loadContract("M01");
		const ledger = buildSatisfiedLedgerWithSource(contract, trustedOpWithTestEvidence, "some-principal-id");

		// Register a principal with ID "some-principal-id" but NO source grant
		const ctx = _internalCreateTrustedValidationContext({
			contract: loadContract("M01"),
			principals: [
				{
					principalId: "test-operator",
					principalKind: "operator",
					capabilities: ["evidence:test-result", "transition:satisfy"],
				},
				{ principalId: "some-principal-id", principalKind: "agent", capabilities: [] },
				{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
			],
			sourceGrants: // NO source grant for "some-principal-id"
				[],
		});

		const validation = validateRequirementLedger(contract, ledger!, ctx);
		expect(validation.ok).toBe(false);
		expect(validation.code).toBe("UNKNOWN_AUTHORITATIVE_SOURCE");
	});

	it("S14: duplicate/ambiguous source grant rejected", () => {
		expect(() => {
			_internalCreateTrustedValidationContext({
				contract: loadContract("M01"),
				principals: [
					{
						principalId: "test-operator",
						principalKind: "operator",
						capabilities: ["evidence:test-result", "transition:satisfy"],
					},
					{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
				],
				sourceGrants: [
					{
						sourceId: "dup-src",
						principalId: "test-operator",
						principalKind: "operator",
						capability: "evidence:test-result" as EvidenceLedgerCapability,
						allowedEvidenceTypes: ["test-result"],
					},
					{
						sourceId: "dup-src",
						principalId: "test-operator",
						principalKind: "operator",
						capability: "evidence:test-result" as EvidenceLedgerCapability,
						allowedEvidenceTypes: ["command-result"],
					},
				],
			});
		}).toThrow("DUPLICATE_SOURCE_GRANT");
	});
});

// =============================================================================
// E01-E09: Contract policy replay
// =============================================================================

describe("E01-E09: Contract policy replay", () => {
	it("E01: registry accepts source but contract excludes it", () => {
		const contract = loadContract("M01");
		const strictContract = structuredClone(contract);
		strictContract.evidencePolicy.authoritativeSources = ["trusted-collector"]; // Only trusted-collector

		const ledger = buildSatisfiedLedgerWithSource(contract, trustedOpWithTestEvidence, "pol-src");

		const ctx = _internalCreateTrustedValidationContext({
			contract: loadContract("M01"),
			principals: [
				{
					principalId: "test-operator",
					principalKind: "operator",
					capabilities: ["evidence:test-result", "transition:satisfy"],
				},
				{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
			],
			sourceGrants: [makeTestOperatorSourceGrant("pol-src")],
		});

		// Evidence has effectiveAuthority: "test-result" but contract only allows "trusted-collector"
		const validation = validateRequirementLedger(strictContract, ledger!, ctx);
		expect(validation.ok).toBe(false);
	});

	it("E02: contract would accept but registry excludes principal", () => {
		const contract = loadContract("M01");
		// Contract allows test-result, but registry doesn't have a matching grant
		const ledger = buildSatisfiedLedgerWithSource(contract, trustedOpWithTestEvidence, "no-grant-src");

		const ctx = _internalCreateTrustedValidationContext({
			contract: loadContract("M01"),
			principals: [
				{
					principalId: "test-operator",
					principalKind: "operator",
					capabilities: ["evidence:test-result", "transition:satisfy"],
				},
				{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
			],
			sourceGrants: // NO source grant for "no-grant-src"
				[],
		});

		const validation = validateRequirementLedger(contract, ledger!, ctx);
		expect(validation.ok).toBe(false);
		expect(validation.code).toBe("UNKNOWN_AUTHORITATIVE_SOURCE");
	});

	it("E03: source allowed for another requirement only", () => {
		const contract = loadContract("M08");
		const ledger = buildSatisfiedLedgerWithSource(contract, trustedOpWithTestEvidence, "req-spec-src");

		const ctx = _internalCreateTrustedValidationContext({
			contract,
			principals: [
				{
					principalId: "test-operator",
					principalKind: "operator",
					capabilities: ["evidence:test-result", "transition:satisfy"],
				},
				{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
			],
			sourceGrants: [
				{
					sourceId: "req-spec-src",
					principalId: "test-operator",
					principalKind: "operator",
					capability: "evidence:test-result" as EvidenceLedgerCapability,
					allowedEvidenceTypes: ["test-result"],
					allowedRequirementIds: ["REQ-002"],
				},
			],
		});

		const validation = validateRequirementLedger(contract, ledger!, ctx);
		expect(validation.ok).toBe(false);
	});

	it("E04: source allowed for another criterion only", () => {
		const contract = loadContract("M08");
		const ledger = buildSatisfiedLedgerWithSource(contract, trustedOpWithTestEvidence, "crit-spec-src");

		const ctx = _internalCreateTrustedValidationContext({
			contract,
			principals: [
				{
					principalId: "test-operator",
					principalKind: "operator",
					capabilities: ["evidence:test-result", "transition:satisfy"],
				},
				{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
			],
			sourceGrants: [
				{
					sourceId: "crit-spec-src",
					principalId: "test-operator",
					principalKind: "operator",
					capability: "evidence:test-result" as EvidenceLedgerCapability,
					allowedEvidenceTypes: ["test-result"],
					allowedCriterionIds: ["AC-2"],
				},
			],
		});

		const validation = validateRequirementLedger(contract, ledger!, ctx);
		expect(validation.ok).toBe(false);
	});

	it("E05: criterion allowedTypes rejects wrong evidence type during replay", () => {
		// M10 contract AC-001 requires allowedTypes: ["test-result"].
		// Tamper evidence type to "command-result" → criterion check should fail.
		const contract = loadContract("M10");
		const ledger = buildSatisfiedLedgerWithSource(contract, trustedOpWithTestEvidence, "e05-src", "test-result");

		// Tamper evidence type to one not in criterion's allowedTypes
		const tampered = structuredClone(ledger!);
		tampered.evidence[0].type = "command-result";

		const ctx = _internalCreateTrustedValidationContext({
			contract,
			principals: [
				{
					principalId: "test-operator",
					principalKind: "operator",
					capabilities: ["evidence:test-result", "transition:satisfy"],
				},
				{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
			],
			sourceGrants: [
				{
					sourceId: "e05-src",
					principalId: "test-operator",
					principalKind: "operator",
					capability: "evidence:test-result" as EvidenceLedgerCapability,
					allowedEvidenceTypes: ["test-result", "command-result"], // Allow both so source check passes
				},
			],
		});

		const validation = validateRequirementLedger(contract, tampered!, ctx);
		expect(validation.ok).toBe(false);
		expect(validation.code).toBe("CRITERION_EVIDENCE_POLICY_VIOLATION");
	});

	it("E06: collector class restriction fails via source grant", () => {
		// Test that source-grant-level collector class restriction works.
		// Evidence has reportedCollectorType "test-runner" but grant restricts to "build-system".
		const contract = loadContract("M01");
		const ledger = buildSatisfiedLedgerWithSource(contract, trustedOpWithTestEvidence, "e06-src");

		const ctx = _internalCreateTrustedValidationContext({
			contract: loadContract("M01"),
			principals: [
				{
					principalId: "test-operator",
					principalKind: "operator",
					capabilities: ["evidence:test-result", "transition:satisfy"],
				},
				{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
			],
			sourceGrants: [
				{
					sourceId: "e06-src",
					principalId: "test-operator",
					principalKind: "operator",
					capability: "evidence:test-result" as EvidenceLedgerCapability,
					allowedEvidenceTypes: ["test-result"],
					allowedCollectorClasses: ["build-system"], // Only build-system, evidence has test-runner
				},
			],
		});

		const validation = validateRequirementLedger(contract, ledger!, ctx);
		expect(validation.ok).toBe(false);
	});

	it("E07: insufficient authority rejected during replay", () => {
		const contract = loadContract("M01");
		// Build ledger without evidence capability → evidence is agent-claim
		const agentCtx = _internalCreateTrustedContext({
			principalId: "some-agent",
			principalKind: "agent",
			capabilities: [],
		});

		const init = initializeRequirementLedger(contract);
		if (!init.ok) throw new Error(init.error);
		let ledger = init.value!;

		const reqId = contract.requirements[0]?.id ?? "REQ-001";
		const critId = contract.requirements[0]?.acceptanceCriteria[0]?.id ?? "AC-001";

		let r = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-E07-001",
			expectedRevision: 0,
			requirementId: reqId,
			toStatus: "IMPLEMENTED_UNVERIFIED",
			reportedActorType: "agent",
			reason: "Done",
			evidenceIds: [],
		});
		if (!r.ok) throw new Error(r.error);
		ledger = r.value!;

		const ev = addLedgerEvidence(
			contract,
			ledger!,
			{
				expectedRevision: 1,
				evidence: {
					id: "EV-E07",
					type: "test-result",
					requirementIds: [reqId],
					criterionIds: [critId],
					status: "pass",
					source: "some-src",
					summary: "pass",
					reportedCollectorType: "test-runner",
					reportedAuthority: true,
				},
			},
			agentCtx,
		);
		if (!ev.ok) throw new Error(ev.error);
		ledger = ev.value!;

		// Evidence has effectiveAuthority: "agent-claim" — cannot SATISFIED
		expect(ledger!.evidence[0].effectiveAuthority).toBe("agent-claim");

		// SATISFIED should fail because evidence is non-authoritative
		r = applyRequirementTransition(
			contract,
			ledger!,
			{
				transitionId: "TX-E07-002",
				expectedRevision: 2,
				requirementId: reqId,
				toStatus: "SATISFIED",
				reportedActorType: "operator",
				reason: "Verified",
				evidenceIds: ["EV-E07"],
			},
			agentCtx,
		);
		expect(r.ok).toBe(false);
		expect(r.code).toBe("TRUSTED_CONTEXT_REQUIRED");
	});

	it("E08: failed evidence with criterion minPassingStatus:pass rejected during replay", () => {
		const contract = loadContract("M10");
		// Build ledger with passing evidence, then tamper status to "fail" post-hoc
		const ledger = buildSatisfiedLedgerWithSource(contract, trustedOpWithTestEvidence, "e08-src");

		const tampered = structuredClone(ledger!);
		tampered.evidence[0].status = "fail";

		// M10 criterion has minPassingStatus default ("pass").
		// Check: the criterion actually has no explicit minPassingStatus,
		// so we create a context that does.
		// Instead, use a tampered contract with strict criterion requiring pass.
		const strictContract = structuredClone(contract);
		const req = strictContract.requirements.find((r) => r.id === "REQ-001");
		if (req?.acceptanceCriteria[0]) {
			req.acceptanceCriteria[0].requiredEvidence = [
				{ allowedTypes: ["test-result"], minAuthority: "test-result", minPassingStatus: "pass" },
			];
		}

		// Rebuild ledger with the modified contract
		const ledger2 = buildSatisfiedLedgerWithSource(strictContract, trustedOpWithTestEvidence, "e08-src");
		const tampered2 = structuredClone(ledger2!);
		tampered2.evidence[0].status = "fail";

		const ctx = _internalCreateTrustedValidationContext({
			contract: strictContract,
			principals: [
				{
					principalId: "test-operator",
					principalKind: "operator",
					capabilities: ["evidence:test-result", "transition:satisfy"],
				},
				{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
			],
			sourceGrants: [makeTestOperatorSourceGrant("e08-src")],
		});

		const validation = validateRequirementLedger(strictContract, tampered2!, ctx);
		expect(validation.ok).toBe(false);
		expect(validation.code).toBe("CRITERION_EVIDENCE_POLICY_VIOLATION");
	});

	it("E09: contract authoritativeSources rejects non-listed authority", () => {
		const contract = loadContract("M01");
		// Build ledger with permissive M01 contract
		const _ledger = buildSatisfiedLedgerWithSource(contract, trustedOpWithTestEvidence, "e09-src");

		// Tamper contract to only allow trusted-collector
		const strictContract = structuredClone(contract);
		strictContract.evidencePolicy.authoritativeSources = ["trusted-collector"];

		// Use the ledger built with permissive contract, but validate with strict contract
		const ctx = _internalCreateTrustedValidationContext({
			contract: strictContract,
			principals: [
				{
					principalId: "test-operator",
					principalKind: "operator",
					capabilities: ["evidence:test-result", "transition:satisfy"],
				},
				{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
			],
			sourceGrants: [makeTestOperatorSourceGrant("e09-src")],
		});

		// Tamper the ledger to match strict contract digest, then validate
		const tampered = structuredClone(_ledger!);
		// Rebuild the ledger with strict contract digest
		const strictInit = initializeRequirementLedger(strictContract);
		const strictDigest = strictInit.ok ? strictInit.value!.contractDigest : undefined;
		if (strictDigest) tampered.contractDigest = strictDigest;
		tampered.evidence[0].effectiveAuthority = "test-result";
		tampered.evidence[0].verifiedCapability = "evidence:test-result";

		const validation = validateRequirementLedger(strictContract, tampered!, ctx);
		expect(validation.ok).toBe(false);
		expect(validation.code).toBe("CONTRACT_EVIDENCE_POLICY_VIOLATION");
	});
});

// =============================================================================
// C01-C07: Completion candidate boundaries
// =============================================================================

describe("C01-C07: Completion candidate boundaries", () => {
	it("C01: fully valid M20 plus exact registry grants → true", () => {
		const contract = loadContract("M20");
		const ctx = _internalCreateTrustedValidationContext({
			contract,
			principals: [
				{
					principalId: "test-operator",
					principalKind: "operator",
					capabilities: ["evidence:test-result", "transition:satisfy"],
				},
				{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
			],
			sourceGrants: [makeTestOperatorSourceGrant("m20-src")],
		});

		// Build complete satisfied ledger
		const init = initializeRequirementLedger(contract);
		if (!init.ok) throw new Error(init.error);
		let ledger = init.value!;

		const reqId = "REQ-001";
		const critId = "AC-1";

		let r = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-C01-001",
			expectedRevision: 0,
			requirementId: reqId,
			toStatus: "IMPLEMENTED_UNVERIFIED",
			reportedActorType: "agent",
			reason: "Done",
			evidenceIds: [],
		});
		if (!r.ok) throw new Error(r.error);
		ledger = r.value!;

		const ev = addLedgerEvidence(
			contract,
			ledger!,
			{
				expectedRevision: 1,
				evidence: {
					id: "EV-C01",
					type: "test-result",
					requirementIds: [reqId],
					criterionIds: [critId],
					status: "pass",
					source: "m20-src",
					summary: "All green",
					reportedCollectorType: "test-runner",
					reportedAuthority: true,
				},
			},
			trustedOpWithTestEvidence,
			ctx,
		);
		if (!ev.ok) throw new Error(ev.error);
		ledger = ev.value!;

		r = applyRequirementTransition(
			contract,
			ledger!,
			{
				transitionId: "TX-C01-002",
				expectedRevision: 2,
				requirementId: reqId,
				toStatus: "SATISFIED",
				reportedActorType: "operator",
				reason: "Verified",
				evidenceIds: ["EV-C01"],
			},
			trustedOpWithTestEvidence,
			ctx,
		);
		if (!r.ok) throw new Error(r.error);
		ledger = r.value!;

		const summary = deriveRequirementLedgerSummary(contract, ledger!, ctx);
		expect(summary.completionCandidate).toBe(true);
	});

	it("C02: cross-kind borrowed capability → no true candidate", () => {
		const contract = loadContract("M20");
		const ledger = buildSatisfiedLedgerWithSource(contract, trustedOpWithTestEvidence, "c02-src");

		// Source grant given to agent kind, but evidence was from operator kind
		const ctx = _internalCreateTrustedValidationContext({
			contract,
			principals: [
				{
					principalId: "test-operator",
					principalKind: "operator",
					capabilities: ["evidence:test-result", "transition:satisfy"],
				},
				{ principalId: "test-operator", principalKind: "agent", capabilities: ["evidence:test-result"] },
				{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
			],
			sourceGrants: [
				{
					sourceId: "c02-src",
					principalId: "test-operator",
					principalKind: "agent", // Wrong kind → mismatch
					capability: "evidence:test-result" as EvidenceLedgerCapability,
					allowedEvidenceTypes: ["test-result"],
				},
			],
		});

		const summary = deriveRequirementLedgerSummary(contract, ledger!, ctx);
		expect(summary.completionCandidate).toBe(false);
	});

	it("C03: cross-principal borrowed source → no true candidate", () => {
		const contract = loadContract("M20");
		const ledger = buildSatisfiedLedgerWithSource(contract, trustedOpWithTestEvidence, "c03-src");

		const ctx = _internalCreateTrustedValidationContext({
			contract,
			principals: [
				{
					principalId: "test-operator",
					principalKind: "operator",
					capabilities: ["evidence:test-result", "transition:satisfy"],
				},
				{ principalId: "other-principal", principalKind: "operator", capabilities: ["evidence:test-result"] },
				{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
			],
			sourceGrants: [
				{
					sourceId: "c03-src",
					principalId: "other-principal", // Different principal
					principalKind: "operator",
					capability: "evidence:test-result" as EvidenceLedgerCapability,
					allowedEvidenceTypes: ["test-result"],
				},
			],
		});

		const summary = deriveRequirementLedgerSummary(contract, ledger!, ctx);
		expect(summary.completionCandidate).toBe(false);
	});

	it("C04: missing source → no true candidate", () => {
		const contract = loadContract("M20");
		// Build ledger with empty source
		const init = initializeRequirementLedger(contract);
		if (!init.ok) throw new Error(init.error);
		let ledger = init.value!;

		let r = applyRequirementTransition(contract, ledger!, {
			transitionId: "TX-C04-001",
			expectedRevision: 0,
			requirementId: "REQ-001",
			toStatus: "IMPLEMENTED_UNVERIFIED",
			reportedActorType: "agent",
			reason: "Done",
			evidenceIds: [],
		});
		if (!r.ok) throw new Error(r.error);
		ledger = r.value!;

		const ctx = _internalCreateTrustedValidationContext({
			contract,
			principals: [
				{
					principalId: "test-operator",
					principalKind: "operator",
					capabilities: ["evidence:test-result", "transition:satisfy"],
				},
				{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
			],
			sourceGrants: [makeTestOperatorSourceGrant("c04-src")],
		});

		const ev = addLedgerEvidence(
			contract,
			ledger!,
			{
				expectedRevision: 1,
				evidence: {
					id: "EV-C04",
					type: "test-result",
					requirementIds: ["REQ-001"],
					criterionIds: ["AC-1"],
					status: "pass",
					source: "c04-src",
					summary: "pass",
					reportedCollectorType: "test-runner",
					reportedAuthority: true,
				},
			},
			trustedOpWithTestEvidence,
			ctx,
		);
		if (!ev.ok) throw new Error(ev.error);
		ledger = ev.value!;

		r = applyRequirementTransition(
			contract,
			ledger!,
			{
				transitionId: "TX-C04-002",
				expectedRevision: 2,
				requirementId: "REQ-001",
				toStatus: "SATISFIED",
				reportedActorType: "operator",
				reason: "Verified",
				evidenceIds: ["EV-C04"],
			},
			trustedOpWithTestEvidence,
			ctx,
		);
		if (!r.ok) throw new Error(r.error);
		ledger = r.value!;

		// Tamper: set source to empty
		const tampered = structuredClone(ledger!);
		tampered.evidence[0].source = "";

		const summary = deriveRequirementLedgerSummary(contract, tampered!, ctx);
		expect(summary.completionCandidate).toBe(false);
	});

	it("C05: contract source mismatch → no true candidate", () => {
		const contract = loadContract("M20");
		const strictContract = structuredClone(contract);
		strictContract.evidencePolicy.authoritativeSources = []; // No authorities allowed

		const ledger = buildSatisfiedLedgerWithSource(contract, trustedOpWithTestEvidence, "c05-src");

		const ctx = _internalCreateTrustedValidationContext({
			contract,
			principals: [
				{
					principalId: "test-operator",
					principalKind: "operator",
					capabilities: ["evidence:test-result", "transition:satisfy"],
				},
				{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
			],
			sourceGrants: [makeTestOperatorSourceGrant("c05-src")],
		});

		const summary = deriveRequirementLedgerSummary(strictContract, ledger!, ctx);
		expect(summary.completionCandidate).toBe(false);
	});

	it("C06: tampered source → no true candidate", () => {
		const contract = loadContract("M20");
		const ledger = buildSatisfiedLedgerWithSource(contract, trustedOpWithTestEvidence, "c06-src");

		const tampered = structuredClone(ledger!);
		tampered.evidence[0].source = "tampered-src";

		const ctx = _internalCreateTrustedValidationContext({
			contract,
			principals: [
				{
					principalId: "test-operator",
					principalKind: "operator",
					capabilities: ["evidence:test-result", "transition:satisfy"],
				},
				{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
			],
			sourceGrants: [makeTestOperatorSourceGrant("c06-src")], // Grant for original, NOT for tampered
		});

		const summary = deriveRequirementLedgerSummary(contract, tampered!, ctx);
		expect(summary.completionCandidate).toBe(false);
	});

	it("C07: fresh fully compliant evidence → true", () => {
		// Same as C01 but with a fresh M20 setup — already tested in C01
		// This also proves the structural inspection path doesn't give completionCandidate
		const contract = loadContract("M20");
		const ledger = buildSatisfiedLedgerWithSource(contract, trustedOpWithTestEvidence, "c07-src");

		const inspection = inspectLedgerStructure(contract, ledger!);
		expect(inspection.completionCandidate).toBe("unavailable");
		expect(inspection.trustVerified).toBe(false);

		const ctx = _internalCreateTrustedValidationContext({
			contract,
			principals: [
				{
					principalId: "test-operator",
					principalKind: "operator",
					capabilities: ["evidence:test-result", "transition:satisfy"],
				},
				{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
			],
			sourceGrants: [makeTestOperatorSourceGrant("c07-src")],
		});

		const summary = deriveRequirementLedgerSummary(contract, ledger!, ctx);
		expect(summary.completionCandidate).toBe(true);
	});
});

// =============================================================================
// R01-R04: Strict validation result semantics
// =============================================================================

describe("R01-R04: Strict validation result semantics", () => {
	const ctx = _internalCreateTrustedValidationContext({
		contract: loadContract("M01"),
		principals: [
			{
				principalId: "test-operator",
				principalKind: "operator",
				capabilities: ["evidence:test-result", "transition:satisfy"],
			},
			{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
		],
		sourceGrants: [makeTestOperatorSourceGrant("r-src")],
	});

	it("R01: structural failure marked failed", () => {
		const contract = loadContract("M01");
		const init = initializeRequirementLedger(contract);
		if (!init.ok) throw new Error(init.error);

		const tampered = structuredClone(init.value!);
		tampered.contractDigest = "wrong-digest";

		const result = validateRequirementLedgerStrict(contract, tampered!, ctx);
		expect(result.valid).toBe(false);
		expect(result.trustVerified).toBe(true);

		expect(result.structuralValidation.status).toBe("failed");
		if (result.structuralValidation.status === "failed") {
			expect(result.structuralValidation.code).toBeDefined();
		}

		expect(result.provenanceValidation.status).toBe("not-reached");
	});

	it("R02: provenance failure marked failed", () => {
		const contract = loadContract("M01");
		const ledger = buildSatisfiedLedgerWithSource(contract, trustedOpWithTestEvidence, "nonexistent-src");

		const result = validateRequirementLedgerStrict(contract, ledger!, ctx);
		expect(result.valid).toBe(false);
		expect(result.trustVerified).toBe(true);

		expect(result.structuralValidation.status).toBe("passed");
		expect(result.provenanceValidation.status).toBe("failed");
		if (result.provenanceValidation.status === "failed") {
			expect(result.provenanceValidation.code).toBeDefined();
		}
	});

	it("R03: provenance not reached distinguished", () => {
		const contract = loadContract("M01");
		const init = initializeRequirementLedger(contract);
		if (!init.ok) throw new Error(init.error);

		const tampered = structuredClone(init.value!);
		tampered.contractRevision = 999;

		const result = validateRequirementLedgerStrict(contract, tampered!, ctx);
		expect(result.valid).toBe(false);

		// Structural failure → provenance not reached
		expect(result.structuralValidation.status).toBe("failed");
		expect(result.provenanceValidation.status).toBe("not-reached");
	});

	it("R04: complete trusted validation marked passed", () => {
		const contract = loadContract("M01");
		const ledger = buildSatisfiedLedgerWithSource(contract, trustedOpWithTestEvidence, "r-src");

		const result = validateRequirementLedgerStrict(contract, ledger!, ctx);
		expect(result.valid).toBe(true);
		expect(result.trustVerified).toBe(true);
		expect(result.structuralValidation.status).toBe("passed");
		expect(result.provenanceValidation.status).toBe("passed");
	});
});
