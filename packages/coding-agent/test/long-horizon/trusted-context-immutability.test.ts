import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type {
	EvidenceSourceVerificationRequest,
	LedgerCapability,
	TrustedEvidenceSourceGrant,
	TrustedPrincipalKind,
} from "../../src/core/long-horizon/trusted-context.js";
import {
	_getBoundContractDigest,
	_internalCreateTrustedValidationContext,
} from "../../src/core/long-horizon/trusted-context.js";
import type { MissionContractV1 } from "../../src/core/long-horizon/types.js";

const CONTRACT_PATH = resolve(__dirname, "..", "..", "src", "core", "long-horizon", "fixtures", "M01-contract.json");

interface MutablePrincipal {
	principalId: string;
	principalKind: TrustedPrincipalKind;
	capabilities: LedgerCapability[];
}

interface MutableGrant extends TrustedEvidenceSourceGrant {
	sourceId: string;
	principalId: string;
	principalKind: TrustedPrincipalKind;
	capability: "evidence:test-result";
	allowedEvidenceTypes: string[];
	allowedCollectorClasses: string[];
	allowedRequirementIds: string[];
	allowedCriterionIds: string[];
}

function readContract(): MissionContractV1 {
	return JSON.parse(readFileSync(CONTRACT_PATH, "utf-8")) as MissionContractV1;
}

function makePrincipal(): MutablePrincipal {
	return {
		principalId: "immut-runner",
		principalKind: "automated-review",
		capabilities: ["evidence:test-result"],
	};
}

function makeGrant(sourceId = "immut-source"): MutableGrant {
	return {
		sourceId,
		principalId: "immut-runner",
		principalKind: "automated-review",
		capability: "evidence:test-result",
		allowedEvidenceTypes: ["test-result"],
		allowedCollectorClasses: ["test-runner"],
		allowedRequirementIds: ["REQ-001"],
		allowedCriterionIds: ["AC-001"],
	};
}

function makeRequest(sourceId = "immut-source"): EvidenceSourceVerificationRequest {
	return {
		sourceId,
		principalId: "immut-runner",
		principalKind: "automated-review",
		capability: "evidence:test-result",
		evidenceType: "test-result",
		collectorClass: "test-runner",
		requirementIds: ["REQ-001"],
		criterionIds: ["AC-001"],
	};
}

function createMutableInputs() {
	const contract = readContract();
	const principal = makePrincipal();
	const grant = makeGrant();
	const sourceGrants: MutableGrant[] = [grant];
	const context = _internalCreateTrustedValidationContext({
		contract,
		principals: [principal],
		sourceGrants,
	});
	return { contract, context, grant, principal, sourceGrants };
}

function createInputsWithAlternateRequirement(configureGrant: (grant: MutableGrant) => void) {
	const contract = readContract();
	const alternateRequirement = structuredClone(contract.requirements[0]);
	alternateRequirement.id = "REQ-002";
	alternateRequirement.acceptanceCriteria[0].id = "AC-002";
	contract.requirements.push(alternateRequirement);
	const principal = makePrincipal();
	const grant = makeGrant();
	configureGrant(grant);
	const context = _internalCreateTrustedValidationContext({
		contract,
		principals: [principal],
		sourceGrants: [grant],
	});
	return { context, grant };
}

