/**
 * CLOSE-01 through CLOSE-12: Closure gate and trusted-context enforcement.
 *
 * Covers:
 *   CLOSE-01: Agent-claim evidence without validationContext succeeds non-authoritatively
 *   CLOSE-02: Unprivileged transition without validationContext succeeds
 *   CLOSE-03: Authoritative evidence without validationContext rejected
 *   CLOSE-04: Authoritative evidence with forged validationContext rejected
 *   CLOSE-05: SATISFIED without validationContext rejected
 *   CLOSE-06: SATISFIED with forged validationContext rejected
 *   CLOSE-07: Runtime NOT_APPLICABLE without validationContext rejected
 *   CLOSE-08: Regression without validationContext rejected
 *   CLOSE-09: Genuine contexts permit valid privileged mutations
 *   CLOSE-10: Successful privileged mutation passes strict replay
 *   CLOSE-11: Failed closure gate returns no mutated ledger and leaves input unchanged
 *   CLOSE-12: Failed closure operation cannot alter atomic output (same bytes, same SHA)
 */

import { createHash } from "crypto";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import {
	addLedgerEvidence,
	applyRequirementTransition,
	initializeRequirementLedger,
	type MissionContractV1,
	type RequirementLedgerV1,
	validateRequirementLedgerStrict,
} from "../../src/core/long-horizon/index.js";
import type {
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

// Genuine trusted contexts
const trustedOpCtx: TrustedLedgerMutationContext = _internalCreateTrustedContext({
	principalId: "test-operator",
	principalKind: "operator",
	capabilities: ["transition:satisfy", "evidence:test-result", "evidence:operator-confirmation"],
});

const trustedOpValidation: TrustedValidationContext = _internalCreateTrustedValidationContext({
	contract: loadContract("M01"),
	principals: [
		{
			principalId: "test-operator",
			principalKind: "operator",
			capabilities: ["transition:satisfy", "evidence:test-result", "evidence:operator-confirmation"],
		},
		{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
	],
	sourceGrants: [
		{
			sourceId: "test",
			principalId: "test-operator",
			principalKind: "operator",
			capability: "evidence:test-result",
			allowedEvidenceTypes: ["test-result"],
		},
	],
});

const applicableMutation: TrustedLedgerMutationContext = _internalCreateTrustedContext({
	principalId: "test-reviewer",
	principalKind: "automated-review",
	capabilities: ["transition:not-applicable"],
});

// Helpers
function initializeLedger(contract: MissionContractV1): RequirementLedgerV1 {
	const r = initializeRequirementLedger(contract);
	if (!r.ok) throw new Error(r.error);
	return r.value!;
}

function sha256(data: string): string {
	return createHash("sha256").update(data).digest("hex");
}

// =============================================================================
// Tests
// =============================================================================

describe("CLOSE-01..CLOSE-12: Closure gate enforcement", () => {
	it("CLOSE-01: agent-claim evidence without validationContext succeeds non-authoritatively", () => {
		const contract = loadContract("M01");
		let ledger = initializeLedger(contract);

		const r = applyRequirementTransition(contract, ledger, {
			transitionId: "CLOSE-01-T1",
			expectedRevision: 0,
			requirementId: "REQ-001",
			toStatus: "IMPLEMENTED_UNVERIFIED",
			reportedActorType: "agent",
			reason: "Implemented",
			evidenceIds: [],
		});
		expect(r.ok).toBe(true);
		ledger = r.value!;

		const ev = addLedgerEvidence(contract, ledger, {
			expectedRevision: 1,
			evidence: {
				id: "EV-CLOSE-01",
				type: "test-result",
				requirementIds: ["REQ-001"],
				criterionIds: ["AC-001"],
				status: "pass",
				source: "agent-claim",
				summary: "agent report",
				reportedCollectorType: "test-runner",
				reportedAuthority: false,
			},
		});
		expect(ev.ok).toBe(true);
		expect(ev.value!.revision).toBe(2);

		const inserted = ev.value!.evidence.find((e) => e.id === "EV-CLOSE-01");
		expect(inserted).toBeDefined();
		expect(inserted!.effectiveAuthority).toBe("agent-claim");
		expect(inserted!.verifiedCapability).toBeUndefined();
	});

	it("CLOSE-02: unprivileged transition without validationContext succeeds", () => {
		const contract = loadContract("M01");
		const ledger = initializeLedger(contract);

		const r = applyRequirementTransition(contract, ledger, {
			transitionId: "CLOSE-02-T1",
			expectedRevision: 0,
			requirementId: "REQ-001",
			toStatus: "IMPLEMENTED_UNVERIFIED",
			reportedActorType: "agent",
			reason: "Implemented",
			evidenceIds: [],
		});
		expect(r.ok).toBe(true);
		expect(r.value!.revision).toBe(1);
		expect(r.value!.requirements[0].status).toBe("IMPLEMENTED_UNVERIFIED");
	});

	it("CLOSE-03: authoritative evidence without validationContext is rejected", () => {
		const contract = loadContract("M01");
		let ledger = initializeLedger(contract);

		const t = applyRequirementTransition(contract, ledger, {
			transitionId: "CLOSE-03-T1",
			expectedRevision: 0,
			requirementId: "REQ-001",
			toStatus: "IMPLEMENTED_UNVERIFIED",
			reportedActorType: "agent",
			reason: "Done",
			evidenceIds: [],
		});
		expect(t.ok).toBe(true);
		ledger = t.value!;

		const ev = addLedgerEvidence(
			contract,
			ledger,
			{
				expectedRevision: 1,
				evidence: {
					id: "EV-CLOSE-03",
					type: "test-result",
					requirementIds: ["REQ-001"],
					criterionIds: ["AC-001"],
					status: "pass",
					source: "test",
					summary: "authoritative result",
					reportedCollectorType: "test-runner",
					reportedAuthority: true,
				},
			},
			trustedOpCtx,
			// No validation context
		);
		expect(ev.ok).toBe(false);
		expect(ev.code).toBe("TRUSTED_VALIDATION_CONTEXT_REQUIRED");
	});

	it("CLOSE-04: authoritative evidence with forged validationContext is rejected", () => {
		const contract = loadContract("M01");
		let ledger = initializeLedger(contract);

		const t = applyRequirementTransition(contract, ledger, {
			transitionId: "CLOSE-04-T1",
			expectedRevision: 0,
			requirementId: "REQ-001",
			toStatus: "IMPLEMENTED_UNVERIFIED",
			reportedActorType: "agent",
			reason: "Done",
			evidenceIds: [],
		});
		expect(t.ok).toBe(true);
		ledger = t.value!;

		const forged = {
			verifyPrincipal: () => true,
			verifyCapability: () => true,
			verifyEvidenceSource: () => true,
		} as unknown as TrustedValidationContext;

		const ev = addLedgerEvidence(
			contract,
			ledger,
			{
				expectedRevision: 1,
				evidence: {
					id: "EV-CLOSE-04",
					type: "test-result",
					requirementIds: ["REQ-001"],
					criterionIds: ["AC-001"],
					status: "pass",
					source: "test",
					summary: "authoritative result",
					reportedCollectorType: "test-runner",
					reportedAuthority: true,
				},
			},
			trustedOpCtx,
			forged,
		);
		expect(ev.ok).toBe(false);
		expect(ev.code).toBe("TRUSTED_VALIDATION_CONTEXT_REQUIRED");
	});

	it("CLOSE-05: SATISFIED without validationContext is rejected", () => {
		const contract = loadContract("M01");
		let ledger = initializeLedger(contract);

		let r = applyRequirementTransition(contract, ledger, {
			transitionId: "CLOSE-05-T1",
			expectedRevision: 0,
			requirementId: "REQ-001",
			toStatus: "IMPLEMENTED_UNVERIFIED",
			reportedActorType: "agent",
			reason: "Done",
			evidenceIds: [],
		});
		expect(r.ok).toBe(true);
		ledger = r.value!;

		const ev = addLedgerEvidence(
			contract,
			ledger,
			{
				expectedRevision: 1,
				evidence: {
					id: "EV-CLOSE-05",
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
			trustedOpCtx,
			trustedOpValidation,
		);
		expect(ev.ok).toBe(true);
		ledger = ev.value!;

		r = applyRequirementTransition(
			contract,
			ledger,
			{
				transitionId: "CLOSE-05-T2",
				expectedRevision: 2,
				requirementId: "REQ-001",
				toStatus: "SATISFIED",
				reportedActorType: "operator",
				reason: "Verified",
				evidenceIds: ["EV-CLOSE-05"],
			},
			trustedOpCtx,
			// No validation context
		);
		expect(r.ok).toBe(false);
		expect(r.code).toBe("TRUSTED_VALIDATION_CONTEXT_REQUIRED");
	});

	it("CLOSE-06: SATISFIED with forged validationContext is rejected", () => {
		const contract = loadContract("M01");
		let ledger = initializeLedger(contract);

		let r = applyRequirementTransition(contract, ledger, {
			transitionId: "CLOSE-06-T1",
			expectedRevision: 0,
			requirementId: "REQ-001",
			toStatus: "IMPLEMENTED_UNVERIFIED",
			reportedActorType: "agent",
			reason: "Done",
			evidenceIds: [],
		});
		expect(r.ok).toBe(true);
		ledger = r.value!;

		const ev = addLedgerEvidence(
			contract,
			ledger,
			{
				expectedRevision: 1,
				evidence: {
					id: "EV-CLOSE-06",
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
			trustedOpCtx,
			trustedOpValidation,
		);
		expect(ev.ok).toBe(true);
		ledger = ev.value!;

		const forged = {
			verifyPrincipal: () => true,
			verifyCapability: () => true,
			verifyEvidenceSource: () => true,
		} as unknown as TrustedValidationContext;

		r = applyRequirementTransition(
			contract,
			ledger,
			{
				transitionId: "CLOSE-06-T2",
				expectedRevision: 2,
				requirementId: "REQ-001",
				toStatus: "SATISFIED",
				reportedActorType: "operator",
				reason: "Verified",
				evidenceIds: ["EV-CLOSE-06"],
			},
			trustedOpCtx,
			forged,
		);
		expect(r.ok).toBe(false);
		expect(r.code).toBe("TRUSTED_VALIDATION_CONTEXT_REQUIRED");
	});

	it("CLOSE-07: NOT_APPLICABLE without validationContext is rejected", () => {
		const contract = loadContract("M01");
		const ledger = initializeLedger(contract);

		// Initial state is UNASSESSED, which permits NOT_APPLICABLE
		// The closure gate fires because NOT_APPLICABLE is privileged
		const r = applyRequirementTransition(
			contract,
			ledger,
			{
				transitionId: "CLOSE-07-T1",
				expectedRevision: 0,
				requirementId: "REQ-001",
				toStatus: "NOT_APPLICABLE",
				reportedActorType: "automated-review",
				reason: "No longer relevant",
				evidenceIds: [],
			},
			applicableMutation,
			// No validation context
		);
		expect(r.ok).toBe(false);
		expect(r.code).toBe("TRUSTED_VALIDATION_CONTEXT_REQUIRED");
	});

	it("CLOSE-08: regression without validationContext is rejected", () => {
		const contract = loadContract("M01");
		let ledger = initializeLedger(contract);

		let r = applyRequirementTransition(contract, ledger, {
			transitionId: "CLOSE-08-T1",
			expectedRevision: 0,
			requirementId: "REQ-001",
			toStatus: "IMPLEMENTED_UNVERIFIED",
			reportedActorType: "agent",
			reason: "Done",
			evidenceIds: [],
		});
		expect(r.ok).toBe(true);
		ledger = r.value!;

		const ev = addLedgerEvidence(
			contract,
			ledger,
			{
				expectedRevision: 1,
				evidence: {
					id: "EV-CLOSE-08",
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
			trustedOpCtx,
			trustedOpValidation,
		);
		expect(ev.ok).toBe(true);
		ledger = ev.value!;

		r = applyRequirementTransition(
			contract,
			ledger,
			{
				transitionId: "CLOSE-08-T2",
				expectedRevision: 2,
				requirementId: "REQ-001",
				toStatus: "SATISFIED",
				reportedActorType: "operator",
				reason: "Verified",
				evidenceIds: ["EV-CLOSE-08"],
			},
			trustedOpCtx,
			trustedOpValidation,
		);
		expect(r.ok).toBe(true);
		ledger = r.value!;

		// Regression from SATISFIED WITHOUT validation context
		r = applyRequirementTransition(
			contract,
			ledger,
			{
				transitionId: "CLOSE-08-T3",
				expectedRevision: 3,
				requirementId: "REQ-001",
				toStatus: "IMPLEMENTED_UNVERIFIED",
				reportedActorType: "operator",
				reason: "Regressed",
				evidenceIds: [],
			},
			trustedOpCtx,
			// No validation context
		);
		expect(r.ok).toBe(false);
		expect(r.code).toBe("TRUSTED_VALIDATION_CONTEXT_REQUIRED");
	});

	it("CLOSE-09: genuine mutation and validation contexts permit valid privileged mutations", () => {
		const contract = loadContract("M01");
		let ledger = initializeLedger(contract);

		let r = applyRequirementTransition(contract, ledger, {
			transitionId: "CLOSE-09-T1",
			expectedRevision: 0,
			requirementId: "REQ-001",
			toStatus: "IMPLEMENTED_UNVERIFIED",
			reportedActorType: "agent",
			reason: "Done",
			evidenceIds: [],
		});
		expect(r.ok).toBe(true);
		ledger = r.value!;

		const ev = addLedgerEvidence(
			contract,
			ledger,
			{
				expectedRevision: 1,
				evidence: {
					id: "EV-CLOSE-09",
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
			trustedOpCtx,
			trustedOpValidation,
		);
		expect(ev.ok).toBe(true);
		ledger = ev.value!;

		r = applyRequirementTransition(
			contract,
			ledger,
			{
				transitionId: "CLOSE-09-T2",
				expectedRevision: 2,
				requirementId: "REQ-001",
				toStatus: "SATISFIED",
				reportedActorType: "operator",
				reason: "Verified",
				evidenceIds: ["EV-CLOSE-09"],
			},
			trustedOpCtx,
			trustedOpValidation,
		);
		expect(r.ok).toBe(true);
		ledger = r.value!;
		expect(ledger.requirements[0].status).toBe("SATISFIED");
	});

	it("CLOSE-10: successful privileged mutation immediately passes validateRequirementLedgerStrict", () => {
		const contract = loadContract("M01");
		let ledger = initializeLedger(contract);

		let r = applyRequirementTransition(contract, ledger, {
			transitionId: "CLOSE-10-T1",
			expectedRevision: 0,
			requirementId: "REQ-001",
			toStatus: "IMPLEMENTED_UNVERIFIED",
			reportedActorType: "agent",
			reason: "Done",
			evidenceIds: [],
		});
		expect(r.ok).toBe(true);
		ledger = r.value!;

		const ev = addLedgerEvidence(
			contract,
			ledger,
			{
				expectedRevision: 1,
				evidence: {
					id: "EV-CLOSE-10",
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
			trustedOpCtx,
			trustedOpValidation,
		);
		expect(ev.ok).toBe(true);
		ledger = ev.value!;

		r = applyRequirementTransition(
			contract,
			ledger,
			{
				transitionId: "CLOSE-10-T2",
				expectedRevision: 2,
				requirementId: "REQ-001",
				toStatus: "SATISFIED",
				reportedActorType: "operator",
				reason: "Verified",
				evidenceIds: ["EV-CLOSE-10"],
			},
			trustedOpCtx,
			trustedOpValidation,
		);
		expect(r.ok).toBe(true);
		ledger = r.value!;

		const strict = validateRequirementLedgerStrict(contract, ledger, trustedOpValidation);
		expect(strict.valid).toBe(true);
	});

	it("CLOSE-11: failed closure gate returns no mutated ledger and leaves input unchanged", () => {
		const contract = loadContract("M01");
		let ledger = initializeLedger(contract);

		let r = applyRequirementTransition(contract, ledger, {
			transitionId: "CLOSE-11-T1",
			expectedRevision: 0,
			requirementId: "REQ-001",
			toStatus: "IMPLEMENTED_UNVERIFIED",
			reportedActorType: "agent",
			reason: "Done",
			evidenceIds: [],
		});
		expect(r.ok).toBe(true);
		ledger = r.value!;

		const ev = addLedgerEvidence(
			contract,
			ledger,
			{
				expectedRevision: 1,
				evidence: {
					id: "EV-CLOSE-11A",
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
			trustedOpCtx,
			trustedOpValidation,
		);
		expect(ev.ok).toBe(true);
		ledger = ev.value!;

		r = applyRequirementTransition(
			contract,
			ledger,
			{
				transitionId: "CLOSE-11-T2",
				expectedRevision: 2,
				requirementId: "REQ-001",
				toStatus: "SATISFIED",
				reportedActorType: "operator",
				reason: "Verified",
				evidenceIds: ["EV-CLOSE-11A"],
			},
			trustedOpCtx,
			trustedOpValidation,
		);
		expect(r.ok).toBe(true);
		const satisfiedLedger = r.value!;

		const beforeRev = satisfiedLedger.revision;
		const beforeTransitionCount = satisfiedLedger.transitions.length;
		const beforeEvidenceCount = satisfiedLedger.evidence.length;
		const beforeStatus = satisfiedLedger.requirements[0].status;
		const beforeJson = JSON.stringify(satisfiedLedger);
		const beforeSha = sha256(beforeJson);

		// Regression WITHOUT validation context
		const failed = applyRequirementTransition(
			contract,
			satisfiedLedger,
			{
				transitionId: "CLOSE-11-FAIL",
				expectedRevision: 3,
				requirementId: "REQ-001",
				toStatus: "IMPLEMENTED_UNVERIFIED",
				reportedActorType: "operator",
				reason: "Should fail",
				evidenceIds: [],
			},
			trustedOpCtx,
		);
		expect(failed.ok).toBe(false);
		expect(failed.value).toBeUndefined();

		// Input ledger unchanged
		expect(satisfiedLedger.revision).toBe(beforeRev);
		expect(satisfiedLedger.transitions.length).toBe(beforeTransitionCount);
		expect(satisfiedLedger.evidence.length).toBe(beforeEvidenceCount);
		expect(satisfiedLedger.requirements[0].status).toBe(beforeStatus);

		const afterJson = JSON.stringify(satisfiedLedger);
		expect(afterJson).toBe(beforeJson);
		expect(sha256(afterJson)).toBe(beforeSha);
	});

	it("CLOSE-12: failed closure operation cannot alter atomic output — same bytes, same SHA-256, no sibling output", () => {
		const contract = loadContract("M01");
		let ledger = initializeLedger(contract);

		let r = applyRequirementTransition(contract, ledger, {
			transitionId: "CLOSE-12-T1",
			expectedRevision: 0,
			requirementId: "REQ-001",
			toStatus: "IMPLEMENTED_UNVERIFIED",
			reportedActorType: "agent",
			reason: "Done",
			evidenceIds: [],
		});
		expect(r.ok).toBe(true);
		ledger = r.value!;

		const ev = addLedgerEvidence(
			contract,
			ledger,
			{
				expectedRevision: 1,
				evidence: {
					id: "EV-CLOSE-12",
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
			trustedOpCtx,
			trustedOpValidation,
		);
		expect(ev.ok).toBe(true);
		ledger = ev.value!;

		const preAttemptJson = JSON.stringify(ledger);
		const preAttemptSha = sha256(preAttemptJson);

		const forged = {
			verifyPrincipal: () => true,
			verifyCapability: () => true,
			verifyEvidenceSource: () => true,
		} as unknown as TrustedValidationContext;

		r = applyRequirementTransition(
			contract,
			ledger,
			{
				transitionId: "CLOSE-12-FAIL",
				expectedRevision: 2,
				requirementId: "REQ-001",
				toStatus: "SATISFIED",
				reportedActorType: "operator",
				reason: "Forged attempt",
				evidenceIds: ["EV-CLOSE-12"],
			},
			trustedOpCtx,
			forged,
		);
		expect(r.ok).toBe(false);
		expect(r.code).toBe("TRUSTED_VALIDATION_CONTEXT_REQUIRED");
		expect(r.value).toBeUndefined();

		const postAttemptJson = JSON.stringify(ledger);
		const postAttemptSha = sha256(postAttemptJson);

		expect(postAttemptJson).toBe(preAttemptJson);
		expect(postAttemptSha).toBe(preAttemptSha);
		expect(ledger.requirements[0].status).toBe("IMPLEMENTED_UNVERIFIED");
	});
});
