/**
 * Mission Execution State Machine v1 — comprehensive tests.
 *
 * Covers every state, every allowed transition, every forbidden
 * transition category, terminal immutability, BLOCK/RESUME semantics,
 * stale revision, duplicate IDs, contract binding, trusted completion,
 * forgery rejection, and input immutability.
 */

import { describe, expect, it } from "vitest";
import { computeMissionContractDigest } from "../../src/core/long-horizon/contract-digest.js";
import {
	applyMissionExecutionTransition,
	EXECUTION_COMPLETION_CAPABILITY,
	initializeMissionExecution,
	inspectMissionExecution,
	type MissionExecutionRecordV1,
	type MissionExecutionTransitionKind,
	validateMissionExecutionRecord,
} from "../../src/core/long-horizon/execution-state-machine.js";
import {
	_getBoundContractDigest,
	_internalCreateTrustedValidationContext,
	isTrustedValidationContext,
	type TrustedValidationContext,
} from "../../src/core/long-horizon/trusted-context.js";
import type { MissionContractV1 } from "../../src/core/long-horizon/types.js";

// =============================================================================
// Test contract
// =============================================================================

const TEST_CONTRACT: MissionContractV1 = {
	contractVersion: 1,
	missionId: "TEST-MISSION",
	revision: 0,
	title: "Test Mission",
	objective: "Verify execution state machine",
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

const TEST_DIGEST = computeMissionContractDigest(TEST_CONTRACT);

// =============================================================================
// Helper to build a completion-capable trusted context
// =============================================================================

function createCompletionTrustedContext(): TrustedValidationContext {
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

// =============================================================================
// Helper to apply a transition and expect success
// =============================================================================

function applyTransition(
	record: MissionExecutionRecordV1,
	kind: MissionExecutionTransitionKind,
	transitionId: string,
	trustedValidationContext?: TrustedValidationContext,
): MissionExecutionRecordV1 {
	const result = applyMissionExecutionTransition(
		TEST_CONTRACT,
		record,
		{
			transitionId,
			expectedRevision: record.revision,
			kind,
		},
		trustedValidationContext ? { trustedValidationContext } : undefined,
	);
	if (!result.ok) {
		throw new Error(`Transition failed: ${result.error}`);
	}
	return result.record;
}

// =============================================================================
// Helper to attempt transition and expect failure
// =============================================================================

function transitionMustFail(
	record: MissionExecutionRecordV1,
	kind: MissionExecutionTransitionKind,
	transitionId: string,
	expectedErrorCode: string,
	trustedValidationContext?: TrustedValidationContext,
): void {
	const result = applyMissionExecutionTransition(
		TEST_CONTRACT,
		record,
		{
			transitionId,
			expectedRevision: record.revision,
			kind,
		},
		trustedValidationContext ? { trustedValidationContext } : undefined,
	);
	expect(result.ok).toBe(false);
	if (result.ok === false) {
		expect(result.code).toBe(expectedErrorCode);
	}
}

// =============================================================================
// ESM-01: Deterministic initialization
// =============================================================================

describe("ESM-01: deterministic initialization", () => {
	it("initializes with PLANNING state and revision 0", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		expect(record.executionVersion).toBe(1);
		expect(record.executionId).toBe("exec-001");
		expect(record.contractDigest).toBe(TEST_DIGEST);
		expect(record.revision).toBe(0);
		expect(record.state).toBe("PLANNING");
		expect(record.transitions).toEqual([]);
	});

	it("rejects empty executionId", () => {
		expect(() => initializeMissionExecution(TEST_CONTRACT, "")).toThrow();
	});

	it("rejects whitespace-only executionId", () => {
		expect(() => initializeMissionExecution(TEST_CONTRACT, "   ")).toThrow();
	});

	it("rejects executionId with leading/trailing whitespace", () => {
		expect(() => initializeMissionExecution(TEST_CONTRACT, " exec-001 ")).toThrow();
	});

	it("produces deterministic output for same inputs", () => {
		const r1 = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const r2 = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		expect(r1).toEqual(r2);
	});

	it("produces different contractDigest for different contracts", () => {
		const altContract: MissionContractV1 = {
			...TEST_CONTRACT,
			missionId: "ALT-MISSION",
		};
		const r1 = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const r2 = initializeMissionExecution(altContract, "exec-001");
		expect(r1.contractDigest).not.toBe(r2.contractDigest);
	});
});

// =============================================================================
// ESM-02: Valid PLANNING → EXECUTION
// =============================================================================

describe("ESM-02: valid PLANNING → EXECUTION", () => {
	it("transitions from PLANNING to EXECUTION via START_EXECUTION", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const updated = applyTransition(record, "START_EXECUTION", "t-001");
		expect(updated.state).toBe("EXECUTION");
		expect(updated.revision).toBe(1);
		expect(updated.transitions.length).toBe(1);
		expect(updated.transitions[0].fromState).toBe("PLANNING");
		expect(updated.transitions[0].toState).toBe("EXECUTION");
		expect(updated.transitions[0].kind).toBe("START_EXECUTION");
		expect(updated.transitions[0].revisionBefore).toBe(0);
		expect(updated.transitions[0].revisionAfter).toBe(1);
	});

	it("rejects START_EXECUTION from non-PLANNING", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const exec = applyTransition(record, "START_EXECUTION", "t-001");
		transitionMustFail(exec, "START_EXECUTION", "t-002", "ILLEGAL_TRANSITION");
	});
});

// =============================================================================
// ESM-03: Valid EXECUTION → VERIFICATION
// =============================================================================

describe("ESM-03: valid EXECUTION → VERIFICATION", () => {
	it("transitions from EXECUTION to VERIFICATION via REQUEST_VERIFICATION", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const exec = applyTransition(record, "START_EXECUTION", "t-001");
		const ver = applyTransition(exec, "REQUEST_VERIFICATION", "t-002");
		expect(ver.state).toBe("VERIFICATION");
		expect(ver.revision).toBe(2);
		expect(ver.transitions.length).toBe(2);
		expect(ver.transitions[1].fromState).toBe("EXECUTION");
		expect(ver.transitions[1].toState).toBe("VERIFICATION");
	});
});

// =============================================================================
// ESM-04: Valid VERIFICATION → COMPLETION_REVIEW
// =============================================================================

describe("ESM-04: valid VERIFICATION → COMPLETION_REVIEW", () => {
	it("transitions from VERIFICATION to COMPLETION_REVIEW", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const exec = applyTransition(record, "START_EXECUTION", "t-001");
		const ver = applyTransition(exec, "REQUEST_VERIFICATION", "t-002");
		const review = applyTransition(ver, "REQUEST_COMPLETION_REVIEW", "t-003");
		expect(review.state).toBe("COMPLETION_REVIEW");
		expect(review.revision).toBe(3);
	});
});

// =============================================================================
// ESM-05: Trusted COMPLETION_REVIEW → COMPLETED
// =============================================================================

