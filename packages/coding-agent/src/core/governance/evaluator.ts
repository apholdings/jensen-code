import type {
	GovernanceBudget,
	GovernanceContext,
	GovernanceDecision,
	GovernanceModelMode,
	GovernanceModelResolution,
	GovernancePolicy,
	GovernanceStatus,
} from "./types.js";

const CAP_FIELDS: readonly (keyof GovernanceBudget)[] = [
	"maxTurns",
	"maxContextTokens",
	"maxGeneratedTokens",
	"maxToolCalls",
	"maxRetries",
	"maxWallClockMs",
	"maxInferenceRequests",
	"maxChildren",
	"maxLogicalAgents",
	"maxTotalRetries",
	"maxReplans",
	"maxFanOut",
	"maxDepth",
	"maxReadyChildren",
	"maxCloudSpendUsd",
	"maxModelEscalations",
];
export const DEFAULT_GOVERNANCE_POLICY: GovernancePolicy = Object.freeze({
	schemaVersion: 1,
	cloudAllowed: true,
	modelMode: "local_default",
	localModel: { provider: "llamacpp-qwen38-bucephalus", model: "qwen3.8-27b" },
	softWallClockRatio: 0.8,
	stagnation: { maxNoProgressTurns: 60, maxRepeatedFailure: 3, maxOutputContractRetries: 2 },
	retryCaps: { tool: 3, output_contract: 2, execution: 2, planner: 2, replan: 2, remote_execution: 2, provider: 2 },
});
function finite(value: number | undefined): number | undefined {
	return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}
export function effectiveBudget(policy: GovernancePolicy): GovernanceBudget {
	const result: GovernanceBudget = {};
	for (const field of CAP_FIELDS) {
		const values = [policy.operator, policy.mission, policy.orchestration, policy.child]
			.map((layer) => finite(layer?.[field]))
			.filter((v): v is number => v !== undefined);
		if (values.length) result[field] = Math.min(...values);
	}
	return result;
}
function usageFor(ctx: GovernanceContext, field: keyof GovernanceBudget): number | undefined {
	const map: Record<string, number> = {
		maxTurns: ctx.usage.turns,
		maxContextTokens: ctx.usage.contextTokens,
		maxGeneratedTokens: ctx.usage.generatedTokens,
		maxToolCalls: ctx.usage.toolCalls,
		maxRetries: ctx.usage.retries,
		maxWallClockMs: ctx.usage.wallClockMs,
		maxInferenceRequests: ctx.usage.inferenceRequests,
		maxChildren: ctx.usage.children,
		maxLogicalAgents: ctx.usage.logicalAgents,
		maxTotalRetries: ctx.usage.totalRetries,
		maxReplans: ctx.usage.replans,
		maxFanOut: ctx.usage.fanOut,
		maxDepth: ctx.usage.depth,
		maxReadyChildren: ctx.usage.readyChildren,
		maxCloudSpendUsd: ctx.cost.knownUsd,
		maxModelEscalations: ctx.usage.modelEscalations,
	};
	return map[field];
}
function statusFor(ctx: GovernanceContext, policy: GovernancePolicy): GovernanceStatus {
	const budget = effectiveBudget(policy);
	for (const field of CAP_FIELDS) {
		const limit = budget[field];
		const used = usageFor(ctx, field);
		if (limit !== undefined && used !== undefined && used >= limit) return "LIMIT_REACHED";
	}
	const wall = budget.maxWallClockMs;
	return wall !== undefined &&
		ctx.wallClockNowMs - ctx.wallClockStartedAtMs >= wall * (policy.softWallClockRatio ?? 0.8)
		? "NEAR_LIMIT"
		: "NORMAL";
}
function evidence(ctx: GovernanceContext, code: string) {
	return {
		code,
		observed: {
			elapsedMs: ctx.wallClockNowMs - ctx.wallClockStartedAtMs,
			progressAgeMs:
				ctx.progress?.lastProgressAtMs === undefined
					? undefined
					: ctx.wallClockNowMs - ctx.progress.lastProgressAtMs,
			retryCount: ctx.usage.retries,
			provider: ctx.provider,
			model: ctx.model,
		},
	};
}
function makeDecision(
	ctx: GovernanceContext,
	status: GovernanceStatus,
	action: GovernanceDecision["action"],
	reason: string,
	to?: { provider: string; model: string },
): GovernanceDecision {
	return {
		action,
		status,
		reason,
		evidence: [evidence(ctx, reason)],
		from: { provider: ctx.provider, model: ctx.model },
		to,
		preserveIdentity: true,
		atMs: ctx.wallClockNowMs,
	};
}

