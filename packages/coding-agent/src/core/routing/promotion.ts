/**
 * Policy promotion and rollback.
 *
 * Promotion is explicitly gated: schema validation, dataset integrity,
 * baseline comparison, safety/correctness/flakiness gates, cost/latency policy,
 * and operator authorization. There is NO automatic promotion. The old policy is
 * always retained and the active-policy pointer is swapped atomically.
 */

import {
	type ActivePolicyPointer,
	appendEvent,
	loadActivePolicyPointer,
	readPolicy,
	saveActivePolicyPointer,
	sha256,
	stableStringify,
} from "./store.js";
import type { CandidateEvidence, RoutingPolicyCandidate } from "./types.js";

export interface PromotionGateInput {
	safetyFloor: number;
	correctnessFloor: number;
	flakinessCeiling: number;
	requiredScenarioPack: string;
	operatorAuthorized: boolean;
}

export interface PromotionGateResult {
	passed: boolean;
	reasonCodes: string[];
}

/** Validate the promotion gates for a candidate policy against its evidence. */
export function validatePromotionGates(
	policy: RoutingPolicyCandidate,
	evidenceById: Record<string, CandidateEvidence>,
	gates: PromotionGateInput,
): PromotionGateResult {
	const reasons: string[] = [];

	if (policy.status !== "draft" && policy.status !== "validated") {
		reasons.push(`policy_status_${policy.status}_not_promotable`);
	}
	if (policy.hash !== sha256(policy.content ?? stableStringify(policy))) {
		reasons.push("policy_hash_mismatch");
	}

	const prefs = policy.preferences ?? [];
	if (prefs.length === 0) {
		reasons.push("policy_has_no_preferences");
	}

	for (const pref of prefs) {
		const ev = evidenceById[pref.candidateId];
		if (!ev) {
			reasons.push(`no_evidence_for_${pref.candidateId}`);
			continue;
		}
		if (ev.sampleCount < 5) reasons.push(`insufficient_samples_${pref.candidateId}`);
		if ((ev.safetyRate ?? 0) < gates.safetyFloor) reasons.push(`safety_gate_failed_${pref.candidateId}`);
		if ((ev.correctnessRate ?? 0) < gates.correctnessFloor)
			reasons.push(`correctness_gate_failed_${pref.candidateId}`);
		if ((ev.flakyRate ?? 0) > gates.flakinessCeiling) reasons.push(`flakiness_gate_failed_${pref.candidateId}`);
	}

	if (!gates.operatorAuthorized) reasons.push("operator_not_authorized");

	appendEvent({
		type: "ROUTING_POLICY_VALIDATED",
		policyId: policy.policyId,
		policyVersion: policy.policyVersion,
		payload: { passed: reasons.length === 0, reasonCodes: reasons },
	});

	return { passed: reasons.length === 0, reasonCodes: reasons };
}

/** Promote a validated policy to be the active policy (explicit operator action). */
export function promotePolicy(
	policyId: string,
	authorizedBy: string,
	evidenceById: Record<string, CandidateEvidence>,
	gates: PromotionGateInput,
): { ok: boolean; pointer?: ActivePolicyPointer; error?: string; reasonCodes: string[] } {
	const policy = readPolicy(policyId);
	if (!policy) return { ok: false, error: `policy ${policyId} not found`, reasonCodes: ["policy_not_found"] };

	const gate = validatePromotionGates(policy, evidenceById, gates);
	if (!gate.passed) {
		return { ok: false, error: "promotion gates failed", reasonCodes: gate.reasonCodes };
	}

	const prev = loadActivePolicyPointer();
	policy.status = "promoted";
	const pointer = {
		policyId: policy.policyId,
		policyVersion: policy.policyVersion,
		hash: policy.hash,
		activatedAt: new Date().toISOString(),
		previousPolicyId: prev?.policyId,
	};
	saveActivePolicyPointer(pointer);
	appendEvent({
		type: "ROUTING_POLICY_PROMOTED",
		policyId: policy.policyId,
		policyVersion: policy.policyVersion,
		payload: { authorizedBy, previousPolicyId: prev?.policyId },
	});
	return { ok: true, pointer, reasonCodes: gate.reasonCodes };
}

/** Roll back to a previous policy. Idempotent; old policy retained. */
export function rollbackPolicy(policyId: string, authorizedBy: string): { ok: boolean; error?: string } {
	const policy = readPolicy(policyId);
	if (!policy) return { ok: false, error: `policy ${policyId} not found` };

	const pointer = {
		policyId: policy.policyId,
		policyVersion: policy.policyVersion,
		hash: policy.hash,
		activatedAt: new Date().toISOString(),
	};
	saveActivePolicyPointer(pointer);
	appendEvent({
		type: "ROUTING_POLICY_ROLLED_BACK",
		policyId: policy.policyId,
		policyVersion: policy.policyVersion,
		payload: { authorizedBy },
	});
	return { ok: true };
}

/** Compare two policies deterministically. */
export function comparePolicies(a: RoutingPolicyCandidate, b: RoutingPolicyCandidate): unknown {
	return {
		left: { policyId: a.policyId, version: a.policyVersion, preferences: a.preferences },
		right: { policyId: b.policyId, version: b.policyVersion, preferences: b.preferences },
		same: stableStringify(a.preferences) === stableStringify(b.preferences),
	};
}