describe("ESM-05: trusted COMPLETION_REVIEW → COMPLETED", () => {
	it("approves completion with genuine trusted context", () => {
		const completionCtx = createCompletionTrustedContext();
		const boundDigest = _getBoundContractDigest(completionCtx);
		expect(boundDigest).toBe(TEST_DIGEST);
		expect(isTrustedValidationContext(completionCtx)).toBe(true);

		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const exec = applyTransition(record, "START_EXECUTION", "t-001");
		const ver = applyTransition(exec, "REQUEST_VERIFICATION", "t-002");
		const review = applyTransition(ver, "REQUEST_COMPLETION_REVIEW", "t-003");
		const completed = applyTransition(review, "APPROVE_COMPLETION", "t-004", completionCtx);
		expect(completed.state).toBe("COMPLETED");
		expect(completed.revision).toBe(4);
	});
});

// =============================================================================
// ESM-06: Direct EXECUTION → COMPLETED rejected
// =============================================================================

describe("ESM-06: direct EXECUTION → COMPLETED rejected", () => {
	it("rejects APPROVE_COMPLETION from EXECUTION", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const exec = applyTransition(record, "START_EXECUTION", "t-001");
		transitionMustFail(exec, "APPROVE_COMPLETION", "t-002", "ILLEGAL_TRANSITION");
	});

	it("rejects APPROVE_COMPLETION from EXECUTION even with trusted context", () => {
		const completionCtx = createCompletionTrustedContext();
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const exec = applyTransition(record, "START_EXECUTION", "t-001");
		transitionMustFail(exec, "APPROVE_COMPLETION", "t-002", "ILLEGAL_TRANSITION", completionCtx);
	});
});

// =============================================================================
// ESM-07: Direct PLANNING → COMPLETED rejected
// =============================================================================

describe("ESM-07: direct PLANNING → COMPLETED rejected", () => {
	it("rejects APPROVE_COMPLETION from PLANNING", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		transitionMustFail(record, "APPROVE_COMPLETION", "t-001", "ILLEGAL_TRANSITION");
	});
});

// =============================================================================
// ESM-08, ESM-09, ESM-10: Terminal state immutability
// =============================================================================

describe("ESM-08/09/10: terminal state immutability", () => {
	const terminalStates = ["COMPLETED", "FAILED", "CANCELLED"] as const;

	for (const terminalState of terminalStates) {
		it(`rejects all transitions from ${terminalState}`, () => {
			const completionCtx = createCompletionTrustedContext();
			let record = initializeMissionExecution(TEST_CONTRACT, "exec-001");

			// Navigate to the terminal state
			if (terminalState === "COMPLETED") {
				record = applyTransition(record, "START_EXECUTION", "t-001");
				record = applyTransition(record, "REQUEST_VERIFICATION", "t-002");
				record = applyTransition(record, "REQUEST_COMPLETION_REVIEW", "t-003");
				record = applyTransition(record, "APPROVE_COMPLETION", "t-004", completionCtx);
			} else if (terminalState === "FAILED") {
				record = applyTransition(record, "FAIL", "t-001");
			} else {
				record = applyTransition(record, "CANCEL", "t-001");
			}

			expect(record.state).toBe(terminalState);

			// All transitions should be rejected
			const allKinds: MissionExecutionTransitionKind[] = [
				"START_EXECUTION",
				"REQUEST_VERIFICATION",
				"RETURN_TO_EXECUTION",
				"REQUEST_COMPLETION_REVIEW",
				"RETURN_TO_VERIFICATION",
				"APPROVE_COMPLETION",
				"BLOCK",
				"RESUME",
				"FAIL",
				"CANCEL",
			];

			for (const kind of allKinds) {
				const result = applyMissionExecutionTransition(TEST_CONTRACT, record, {
					transitionId: `t-attempt-${kind}`,
					expectedRevision: record.revision,
					kind,
				});
				expect(result.ok).toBe(false);
				if (!result.ok) {
					expect(result.code).toBe("TERMINAL_STATE");
				}
			}
		});
	}
});

// =============================================================================
// ESM-11: BLOCK records exact prior state
// =============================================================================

describe("ESM-11: BLOCK records exact prior state", () => {
	it("records EXECUTION when BLOCKed from EXECUTION", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const exec = applyTransition(record, "START_EXECUTION", "t-001");
		const blocked = applyTransition(exec, "BLOCK", "t-002");
		expect(blocked.state).toBe("BLOCKED");
		expect(blocked.blockedFromState).toBe("EXECUTION");
	});

	it("records VERIFICATION when BLOCKed from VERIFICATION", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		let r = applyTransition(record, "START_EXECUTION", "t-001");
		r = applyTransition(r, "REQUEST_VERIFICATION", "t-002");
		const blocked = applyTransition(r, "BLOCK", "t-003");
		expect(blocked.state).toBe("BLOCKED");
		expect(blocked.blockedFromState).toBe("VERIFICATION");
	});

	it("records COMPLETION_REVIEW when BLOCKed from COMPLETION_REVIEW", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		let r = applyTransition(record, "START_EXECUTION", "t-001");
		r = applyTransition(r, "REQUEST_VERIFICATION", "t-002");
		r = applyTransition(r, "REQUEST_COMPLETION_REVIEW", "t-003");
		const blocked = applyTransition(r, "BLOCK", "t-004");
		expect(blocked.state).toBe("BLOCKED");
		expect(blocked.blockedFromState).toBe("COMPLETION_REVIEW");
	});

	it("records PLANNING when BLOCKed from PLANNING", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const blocked = applyTransition(record, "BLOCK", "t-001");
		expect(blocked.state).toBe("BLOCKED");
		expect(blocked.blockedFromState).toBe("PLANNING");
	});
});

// =============================================================================
// ESM-12: RESUME returns to exact prior state
// =============================================================================

describe("ESM-12: RESUME returns to exact prior state", () => {
	it("RESUME returns from BLOCKED to EXECUTION", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		let r = applyTransition(record, "START_EXECUTION", "t-001");
		const execState = r;
		r = applyTransition(r, "BLOCK", "t-002");
		expect(r.state).toBe("BLOCKED");
		r = applyTransition(r, "RESUME", "t-003");
		expect(r.state).toBe("EXECUTION");
		expect(r.blockedFromState).toBeUndefined();
		// State after resume should equal the pre-BLOCK state, minus revision
		expect(r.state).toBe(execState.state);
	});

	it("RESUME returns from BLOCKED to VERIFICATION", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		let r = applyTransition(record, "START_EXECUTION", "t-001");
		r = applyTransition(r, "REQUEST_VERIFICATION", "t-002");
		r = applyTransition(r, "BLOCK", "t-003");
		expect(r.state).toBe("BLOCKED");
		expect(r.blockedFromState).toBe("VERIFICATION");
		r = applyTransition(r, "RESUME", "t-004");
		expect(r.state).toBe("VERIFICATION");
		expect(r.blockedFromState).toBeUndefined();
	});

	it("multiple BLOCK/RESUME cycles work correctly", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		let r = applyTransition(record, "START_EXECUTION", "t-001");

		// First cycle
		r = applyTransition(r, "BLOCK", "t-002");
		expect(r.state).toBe("BLOCKED");
		r = applyTransition(r, "RESUME", "t-003");
		expect(r.state).toBe("EXECUTION");

		// Second cycle
		r = applyTransition(r, "REQUEST_VERIFICATION", "t-004");
		r = applyTransition(r, "BLOCK", "t-005");
		expect(r.blockedFromState).toBe("VERIFICATION");
		r = applyTransition(r, "RESUME", "t-006");
		expect(r.state).toBe("VERIFICATION");
	});
});

