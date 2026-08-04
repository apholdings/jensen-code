import { createHash } from "node:crypto";
import { env } from "node:process";
import type {
	EvaluationCandidateIdentity,
	EvaluationEnvironmentIdentity,
	EvaluationScenario,
	JsonValue,
} from "./types.js";

export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, entry]) => entry !== undefined)
		.sort(([left], [right]) => left.localeCompare(right));
	return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
}

export function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

export function hashJson(value: JsonValue | unknown): string {
	return sha256(stableStringify(value));
}

export function scenarioContentHash(scenario: EvaluationScenario): string {
	return hashJson(scenario);
}

export function createEnvironmentIdentity(
	fixtureHash: string,
	overrides?: Partial<EvaluationEnvironmentIdentity>,
): EvaluationEnvironmentIdentity {
	return {
		os: overrides?.os ?? process.platform,
		architecture: overrides?.architecture ?? process.arch,
		nodeVersion: overrides?.nodeVersion ?? process.version,
		packageManager: overrides?.packageManager ?? "npm",
		fixtureHash,
		timezone: overrides?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
		locale: overrides?.locale ?? Intl.DateTimeFormat().resolvedOptions().locale,
		availableTools: overrides?.availableTools ?? ["node", "git"],
		sandboxPolicyVersion: overrides?.sandboxPolicyVersion ?? "1",
		jensenPackageIntegrity: overrides?.jensenPackageIntegrity,
		gitCommit: overrides?.gitCommit,
		providerFixtureVersion: overrides?.providerFixtureVersion,
	};
}

export function createCandidateIdentity(input: Partial<EvaluationCandidateIdentity> = {}): EvaluationCandidateIdentity {
	return {
		jensenVersion: input.jensenVersion ?? "unknown",
		providerProfile: input.providerProfile ?? "fixture",
		provider: input.provider ?? "fixture",
		configuredModel: input.configuredModel ?? "deterministic-fixture",
		resolvedModel: input.resolvedModel,
		thinkingLevel: input.thinkingLevel,
		temperature: input.temperature,
		seed: input.seed,
		systemPromptHash: input.systemPromptHash ?? sha256(""),
		toolSchemaHash: input.toolSchemaHash ?? sha256(""),
		policyHash: input.policyHash ?? sha256(""),
		skillSetHash: input.skillSetHash ?? sha256(""),
		subagentRegistryHash: input.subagentRegistryHash ?? sha256(""),
		retrievalConfigurationHash: input.retrievalConfigurationHash ?? sha256(""),
		runtimeFeatureFlags: input.runtimeFeatureFlags ?? {},
		gitCommit: input.gitCommit,
		packageIntegrity: input.packageIntegrity,
	};
}

export function hasExplicitLiveOptIn(options: {
	mode?: string;
	live?: boolean;
	budget?: { maximumCostUsd?: number };
}): boolean {
	return (
		options.mode === "live" &&
		options.live === true &&
		options.budget?.maximumCostUsd !== undefined &&
		options.budget.maximumCostUsd > 0 &&
		env.JENSEN_EVAL_LIVE === "1"
	);
}