describe("trusted validation context immutable snapshots", () => {
	it("IMMUT-01 principal capability mutation has no effect", () => {
		const { context, principal } = createMutableInputs();
		const before = context.verifyCapability("immut-runner", "automated-review", "evidence:test-result");
		principal.capabilities.splice(0, principal.capabilities.length);
		const after = context.verifyCapability("immut-runner", "automated-review", "evidence:test-result");
		expect({ before, after }).toEqual({ before: true, after: true });
	});

	it("IMMUT-02 allowedEvidenceTypes mutation has no effect", () => {
		const { context, grant } = createMutableInputs();
		const before = context.verifyEvidenceSource(makeRequest());
		grant.allowedEvidenceTypes.splice(0, 1, "command-result");
		const after = context.verifyEvidenceSource(makeRequest());
		expect({ before, after }).toEqual({ before: true, after: true });
	});

	it("IMMUT-03 allowedCollectorClasses mutation has no effect", () => {
		const { context, grant } = createMutableInputs();
		const before = context.verifyEvidenceSource(makeRequest());
		grant.allowedCollectorClasses.splice(0, 1, "agent");
		const after = context.verifyEvidenceSource(makeRequest());
		expect({ before, after }).toEqual({ before: true, after: true });
	});

	it("IMMUT-04 allowedRequirementIds mutation has no effect", () => {
		const { context, grant } = createMutableInputs();
		const before = context.verifyEvidenceSource(makeRequest());
		grant.allowedRequirementIds.splice(0, grant.allowedRequirementIds.length);
		const after = context.verifyEvidenceSource(makeRequest());
		expect({ before, after }).toEqual({ before: true, after: true });
	});

	it("IMMUT-05 allowedCriterionIds mutation has no effect", () => {
		const { context, grant } = createMutableInputs();
		const before = context.verifyEvidenceSource(makeRequest());
		grant.allowedCriterionIds.splice(0, grant.allowedCriterionIds.length);
		const after = context.verifyEvidenceSource(makeRequest());
		expect({ before, after }).toEqual({ before: true, after: true });
	});

	it("IMMUT-06 source-grant array append has no effect", () => {
		const { context, sourceGrants } = createMutableInputs();
		const request = makeRequest("appended-source");
		const before = context.verifyEvidenceSource(request);
		sourceGrants.push(makeGrant("appended-source"));
		const after = context.verifyEvidenceSource(request);
		expect({ before, after }).toEqual({ before: false, after: false });
	});

	it("IMMUT-07 replacing caller grant object fields has no effect", () => {
		const { context, grant } = createMutableInputs();
		const before = context.verifyEvidenceSource(makeRequest());
		grant.sourceId = "replaced-source";
		grant.principalId = "replaced-principal";
		grant.principalKind = "agent";
		const after = context.verifyEvidenceSource(makeRequest());
		expect({ before, after }).toEqual({ before: true, after: true });
	});

	it("IMMUT-08 nested mutations cannot widen authorization", () => {
		const contract = readContract();
		const principal = makePrincipal();
		const grant = makeGrant();
		grant.allowedEvidenceTypes = ["command-result"];
		const context = _internalCreateTrustedValidationContext({
			contract,
			principals: [principal],
			sourceGrants: [grant],
		});
		const before = context.verifyEvidenceSource(makeRequest());
		grant.allowedEvidenceTypes.push("test-result");
		const after = context.verifyEvidenceSource(makeRequest());
		expect({ before, after }).toEqual({ before: false, after: false });
	});

	it("IMMUT-09 nested mutations cannot revoke snapshotted authorization", () => {
		const { context, grant, principal } = createMutableInputs();
		const before = context.verifyEvidenceSource(makeRequest());
		principal.capabilities.splice(0, principal.capabilities.length);
		grant.allowedEvidenceTypes.splice(0, grant.allowedEvidenceTypes.length);
		grant.allowedCollectorClasses.splice(0, grant.allowedCollectorClasses.length);
		grant.allowedRequirementIds.splice(0, grant.allowedRequirementIds.length);
		grant.allowedCriterionIds.splice(0, grant.allowedCriterionIds.length);
		const after = context.verifyEvidenceSource(makeRequest());
		expect({ before, after }).toEqual({ before: true, after: true });
	});

	it("IMMUT-10 contract digest binding remains unchanged after caller mutation", () => {
		const { context, contract, grant } = createMutableInputs();
		const before = {
			digest: _getBoundContractDigest(context),
			verified: context.verifyEvidenceSource(makeRequest()),
		};
		contract.missionId = "caller-mutated-mission";
		grant.allowedEvidenceTypes.push("artifact");
		const after = {
			digest: _getBoundContractDigest(context),
			verified: context.verifyEvidenceSource(makeRequest()),
		};
		expect(after).toEqual(before);
	});

	it("IMMUT-11 principal capability element replacement has no effect", () => {
		const { context, principal } = createMutableInputs();
		const before = {
			digest: _getBoundContractDigest(context),
			principal: context.verifyPrincipal("immut-runner", "automated-review"),
			original: context.verifyCapability("immut-runner", "automated-review", "evidence:test-result"),
			replacement: context.verifyCapability("immut-runner", "automated-review", "transition:satisfy"),
		};
		principal.capabilities[0] = "transition:satisfy";
		const after = {
			digest: _getBoundContractDigest(context),
			principal: context.verifyPrincipal("immut-runner", "automated-review"),
			original: context.verifyCapability("immut-runner", "automated-review", "evidence:test-result"),
			replacement: context.verifyCapability("immut-runner", "automated-review", "transition:satisfy"),
		};
		expect(before).toMatchObject({ principal: true, original: true, replacement: false });
		expect(after).toEqual(before);
	});

	it("IMMUT-12 evidence-type element replacement has no effect", () => {
		const { context, grant } = createMutableInputs();
		const replacementRequest: EvidenceSourceVerificationRequest = {
			...makeRequest(),
			evidenceType: "command-result",
		};
		const before = {
			digest: _getBoundContractDigest(context),
			original: context.verifyEvidenceSource(makeRequest()),
			replacement: context.verifyEvidenceSource(replacementRequest),
		};
		grant.allowedEvidenceTypes[0] = "command-result";
		const after = {
			digest: _getBoundContractDigest(context),
			original: context.verifyEvidenceSource(makeRequest()),
			replacement: context.verifyEvidenceSource(replacementRequest),
		};
		expect(before).toMatchObject({ original: true, replacement: false });
		expect(after).toEqual(before);
	});

	it("IMMUT-13 collector-class element replacement has no effect", () => {
		const { context, grant } = createMutableInputs();
		const replacementRequest: EvidenceSourceVerificationRequest = {
			...makeRequest(),
			collectorClass: "agent",
		};
		const before = {
			digest: _getBoundContractDigest(context),
			original: context.verifyEvidenceSource(makeRequest()),
			replacement: context.verifyEvidenceSource(replacementRequest),
		};
		grant.allowedCollectorClasses[0] = "agent";
		const after = {
			digest: _getBoundContractDigest(context),
			original: context.verifyEvidenceSource(makeRequest()),
			replacement: context.verifyEvidenceSource(replacementRequest),
		};
		expect(before).toMatchObject({ original: true, replacement: false });
		expect(after).toEqual(before);
	});

	it("IMMUT-14 requirement-ID element replacement has no effect", () => {
		const { context, grant } = createInputsWithAlternateRequirement(() => {});
		const replacementRequest: EvidenceSourceVerificationRequest = {
			...makeRequest(),
			requirementIds: ["REQ-002"],
			criterionIds: [],
		};
		const before = {
			digest: _getBoundContractDigest(context),
			original: context.verifyEvidenceSource(makeRequest()),
			replacement: context.verifyEvidenceSource(replacementRequest),
		};
		grant.allowedRequirementIds[0] = "REQ-002";
		const after = {
			digest: _getBoundContractDigest(context),
			original: context.verifyEvidenceSource(makeRequest()),
			replacement: context.verifyEvidenceSource(replacementRequest),
		};
		expect(before).toMatchObject({ original: true, replacement: false });
		expect(after).toEqual(before);
	});

	it("IMMUT-15 criterion-ID element replacement has no effect", () => {
		const { context, grant } = createInputsWithAlternateRequirement((inputGrant) => {
			inputGrant.allowedRequirementIds.push("REQ-002");
		});
		const replacementRequest: EvidenceSourceVerificationRequest = {
			...makeRequest(),
			requirementIds: ["REQ-002"],
			criterionIds: ["AC-002"],
		};
		const before = {
			digest: _getBoundContractDigest(context),
			original: context.verifyEvidenceSource(makeRequest()),
			replacement: context.verifyEvidenceSource(replacementRequest),
		};
		grant.allowedCriterionIds[0] = "AC-002";
		const after = {
			digest: _getBoundContractDigest(context),
			original: context.verifyEvidenceSource(makeRequest()),
			replacement: context.verifyEvidenceSource(replacementRequest),
		};
		expect(before).toMatchObject({ original: true, replacement: false });
		expect(after).toEqual(before);
	});

	it("IMMUT-16 principal capabilities array replacement has no effect", () => {
		const { context, principal } = createMutableInputs();
		const before = {
			digest: _getBoundContractDigest(context),
			principal: context.verifyPrincipal("immut-runner", "automated-review"),
			original: context.verifyCapability("immut-runner", "automated-review", "evidence:test-result"),
			replacement: context.verifyCapability("immut-runner", "automated-review", "transition:satisfy"),
		};
		principal.capabilities = ["transition:satisfy"];
		const after = {
			digest: _getBoundContractDigest(context),
			principal: context.verifyPrincipal("immut-runner", "automated-review"),
			original: context.verifyCapability("immut-runner", "automated-review", "evidence:test-result"),
			replacement: context.verifyCapability("immut-runner", "automated-review", "transition:satisfy"),
		};
		expect(before).toMatchObject({ principal: true, original: true, replacement: false });
		expect(after).toEqual(before);
	});

	it("IMMUT-17 allowedEvidenceTypes array replacement has no effect", () => {
		const { context, grant } = createMutableInputs();
		const replacementRequest: EvidenceSourceVerificationRequest = {
			...makeRequest(),
			evidenceType: "command-result",
		};
		const before = {
			digest: _getBoundContractDigest(context),
			original: context.verifyEvidenceSource(makeRequest()),
			replacement: context.verifyEvidenceSource(replacementRequest),
		};
		grant.allowedEvidenceTypes = ["command-result"];
		const after = {
			digest: _getBoundContractDigest(context),
			original: context.verifyEvidenceSource(makeRequest()),
			replacement: context.verifyEvidenceSource(replacementRequest),
		};
		expect(before).toMatchObject({ original: true, replacement: false });
		expect(after).toEqual(before);
	});

	it("IMMUT-18 allowedCollectorClasses array replacement has no effect", () => {
		const { context, grant } = createMutableInputs();
		const replacementRequest: EvidenceSourceVerificationRequest = {
			...makeRequest(),
			collectorClass: "agent",
		};
		const before = {
			digest: _getBoundContractDigest(context),
			original: context.verifyEvidenceSource(makeRequest()),
			replacement: context.verifyEvidenceSource(replacementRequest),
		};
		grant.allowedCollectorClasses = ["agent"];
		const after = {
			digest: _getBoundContractDigest(context),
			original: context.verifyEvidenceSource(makeRequest()),
			replacement: context.verifyEvidenceSource(replacementRequest),
		};
		expect(before).toMatchObject({ original: true, replacement: false });
		expect(after).toEqual(before);
	});

	it("IMMUT-19 allowedRequirementIds array replacement has no effect", () => {
		const { context, grant } = createInputsWithAlternateRequirement(() => {});
		const replacementRequest: EvidenceSourceVerificationRequest = {
			...makeRequest(),
			requirementIds: ["REQ-002"],
			criterionIds: [],
		};
		const before = {
			digest: _getBoundContractDigest(context),
			original: context.verifyEvidenceSource(makeRequest()),
			replacement: context.verifyEvidenceSource(replacementRequest),
		};
		grant.allowedRequirementIds = ["REQ-002"];
		const after = {
			digest: _getBoundContractDigest(context),
			original: context.verifyEvidenceSource(makeRequest()),
			replacement: context.verifyEvidenceSource(replacementRequest),
		};
		expect(before).toMatchObject({ original: true, replacement: false });
		expect(after).toEqual(before);
	});

	it("IMMUT-20 allowedCriterionIds array replacement has no effect", () => {
		const { context, grant } = createInputsWithAlternateRequirement((inputGrant) => {
			inputGrant.allowedRequirementIds.push("REQ-002");
		});
		const replacementRequest: EvidenceSourceVerificationRequest = {
			...makeRequest(),
			requirementIds: ["REQ-002"],
			criterionIds: ["AC-002"],
		};
		const before = {
			digest: _getBoundContractDigest(context),
			original: context.verifyEvidenceSource(makeRequest()),
			replacement: context.verifyEvidenceSource(replacementRequest),
		};
		grant.allowedCriterionIds = ["AC-002"];
		const after = {
			digest: _getBoundContractDigest(context),
			original: context.verifyEvidenceSource(makeRequest()),
			replacement: context.verifyEvidenceSource(replacementRequest),
		};
		expect(before).toMatchObject({ original: true, replacement: false });
		expect(after).toEqual(before);
	});
});
