/**
 * Provider/model capability registry.
 *
 * Deterministic capability resolution driven by explicit capability flags —
 * never by model names or by the assumption that a newer or more expensive
 * model is better. Unknown capability state is explicit ("unknown"), not
 * silently assumed. Pricing carries an `effectiveAt` and is never used to
 * rewrite historical budget records.
 */

import type { CapabilityFlag, ModelCapabilities } from "./types.js";

export interface CapabilityRegistry {
	profiles: readonly ModelCapabilities[];
}

export interface FindCapabilitiesInput {
	provider: string;
	model: string;
	overrides?: Partial<ModelCapabilities>;
}

export function createCapabilityRegistry(profiles: ModelCapabilities[]): CapabilityRegistry {
	return { profiles: Object.freeze([...profiles]) };
}

function matches(flag: CapabilityFlag): boolean {
	return flag === true;
}

/**
 * Resolve capabilities for a provider/model, applying configuration overrides.
 * Returns `{ found, capabilities, unknown }` — an explicit unknown profile is
 * represented, never fabricated.
 */
export function resolveCapabilities(registry: CapabilityRegistry, input: FindCapabilitiesInput) {
	const base = registry.profiles.find((p) => p.provider === input.provider && p.model === input.model);
	if (!base) {
		return {
			found: false as const,
			capabilities: null,
			unknown: true as const,
		};
	}
	const merged: ModelCapabilities = {
		...base,
		...input.overrides,
		provider: base.provider,
		model: base.model,
	};
	return { found: true as const, capabilities: merged, unknown: false as const };
}

/**
 * Check that a capability profile satisfies an array of required capability
 * names. A flag of `"unknown"` does NOT satisfy a requirement.
 */
export function hasAllCapabilities(profile: ModelCapabilities | null, required: string[]): boolean {
	if (!profile) return false;
	for (const cap of required) {
		const value = (profile as unknown as Record<string, CapabilityFlag>)[cap];
		if (value === undefined || !matches(value)) return false;
	}
	return true;
}

export interface RoleCompatibility {
	compatible: boolean;
	missingRequired: string[];
	unknownRequired: string[];
	reasons: string[];
}

/**
 * Determine whether a profile is compatible with a role's required capabilities.
 */
export function roleCompatibility(profile: ModelCapabilities | null, required: string[]): RoleCompatibility {
	if (!profile) {
		return {
			compatible: false,
			missingRequired: required,
			unknownRequired: [],
			reasons: ["UNKNOWN_CAPABILITY_PROFILE"],
		};
	}
	const missingRequired: string[] = [];
	const unknownRequired: string[] = [];
	const reasons: string[] = [];
	for (const cap of required) {
		const value = (profile as unknown as Record<string, CapabilityFlag>)[cap];
		if (value === undefined || value === "unknown") {
			unknownRequired.push(cap);
			reasons.push(`UNKNOWN_CAPABILITY:${cap}`);
		} else if (value === false) {
			missingRequired.push(cap);
			reasons.push(`MISSING_CAPABILITY:${cap}`);
		}
	}
	return {
		compatible: missingRequired.length === 0 && unknownRequired.length === 0,
		missingRequired,
		unknownRequired,
		reasons,
	};
}

/** Cost-tier heuristic from a profile's pricing (cheap/standard/premium). */
export function costTierOf(profile: ModelCapabilities | null): "cheap" | "standard" | "premium" | "unknown" {
	if (!profile?.pricing) return "unknown";
	const output = profile.pricing.outputPerMillion ?? 0;
	const input = profile.pricing.inputPerMillion ?? 0;
	if (output < 2 && input < 1) return "cheap";
	if (output >= 18 || input >= 10) return "premium";
	return "standard";
}

/** Whether `tier` fits within a `maximumCostTier` policy bound. */
export function tierWithin(
	tier: "cheap" | "standard" | "premium" | "unknown",
	maximumCostTier: string | undefined,
): boolean {
	if (!maximumCostTier) return true;
	if (tier === "unknown") return false;
	const rank: Record<string, number> = { cheap: 1, standard: 2, premium: 3 };
	return rank[tier] <= rank[maximumCostTier];
}
