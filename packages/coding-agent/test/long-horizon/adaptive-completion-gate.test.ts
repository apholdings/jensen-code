/**
 * Adaptive completion-readiness gate integration.
 *
 * Proves that the deterministic readiness gate is wired into the canonical
 * APPROVE_COMPLETION boundary: with a readiness context supplied, completion is
 * blocked when not ready and allowed when ready; without a readiness context
 * the legacy trusted-completion behavior is preserved (frozen execution-record
 * compatibility).
 */

import { describe, expect, it } from "vitest";

import {
	applyMissionExecutionTransition,
	EXECUTION_COMPLETION_CAPABILITY,
	initializeMissionExecution,
	type MissionExecutionRecordV1,
	type MissionExecutionTransitionKind,
} from "../../src/core/long-horizon/execution-state-machine.js";
import { _internalCreateTrustedValidationContext } from "../../src/core/long-horizon/trusted-context.js";
import type { MissionContractV1 } from "../../src/core/long-horizon/types.js";

const TEST_CONTRACT: MissionContractV1 = {
	contractVersion: 1,
	missionId: "MISSION-ADAPTIVE",
	revision: 0,
	title: "adaptive gate",
	objective: "verify readiness gate wiring",
	workstreams: [{ id: "WS-1", title: "Main Workstream", order: 1 }],
	requirements: [
		{
			id: "REQ-1",
			workstreamId: "WS-1",
			kind: "EXPLICIT",
			statement: "Requirement 1",
			sourceRefs: [],
			dependencies: [],
			acceptanceCriteria: [
				{
					id: "CRIT-1",
					statement: "Criterion 1",
					requiredEvidence: [],
				},
			],
		},
	],
	constraints: [],
	forbiddenActions: [],
	evidencePolicy: { authoritativeSources: ["test-result"] },
};

function completionContext(): ReturnType<typeof _internalCreateTrustedValidationContext> {
	return _internalCreateTrustedValidationContext({
		contract: TEST_CONTRACT,
		principals: [
			{
				principalId: "completion-operator",
				principalKind: "operator",
				capabilities: [EXECUTION_COMPLETION_CAPABILITY],
			},
		],
		sourceGrants: [],
	});
}

function walkToReview(record: MissionExecutionRecordV1): MissionExecutionRecordV1 {
	let r = record;
	const steps: Array<{ kind: MissionExecutionTransitionKind; id: string }> = [
		{ kind: "START_EXECUTION", id: "t-001" },
		{ kind: "REQUEST_VERIFICATION", id: "t-002" },
		{ kind: "REQUEST_COMPLETION_REVIEW", id: "t-003" },
	];
	for (const step of steps) {
		const out = applyMissionExecutionTransition(TEST_CONTRACT, r, {
			transitionId: step.id,
			expectedRevision: r.revision,
			kind: step.kind,
		});
		if (!out.ok) throw new Error(`walk failed: ${out.error}`);
		r = out.record;
	}
	return r;
}

const readyInput = {
	criteria: [
		{
			criterionId: "c1",
			description: "x",
			required: true,
			evidenceRequirements: ["test"],
			status: "satisfied" as const,
			evidenceIds: ["t1"],
		},
	],
	satisfiedCriterionIds: ["c1"],
	transactionConfirmed: true,
	requiredTransaction: true,
	testsFailed: false,
	jobsResolved: true,
	requiredJobs: false,
	releaseArtifactsVerified: true,
	requiredReleaseVerification: true,
	budgetAccountingConsistent: true,
	requiredReviewPresent: true,
	requiredReview: true,
	finalResponseReserveAvailable: true,
};

describe("adaptive completion-readiness gate", () => {
	it("preserves legacy APPROVE_COMPLETION without a readiness gate", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-1");
		const reviewed = walkToReview(record);
		const out = applyMissionExecutionTransition(
			TEST_CONTRACT,
			reviewed,
			{
				transitionId: "t-004",
				expectedRevision: reviewed.revision,
				kind: "APPROVE_COMPLETION",
			},
			{ trustedValidationContext: completionContext() },
		);
		expect(out.ok).toBe(true);
	});

	it("blocks APPROVE_COMPLETION when the readiness gate is not ready", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-2");
		const reviewed = walkToReview(record);
		const out = applyMissionExecutionTransition(
			TEST_CONTRACT,
			reviewed,
			{
				transitionId: "t-004",
				expectedRevision: reviewed.revision,
				kind: "APPROVE_COMPLETION",
			},
			{
				trustedValidationContext: completionContext(),
				readinessGate: {
					...readyInput,
					transactionConfirmed: false, // a required transaction is unconfirmed
				},
			},
		);
		expect(out.ok).toBe(false);
		if (!out.ok) {
			expect(out.code).toBe("READINESS_GATE_BLOCKED");
			expect(out.error).toContain("REQUIRED_TRANSACTION_UNCONFIRMED");
		}
	});

	it("allows APPROVE_COMPLETION when the readiness gate is ready", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-3");
		const reviewed = walkToReview(record);
		const out = applyMissionExecutionTransition(
			TEST_CONTRACT,
			reviewed,
			{
				transitionId: "t-004",
				expectedRevision: reviewed.revision,
				kind: "APPROVE_COMPLETION",
			},
			{
				trustedValidationContext: completionContext(),
				readinessGate: readyInput,
			},
		);
		expect(out.ok).toBe(true);
		if (out.ok) expect(out.record.state).toBe("COMPLETED");
	});

	it("does not regress the forged-context rejection", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-4");
		const reviewed = walkToReview(record);
		const out = applyMissionExecutionTransition(
			TEST_CONTRACT,
			reviewed,
			{
				transitionId: "t-004",
				expectedRevision: reviewed.revision,
				kind: "APPROVE_COMPLETION",
			},
			{ trustedValidationContext: { verifyCapability: () => true } as never },
		);
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.code).toBe("TRUSTED_VALIDATION_CONTEXT_REQUIRED");
	});
});
