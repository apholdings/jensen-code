import { describe, expect, it } from "vitest";
import {
	ANALYTICAL_MODEL,
	BUILTIN_SUBAGENT_DEFINITIONS,
	getCanonicalSubagentRegistry,
	resolveSubagentModel,
	validateSkillAgentReferences,
	validateSubagentOutput,
} from "./subagent-registry.js";

describe("canonical subagent registry", () => {
	it("contains all advertised agents in deterministic order", () => {
		const registry = getCanonicalSubagentRegistry();
		expect(registry.validate().valid).toBe(true);
		expect(registry.list().map((agent) => agent.name)).toEqual([
			"cavecrew-builder",
			"cavecrew-investigator",
			"cavecrew-reviewer",
			"librarian",
			"pentester",
			"planner",
			"reviewer",
			"scout",
			"security",
			"worker",
		]);
		expect(BUILTIN_SUBAGENT_DEFINITIONS).toHaveLength(10);
	});

	it("resolves registered aliases only and rejects unknown agents without fallback", () => {
		const registry = getCanonicalSubagentRegistry();
		const alias = registry.resolve("cavecrew-investigate");
		expect("code" in alias).toBe(false);
		const unknown = registry.resolve("cavecrew-investigator-typo");
		expect(unknown).toMatchObject({ code: "SUBAGENT_NOT_REGISTERED", automaticFallbackAttempted: false });
		expect((unknown as { availableAgents: string[] }).availableAgents).toContain("cavecrew-builder");
	});

	it("assigns analytical and worker model policies explicitly", () => {
		const registry = getCanonicalSubagentRegistry();
		for (const name of [
			"librarian",
			"pentester",
			"planner",
			"reviewer",
			"scout",
			"security",
			"cavecrew-investigator",
			"cavecrew-reviewer",
		]) {
			const resolved = registry.resolve(name);
			expect(resolved).toMatchObject({
				model: { configuredProvider: "openrouter", configuredModel: ANALYTICAL_MODEL },
			});
		}
		for (const name of ["worker", "cavecrew-builder"]) {
			const resolved = registry.resolve(name);
			expect(resolved).toMatchObject({
				model: { configuredProvider: "openrouter", configuredModel: "openai/gpt-5.6-luna" },
			});
		}
	});

	it("enforces read-only and builder policy boundaries", () => {
		const registry = getCanonicalSubagentRegistry();
		expect(registry.resolve("cavecrew-investigator")).toMatchObject({
			definition: { executionMode: "observe", deniedEffects: expect.arrayContaining(["writesWorkspace"]) },
		});
		expect(registry.resolve("cavecrew-reviewer")).toMatchObject({
			definition: { executionMode: "observe", deniedEffects: expect.arrayContaining(["writesWorkspace"]) },
		});
		expect(registry.resolve("cavecrew-builder")).toMatchObject({
			definition: {
				recursion: { maximumDepth: 0 },
				concurrency: { maximumInstances: 1 },
				fallbackAgents: ["worker"],
			},
		});
	});

	it("strips a profile marker only at the registry boundary", () => {
		const definition = {
			...BUILTIN_SUBAGENT_DEFINITIONS.find((agent) => agent.name === "scout")!,
			model: `~${ANALYTICAL_MODEL}`,
		};
		const result = resolveSubagentModel(definition);
		expect(result).toMatchObject({
			ok: true,
			value: { resolvedModel: ANALYTICAL_MODEL, resolutionKind: "provider_alias" },
		});
	});

	it("validates skill references before activation", () => {
		expect(
			validateSkillAgentReferences(
				"cavecrew",
				"/skill/cavecrew/SKILL.md",
				"Use cavecrew-investigator, cavecrew-builder, cavecrew-reviewer.",
			),
		).toEqual([]);
		expect(
			validateSkillAgentReferences("broken", "/skill/broken/SKILL.md", "Use cavecrew-investigator-typo."),
		).toMatchObject([{ missingAgent: "cavecrew-investigator-typo" }]);
	});

	it("requires structured output fields", () => {
		expect(
			validateSubagentOutput("cavecrew-review-result-v1", {
				verdict: "pass",
				findings: [],
				missingTests: [],
				acceptanceGaps: [],
			}).valid,
		).toBe(true);
		expect(validateSubagentOutput("cavecrew-review-result-v1", { verdict: "pass" }).valid).toBe(false);
	});

	it("rejects unavailable models and does not substitute a dated model", () => {
		const registry = getCanonicalSubagentRegistry();
		const result = registry.resolve("scout", { availableModels: ["deepseek/deepseek-v4-flash-0731"] });
		expect(result).toMatchObject({ code: "SUBAGENT_MODEL_UNAVAILABLE", automaticFallbackAttempted: false });
	});
});
