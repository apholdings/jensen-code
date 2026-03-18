import { MODELS } from "./models.generated.js";
import type { Api, KnownProvider, Model, Usage } from "./types.js";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";

const DEEPSEEK_MODELS = {
	"deepseek-chat": {
		id: "deepseek-chat",
		name: "DeepSeek Chat",
		api: "openai-completions",
		provider: "deepseek",
		baseUrl: DEEPSEEK_BASE_URL,
		reasoning: false,
		input: ["text"],
		cost: {
			input: 0.28,
			output: 0.42,
			cacheRead: 0.028,
			cacheWrite: 0,
		},
		contextWindow: 128000,
		maxTokens: 8000,
	} satisfies Model<"openai-completions">,
	"deepseek-reasoner": {
		id: "deepseek-reasoner",
		name: "DeepSeek Reasoner",
		api: "openai-completions",
		provider: "deepseek",
		baseUrl: DEEPSEEK_BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: {
			input: 0.55,
			output: 2.19,
			cacheRead: 0.14,
			cacheWrite: 0,
		},
		contextWindow: 128000,
		maxTokens: 64000,
	} satisfies Model<"openai-completions">,
} as const;

const ZAI_MODELS = Object.fromEntries(
	Object.entries(MODELS.zai).map(([id, model]) => [
		id,
		{
			...model,
			compat: {
				...(model.compat ?? {}),
				thinkingFormat: "zai",
			},
		} satisfies Model<"openai-completions">,
	]),
) as typeof MODELS.zai;

type ModelCatalog = typeof MODELS & {
	deepseek: typeof DEEPSEEK_MODELS;
};

const ALL_MODELS: ModelCatalog = {
	...MODELS,
	deepseek: DEEPSEEK_MODELS,
	zai: ZAI_MODELS,
};

const modelRegistry: Map<string, Map<string, Model<Api>>> = new Map();

// Initialize registry from MODELS on module load
for (const [provider, models] of Object.entries(ALL_MODELS)) {
	const providerModels = new Map<string, Model<Api>>();
	for (const [id, model] of Object.entries(models)) {
		providerModels.set(id, model as Model<Api>);
	}
	modelRegistry.set(provider, providerModels);
}

type ModelApi<
	TProvider extends KnownProvider,
	TModelId extends keyof ModelCatalog[TProvider],
> = ModelCatalog[TProvider][TModelId] extends { api: infer TApi } ? (TApi extends Api ? TApi : never) : never;

export function getModel<TProvider extends KnownProvider, TModelId extends keyof ModelCatalog[TProvider]>(
	provider: TProvider,
	modelId: TModelId,
): Model<ModelApi<TProvider, TModelId>> {
	const providerModels = modelRegistry.get(provider);
	return providerModels?.get(modelId as string) as Model<ModelApi<TProvider, TModelId>>;
}

export function getProviders(): KnownProvider[] {
	return Array.from(modelRegistry.keys()) as KnownProvider[];
}

export function getModels<TProvider extends KnownProvider>(
	provider: TProvider,
): Model<ModelApi<TProvider, keyof ModelCatalog[TProvider]>>[] {
	const models = modelRegistry.get(provider);
	return models ? (Array.from(models.values()) as Model<ModelApi<TProvider, keyof ModelCatalog[TProvider]>>[]) : [];
}

export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
	usage.cost.input = (model.cost.input / 1000000) * usage.input;
	usage.cost.output = (model.cost.output / 1000000) * usage.output;
	usage.cost.cacheRead = (model.cost.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = (model.cost.cacheWrite / 1000000) * usage.cacheWrite;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

/**
 * Check if a model supports xhigh thinking level.
 *
 * Supported today:
 * - GPT-5.2 / GPT-5.3 / GPT-5.4 model families
 * - Opus 4.6 models (xhigh maps to adaptive effort "max" on Anthropic-compatible providers)
 */
export function supportsXhigh<TApi extends Api>(model: Model<TApi>): boolean {
	if (model.id.includes("gpt-5.2") || model.id.includes("gpt-5.3") || model.id.includes("gpt-5.4")) {
		return true;
	}

	if (model.id.includes("opus-4-6") || model.id.includes("opus-4.6")) {
		return true;
	}

	return false;
}

/**
 * Check if two models are equal by comparing both their id and provider.
 * Returns false if either model is null or undefined.
 */
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
