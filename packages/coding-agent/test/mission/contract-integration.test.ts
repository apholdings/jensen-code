/**
 * Durable Mission Graph — contracts, integration transactions, localized
 * rollback, approvals, external blockers.
 */

import { describe, expect, it } from "vitest";
import {
	type ApprovalGateSpec,
	addIntegrationCheckpoint,
	beginIntegrationTransaction,
	confirmIntegrationTransaction,
	type ExternalBlockerSpec,
	evaluateApproval,
	isApprovalValid,
	isContractStale,
	linkProducerConsumer,
	type MissionContract,
	markIntegrationValidating,
	type RepositoryLease,
	rollbackIntegrationTransaction,
	satisfyExternalBlocker,
	verifyContractCompatibility,
} from "../../src/core/mission/index.js";

describe("mission contracts", () => {
	const contract: MissionContract = {
		id: "c1",
		schema: "s",
		revision: 3,
		producerObjective: "a",
		consumerObjective: "b",
		compatibility: ">=3",
	};

	it("CONTRACT_IDENTITY links producer and consumer of the same contract", () => {
		const res = linkProducerConsumer(
			contract,
			{ id: "c1", revision: 3, schema: "s", producedRevision: 3 },
			{ contractId: "c1", requiredRevision: 3 },
		);
		expect(res.ok).toBe(true);
	});

	it("rejects mismatched contract ids (PRODUCER_CONSUMER_LINK)", () => {
		const res = linkProducerConsumer(
			contract,
			{ id: "other", revision: 3, schema: "s" },
			{ contractId: "c1", requiredRevision: 3 },
		);
		expect(res.ok).toBe(false);
		expect(res.code).toBe("CONTRACT_MISMATCH");
	});

	it("COMPATIBILITY_VERIFICATION rejects insufficient producer revision", () => {
		const check = verifyContractCompatibility(
			{ id: "c1", revision: 1, schema: "s", producedRevision: 1 },
			{ contractId: "c1", requiredRevision: 3 },
		);
		expect(check.compatible).toBe(false);
	});

	it("STALE_CONTRACT_DETECTED via revision regression", () => {
		expect(
			isContractStale(
				{ id: "c1", revision: 2, schema: "s", producedRevision: 2 },
				{ contractId: "c1", requiredRevision: 3 },
			),
		).toBe(true);
	});
});

describe("mission integration transactions", () => {
	const leases: RepositoryLease[] = [
		{ leaseId: "l1", repositoryId: "repo:A", holder: "p1", acquiredAtMs: 0, expiresAtMs: 100000 },
		{ leaseId: "l2", repositoryId: "repo:B", holder: "p1", acquiredAtMs: 0, expiresAtMs: 100000 },
	];

	it("INTEGRATION_LEASE requires a held lease per repository", () => {
		const tx = beginIntegrationTransaction({
			transactionId: "t1",
			objectiveIds: ["a"],
			repositoryIds: ["repo:A", "repo:MISSING"],
			leases,
			nowMs: 0,
		});
		expect(tx.ok).toBe(false);
		expect(tx.code).toBe("LEASE_NOT_HELD");
	});

	it("INTEGRATION_CHECKPOINT precedes mutation and confirms", () => {
		const started = beginIntegrationTransaction({
			transactionId: "t1",
			objectiveIds: ["a", "b"],
			repositoryIds: ["repo:A", "repo:B"],
			leases,
			nowMs: 0,
		});
		expect(started.ok).toBe(true);
		let tx = started.value!;
		tx = addIntegrationCheckpoint(tx, "a", { baseline: 1 }).value!;
		expect(tx.stage).toBe("PREPARED");
		tx = addIntegrationCheckpoint(tx, "b", { baseline: 2 }).value!;
		expect(tx.stage).toBe("CHECKPOINTED");
		tx = markIntegrationValidating(tx).value!;
		tx = confirmIntegrationTransaction(tx).value!;
		expect(tx.stage).toBe("CONFIRMED");
	});

	it("INTEGRATION_ROLLBACK restores checkpoints and preserves independent work", () => {
		const started = beginIntegrationTransaction({
			transactionId: "t2",
			objectiveIds: ["a", "b"],
			repositoryIds: ["repo:A", "repo:B"],
			leases,
			nowMs: 0,
		});
		let tx = started.value!;
		tx = addIntegrationCheckpoint(tx, "a", { baseline: 1 }).value!;
		tx = addIntegrationCheckpoint(tx, "b", { baseline: 2 }).value!;
		const rollback = rollbackIntegrationTransaction(tx);
		expect(rollback.ok).toBe(true);
		expect(rollback.value?.restoredCheckpoints).toEqual(["a", "b"]);
		// Independent work (objectives outside this tx) is preserved by design.
		expect(rollback.value?.preservedIndependentWork).toBe(true);
	});
});

describe("mission approval gates", () => {
	const gate: ApprovalGateSpec = { id: "g1", requiredPrincipals: ["human-1"], scope: "objective", ttlMs: 1000 };

	it("APPROVAL_REQUIRED blocks non-principals (NO unauthorized grant)", () => {
		const r = evaluateApproval({ gate, objectiveId: "obj", principal: "human-2", approved: true, nowMs: 0 });
		expect(r.ok).toBe(false);
		expect(r.code).toBe("APPROVAL_NOT_GRANTED");
	});

	it("NO_SELF_APPROVAL is rejected", () => {
		const selfGate: ApprovalGateSpec = { id: "g2", requiredPrincipals: ["obj"], scope: "objective" };
		const r = evaluateApproval({ gate: selfGate, objectiveId: "obj", principal: "obj", approved: true, nowMs: 0 });
		expect(r.ok).toBe(false);
		expect(r.code).toBe("SELF_APPROVAL");
	});

	it("APPROVAL_PRINCIPAL_VERIFIED grants to a listed principal", () => {
		const r = evaluateApproval({ gate, objectiveId: "obj", principal: "human-1", approved: true, nowMs: 0 });
		expect(r.ok).toBe(true);
		expect(r.value?.approved).toBe(true);
	});

	it("REJECTION is recorded and invalidates readiness", () => {
		const r = evaluateApproval({ gate, objectiveId: "obj", principal: "human-1", approved: false, nowMs: 0 });
		expect(r.ok).toBe(true);
		expect(r.value?.approved).toBe(false);
	});

	it("EXPIRATION makes a prior approval invalid", () => {
		const decision = evaluateApproval({ gate, objectiveId: "obj", principal: "human-1", approved: true, nowMs: 0 })
			.value!;
		expect(isApprovalValid(gate, decision, 500)).toBe(true);
		expect(isApprovalValid(gate, decision, 5000)).toBe(false);
	});
});

describe("mission external blockers", () => {
	const blocker: ExternalBlockerSpec = {
		id: "b1",
		statement: "license approval acquired",
		evidenceRequired: true,
		satisfiedOn: ["ref:license-EMAIL-2024"],
	};

	it("NO_FABRICATED_SATISFACTION without evidence", () => {
		const r = satisfyExternalBlocker(blocker, undefined);
		expect(r.ok).toBe(false);
		expect(r.code).toBe("BLOCKER_WITHOUT_EVIDENCE");
	});

	it("EXTERNAL_BLOCKER_EVIDENCE_PASS only on listed evidence", () => {
		expect(satisfyExternalBlocker(blocker, "ref:license-EMAIL-2024").ok).toBe(true);
		expect(satisfyExternalBlocker(blocker, "ref:fabricated").ok).toBe(false);
	});
});
