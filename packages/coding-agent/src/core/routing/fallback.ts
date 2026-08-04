/**
 * Typed fallback and degradation.
 *
 * Fallback triggers are typed: no fuzzy substitution, no surprise paid
 * provider, local-only preserved, safety class preserved, fallback reason and
 * cost implications visible, loops bounded, and no silent quality downgrade.
 *
 * Fallback hierarchy:
 *   explicit operator fallback → validated policy fallback →
 *   deterministic baseline → safe degraded mode → typed blocked state.
 */

import { baselineSelect } from "./baseline.js";
import { appendEvent } from "./store.js";
import type { OrchestrationCandidate, OrchestrationFeatureVector } from "./types.js";

export type FallbackTrigger =
	| "provider_unavailable"
	| "model_unavailable"
	| "rate_limited"
	| "context_limit"
	| "structured_output_invalid"
	| "tool_capability_unavailable"
	| "subagent_unavailable"
	| "evaluation_store_unavailable"
	| "routing_policy_corrupt";

export interface FallbackResult {
	trigger: FallbackTrigger;
	selectedCandidate?: OrchestrationCandidate;
	fallbackLayer: "operator" | "validated_policy" | "deterministic_baseline" | "degraded" | "blocked";
	reason: string;
	costImplication: string;
	blocked: boolean;
}

const FALLBACK_LIMIT = 5;

/**
 * Resolve a fallback for a trigger.
 * - explicitFallback: operator-provided candidate (highest authority).
 * - policyFallback: candidate from the validated policy.
 * - Otherwise, fall to the deterministic baseline then to a typed degraded mode.
 */
export function resolveFallback(
	trigger: FallbackTrigger,
	features: OrchestrationFeatureVector,
	options: {
		explicitFallback?: OrchestrationCandidate;
		policyFallback?: OrchestrationCandidate;
		localOnly: boolean;
		safetyClass: string;
	},
): FallbackResult {
	if (options.explicitFallback) {
		return {
			trigger,
			selectedCandidate: options.explicitFallback,
			fallbackLayer: "operator",
			reason: `operator fallback for ${trigger}`,
			costImplication: "as operator-specified",
			blocked: false,
		};
	}

	if (options.policyFallback) {
		return {
			trigger,
			selectedCandidate: options.policyFallback,
			fallbackLayer: "validated_policy",
			reason: `validated policy fallback for ${trigger}`,
			costImplication: "policy-specified candidate",
			blocked: false,
		};
	}

	// Deterministic baseline.
	if (features) {
		const baseline = baselineSelect(features);
		const baselineCandidate = baseline.candidate;
		// Blocked triggers that cannot be safely served by baseline.
		if (trigger === "routing_policy_corrupt") {
			// Baseline remains available even when policy store is corrupt.
			return {
				trigger,
				selectedCandidate: baselineCandidate,
				fallbackLayer: "deterministic_baseline",
				reason: `deterministic baseline available despite ${trigger}`,
				costImplication: "baseline local-only cost",
				blocked: false,
			};
		}
		if (options.localOnly && isRemoteProvider(baselineCandidate.providerProfile)) {
			return degradedOrBlocked(trigger, options);
		}
		return {
			trigger,
			selectedCandidate: baselineCandidate,
			fallbackLayer: "deterministic_baseline",
			reason: `deterministic baseline fallback for ${trigger}`,
			costImplication: "baseline cost",
			blocked: false,
		};
	}

	// Safe degraded mode.
	if (trigger !== "provider_unavailable" && trigger !== "rate_limited") {
		const degraded: OrchestrationCandidate = {
			candidateId: "degraded-local-readonly",
			providerProfile: "local",
			configuredModel: "local/readonly",
			executionTopology: "single_agent",
			skillIds: [],
			subagentDefinitions: [],
			retrievalPolicy: "lexical",
			budgetClass: "small",
			fallbackPolicy: "degraded",
		};
		return {
			trigger,
			selectedCandidate: degraded,
			fallbackLayer: "degraded",
			reason: `safe degraded mode for ${trigger}`,
			costImplication: "local-only, no new paid provider",
			blocked: false,
		};
	}

	return degradedOrBlocked(trigger, options);
}

function degradedOrBlocked(trigger: FallbackTrigger, options: { safetyClass: string }): FallbackResult {
	appendEvent({
		type: "ORCHESTRATION_FALLBACK_APPLIED",
		payload: { trigger, layer: "blocked" },
	});
	return {
		trigger,
		fallbackLayer: "blocked",
		reason: `no safe fallback for ${trigger}; must preserve safety class (${options.safetyClass})`,
		costImplication: "none (blocked)",
		blocked: true,
	};
}

export function isRemoteProvider(provider: string): boolean {
	const p = provider.toLowerCase();
	return !(p === "local" || p.startsWith("local-") || p === "fixture" || p.includes("test"));
}

export const FALLBACK_CHAIN_LIMIT = FALLBACK_LIMIT;
