/**
 * Deterministic baseline policy.
 *
 * The baseline must function with no historical evaluations, no live providers,
 * no model-based routing, and no network access. It is a canonical, rule-based,
 * deterministic mapping from the feature vector to a recommended candidate.
 *
 * Rules carry explicit IDs and deterministic precedence. The baseline remains
 * available during evaluation-store failure and is fully replayable.
 */

import type { BaselineRule, ExecutionTopology, OrchestrationCandidate, OrchestrationFeatureVector } from "./types.js";

const DEFAULT_PROVIDER = "fixture";
const DEFAULT_MODEL = "fixture/deterministic";
const _DEFAULT_THINKING = "off";

/**
 * Deterministic baseline rules, ordered by precedence (lower runs first).
 * Each rule matches on a subset of feature fields.
 */
export const BASELINE_RULES: BaselineRule[] = [
	{
		ruleId: "baseline-release",
		description: "Release task: planner + builder + reviewer topology, release budget, hybrid retrieval.",
		precedence: 1,
		match: { requiresRelease: true },
		result: {
			executionTopology: "cavecrew",
			retrievalPolicy: "hybrid",
			budgetClass: "release",
			providerProfile: DEFAULT_PROVIDER,
			configuredModel: DEFAULT_MODEL,
			thinkingLevel: "high",
			reasonCodes: ["baseline:release_task"],
		},
	},
	{
		ruleId: "baseline-high-risk-mutation",
		description:
			"High-risk multi-file mutation: single agent plus reviewer or Cavecrew builder, large bounded budget.",
		precedence: 2,
		match: { minComplexity: 0.55, requiresMutation: true },
		result: {
			executionTopology: "single_agent_with_reviewer",
			retrievalPolicy: "hybrid",
			budgetClass: "large",
			providerProfile: DEFAULT_PROVIDER,
			configuredModel: DEFAULT_MODEL,
			thinkingLevel: "high",
			reasonCodes: ["baseline:high_risk_mutation"],
		},
	},
	{
		ruleId: "baseline-bounded-implementation",
		description: "Bounded implementation: single worker, hybrid retrieval, standard budget.",
		precedence: 3,
		match: { requiresMutation: true, minComplexity: 0.1 },
		result: {
			executionTopology: "single_agent",
			retrievalPolicy: "hybrid",
			budgetClass: "standard",
			providerProfile: DEFAULT_PROVIDER,
			configuredModel: DEFAULT_MODEL,
			thinkingLevel: "high",
			reasonCodes: ["baseline:bounded_implementation"],
		},
	},
	{
		ruleId: "baseline-small-exact-lookup",
		description: "Small exact read-only query: single analytical agent, lexical retrieval, small budget.",
		precedence: 4,
		match: { requiresMutation: false, minComplexity: 0.05 },
		result: {
			executionTopology: "single_agent",
			retrievalPolicy: "lexical",
			budgetClass: "small",
			providerProfile: DEFAULT_PROVIDER,
			configuredModel: DEFAULT_MODEL,
			thinkingLevel: "off",
			reasonCodes: ["baseline:small_exact_lookup"],
		},
	},
	{
		ruleId: "baseline-default",
		description: "Default fallback: single analytical agent, hybrid retrieval, standard budget.",
		precedence: 99,
		match: {},
		result: {
			executionTopology: "single_agent",
			retrievalPolicy: "hybrid",
			budgetClass: "standard",
			providerProfile: DEFAULT_PROVIDER,
			configuredModel: DEFAULT_MODEL,
			thinkingLevel: "high",
			reasonCodes: ["baseline:default"],
		},
	},
];

export interface BaselineResult {
	ruleId: string;
	candidate: OrchestrationCandidate;
	reasonCodes: string[];
	precedence: number;
}

/** Select the deterministic baseline candidate for a feature vector. */
export function baselineSelect(features: OrchestrationFeatureVector): BaselineResult {
	const sorted = [...BASELINE_RULES].sort((a, b) => a.precedence - b.precedence);
	for (const rule of sorted) {
		if (matchesRule(rule, features)) {
			const r = rule.result;
			const candidate: OrchestrationCandidate = {
				candidateId: buildCandidateId(r),
				providerProfile: r.providerProfile,
				configuredModel: r.configuredModel,
				thinkingLevel: r.thinkingLevel,
				executionTopology: r.executionTopology,
				skillIds: [],
				subagentDefinitions:
					r.executionTopology === "single_agent_with_reviewer"
						? ["reviewer"]
						: r.executionTopology === "cavecrew"
							? ["investigator", "planner", "builder", "reviewer"]
							: [],
				retrievalPolicy: r.retrievalPolicy,
				budgetClass: r.budgetClass,
				fallbackPolicy: "validated_policy",
			};
			return { ruleId: rule.ruleId, candidate, reasonCodes: r.reasonCodes, precedence: rule.precedence };
		}
	}
	// Unreachable since baseline-default always matches.
	const fallback = BASELINE_RULES[BASELINE_RULES.length - 1];
	const r = fallback.result;
	return {
		ruleId: fallback.ruleId,
		candidate: {
			candidateId: buildCandidateId(r),
			providerProfile: r.providerProfile,
			configuredModel: r.configuredModel,
			executionTopology: r.executionTopology,
			skillIds: [],
			subagentDefinitions: [],
			retrievalPolicy: r.retrievalPolicy,
			budgetClass: r.budgetClass,
			fallbackPolicy: "validated_policy",
		},
		reasonCodes: r.reasonCodes,
		precedence: fallback.precedence,
	};
}

function matchesRule(rule: BaselineRule, features: OrchestrationFeatureVector): boolean {
	const m = rule.match;
	if (m.taskCategory !== undefined && m.taskCategory !== features.taskCategory) return false;
	if (m.minComplexity !== undefined && features.taskComplexity < m.minComplexity) return false;
	if (m.requiresMutation !== undefined && m.requiresMutation !== features.requiresMutation) return false;
	if (m.requiresRelease !== undefined && m.requiresRelease !== features.requiresRelease) return false;
	if (
		m.requiresCrossPlatformValidation !== undefined &&
		m.requiresCrossPlatformValidation !== features.requiresCrossPlatformValidation
	)
		return false;
	if (m.requiresExternalResearch !== undefined && m.requiresExternalResearch !== features.requiresExternalResearch)
		return false;
	return true;
}

export function buildCandidateId(r: {
	executionTopology: ExecutionTopology;
	retrievalPolicy: string;
	budgetClass: string;
	providerProfile: string;
	configuredModel: string;
}): string {
	return `c-${r.providerProfile.replace(/[^a-z0-9]/gi, "-")}-${r.configuredModel.replace(/[^a-z0-9]/gi, "-")}-${r.executionTopology}-${r.retrievalPolicy}-${r.budgetClass}`;
}