// =============================================================================
// ESM-13: Arbitrary blocked resume rejected
// =============================================================================

describe("ESM-13: arbitrary blocked resume rejected", () => {
	it("RESUME from non-BLOCKED fails", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const exec = applyTransition(record, "START_EXECUTION", "t-001");
		transitionMustFail(exec, "RESUME", "t-002", "RESUME_WHILE_NOT_BLOCKED");
	});

	it("BLOCK then FAIL then attempt RESUME fails", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		let r = applyTransition(record, "START_EXECUTION", "t-001");
		r = applyTransition(r, "BLOCK", "t-002");
		r = applyTransition(r, "FAIL", "t-003");
		expect(r.state).toBe("FAILED");
		transitionMustFail(r, "RESUME", "t-004", "TERMINAL_STATE");
	});
});

// =============================================================================
// ESM-14: Nested/double BLOCK rejected
// =============================================================================

describe("ESM-14: nested/double BLOCK rejected", () => {
	it("BLOCK while already BLOCKED fails", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		let r = applyTransition(record, "START_EXECUTION", "t-001");
		r = applyTransition(r, "BLOCK", "t-002");
		expect(r.state).toBe("BLOCKED");
		transitionMustFail(r, "BLOCK", "t-003", "BLOCK_WHILE_BLOCKED");
	});
});

// =============================================================================
// ESM-15: Stale revision rejected
// =============================================================================

describe("ESM-15: stale revision rejected", () => {
	it("rejects transition with incorrect expectedRevision", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const result = applyMissionExecutionTransition(TEST_CONTRACT, record, {
			transitionId: "t-001",
			expectedRevision: 1, // Record is at revision 0
			kind: "START_EXECUTION",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("STALE_REVISION");
	});

	it("rejects transition with negative expectedRevision", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const result = applyMissionExecutionTransition(TEST_CONTRACT, record, {
			transitionId: "t-001",
			expectedRevision: -1,
			kind: "START_EXECUTION",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("STALE_REVISION");
	});

	it("rejects transition with NaN expectedRevision", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const result = applyMissionExecutionTransition(TEST_CONTRACT, record, {
			transitionId: "t-001",
			expectedRevision: NaN,
			kind: "START_EXECUTION",
		});
		expect(result.ok).toBe(false);
	});

	it("rejects transition with Infinity expectedRevision", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const result = applyMissionExecutionTransition(TEST_CONTRACT, record, {
			transitionId: "t-001",
			expectedRevision: Infinity,
			kind: "START_EXECUTION",
		});
		expect(result.ok).toBe(false);
	});
});

// =============================================================================
// ESM-16: Duplicate transition ID rejected
// =============================================================================

describe("ESM-16: duplicate transition ID rejected", () => {
	it("rejects duplicate transitionId", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const exec = applyTransition(record, "START_EXECUTION", "t-001");
		transitionMustFail(exec, "REQUEST_VERIFICATION", "t-001", "DUPLICATE_TRANSITION_ID");
	});
});

// =============================================================================
// ESM-17: History revision discontinuity rejected
// =============================================================================

describe("ESM-17: history revision discontinuity rejected", () => {
	it("rejects record with revision gap in history", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const exec = applyTransition(record, "START_EXECUTION", "t-001");
		const ver = applyTransition(exec, "REQUEST_VERIFICATION", "t-002");

		// Fabricate a record with a revision gap
		const fabricated = JSON.parse(JSON.stringify(ver)) as any;
		fabricated.transitions = [
			{
				transitionId: "t-001",
				kind: "START_EXECUTION",
				fromState: "PLANNING",
				toState: "EXECUTION",
				revisionBefore: 0,
				revisionAfter: 1,
			},
			{
				transitionId: "t-002",
				kind: "REQUEST_VERIFICATION",
				fromState: "EXECUTION",
				toState: "VERIFICATION",
				revisionBefore: 2, // Gap — should be 1
				revisionAfter: 3,
			},
		];
		// (fabricated.revision is 2 but transition count is 2 — revision check also fails)
		const result = validateMissionExecutionRecord(TEST_CONTRACT, fabricated);
		expect(result.valid).toBe(false);
	});
});

// =============================================================================
// ESM-18: History fromState tampering rejected
// =============================================================================

describe("ESM-18: history fromState tampering rejected", () => {
	it("rejects record with tampered fromState in history", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const exec = applyTransition(record, "START_EXECUTION", "t-001");
		const ver = applyTransition(exec, "REQUEST_VERIFICATION", "t-002");

		const fabricated = JSON.parse(JSON.stringify(ver)) as any;
		fabricated.transitions = [
			{
				transitionId: "t-001",
				kind: "START_EXECUTION",
				fromState: "PLANNING",
				toState: "EXECUTION",
				revisionBefore: 0,
				revisionAfter: 1,
			},
			{
				transitionId: "t-002",
				kind: "REQUEST_VERIFICATION",
				fromState: "EXECUTION",
				toState: "VERIFICATION",
				revisionBefore: 1,
				revisionAfter: 2,
			},
		];
		// Fabricate fromState mismatch: change t-002's fromState
		(fabricated.transitions as any)[1].fromState = "PLANNING";

		const result = validateMissionExecutionRecord(TEST_CONTRACT, fabricated);
		expect(result.valid).toBe(false);
		expect(result).toHaveProperty("error");
	});
});

// =============================================================================
// ESM-19: History toState tampering rejected
// =============================================================================

describe("ESM-19: history toState tampering rejected", () => {
	it("rejects record with tampered toState", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const exec = applyTransition(record, "START_EXECUTION", "t-001");
		const ver = applyTransition(exec, "REQUEST_VERIFICATION", "t-002");

		const fabricated = JSON.parse(JSON.stringify(ver)) as any;
		fabricated.transitions = [
			{
				transitionId: "t-001",
				kind: "START_EXECUTION",
				fromState: "PLANNING",
				toState: "EXECUTION",
				revisionBefore: 0,
				revisionAfter: 1,
			},
			{
				transitionId: "t-002",
				kind: "REQUEST_VERIFICATION",
				fromState: "EXECUTION",
				toState: "VERIFICATION",
				revisionBefore: 1,
				revisionAfter: 2,
			},
		];
		// Fabricate toState mismatch
		(fabricated.transitions as any)[1].toState = "COMPLETED";

		const result = validateMissionExecutionRecord(TEST_CONTRACT, fabricated);
		expect(result.valid).toBe(false);
	});
});

// =============================================================================
// ESM-20: transition-kind tampering rejected
// =============================================================================

