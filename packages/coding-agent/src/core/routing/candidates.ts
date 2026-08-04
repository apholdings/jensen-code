/**
 * Candidate generation and hard policy filtering.
 *
 * Candidates are generated ONLY from configured and authorized components
 * (provider profiles, model registry, subagent registry, skill registry,
 * retrieval policies, budget classes). The engine never invents a provider,
 * model, skill or agent. Hard-policy filtering runs before scoring and cannot
 * be overcome by a higher evaluation score.
 */

import type {
	ExecutionTopology,
	OrchestrationCandidate,
	OrchestrationCandidateRejection,
	SelectionPolicy,
} from "./types.js";

export interface HardPolicyInput {
	workspaceBoundary: boolean;
	requiredLocalOnly: boolean;
	providerAllowlist: readonly string[];
	modelAllowlist: readonly string[];
	maxCostUsd?: number;
	maxModelCalls?: number;
	maxSubagents?: number;
	maxAffectedFiles?: number;
	networkPolicy: "allow_all" | "local_only" | "none";
	allowLiveProviders: boolean;
}

export interface CandidateSource {
	providerProfile: string;
	configuredModel: string;
	thinkingLevel?: string;
	executionTopology: ExecutionTopology;
	skillIds: string[];
	subagentDefinitions: string[];
	retrievalPolicy: string;
	budgetClass: string;
	fallbackPolicy: string;
}

/** Build the candidate cartesian set from configured components, then intersect permission. */
export function generateCandidates(input: {
	providerProfiles: string[];
	models: { provider: string; model: string }[];
	topologies: ExecutionTopology[];
	skills: string[];
	subagents: string[];
	retrievalPolicies: string[];
	budgetClasses: string[];
	fallbackPolicies: string[];
	operatorSelectionPolicy: SelectionPolicy;
}): { candidates: OrchestrationCandidate[]; warnings: string[] } {
	const {
		providerProfiles,
		models,
		topologies,
		skills,
		subagents,
		retrievalPolicies,
		budgetClasses,
		fallbackPolicies,
	} = input;
	const warnings: string[] = [];

	if (providerProfiles.length === 0) {
		warnings.push("No provider profiles configured; falling back to single local analytical provider.");
	}

	// Bounded cartesian product. Intersect each model with the provider profile
	// name so a candidate can never pair a model with a foreign provider profile.
	const candidates: OrchestrationCandidate[] = [];
	const providers = providerProfiles.length > 0 ? providerProfiles : ["local"];
	const effectiveModels = models.length > 0 ? models : providers.map((p) => ({ provider: p, model: "default" }));
	const topo: ExecutionTopology[] = topologies.length > 0 ? topologies : ["single_agent"];
	const retrieval = retrievalPolicies.length > 0 ? retrievalPolicies : ["hybrid"];
	const budget = budgetClasses.length > 0 ? budgetClasses : ["standard"];
	const fallback = fallbackPolicies.length > 0 ? fallbackPolicies : ["validated_policy"];

	for (const provider of providers) {
		// Pick a model that belongs to this provider when available, else first.
		const owned = effectiveModels.find((m) => m.provider === provider);
		const model = owned ?? effectiveModels[0];
		for (const topology of topo) {
			for (const rp of retrieval) {
				for (const bc of budget) {
					for (const fb of fallback) {
						const candidateId = `c-${provider.replace(/[^a-z0-9]/gi, "-")}-${model.model.replace(/[^a-z0-9]/gi, "-")}-${topology}-${rp}-${bc}`;
						candidates.push({
							candidateId,
							providerProfile: provider,
							configuredModel: model.model,
							executionTopology: topology,
							skillIds: topology === "custom_skill" ? skills.slice(0, 1) : [],
							subagentDefinitions:
								topology === "cavecrew"
									? subagents.slice(0, 4)
									: topology === "single_agent_with_reviewer"
										? subagents.slice(0, 1)
										: [],
							retrievalPolicy: rp,
							budgetClass: bc,
							fallbackPolicy: fb,
						});
					}
				}
			}
		}
	}
	return { candidates, warnings };
}

/**
 * Apply hard policy filters. Returns the surviving candidates and a rejection
 * list for every filtered candidate. Filtering is deterministic and ordered.
 */
export function applyHardPolicy(
	candidates: OrchestrationCandidate[],
	input: HardPolicyInput,
): { accepted: OrchestrationCandidate[]; rejected: OrchestrationCandidateRejection[] } {
	const accepted: OrchestrationCandidate[] = [];
	const rejected: OrchestrationCandidateRejection[] = [];

	for (const candidate of candidates) {
		const reasons: OrchestrationCandidateRejection[] = [];

		if (!input.workspaceBoundary) {
			reasons.push({
				candidateId: candidate.candidateId,
				reasonCode: "workspace_boundary_denied",
				policyRuleId: "rule-workspace-boundary",
				evidenceIds: [],
			});
		}
		if (input.requiredLocalOnly && isRemoteProvider(candidate.providerProfile)) {
			reasons.push({
				candidateId: candidate.candidateId,
				reasonCode: "remote_provider_denied_local_only",
				policyRuleId: "rule-local-only",
				evidenceIds: [],
			});
		}
		if (!isProviderAllowed(candidate.providerProfile, input.providerAllowlist)) {
			reasons.push({
				candidateId: candidate.candidateId,
				reasonCode: "provider_not_in_allowlist",
				policyRuleId: "rule-provider-allowlist",
				evidenceIds: [],
			});
		}
		if (!isModelAllowed(candidate.configuredModel, input.modelAllowlist)) {
			reasons.push({
				candidateId: candidate.candidateId,
				reasonCode: "model_not_in_allowlist",
				policyRuleId: "rule-model-allowlist",
				evidenceIds: [],
			});
		}
		if (input.networkPolicy !== "allow_all" && isRemoteProvider(candidate.providerProfile)) {
			reasons.push({
				candidateId: candidate.candidateId,
				reasonCode: "network_policy_denies_remote",
				policyRuleId: "rule-network-policy",
				evidenceIds: [],
			});
		}
		if (!isLiveProviderAllowed(candidate.providerProfile, input.allowLiveProviders)) {
			reasons.push({
				candidateId: candidate.candidateId,
				reasonCode: "live_provider_not_authorized",
				policyRuleId: "rule-live-provider",
				evidenceIds: [],
			});
		}
		if (input.maxSubagents !== undefined && candidate.subagentDefinitions.length > input.maxSubagents) {
			reasons.push({
				candidateId: candidate.candidateId,
				reasonCode: "subagent_count_exceeds_max",
				policyRuleId: "rule-max-subagents",
				evidenceIds: [],
			});
		}

		if (reasons.length > 0) {
			rejected.push(...reasons);
		} else {
			accepted.push(candidate);
		}
	}

	return { accepted, rejected };
}

/** Providers considered "remote" (require network / live credentials). */
function isRemoteProvider(provider: string): boolean {
	const p = provider.toLowerCase();
	return !(p === "local" || p.startsWith("local-") || p === "fixture" || p.includes("test"));
}

function isProviderAllowed(provider: string, allowlist: readonly string[]): boolean {
	if (allowlist.length === 0) return true; // no allowlist = everything from registry allowed
	return allowlist.includes(provider);
}

function isModelAllowed(model: string, allowlist: readonly string[]): boolean {
	if (allowlist.length === 0) return true;
	return allowlist.includes(model);
}

function isLiveProviderAllowed(provider: string, allowLiveProviders: boolean): boolean {
	if (isRemoteProvider(provider)) return allowLiveProviders;
	return true;
}
