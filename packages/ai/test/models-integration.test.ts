import { describe, expect, it } from "vitest";
import { MODELS } from "../src/models.generated.js";
import { getModel, getModels, getProviders } from "../src/models.js";

/** OpenRouter models that were discovered during the 2.0.1 catalog refresh. */
const NEW_OPENROUTER_MODELS = [
	"x-ai/grok-4.6",
	"qwen/qwen3.8-max",
	"thinkingmachines/inkling-small",
	"sakana/sakana-namazu",
	"upstage/solar-pro4",
	"~deepseek/deepseek-v4-flash-latest",
] as const;

/** Generic OpenRouter router/special entries that must survive generation. */
const GENERIC_OPENROUTER_ENTRIES = ["openrouter/auto", "openrouter/auto-beta", "openrouter/free"] as const;

describe("generated model catalog integrity", () => {
	it("has unique model IDs per provider (no duplicates within a provider)", () => {
		for (const [_provider, models] of Object.entries(MODELS)) {
			const ids = Object.keys(models);
			expect(new Set(ids).size).toBe(ids.length);
			for (const id of ids) {
				expect(id.trim().length).toBeGreaterThan(0);
			}
		}
	});

	it("has no empty or malformed OpenRouter model IDs", () => {
		const openrouterModels = MODELS.openrouter;
		for (const id of Object.keys(openrouterModels)) {
			expect(id).toMatch(/^[^\s/]+(\/[^\s/]+)+|^[\w-]+$/);
			expect(id.trim()).toBe(id);
		}
	});

	it("exports an openrouter provider section", () => {
		const provider = getModel("openrouter", "openrouter/auto");
		expect(provider).toBeDefined();
		expect(provider.baseUrl).toContain("openrouter.ai");
	});

	it("keeps generic OpenRouter router entries", () => {
		for (const id of GENERIC_OPENROUTER_ENTRIES) {
			const model = getModel("openrouter", id);
			expect(model, `expected ${id} in openrouter catalog`).toBeDefined();
		}
	});
});

describe("newly discovered OpenRouter models resolve through the provider", () => {
	for (const id of NEW_OPENROUTER_MODELS) {
		it(`resolves ${id}`, () => {
			const model = getModel("openrouter", id);
			expect(model).toBeDefined();
			expect(model.id).toBe(id);
			expect(model.api).toBe("openai-completions");
			expect(model.provider).toBe("openrouter");
			expect(model.baseUrl).toContain("openrouter.ai");
			expect(model.contextWindow).toBeGreaterThan(0);
		});
	}

	it("all openrouter models route to the openai-completions (OpenRouter) provider", () => {
		for (const model of getModels("openrouter")) {
			expect(model.api).toBe("openai-completions");
			expect(model.provider).toBe("openrouter");
		}
	});

	it("lists openrouter in the providers", () => {
		expect(getProviders()).toContain("openrouter");
	});
});