describe("ESM-20: transition-kind tampering rejected", () => {
	it("rejects record with tampered kind", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const exec = applyTransition(record, "START_EXECUTION", "t-001");
		const ver = applyTransition(exec, "REQUEST_VERIFICATION", "t-002");

		const fabricated = JSON.parse(JSON.stringify(ver)) as any;
		fabricated.transitions = [
			{
				transitionId: "t-001",
				kind: "START_EXECUTION",
				fromState: "PLANNING",
				toState: "EXECUTION",
				revisionBefore: 0,
				revisionAfter: 1,
			},
			{
				transitionId: "t-002",
				kind: "START_EXECUTION", // Should be REQUEST_VERIFICATION
				fromState: "EXECUTION",
				toState: "VERIFICATION",
				revisionBefore: 1,
				revisionAfter: 2,
			},
		];

		const result = validateMissionExecutionRecord(TEST_CONTRACT, fabricated);
		expect(result.valid).toBe(false);
	});
});

// =============================================================================
// ESM-21: Contract digest tampering rejected
// =============================================================================

describe("ESM-21: contract digest tampering rejected", () => {
	it("rejects record with tampered contractDigest", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const fabricated = { ...record, contractDigest: "deadbeef" };
		const result = validateMissionExecutionRecord(TEST_CONTRACT, fabricated);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.error).toContain("CONTRACT_DIGEST_MISMATCH");
		}
	});

	it("applyTransition rejects different contract", () => {
		const altContract: MissionContractV1 = { ...TEST_CONTRACT, missionId: "ALT" };
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const result = applyMissionExecutionTransition(altContract, record, {
			transitionId: "t-001",
			expectedRevision: 0,
			kind: "START_EXECUTION",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("CONTRACT_DIGEST_MISMATCH");
	});
});

// =============================================================================
// ESM-22: Same IDs / different contract digest rejected
// =============================================================================

describe("ESM-22: same IDs / different contract digest rejected", () => {
	it("rejects record where executionId matches but contractDigest differs", () => {
		const altContract: MissionContractV1 = { ...TEST_CONTRACT, missionId: "ALT-MISSION-22" };
		const _altDigest = computeMissionContractDigest(altContract);

		// Initialize with TEST_CONTRACT, then validate against altContract
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const result = validateMissionExecutionRecord(altContract, record);
		expect(result.valid).toBe(false);
	});
});

// =============================================================================
// ESM-23: Forged trusted context rejected
// =============================================================================

describe("ESM-23: forged trusted context rejected", () => {
	it("rejects plain object as trusted context", () => {
		const fakeCtx = {
			verifyPrincipal: () => true,
			verifyCapability: () => true,
			verifyEvidenceSource: () => true,
		};

		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		let r = applyTransition(record, "START_EXECUTION", "t-001");
		r = applyTransition(r, "REQUEST_VERIFICATION", "t-002");
		r = applyTransition(r, "REQUEST_COMPLETION_REVIEW", "t-003");

		const result = applyMissionExecutionTransition(
			TEST_CONTRACT,
			r,
			{
				transitionId: "t-004",
				expectedRevision: 3,
				kind: "APPROVE_COMPLETION",
			},
			{ trustedValidationContext: fakeCtx as any },
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("TRUSTED_VALIDATION_CONTEXT_REQUIRED");
		}
	});

	it("rejects structurally similar but unbranded context", () => {
		const fakeCtx = Object.create(
			Object.getPrototypeOf({
				verifyPrincipal: () => true,
				verifyCapability: () => true,
				verifyEvidenceSource: () => true,
			}),
		);

		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		let r = applyTransition(record, "START_EXECUTION", "t-001");
		r = applyTransition(r, "REQUEST_VERIFICATION", "t-002");
		r = applyTransition(r, "REQUEST_COMPLETION_REVIEW", "t-003");

		const result = applyMissionExecutionTransition(
			TEST_CONTRACT,
			r,
			{
				transitionId: "t-004",
				expectedRevision: 3,
				kind: "APPROVE_COMPLETION",
			},
			{ trustedValidationContext: fakeCtx as any },
		);

		expect(result.ok).toBe(false);
	});
});

// =============================================================================
// ESM-24: Missing completion capability rejected
// =============================================================================

describe("ESM-24: missing completion capability rejected", () => {
	it("rejects trusted context without execution:complete", () => {
		// Create a trusted context without the completion capability
		const ctx = _internalCreateTrustedValidationContext({
			contract: TEST_CONTRACT,
			principals: [
				{
					principalId: "completion-operator",
					principalKind: "operator",
					capabilities: ["transition:satisfy"], // No execution:complete
				},
			],
			sourceGrants: [],
		});

		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		let r = applyTransition(record, "START_EXECUTION", "t-001");
		r = applyTransition(r, "REQUEST_VERIFICATION", "t-002");
		r = applyTransition(r, "REQUEST_COMPLETION_REVIEW", "t-003");

		const result = applyMissionExecutionTransition(
			TEST_CONTRACT,
			r,
			{
				transitionId: "t-004",
				expectedRevision: 3,
				kind: "APPROVE_COMPLETION",
			},
			{ trustedValidationContext: ctx },
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("EXECUTION_COMPLETION_CAPABILITY_REQUIRED");
		}
	});
});

// =============================================================================
// ESM-29: Replay reconstructs exact final state
// =============================================================================

describe("ESM-29: replay reconstructs exact final state", () => {
	it("validation succeeds for a valid complete lifecycle", () => {
		const completionCtx = createCompletionTrustedContext();

		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		let r = applyTransition(record, "START_EXECUTION", "t-001");
		r = applyTransition(r, "REQUEST_VERIFICATION", "t-002");
		r = applyTransition(r, "REQUEST_COMPLETION_REVIEW", "t-003");
		r = applyTransition(r, "APPROVE_COMPLETION", "t-004", completionCtx);

		const result = validateMissionExecutionRecord(TEST_CONTRACT, r);
		expect(result.valid).toBe(true);
	});

	it("validation detects state/replay mismatch", () => {
		const completionCtx = createCompletionTrustedContext();

		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		let r = applyTransition(record, "START_EXECUTION", "t-001");
		r = applyTransition(r, "REQUEST_VERIFICATION", "t-002");
		r = applyTransition(r, "REQUEST_COMPLETION_REVIEW", "t-003");
		r = applyTransition(r, "APPROVE_COMPLETION", "t-004", completionCtx);

		// Tamper with the state field
		const fabricated = JSON.parse(JSON.stringify(r)) as any;
		(fabricated as any).state = "VERIFICATION";

		const result = validateMissionExecutionRecord(TEST_CONTRACT, fabricated);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.error).toContain("state mismatch");
		}
	});

	it("validation for record with BLOCK/RESUME cycle", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		let r = applyTransition(record, "START_EXECUTION", "t-001");
		r = applyTransition(r, "BLOCK", "t-002");
		r = applyTransition(r, "RESUME", "t-003");
		r = applyTransition(r, "REQUEST_VERIFICATION", "t-004");

		const result = validateMissionExecutionRecord(TEST_CONTRACT, r);
		expect(result.valid).toBe(true);
	});
});

