/**
 * Zero-effect shadow routing.
 *
 * A shadow policy evaluates the same task context and records what it WOULD
 * have selected, but never executes, never calls a provider, never mutates the
 * workspace, and never affects the current run. Shadow decisions are durable
 * and can later be compared counterfactually.
 */

import { randomUUID } from "node:crypto";
import { appendEvent, writeShadowDecision } from "./store.js";
import type { OrchestrationDecision, OrchestrationFeatureVector, ShadowDecision } from "./types.js";

export interface ShadowRoutingInput {
	productionDecision: OrchestrationDecision;
	shadowPolicyId: string;
	shadowPolicyVersion: number;
	shadowCandidateId?: string;
	reasonCodes?: string[];
	runId?: string;
}

/**
 * Produce a shadow decision. This function is pure with respect to effects:
 * it only records the shadow record and an event; it performs no execution.
 */
export function shadowEvaluate(
	productionFeatures: OrchestrationFeatureVector,
	shadowCandidateId: string | undefined,
	shadowPolicyId: string,
	shadowPolicyVersion: number,
	productionCandidateId: string | undefined,
	runId: string,
	reasonCodes: string[] = [],
): ShadowDecision {
	const shadow: ShadowDecision = {
		shadowId: randomUUID(),
		productionDecisionId: "",
		runId,
		taskFingerprint: productionFeatures.featureHash,
		features: productionFeatures,
		shadowPolicyId,
		shadowPolicyVersion,
		productionCandidateId,
		shadowCandidateId,
		wouldSelectDifferent: Boolean(shadowCandidateId) && shadowCandidateId !== productionCandidateId,
		reasonCodes,
		recordedAt: new Date().toISOString(),
	};
	return shadow;
}

/** Record a shadow decision durably (still zero execution effects). */
export function recordShadowDecision(shadow: ShadowDecision): ShadowDecision {
	writeShadowDecision(shadow);
	appendEvent({
		type: "ORCHESTRATION_SHADOW_DECISION",
		runId: shadow.runId,
		decisionId: shadow.productionDecisionId || undefined,
		policyId: shadow.shadowPolicyId,
		policyVersion: shadow.shadowPolicyVersion,
		candidateId: shadow.shadowCandidateId,
		evidenceIds: [],
		payload: {
			wouldSelectDifferent: shadow.wouldSelectDifferent,
			shadowId: shadow.shadowId,
		},
	});
	return shadow;
}
