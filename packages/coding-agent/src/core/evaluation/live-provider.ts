import { randomUUID } from "node:crypto";
import type { EvaluationExecutionResult, EvaluationExecutor } from "./runner.js";
import type { EvaluationBudget, EvaluationEvent } from "./types.js";

export interface EvaluationProviderProfile {
	profileId: string;
	provider: string;
	configuredModel: string;
	resolvedModel: string;
	baseUrl: string;
	apiKeyEnv: string;
	apiKey?: string;
}

export interface EvaluationProviderUsage {
	inputTokens: number;
	outputTokens: number;
	modelCalls: number;
	estimatedCostUsd?: number;
	providerReportedCostUsd?: number;
}

export interface EvaluationProviderResponse {
	text: string;
	usage: EvaluationProviderUsage;
}

export interface EvaluationProviderClient {
	complete(input: { prompt: string; model: string; signal?: AbortSignal }): Promise<EvaluationProviderResponse>;
}

export class EvaluationProviderError extends Error {
	readonly code:
		| "PREFLIGHT_FAILED"
		| "AUTH_FAILED"
		| "RATE_LIMITED"
		| "BUDGET_EXCEEDED"
		| "PROVIDER_FAILED"
		| "CANCELLED";
	readonly provider: string;
	constructor(code: EvaluationProviderError["code"], provider: string, message: string) {
		super(message);
		this.name = "EvaluationProviderError";
		this.code = code;
		this.provider = provider;
	}
}