// =============================================================================
// ESM-30: Caller mutation cannot alter accepted record
// =============================================================================

describe("ESM-30: caller mutation cannot alter accepted record", () => {
	it("returned record is immutable", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const exec = applyTransition(record, "START_EXECUTION", "t-001");

		expect(() => {
			(exec as any).state = "FAILED";
		}).toThrow();
	});

	it("returned transitions array is immutable", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const exec = applyTransition(record, "START_EXECUTION", "t-001");

		expect(() => {
			(exec.transitions as any).push({});
		}).toThrow();
	});

	it("original record is unchanged after transition", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const originalRevision = record.revision;
		const originalState = record.state;
		const originalTransitionsLen = record.transitions.length;

		applyTransition(record, "START_EXECUTION", "t-001");

		expect(record.revision).toBe(originalRevision);
		expect(record.state).toBe(originalState);
		expect(record.transitions.length).toBe(originalTransitionsLen);
	});

	// =========================================================================
	// ESM-30A: Mutate original record properties after success (JSON-round-tripped)
	// =========================================================================

	it("ESM-30A: mutating JSON-round-tripped original record properties after transition does not affect output", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-30a");
		const r2 = applyTransition(record, "START_EXECUTION", "t-001");
		const r3 = applyTransition(r2, "REQUEST_VERIFICATION", "t-002");

		// JSON round-trip to create fully mutable caller-owned input
		const mutableInput = JSON.parse(JSON.stringify(r3)) as MissionExecutionRecordV1;

		const output = applyTransition(mutableInput, "REQUEST_COMPLETION_REVIEW", "t-003");
		const outputSnapshot = JSON.stringify(output);

		// Mutate original record properties after success
		(mutableInput as any).revision = 999;
		(mutableInput as any).state = "FAILED";
		(mutableInput as any).executionId = "hacked";

		expect(JSON.stringify(output)).toBe(outputSnapshot);
		expect(output.state).toBe("COMPLETION_REVIEW");
		expect(output.revision).toBe(3);
	});

	// =========================================================================
	// ESM-30B: Mutate original transitions array after success (JSON-round-tripped)
	// =========================================================================

	it("ESM-30B: mutating JSON-round-tripped original transitions array after transition does not affect output", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-30b");
		const r2 = applyTransition(record, "START_EXECUTION", "t-001");
		const r3 = applyTransition(r2, "REQUEST_VERIFICATION", "t-002");

		const mutableInput = JSON.parse(JSON.stringify(r3)) as MissionExecutionRecordV1;
		const output = applyTransition(mutableInput, "REQUEST_COMPLETION_REVIEW", "t-003");
		const outputSnapshot = JSON.stringify(output);

		// Mutate transitions array
		(mutableInput.transitions as any).push({
			transitionId: "forged",
			kind: "FAIL",
			fromState: "COMPLETED",
			toState: "FAILED",
			revisionBefore: 999,
			revisionAfter: 1000,
		});

		expect(JSON.stringify(output)).toBe(outputSnapshot);
		expect(output.transitions).toHaveLength(3);
	});

	it("ESM-30B: clearing JSON-round-tripped original transitions array after transition does not affect output", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-30b2");
		const r2 = applyTransition(record, "START_EXECUTION", "t-001");
		const r3 = applyTransition(r2, "REQUEST_VERIFICATION", "t-002");

		const mutableInput = JSON.parse(JSON.stringify(r3)) as MissionExecutionRecordV1;
		const output = applyTransition(mutableInput, "REQUEST_COMPLETION_REVIEW", "t-003");

		// Clear transitions array
		(mutableInput.transitions as any).length = 0;

		expect(output.transitions).toHaveLength(3);
		expect(output.state).toBe("COMPLETION_REVIEW");
		expect(output.revision).toBe(3);
		const valid = validateMissionExecutionRecord(TEST_CONTRACT, output);
		expect(valid.valid).toBe(true);
	});

	// =========================================================================
	// ESM-30C: Mutate original historical transition object after success
	// =========================================================================

	it("ESM-30C: mutating a historical transition object from JSON-round-tripped input after transition does not affect output", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-30c");
		const r2 = applyTransition(record, "START_EXECUTION", "t-001");
		const r3 = applyTransition(r2, "REQUEST_VERIFICATION", "t-002");

		const mutableInput = JSON.parse(JSON.stringify(r3)) as MissionExecutionRecordV1;
		const output = applyTransition(mutableInput, "REQUEST_COMPLETION_REVIEW", "t-003");
		const outputSnapshot = JSON.stringify(output);

		// Mutate historical transition properties
		(mutableInput.transitions[0] as any).transitionId = "mutated-id";
		(mutableInput.transitions[0] as any).toState = "COMPLETED";
		(mutableInput.transitions[0] as any).kind = "CANCEL";
		(mutableInput.transitions[0] as any).revisionAfter = 999;

		expect(JSON.stringify(output)).toBe(outputSnapshot);
		expect(output.transitions[0].transitionId).toBe("t-001");
		expect(output.transitions[0].toState).toBe("EXECUTION");
		expect(output.transitions[0].kind).toBe("START_EXECUTION");
		expect(output.transitions[0].revisionAfter).toBe(1);
	});

	// =========================================================================
	// ESM-30D: Replace an original historical transition after success
	// =========================================================================

	it("ESM-30D: replacing a historical transition in JSON-round-tripped input after transition does not affect output", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-30d");
		const r2 = applyTransition(record, "START_EXECUTION", "t-001");
		const r3 = applyTransition(r2, "REQUEST_VERIFICATION", "t-002");

		const mutableInput = JSON.parse(JSON.stringify(r3)) as MissionExecutionRecordV1;
		const output = applyTransition(mutableInput, "REQUEST_COMPLETION_REVIEW", "t-003");

		const forgedTransition = {
			transitionId: "forged-id",
			kind: "FAIL" as const,
			fromState: "PLANNING",
			toState: "FAILED",
			revisionBefore: 0,
			revisionAfter: 1,
		};
		(mutableInput.transitions as any)[0] = forgedTransition;

		expect(output.transitions[0].transitionId).toBe("t-001");
		expect(output.transitions[0].kind).toBe("START_EXECUTION");
		expect(output.transitions).toHaveLength(3);
	});

	// =========================================================================
	// ESM-30E: Every transition object in accepted output is frozen
	// =========================================================================

	it("ESM-30E: every transition object in accepted output is frozen", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-30e");
		const r2 = applyTransition(record, "START_EXECUTION", "t-001");
		const r3 = applyTransition(r2, "REQUEST_VERIFICATION", "t-002");

		const mutableInput = JSON.parse(JSON.stringify(r3)) as MissionExecutionRecordV1;
		const output = applyTransition(mutableInput, "REQUEST_COMPLETION_REVIEW", "t-003");

		for (let i = 0; i < output.transitions.length; i++) {
			expect(Object.isFrozen(output.transitions[i])).toBe(true);
		}
		// Also check the output record and transitions array are frozen
		expect(Object.isFrozen(output)).toBe(true);
		expect(Object.isFrozen(output.transitions)).toBe(true);
	});

	it("ESM-30E: every transition object in initialization output is frozen", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-30e-init");
		expect(Object.isFrozen(record)).toBe(true);
		expect(Object.isFrozen(record.transitions)).toBe(true);
	});

	// =========================================================================
	// ESM-30F: Output still validates after caller mutations
	// =========================================================================

	it("ESM-30F: output still validates after extensive caller mutations on JSON-round-tripped input", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-30f");
		const r2 = applyTransition(record, "START_EXECUTION", "t-001");
		const r3 = applyTransition(r2, "REQUEST_VERIFICATION", "t-002");

		const mutableInput = JSON.parse(JSON.stringify(r3)) as MissionExecutionRecordV1;
		const output = applyTransition(mutableInput, "REQUEST_COMPLETION_REVIEW", "t-003");
		const outputSnapshot = JSON.stringify(output);

		// Apply all mutation forms from ESM-30A through ESM-30D
		(mutableInput as any).revision = 999;
		(mutableInput as any).state = "FAILED";
		(mutableInput.transitions[0] as any).transitionId = "mutated-id";
		(mutableInput.transitions[0] as any).toState = "COMPLETED";
		(mutableInput.transitions[0] as any).kind = "CANCEL";
		(mutableInput.transitions[0] as any).revisionAfter = 999;
		(mutableInput.transitions as any)[1] = {
			transitionId: "forged",
			kind: "FAIL",
			fromState: "PLANNING",
			toState: "FAILED",
			revisionBefore: 0,
			revisionAfter: 1,
		};
		try {
			(mutableInput.transitions as any).push({});
		} catch {}
		try {
			(mutableInput.transitions as any).length = 0;
		} catch {}

		// Verify output is unchanged
		expect(JSON.stringify(output)).toBe(outputSnapshot);

		// Verify output still validates
		const validationResult = validateMissionExecutionRecord(TEST_CONTRACT, output);
		expect(validationResult.valid).toBe(true);

		// Verify output state/revision/history unchanged
		expect(output.state).toBe("COMPLETION_REVIEW");
		expect(output.revision).toBe(3);
		expect(output.transitions).toHaveLength(3);
	});
});

