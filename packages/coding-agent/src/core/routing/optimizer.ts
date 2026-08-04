/**
 * Conservative offline policy optimization.
 *
 * Generates a candidate routing policy from validated evaluation artifacts.
 * The optimizer adjusts rankings, identifies dominated candidates, suggests
 * thresholds/rules, and identifies evidence gaps. It NEVER activates a policy:
 * promotion requires an explicit gate.
 */

import { randomUUID } from "node:crypto";
import { sha256, stableStringify, writePolicy } from "./store.js";
import type { CandidateEvidence, RoutingPolicyCandidate } from "./types.js";

export interface OptimizationInput {
	candidateIds: string[];
	evidenceById: Record<string, CandidateEvidence>;
	evaluatorVersion: string;
	/** Immutable content-addressable dataset identity. */
	sourceDatasetHash: string;
}

export interface OptimizationResult {
	policy: RoutingPolicyCandidate;
	ranked: { candidateId: string; quality: number }[];
	dominatedCandidateIds: string[];
	evidenceGaps: string[];
}

/**
 * Derive a candidate policy from an immutable evidence dataset.
 * Quality is a deterministic blend of correctness, reliability and safety,
 * penalized by uncertainty. No candidate self-report is used as a label.
 */
export function generateRoutingPolicy(
	candidateIds: string[],
	evidenceById: Record<string, CandidateEvidence>,
	evaluatorVersion: string,
	sourceDatasetHash: string,
): OptimizationResult {
	const ranked: { candidateId: string; quality: number }[] = [];
	const evidenceGaps: string[] = [];

	for (const id of candidateIds) {
		const ev = evidenceById[id];
		if (!ev) {
			evidenceGaps.push(id);
			continue;
		}
		const safety = ev.safetyRate ?? 0;
		const quality =
			(ev.correctnessRate ?? 0) * 0.4 + (ev.reliabilityRate ?? 0) * 0.3 + safety * 0.3 - (ev.flakyRate ?? 0) * 0.3;
		ranked.push({
			candidateId: id,
			quality: Math.max(0, quality) * (1 - responseUncertainty(ev) * 0.2),
		});
	}

	ranked.sort((a, b) => b.quality - a.quality || a.candidateId.localeCompare(b.candidateId));

	// Dominance: a candidate is dominated if some other candidate is >= on
	// correctness, reliability AND safety with strict improvement on one, and both
	// have sufficient samples.
	const dominatedCandidateIds = findDominated(candidateIds, evidenceById, ranked);

	const suggestedRules: string[] = [];
	if (ranked.length > 0 && ranked[0]) {
		suggestedRules.push(`prefer ${ranked[0].candidateId} when evidence compatible`);
	}
	if (dominatedCandidateIds.length > 0) {
		suggestedRules.push(`exclude dominated: ${dominatedCandidateIds.join(", ")}`);
	}

	const policyId = randomUUID();
	const content = stableStringify({
		policyId,
		evaluatorVersion,
		sourceDatasetHash,
		ranked,
		dominatedCandidateIds,
		evidenceGaps,
	});
	const policy: RoutingPolicyCandidate = {
		policyId,
		policyVersion: 1,
		sourceDatasetHash,
		evaluatorVersion,
		generatedAt: new Date().toISOString(),
		status: "draft",
		preferences: ranked,
		suggestedRules,
		dominatedCandidateIds,
		evidenceGaps,
		hash: sha256(content),
		content,
	};

	writePolicy(policy);
	return { policy, ranked, dominatedCandidateIds, evidenceGaps };
}

function findDominated(
	candidateIds: string[],
	evidenceById: Record<string, CandidateEvidence>,
	_ranked: { candidateId: string; quality: number }[],
): string[] {
	const dominated: string[] = [];
	for (const id of candidateIds) {
		const ev = evidenceById[id];
		if (!ev || ev.sampleCount < 5) continue;
		for (const otherId of candidateIds) {
			if (otherId === id) continue;
			const other = evidenceById[otherId];
			if (!other || other.sampleCount < 5) continue;
			const dominates =
				(other.correctnessRate ?? 0) >= (ev.correctnessRate ?? 0) &&
				(other.reliabilityRate ?? 0) >= (ev.reliabilityRate ?? 0) &&
				(other.safetyRate ?? 0) >= (ev.safetyRate ?? 0) &&
				((other.correctnessRate ?? 0) > (ev.correctnessRate ?? 0) ||
					(other.reliabilityRate ?? 0) > (ev.reliabilityRate ?? 0) ||
					(other.safetyRate ?? 0) > (ev.safetyRate ?? 0));
			if (dominates) {
				dominated.push(id);
				break;
			}
		}
	}
	return [...new Set(dominated)];
}

export function responseUncertainty(ev: CandidateEvidence): number {
	let u = Math.max(0, 1 - Math.min(1, ev.sampleCount / 30));
	u = Math.max(0, Math.min(1, u + (ev.flakyRate ?? 0) * 0.5));
	return u;
}
