/**
 * CLI helper functions: active policy status, fixture evidence, and policy
 * generation used by the routing CLI. These are inherently deterministic and
 * offline (no providers, no network) so normal CI never touches a paid API.
 */

import { generateRoutingPolicy } from "./optimizer.js";
import { loadActivePolicyPointer, readPolicy } from "./store.js";
import type { CandidateEvidence } from "./types.js";

export interface ActivePolicyStatus {
	active: boolean;
	policyId?: string;
	policyVersion?: number;
	hash?: string;
	activatedAt?: string;
	previousPolicyId?: string;
}

export function activePolicyStatus(): ActivePolicyStatus {
	const pointer = loadActivePolicyPointer();
	if (!pointer) return { active: false };
	return {
		active: true,
		policyId: pointer.policyId,
		policyVersion: pointer.policyVersion,
		hash: pointer.hash,
		activatedAt: pointer.activatedAt,
		previousPolicyId: pointer.previousPolicyId,
	};
}

/**
 * Deterministic fixture evidence set used for offline CLI paths (decide,
 * generate, promote). Uses fixture candidate IDs and a fixed evaluation
 * fingerprint so results are reproducible across runs and platforms.
 */
export function fixtureEvidence(): Record<string, CandidateEvidence> {
	const ev: Record<string, CandidateEvidence> = {};
	const base = (candidateId: string, sampleCount: number): CandidateEvidence => ({
		candidateId,
		evaluatorVersion: "1.0.0-fixture",
		scenarioVersion: "routing-pack-v1",
		evidenceHash: `${candidateId}-fixture-v1`,
		sampleCount,
		correctnessRate: 0.9,
		safetyRate: 0.98,
		reliabilityRate: 0.92,
		medianLatencyMs: 1200,
		avgCostUsd: 0.3,
		flakyRate: 0.05,
		compatibility: { promptTemplateId: "fixture", toolSchemaVersion: "1" },
		collectedAt: "2026-01-01T00:00:00.000Z",
		version: 1,
	});
	const ids = [
		"c-fixture-fixture-deterministic-single_agent-lexical-small",
		"c-fixture-fixture-deterministic-single_agent-hybrid-standard",
		"c-fixture-fixture-deterministic-single_agent_with_reviewer-hybrid-large",
		"c-fixture-fixture-deterministic-cavecrew-hybrid-release",
	];
	for (const id of ids) ev[id] = base(id, 25);
	return ev;
}

/** Generate a policy from fixture evidence and return its summary. */
export function generatePolicyFromFixture(): unknown {
	const evidenceById = fixtureEvidence();
	const candidateIds = Object.keys(evidenceById);
	const result = generateRoutingPolicy(candidateIds, evidenceById, "1.0.0-fixture", "dataset-fixture-hash");
	return {
		policyId: result.policy.policyId,
		policyVersion: result.policy.policyVersion,
		sourceDatasetHash: result.policy.sourceDatasetHash,
		status: result.policy.status,
		ranked: result.ranked,
		dominatedCandidateIds: result.dominatedCandidateIds,
		evidenceGaps: result.evidenceGaps,
	};
}

/** Resolve the active policy's preferences for engine consumption. */
export function activePolicyContext():
	| {
			policyId: string;
			policyVersion: number;
			preferences?: { candidateId: string; quality: number }[];
			dominatedCandidateIds?: string[];
	  }
	| undefined {
	const pointer = loadActivePolicyPointer();
	if (!pointer) return undefined;
	const policy = readPolicy(pointer.policyId);
	if (!policy) return undefined;
	return {
		policyId: policy.policyId,
		policyVersion: policy.policyVersion,
		preferences: policy.preferences ?? undefined,
		dominatedCandidateIds: policy.dominatedCandidateIds,
	};
}