// =============================================================================
// Inspection (untrusted)
// =============================================================================

describe("inspectMissionExecution", () => {
	it("returns valid inspection for PLANNING record", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const inspection = inspectMissionExecution(TEST_CONTRACT, record);
		expect(inspection.valid).toBe(true);
		if (inspection.valid) {
			expect(inspection.state).toBe("PLANNING");
			expect(inspection.revision).toBe(0);
			expect(inspection.completionApproved).toBe("unavailable");
		}
	});

	it("never claims completion approval", () => {
		const completionCtx = createCompletionTrustedContext();
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		let r = applyTransition(record, "START_EXECUTION", "t-001");
		r = applyTransition(r, "REQUEST_VERIFICATION", "t-002");
		r = applyTransition(r, "REQUEST_COMPLETION_REVIEW", "t-003");
		r = applyTransition(r, "APPROVE_COMPLETION", "t-004", completionCtx);

		const inspection = inspectMissionExecution(TEST_CONTRACT, r);
		expect(inspection.valid).toBe(true);
		if (inspection.valid) {
			expect(inspection.completionApproved).toBe("unavailable");
		}
	});

	it("returns error for invalid record", () => {
		const inspection = inspectMissionExecution(TEST_CONTRACT, null);
		expect(inspection.valid).toBe(false);
	});

	it("returns error for record with missing executionId", () => {
		const inspection = inspectMissionExecution(TEST_CONTRACT, { executionVersion: 1 });
		expect(inspection.valid).toBe(false);
	});
});

// =============================================================================
// Unknown field rejection
// =============================================================================

describe("unknown field rejection", () => {
	it("rejects transition with unknown field", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const exec = applyTransition(record, "START_EXECUTION", "t-001");

		// Fabricate a transition with unknown fields
		const fabricated = JSON.parse(JSON.stringify(exec)) as any;
		fabricated.transitions[0].surprise = "boo";

		const result = validateMissionExecutionRecord(TEST_CONTRACT, fabricated);
		expect(result.valid).toBe(false);
	});

	it("rejects record with unknown top-level field", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const fabricated = { ...record, extraField: "bad" } as any;

		const result = validateMissionExecutionRecord(TEST_CONTRACT, fabricated);
		expect(result.valid).toBe(false);
	});
});

// =============================================================================
// Malformed input rejection
// =============================================================================

describe("malformed input rejection", () => {
	it("rejects null", () => {
		const result = validateMissionExecutionRecord(TEST_CONTRACT, null);
		expect(result.valid).toBe(false);
	});

	it("rejects undefined", () => {
		const result = validateMissionExecutionRecord(TEST_CONTRACT, undefined);
		expect(result.valid).toBe(false);
	});

	it("rejects array", () => {
		const result = validateMissionExecutionRecord(TEST_CONTRACT, []);
		expect(result.valid).toBe(false);
	});

	it("rejects string", () => {
		const result = validateMissionExecutionRecord(TEST_CONTRACT, "not an object");
		expect(result.valid).toBe(false);
	});

	it("rejects record with non-string transitions", () => {
		const result = validateMissionExecutionRecord(TEST_CONTRACT, {
			executionVersion: 1,
			executionId: "exec-001",
			contractDigest: TEST_DIGEST,
			revision: 0,
			state: "PLANNING",
			transitions: "not-an-array",
		});
		expect(result.valid).toBe(false);
	});

	it("rejects NaN in revision", () => {
		const result = validateMissionExecutionRecord(TEST_CONTRACT, {
			executionVersion: 1,
			executionId: "exec-001",
			contractDigest: TEST_DIGEST,
			revision: NaN,
			state: "PLANNING",
			transitions: [],
		});
		expect(result.valid).toBe(false);
	});

	it("rejects Infinity in revision", () => {
		const result = validateMissionExecutionRecord(TEST_CONTRACT, {
			executionVersion: 1,
			executionId: "exec-001",
			contractDigest: TEST_DIGEST,
			revision: Infinity,
			state: "PLANNING",
			transitions: [],
		});
		expect(result.valid).toBe(false);
	});
});

// =============================================================================
// Self-transition rejection
// =============================================================================

describe("self-transition rejection", () => {
	it("rejects self-transition via validation", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const exec = applyTransition(record, "START_EXECUTION", "t-001");

		// Fabricate a self-transition
		const fabricated = JSON.parse(JSON.stringify(exec)) as any;
		fabricated.transitions.push({
			transitionId: "t-bad",
			kind: "START_EXECUTION",
			fromState: "EXECUTION",
			toState: "EXECUTION",
			revisionBefore: 1,
			revisionAfter: 2,
		});
		fabricated.revision = 2;
		fabricated.state = "EXECUTION";

		const result = validateMissionExecutionRecord(TEST_CONTRACT, fabricated);
		expect(result.valid).toBe(false);
	});
});