/** Pure policy evaluation. It cannot launch, assign, acquire, or commit work. */
export function evaluateGovernance(ctx: GovernanceContext, policy: GovernancePolicy): GovernanceDecision {
	const budget = effectiveBudget(policy);
	const status = statusFor(ctx, policy);
	if (ctx.resourceWait) return makeDecision(ctx, status, "PARK", "RESOURCE_WAIT");
	if (ctx.dependencyBlocked) return makeDecision(ctx, status, "PARK", "BLOCKED_DEPENDENCY");
	if (ctx.outputContractMissing) {
		const cap = policy.stagnation?.maxOutputContractRetries ?? policy.retryCaps?.output_contract ?? 0;
		return ctx.retries.output_contract < cap
			? makeDecision(ctx, status, "RETRY_OUTPUT_CONTRACT", "MISSING_RESULT_ENVELOPE")
			: makeDecision(ctx, "LIMIT_REACHED", "TERMINATE_CHILD", "OUTPUT_CONTRACT_RETRY_LIMIT");
	}
	if (
		ctx.requestedChildren !== undefined &&
		budget.maxFanOut !== undefined &&
		ctx.requestedChildren > budget.maxFanOut
	)
		return makeDecision(ctx, "LIMIT_REACHED", "REQUEST_REPLAN", "FANOUT_HARD_LIMIT");
	if (budget.maxDepth !== undefined && (ctx.orchestrationDepth ?? ctx.usage.depth) > budget.maxDepth)
		return makeDecision(ctx, "LIMIT_REACHED", "DENY_NEW_CHILD", "ORCHESTRATION_DEPTH_HARD_LIMIT");
	const elapsed = ctx.wallClockNowMs - ctx.wallClockStartedAtMs;
	if (budget.maxWallClockMs !== undefined && elapsed >= budget.maxWallClockMs)
		return makeDecision(ctx, "LIMIT_REACHED", "TERMINATE_MISSION", "WALL_CLOCK_HARD_LIMIT");
	if (ctx.isPaidInference && !policy.cloudAllowed)
		return makeDecision(ctx, status, "DENY_INFERENCE", "CLOUD_PROHIBITED");
	if (ctx.isPaidInference && budget.maxCloudSpendUsd !== undefined && ctx.cost.unknownPaidEvents > 0)
		return makeDecision(ctx, "UNKNOWN", "DENY_INFERENCE", "UNKNOWN_CLOUD_COST");
	if (ctx.isPaidInference && budget.maxCloudSpendUsd !== undefined && ctx.cost.knownUsd >= budget.maxCloudSpendUsd)
		return makeDecision(ctx, "LIMIT_REACHED", "DENY_INFERENCE", "CLOUD_COST_HARD_LIMIT");
	const stagnant =
		ctx.progress?.state === "STAGNATING" ||
		(ctx.progress !== undefined &&
			ctx.progress.noProgressTurns >= (policy.stagnation?.maxNoProgressTurns ?? Number.MAX_SAFE_INTEGER)) ||
		(ctx.progress !== undefined &&
			ctx.progress.repeatedFailureCount >= (policy.stagnation?.maxRepeatedFailure ?? Number.MAX_SAFE_INTEGER));
	const nearWall =
		budget.maxWallClockMs !== undefined && elapsed >= budget.maxWallClockMs * (policy.softWallClockRatio ?? 0.8);
	if (
		(stagnant || nearWall) &&
		ctx.provider === policy.localModel.provider &&
		ctx.model === policy.localModel.model &&
		policy.cloudEscalation
	) {
		if (!policy.cloudAllowed) return makeDecision(ctx, status, "REQUEST_REPLAN", "CLOUD_ESCALATION_BLOCKED");
		if (budget.maxModelEscalations !== undefined && ctx.usage.modelEscalations >= budget.maxModelEscalations)
			return makeDecision(ctx, "LIMIT_REACHED", "TERMINATE_CHILD", "MODEL_ESCALATION_LIMIT");
		return makeDecision(
			ctx,
			"NEAR_LIMIT",
			"ESCALATE_MODEL",
			stagnant ? "STAGNATION" : "WALL_CLOCK_SOFT_LIMIT",
			policy.cloudEscalation,
		);
	}
	for (const field of CAP_FIELDS) {
		const limit = budget[field];
		const used = usageFor(ctx, field);
		if (limit !== undefined && used !== undefined && used >= limit)
			return makeDecision(
				ctx,
				"LIMIT_REACHED",
				field === "maxChildren" || field === "maxFanOut" || field === "maxDepth"
					? "DENY_NEW_CHILD"
					: "TERMINATE_CHILD",
				`${field.toUpperCase()}_HARD_LIMIT`,
			);
	}
	return makeDecision(ctx, status, "CONTINUE", status === "NEAR_LIMIT" ? "SOFT_LIMIT_APPROACHING" : "WITHIN_POLICY");
}
export function resolveGovernanceModel(
	policy: GovernancePolicy,
	requested?: { provider: string; model: string },
): GovernanceModelResolution {
	if (policy.modelMode === "fixed")
		return {
			mode: "fixed",
			selected: policy.fixedModel ?? policy.localModel,
			fallbackChain: [],
			reason: "FIXED_POLICY",
		};
	if (policy.modelMode === "cloud_prohibited")
		return { mode: "cloud_prohibited", selected: policy.localModel, fallbackChain: [], reason: "LOCAL_ONLY" };
	if (!policy.cloudAllowed)
		return { mode: "cloud_prohibited", selected: policy.localModel, fallbackChain: [], reason: "LOCAL_ONLY" };
	if (policy.modelMode === "cloud_preferred" && policy.cloudEscalation)
		return {
			mode: "cloud_preferred",
			selected: policy.cloudEscalation,
			fallbackChain: [policy.localModel],
			reason: "CLOUD_PREFERRED",
		};
	return {
		mode: policy.modelMode,
		selected: requested ?? policy.localModel,
		fallbackChain: policy.fallbackChain ?? (policy.cloudEscalation ? [policy.cloudEscalation] : []),
		reason: requested ? "REQUESTED_WITHIN_DEFAULT_POLICY" : "LOCAL_DEFAULT",
	};
}
export function governancePolicyFromEnv(env: NodeJS.ProcessEnv = process.env): GovernancePolicy {
	const parse = (key: string): number | undefined => {
		const value = env[key];
		if (value === undefined || value.trim() === "") return undefined;
		const n = Number(value);
		return Number.isFinite(n) && n >= 0 ? n : undefined;
	};
	const cloudProvider = env.JENSEN_GOVERNANCE_CLOUD_PROVIDER;
	const cloudModel = env.JENSEN_GOVERNANCE_CLOUD_MODEL;
	return {
		...DEFAULT_GOVERNANCE_POLICY,
		cloudAllowed: env.JENSEN_GOVERNANCE_CLOUD_ALLOWED !== "0",
		modelMode:
			(env.JENSEN_GOVERNANCE_MODEL_MODE as GovernanceModelMode | undefined) ?? DEFAULT_GOVERNANCE_POLICY.modelMode,
		localModel: {
			provider: env.JENSEN_GOVERNANCE_LOCAL_PROVIDER ?? DEFAULT_GOVERNANCE_POLICY.localModel.provider,
			model: env.JENSEN_GOVERNANCE_LOCAL_MODEL ?? DEFAULT_GOVERNANCE_POLICY.localModel.model,
		},
		cloudEscalation: cloudProvider && cloudModel ? { provider: cloudProvider, model: cloudModel } : undefined,
		operator: {
			maxCloudSpendUsd: parse("JENSEN_GOVERNANCE_MAX_CLOUD_SPEND_USD"),
			maxWallClockMs: parse("JENSEN_GOVERNANCE_MAX_WALL_CLOCK_MS"),
			maxChildren: parse("JENSEN_GOVERNANCE_MAX_CHILDREN"),
			maxDepth: parse("JENSEN_GOVERNANCE_MAX_DEPTH"),
			maxRetries: parse("JENSEN_GOVERNANCE_MAX_RETRIES"),
			maxReplans: parse("JENSEN_GOVERNANCE_MAX_REPLANS"),
		},
	};
}
