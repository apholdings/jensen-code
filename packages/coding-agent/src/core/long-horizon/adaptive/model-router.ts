/**
 * Role-based model routing.
 *
 * Deterministic, policy-constrained selection of a provider/model for a role.
 * Routing consumes structured evidence (risk, type, phase, remaining budget,
 * health, failures, stall, required independence) and returns a structured,
 * explainable `reasonCodes` decision. A model may *recommend* escalation but
 * never self-authorizes it — escalation requires its own bounded, evidence-
 * backed policy evaluation (see `escalation.ts`).
 */

import { type CapabilityRegistry, type costTierOf, roleCompatibility, tierWithin } from "./capability-registry.js";
import type { HealthLevel as ProviderHealthLevel } from "./provider-health.js";
import type { ModelCapabilities, ModelRole, ModelRolePolicy, ModelRouteDecision, RoutingInput } from "./types.js";

/** A candidate model registered for routing. */
export interface RouteCandidate {
	provider: string;
	model: string;
	profile: ModelCapabilities | null;
	costTier: ReturnType<typeof costTierOf>;
	health: ProviderHealthLevel;
}

export interface RouterConfig {
	registry: CapabilityRegistry;
	rolePolicies: Record<ModelRole, ModelRolePolicy>;
	candidates: RouteCandidate[];
	healthState: Record<string, ProviderHealthLevel>;
	maxEscalationLevel: number;
}

export interface RouteOptions {
	escalationLevel?: number;
	deniedModels?: string[];
	forceModel?: { provider: string; model: string };
}

const ROLE_CAPABILITY_BY_TASK: Record<string, string[]> = {
	code: ["supportsTools", "supportsCodeGeneration"],
	research: ["supportsResearchSynthesis"],
	review: ["supportsCodeReview"],
	synthesis: ["supportsCheapSummarization"],
	repair: ["supportsToolCallRepair"],
	recovery: ["supportsTools", "supportsCodeGeneration"],
};

/**
 * Compute the capability requirements for a routing input by combining the
 * role policy's required capabilities with task-type requirements.
 */
export function requiredCapabilitiesFor(policy: ModelRolePolicy, input: RoutingInput): string[] {
	const required = new Set(policy.requiredCapabilities);
	for (const cap of ROLE_CAPABILITY_BY_TASK[input.taskType] ?? []) {
		required.add(cap);
	}
	if (input.requiredTools && input.requiredTools.length > 0) {
		required.add("supportsTools");
	}
	return [...required];
}

export interface RouteResult {
	decision: ModelRouteDecision | null;
	rejections: string[];
}

/**
 * Deterministic routing. Returns a decision or a list of rejections (reason
 * codes) when no candidate satisfies policy.
 */
export function routeForRole(
	config: RouterConfig,
	input: RoutingInput,
	policy: ModelRolePolicy,
	options: RouteOptions = {},
): RouteResult {
	const required = requiredCapabilitiesFor(policy, input);
	const rejections: string[] = [];

	// Respect forced model override (used only by deterministic policy, never by
	// model self-authorization).
	if (options.forceModel) {
		const forced = config.candidates.find(
			(c) => c.provider === options.forceModel?.provider && c.model === options.forceModel?.model,
		);
		if (forced) {
			const compat = roleCompatibility(forced.profile, required);
			if (compat.compatible) {
				return {
					decision: {
						role: input.role,
						provider: forced.provider,
						model: forced.model,
						reasonCodes: ["FORCED_BY_POLICY", "CAPABILITY_COMPATIBLE", ...compat.reasons],
						fallbackChain: [],
						escalationLevel: 0,
					},
					rejections,
				};
			}
			rejections.push(`FORCED_MODEL_INCOMPATIBLE:${forced.provider}/${forced.model}`);
		}
	}

	// Filter by denied models and allowed providers.
	const allowedProviders = policy.allowedProviders;
	const deniedModels = new Set([...(policy.deniedModels ?? []), ...(options.deniedModels ?? [])]);

	// Cost-tier cap.
	const maxTier = policy.maximumCostTier;

	// Determine escalation depth budget.
	const escalationLevel = options.escalationLevel ?? 0;
	if (escalationLevel > config.maxEscalationLevel) {
		rejections.push("ESCALATION_BUDGET_EXHAUSTED");
	}

	// Build list of compatible candidates in declared order (deterministic).
	const fallbackChain: string[] = [];
	let chosen: RouteCandidate | null = null;

	for (const candidate of config.candidates) {
		const key = `${candidate.provider}/${candidate.model}`;
		if ((candidate.profile?.model && deniedModels.has(candidate.model)) || deniedModels.has(key)) {
			rejections.push(`DENIED_MODEL:${key}`);
			continue;
		}
		if (allowedProviders && !allowedProviders.includes(candidate.provider)) {
			rejections.push(`DENIED_PROVIDER:${candidate.provider}`);
			continue;
		}
		if (candidate.health === "unhealthy") {
			rejections.push(`UNHEALTHY:${key}`);
			continue;
		}
		if (candidate.health === "degraded" && candidate.costTier === "premium") {
			rejections.push(`DEGRADED_PREMIUM:${key}`);
			continue;
		}
		if (!tierWithin(candidate.costTier, maxTier)) {
			rejections.push(`COST_TIER:${key}`);
			continue;
		}
		fallbackChain.push(key);

		const compat = roleCompatibility(candidate.profile, required);
		if (!compat.compatible) {
			rejections.push(`INCOMPATIBLE:${key}:${compat.reasons.join(",")}`);
			if (!chosen) {
				// Keep the first *compatible-required* candidate even if optional
				// preferred caps are missing, but only if required caps pass.
			}
			continue;
		}
		if (!chosen) {
			chosen = candidate;
		}
		// Prefer candidates satisfying more preferred capabilities (deterministic ties).
	}

	if (!chosen) {
		return { decision: null, rejections };
	}

	const decision: ModelRouteDecision = {
		role: input.role,
		provider: chosen.provider,
		model: chosen.model,
		reasonCodes: ["CAPABILITY_COMPATIBLE", ...preferredReasons(chosen, policy)],
		estimatedBudgetImpact: estimateBudgetImpact(chosen.profile),
		fallbackChain,
		escalationLevel,
	};
	return { decision, rejections };
}

function preferredReasons(candidate: RouteCandidate, policy: ModelRolePolicy): string[] {
	const reasons: string[] = [];
	for (const pref of policy.preferredCapabilities ?? []) {
		if ((candidate.profile as Record<string, boolean | "unknown"> | null)?.[pref] === true) {
			reasons.push(`PREFERRED:${pref}`);
		}
	}
	return reasons;
}

function estimateBudgetImpact(profile: ModelCapabilities | null): number | undefined {
	if (!profile?.pricing) return undefined;
	const input = profile.pricing.inputPerMillion ?? 0;
	const output = profile.pricing.outputPerMillion ?? 0;
	// Rough per-million-input equivalent cost of a typical 1M input / 50K output call.
	return +(input + output * 0.05).toFixed(6);
}

export { hasAllCapabilities } from "./capability-registry.js";