// =============================================================================
// Transition after terminal state in history
// =============================================================================

describe("transition after terminal state in history", () => {
	it("rejects history with transition after terminal", () => {
		// Fabricated: FAILED then another transition
		const fabricated = {
			executionVersion: 1,
			executionId: "exec-001",
			contractDigest: TEST_DIGEST,
			revision: 2,
			state: "FAILED",
			transitions: [
				{
					transitionId: "t-001",
					kind: "FAIL",
					fromState: "PLANNING",
					toState: "FAILED",
					revisionBefore: 0,
					revisionAfter: 1,
				},
				{
					transitionId: "t-002",
					kind: "BLOCK",
					fromState: "FAILED",
					toState: "BLOCKED",
					revisionBefore: 1,
					revisionAfter: 2,
				},
			],
		};

		const result = validateMissionExecutionRecord(TEST_CONTRACT, fabricated);
		expect(result.valid).toBe(false);
	});
});

// =============================================================================
// Direct EXECUTION → COMPLETED fabrication via history
// =============================================================================

describe("direct EXECUTION → COMPLETED fabrication via history", () => {
	it("rejects fabricated history with EXECUTION→COMPLETED", () => {
		const fabricated = {
			executionVersion: 1,
			executionId: "exec-001",
			contractDigest: TEST_DIGEST,
			revision: 1,
			state: "COMPLETED",
			transitions: [
				{
					transitionId: "t-001",
					kind: "START_EXECUTION",
					fromState: "PLANNING",
					toState: "EXECUTION",
					revisionBefore: 0,
					revisionAfter: 1,
				},
				{
					transitionId: "t-002",
					kind: "APPROVE_COMPLETION",
					fromState: "EXECUTION",
					toState: "COMPLETED", // Illegal — APPROVE_COMPLETION not valid from EXECUTION
					revisionBefore: 1,
					revisionAfter: 2,
				},
			],
		};

		const result = validateMissionExecutionRecord(TEST_CONTRACT, fabricated);
		expect(result.valid).toBe(false);
	});
});

// =============================================================================
// blockedFromState consistency in validation
// =============================================================================

describe("blockedFromState consistency in validation", () => {
	it("rejects BLOCKED without blockedFromState", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const exec = applyTransition(record, "START_EXECUTION", "t-001");
		const blocked = applyTransition(exec, "BLOCK", "t-002");

		const fabricated = JSON.parse(JSON.stringify(blocked)) as any;
		delete fabricated.blockedFromState;

		const result = validateMissionExecutionRecord(TEST_CONTRACT, fabricated);
		expect(result.valid).toBe(false);
	});

	it("rejects blockedFromState when not BLOCKED", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const fabricated = JSON.parse(JSON.stringify(record)) as any;
		fabricated.blockedFromState = "PLANNING";

		const result = validateMissionExecutionRecord(TEST_CONTRACT, fabricated);
		expect(result.valid).toBe(false);
	});

	it("rejects incorrect blockedFromState after replay", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const exec = applyTransition(record, "START_EXECUTION", "t-001");
		const blocked = applyTransition(exec, "BLOCK", "t-002");

		// blockedFromState should be EXECUTION, fabricate it to VERIFICATION
		const fabricated = JSON.parse(JSON.stringify(blocked)) as any;
		fabricated.blockedFromState = "VERIFICATION";

		const result = validateMissionExecutionRecord(TEST_CONTRACT, fabricated);
		expect(result.valid).toBe(false);
	});
});

// =============================================================================
// inspectMissionExecution with blocked records
// =============================================================================

describe("inspect blocked records", () => {
	it("returns blockedFromState for BLOCKED record", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const exec = applyTransition(record, "START_EXECUTION", "t-001");
		const blocked = applyTransition(exec, "BLOCK", "t-002");

		const inspection = inspectMissionExecution(TEST_CONTRACT, blocked);
		expect(inspection.valid).toBe(true);
		if (inspection.valid) {
			expect(inspection.state).toBe("BLOCKED");
			expect(inspection.blockedFromState).toBe("EXECUTION");
		}
	});
});

// =============================================================================
// Replay correctness: BLOCK/RESUME preserves state
// =============================================================================

describe("replay correctness", () => {
	it("replay of BLOCK/RESUME returns to correct state", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		let r = applyTransition(record, "START_EXECUTION", "t-001");
		r = applyTransition(r, "REQUEST_VERIFICATION", "t-002");
		r = applyTransition(r, "BLOCK", "t-003");
		r = applyTransition(r, "RESUME", "t-004");
		r = applyTransition(r, "REQUEST_COMPLETION_REVIEW", "t-005");

		expect(r.state).toBe("COMPLETION_REVIEW");
		const result = validateMissionExecutionRecord(TEST_CONTRACT, r);
		expect(result.valid).toBe(true);
	});
});

// =============================================================================
// Empty transitions array validates
// =============================================================================

describe("empty transitions validation", () => {
	it("empty transitions array with PLANNING state is valid", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const result = validateMissionExecutionRecord(TEST_CONTRACT, record);
		expect(result.valid).toBe(true);
	});

	it("empty transitions with non-PLANNING state is invalid", () => {
		const fabricated = {
			executionVersion: 1,
			executionId: "exec-001",
			contractDigest: TEST_DIGEST,
			revision: 0,
			state: "EXECUTION",
			transitions: [],
		};
		const result = validateMissionExecutionRecord(TEST_CONTRACT, fabricated);
		expect(result.valid).toBe(false);
		// Replay yields PLANNING, record claims EXECUTION
	});
});

// =============================================================================
// All 10 transition kinds test
// =============================================================================