export function resolveProviderProfile(input: {
	profileId: string;
	configuredModel: string;
	resolvedModel?: string;
	provider?: string;
}): EvaluationProviderProfile {
	const profileId = input.profileId.trim();
	if (!profileId) throw new EvaluationProviderError("PREFLIGHT_FAILED", "unknown", "provider profile is required");
	const provider = input.provider ?? (profileId === "openrouter" ? "openrouter" : profileId);
	const defaults: Record<string, { baseUrl: string; apiKeyEnv: string }> = {
		openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" },
		openai: { baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" },
		anthropic: { baseUrl: "https://api.anthropic.com/v1", apiKeyEnv: "ANTHROPIC_API_KEY" },
	};
	const defaultProfile = defaults[provider];
	if (!defaultProfile)
		throw new EvaluationProviderError("PREFLIGHT_FAILED", provider, `unsupported provider profile: ${profileId}`);
	const apiKey = process.env[defaultProfile.apiKeyEnv];
	return {
		profileId,
		provider,
		configuredModel: input.configuredModel,
		resolvedModel: input.resolvedModel ?? input.configuredModel,
		baseUrl: process.env.JENSEN_EVAL_PROVIDER_BASE_URL ?? defaultProfile.baseUrl,
		apiKeyEnv: defaultProfile.apiKeyEnv,
		apiKey,
	};
}

export function preflightLiveEvaluation(input: {
	profile: EvaluationProviderProfile;
	budget?: EvaluationBudget;
	confirmed: boolean;
}): void {
	if (!input.confirmed)
		throw new EvaluationProviderError(
			"PREFLIGHT_FAILED",
			input.profile.provider,
			"live evaluation requires explicit confirmation",
		);
	if (!input.profile.apiKey)
		throw new EvaluationProviderError(
			"PREFLIGHT_FAILED",
			input.profile.provider,
			`credential ${input.profile.apiKeyEnv} is unavailable`,
		);
	if (!input.profile.resolvedModel)
		throw new EvaluationProviderError(
			"PREFLIGHT_FAILED",
			input.profile.provider,
			"resolved model identity is required",
		);
	if (!input.budget?.maximumCostUsd || input.budget.maximumCostUsd <= 0)
		throw new EvaluationProviderError(
			"PREFLIGHT_FAILED",
			input.profile.provider,
			"a positive maximum cost is required",
		);
	if (!input.budget.maximumModelCalls || input.budget.maximumModelCalls < 1)
		throw new EvaluationProviderError("PREFLIGHT_FAILED", input.profile.provider, "maximum model calls is required");
	if (!input.budget.maximumWallTimeMs || input.budget.maximumWallTimeMs < 1)
		throw new EvaluationProviderError("PREFLIGHT_FAILED", input.profile.provider, "maximum wall time is required");
}

function estimateCost(provider: string, usage: { inputTokens: number; outputTokens: number }): number {
	const rate = provider === "openrouter" ? 0.00001 : 0.00002;
	return (usage.inputTokens + usage.outputTokens) * rate;
}

export function createOpenAiCompatibleProvider(profile: EvaluationProviderProfile): EvaluationProviderClient {
	return {
		async complete(input) {
			if (!profile.apiKey)
				throw new EvaluationProviderError("AUTH_FAILED", profile.provider, "provider credential is unavailable");
			const response = await fetch(`${profile.baseUrl.replace(/\/$/, "")}/chat/completions`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${profile.apiKey}`,
					"Content-Type": "application/json",
					...(profile.provider === "openrouter"
						? { "HTTP-Referer": "https://github.com/apholdings/jensen-code" }
						: {}),
				},
				body: JSON.stringify({ model: input.model, messages: [{ role: "user", content: input.prompt }] }),
				signal: input.signal,
			});
			if (!response.ok) {
				const code =
					response.status === 401 || response.status === 403
						? "AUTH_FAILED"
						: response.status === 429
							? "RATE_LIMITED"
							: "PROVIDER_FAILED";
				throw new EvaluationProviderError(
					code,
					profile.provider,
					`provider request failed with HTTP ${response.status}`,
				);
			}
			const payload = (await response.json()) as {
				choices?: Array<{ message?: { content?: string } }>;
				usage?: { prompt_tokens?: number; completion_tokens?: number };
			};
			const inputTokens = payload.usage?.prompt_tokens ?? 0;
			const outputTokens = payload.usage?.completion_tokens ?? 0;
			return {
				text: payload.choices?.[0]?.message?.content ?? "",
				usage: {
					inputTokens,
					outputTokens,
					modelCalls: 1,
					estimatedCostUsd: estimateCost(profile.provider, { inputTokens, outputTokens }),
				},
			};
		},
	};
}

export function createDeterministicProvider(): EvaluationProviderClient {
	return {
		async complete(input) {
			const inputTokens = input.prompt.length;
			return {
				text: `deterministic evaluation response for ${input.model}`,
				usage: { inputTokens, outputTokens: 8, modelCalls: 1, estimatedCostUsd: 0 },
			};
		},
	};
}

export function createLiveProviderExecutor(
	profile: EvaluationProviderProfile,
	client: EvaluationProviderClient,
	budget: EvaluationBudget,
	signal?: AbortSignal,
): EvaluationExecutor {
	return {
		async execute(input): Promise<EvaluationExecutionResult> {
			const started = Date.now();
			const events: EvaluationEvent[] = [];
			let totalCost = 0;
			let modelCalls = 0;
			const response = await client.complete({
				prompt: input.scenario.task.prompt,
				model: profile.resolvedModel,
				signal,
			});
			modelCalls += response.usage.modelCalls;
			totalCost += response.usage.providerReportedCostUsd ?? response.usage.estimatedCostUsd ?? 0;
			if (budget.maximumModelCalls !== undefined && modelCalls > budget.maximumModelCalls)
				throw new EvaluationProviderError("BUDGET_EXCEEDED", profile.provider, "maximum model calls exceeded");
			if (budget.maximumCostUsd !== undefined && totalCost > budget.maximumCostUsd)
				throw new EvaluationProviderError("BUDGET_EXCEEDED", profile.provider, "maximum evaluation cost exceeded");
			if (budget.maximumWallTimeMs !== undefined && Date.now() - started > budget.maximumWallTimeMs)
				throw new EvaluationProviderError(
					"BUDGET_EXCEEDED",
					profile.provider,
					"maximum evaluation wall time exceeded",
				);
			events.push({
				eventId: randomUUID(),
				type: "provider.response",
				timestamp: new Date().toISOString(),
				details: {
					provider: profile.provider,
					configuredModel: profile.configuredModel,
					resolvedModel: profile.resolvedModel,
					modelCalls,
					estimatedCostUsd: response.usage.estimatedCostUsd ?? 0,
					providerReportedCostUsd: response.usage.providerReportedCostUsd ?? 0,
					responseBytes: Buffer.byteLength(response.text),
				},
			});
			return {
				events,
				semanticResults: [],
				workspaceRoot: input.workspaceRoot,
				usage: response.usage,
			};
		},
	};
}