describe("all transition kinds", () => {
	it("START_EXECUTION from PLANNING", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const r = applyTransition(record, "START_EXECUTION", "t-001");
		expect(r.state).toBe("EXECUTION");
	});

	it("REQUEST_VERIFICATION from EXECUTION", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		let r = applyTransition(record, "START_EXECUTION", "t-001");
		r = applyTransition(r, "REQUEST_VERIFICATION", "t-002");
		expect(r.state).toBe("VERIFICATION");
	});

	it("RETURN_TO_EXECUTION from VERIFICATION", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		let r = applyTransition(record, "START_EXECUTION", "t-001");
		r = applyTransition(r, "REQUEST_VERIFICATION", "t-002");
		r = applyTransition(r, "RETURN_TO_EXECUTION", "t-003");
		expect(r.state).toBe("EXECUTION");
	});

	it("REQUEST_COMPLETION_REVIEW from VERIFICATION", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		let r = applyTransition(record, "START_EXECUTION", "t-001");
		r = applyTransition(r, "REQUEST_VERIFICATION", "t-002");
		r = applyTransition(r, "REQUEST_COMPLETION_REVIEW", "t-003");
		expect(r.state).toBe("COMPLETION_REVIEW");
	});

	it("RETURN_TO_VERIFICATION from COMPLETION_REVIEW", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		let r = applyTransition(record, "START_EXECUTION", "t-001");
		r = applyTransition(r, "REQUEST_VERIFICATION", "t-002");
		r = applyTransition(r, "REQUEST_COMPLETION_REVIEW", "t-003");
		r = applyTransition(r, "RETURN_TO_VERIFICATION", "t-004");
		expect(r.state).toBe("VERIFICATION");
	});

	it("RETURN_TO_EXECUTION from COMPLETION_REVIEW", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		let r = applyTransition(record, "START_EXECUTION", "t-001");
		r = applyTransition(r, "REQUEST_VERIFICATION", "t-002");
		r = applyTransition(r, "REQUEST_COMPLETION_REVIEW", "t-003");
		r = applyTransition(r, "RETURN_TO_EXECUTION", "t-004");
		expect(r.state).toBe("EXECUTION");
	});

	it("APPROVE_COMPLETION from COMPLETION_REVIEW with trusted context", () => {
		const ctx = createCompletionTrustedContext();
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		let r = applyTransition(record, "START_EXECUTION", "t-001");
		r = applyTransition(r, "REQUEST_VERIFICATION", "t-002");
		r = applyTransition(r, "REQUEST_COMPLETION_REVIEW", "t-003");
		r = applyTransition(r, "APPROVE_COMPLETION", "t-004", ctx);
		expect(r.state).toBe("COMPLETED");
	});

	it("BLOCK from EXECUTION", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		let r = applyTransition(record, "START_EXECUTION", "t-001");
		r = applyTransition(r, "BLOCK", "t-002");
		expect(r.state).toBe("BLOCKED");
	});

	it("RESUME from BLOCKED", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		let r = applyTransition(record, "START_EXECUTION", "t-001");
		r = applyTransition(r, "BLOCK", "t-002");
		r = applyTransition(r, "RESUME", "t-003");
		expect(r.state).toBe("EXECUTION");
	});

	it("FAIL from PLANNING", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const r = applyTransition(record, "FAIL", "t-001");
		expect(r.state).toBe("FAILED");
	});

	it("CANCEL from EXECUTION", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		let r = applyTransition(record, "START_EXECUTION", "t-001");
		r = applyTransition(r, "CANCEL", "t-002");
		expect(r.state).toBe("CANCELLED");
	});

	it("BLOCK from COMPLETION_REVIEW then FAIL", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		let r = applyTransition(record, "START_EXECUTION", "t-001");
		r = applyTransition(r, "REQUEST_VERIFICATION", "t-002");
		r = applyTransition(r, "REQUEST_COMPLETION_REVIEW", "t-003");
		r = applyTransition(r, "BLOCK", "t-004");
		expect(r.state).toBe("BLOCKED");
		expect(r.blockedFromState).toBe("COMPLETION_REVIEW");
		r = applyTransition(r, "FAIL", "t-005");
		expect(r.state).toBe("FAILED");
		// Terminal — no blockedFromState
		expect(r.blockedFromState).toBeUndefined();
	});
});

// =============================================================================
// Canonical outputs: transitions always produce same shape
// =============================================================================

describe("canonical outputs", () => {
	it("transition record shape is consistent", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		const r = applyTransition(record, "START_EXECUTION", "t-001");
		const tx = r.transitions[0];

		expect(Object.keys(tx).sort()).toEqual([
			"fromState",
			"kind",
			"revisionAfter",
			"revisionBefore",
			"toState",
			"transitionId",
		]);

		expect(tx.transitionId).toBe("t-001");
		expect(tx.kind).toBe("START_EXECUTION");
		expect(tx.fromState).toBe("PLANNING");
		expect(tx.toState).toBe("EXECUTION");
		expect(tx.revisionBefore).toBe(0);
		expect(tx.revisionAfter).toBe(1);
	});
});

// =============================================================================
// Revision equals transition history length
// =============================================================================

describe("revision equals transition history length", () => {
	it("revision matches transition count", () => {
		const record = initializeMissionExecution(TEST_CONTRACT, "exec-001");
		let r = applyTransition(record, "START_EXECUTION", "t-001");
		expect(r.revision).toBe(1);
		expect(r.transitions.length).toBe(1);

		r = applyTransition(r, "REQUEST_VERIFICATION", "t-002");
		expect(r.revision).toBe(2);
		expect(r.transitions.length).toBe(2);

		r = applyTransition(r, "REQUEST_COMPLETION_REVIEW", "t-003");
		expect(r.revision).toBe(3);
		expect(r.transitions.length).toBe(3);
	});
});

// =============================================================================
// ESM-15 (expanded): Strict expectedRevision CLI parser
// =============================================================================

import { parseStrictNonNegativeInteger } from "../../src/core/long-horizon/cli.js";

describe("ESM-15 (expanded): strict expectedRevision parser", () => {
	it("accepts canonical non-negative integers", () => {
		expect(parseStrictNonNegativeInteger("0")).toBe(0);
		expect(parseStrictNonNegativeInteger("1")).toBe(1);
		expect(parseStrictNonNegativeInteger("12")).toBe(12);
		expect(parseStrictNonNegativeInteger("9007199254740991")).toBe(9007199254740991);
	});

	it("rejects decimal fractions", () => {
		expect(parseStrictNonNegativeInteger("1.0")).toBeUndefined();
		expect(parseStrictNonNegativeInteger("12.5")).toBeUndefined();
		expect(parseStrictNonNegativeInteger("0.0")).toBeUndefined();
	});

	it("rejects scientific notation", () => {
		expect(parseStrictNonNegativeInteger("1e2")).toBeUndefined();
		expect(parseStrictNonNegativeInteger("1e0")).toBeUndefined();
		expect(parseStrictNonNegativeInteger("1E2")).toBeUndefined();
	});

	it("rejects leading sign", () => {
		expect(parseStrictNonNegativeInteger("+1")).toBeUndefined();
		expect(parseStrictNonNegativeInteger("-1")).toBeUndefined();
	});

	it("rejects leading zeros", () => {
		expect(parseStrictNonNegativeInteger("01")).toBeUndefined();
		expect(parseStrictNonNegativeInteger("007")).toBeUndefined();
		expect(parseStrictNonNegativeInteger("00")).toBeUndefined();
	});

	it("rejects special values", () => {
		expect(parseStrictNonNegativeInteger("NaN")).toBeUndefined();
		expect(parseStrictNonNegativeInteger("Infinity")).toBeUndefined();
		expect(parseStrictNonNegativeInteger("-Infinity")).toBeUndefined();
		expect(parseStrictNonNegativeInteger("")).toBeUndefined();
		expect(parseStrictNonNegativeInteger("   ")).toBeUndefined();
	});

	it("rejects values exceeding MAX_SAFE_INTEGER", () => {
		expect(parseStrictNonNegativeInteger("9007199254740992")).toBeUndefined();
		expect(parseStrictNonNegativeInteger("99999999999999999")).toBeUndefined();
	});

	it("rejects non-numeric strings", () => {
		expect(parseStrictNonNegativeInteger("abc")).toBeUndefined();
		expect(parseStrictNonNegativeInteger("1a")).toBeUndefined();
		expect(parseStrictNonNegativeInteger(" 1 ")).toBeUndefined();
	});
});
