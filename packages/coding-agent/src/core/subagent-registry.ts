/**
 * Canonical subagent registry and policy boundary.
 *
 * Agent Markdown files are user-facing configuration. They are not the
 * authority for role, model, tools, effects, budgets, or output contracts.
 * The registry is rebuilt from immutable definitions on every load; callers
 * may cache diagnostics, but a cache can never create authority.
 */

export const ANALYTICAL_PROVIDER = "openrouter" as const;
export const ANALYTICAL_MODEL = "deepseek/deepseek-v4-flash-latest" as const;
export const WORKER_PROVIDER = "openrouter" as const;
export const WORKER_MODEL = "openai/gpt-5.6-luna" as const;

export type SubagentRole =
	| "exploration"
	| "investigation"
	| "planning"
	| "implementation"
	| "review"
	| "security"
	| "research"
	| "testing";
export type SubagentExecutionMode = "observe" | "plan" | "execute";
export type ModelResolutionPolicy = "strict" | "configured_fallback";

export interface SubagentBudget {
	maxModelTurns?: number;
	maxToolCalls?: number;
	maxWallTimeMs?: number;
	maxInputTokens?: number;
	maxOutputTokens?: number;
	maxCostUsd?: number;
}

export interface SubagentDefinition {
	name: string;
	aliases: string[];
	version: number;
	description: string;
	role: SubagentRole;
	provider: string;
	model: string;
	modelResolutionPolicy: ModelResolutionPolicy;
	executionMode: SubagentExecutionMode;
	allowedTools: string[];
	deniedTools: string[];
	deniedEffects: string[];
	requiredCapabilities: string[];
	budget: SubagentBudget;
	concurrency: { parallelSafe: boolean; maximumInstances: number };
	recursion: { maySpawnSubagents: boolean; maximumDepth: number };
	inputSchema: string;
	outputSchema: string;
	fallbackAgents: string[];
	resultCompression?: { enabled: boolean; maximumCharacters?: number };
}

export interface SubagentModelResolution {
	agent: string;
	configuredProvider: string;
	configuredModel: string;
	resolvedProvider: string;
	resolvedModel: string;
	resolutionKind: "exact" | "provider_alias" | "configured_fallback";
	reasonCode: string;
	recordedAt: string;
}

export type SubagentResolutionErrorCode =
	| "SUBAGENT_NOT_REGISTERED"
	| "SUBAGENT_ALIAS_AMBIGUOUS"
	| "SUBAGENT_DISABLED"
	| "SUBAGENT_MODEL_UNAVAILABLE"
	| "SUBAGENT_PERMISSION_CONFLICT"
	| "SUBAGENT_OUTPUT_SCHEMA_INVALID";

export interface SubagentResolutionError {
	code: SubagentResolutionErrorCode;
	requestedAgent: string;
	referencingSkill?: string;
	availableAgents: string[];
	compatibleAgents?: string[];
	automaticFallbackAttempted: false;
}

export interface RegistryDiagnostic {
	code: string;
	message: string;
	agent?: string;
	path?: string;
}

export interface SkillDependencyDiagnostic {
	code: "SKILL_DEPENDENCY_INVALID";
	skillName: string;
	skillSource: string;
	missingAgent?: string;
	invalidFallback?: string;
	invalidModel?: string;
	permissionConflict?: string;
	schemaError?: string;
	recommendedRemediation: string;
}

export interface ResolvedSubagent {
	definition: SubagentDefinition;
	model: SubagentModelResolution;
}

const OBSERVE_TOOLS = ["read", "grep", "find", "ls", "bash"];
const BUILDER_TOOLS = ["read", "grep", "find", "ls", "edit", "write", "bash"];
const WORKER_TOOLS = ["read", "grep", "find", "ls", "edit", "write", "bash", "powershell"];
const OBSERVE_EFFECTS = ["writesWorkspace", "mutatesGit", "publishes", "terminatesProcesses", "spawnsSubagents"];
const PLAN_EFFECTS = ["writesWorkspace", "mutatesGit", "publishes", "terminatesProcesses", "spawnsSubagents"];
const EXECUTE_EFFECTS = ["publishes", "mutatesReleaseTags", "merges", "spawnsSubagents"];

function analytical(
	name: string,
	description: string,
	role: SubagentRole,
	outputSchema: string,
	options: Partial<SubagentDefinition> = {},
): SubagentDefinition {
	return {
		name,
		aliases: [],
		version: 1,
		description,
		role,
		provider: ANALYTICAL_PROVIDER,
		model: ANALYTICAL_MODEL,
		modelResolutionPolicy: "strict",
		executionMode: "observe",
		allowedTools: OBSERVE_TOOLS,
		deniedTools: ["edit", "write", "publish", "merge"],
		deniedEffects: OBSERVE_EFFECTS,
		requiredCapabilities: [],
		budget: { maxModelTurns: 8, maxToolCalls: 32, maxWallTimeMs: 120_000, maxOutputTokens: 4_000 },
		concurrency: { parallelSafe: true, maximumInstances: 2 },
		recursion: { maySpawnSubagents: false, maximumDepth: 0 },
		inputSchema: "subagent-context-packet-v1",
		outputSchema,
		fallbackAgents: [],
		resultCompression: { enabled: true, maximumCharacters: 8_000 },
		...options,
	};
}

export const BUILTIN_SUBAGENT_DEFINITIONS: readonly SubagentDefinition[] = [
	analytical("librarian", "Find documented, historical, and release facts.", "research", "librarian-result-v1"),
	analytical(
		"pentester",
		"Run bounded authorized adversarial tests against existing defenses.",
		"testing",
		"pentest-result-v1",
	),
	analytical("planner", "Turn evidence into a bounded implementation plan.", "planning", "planner-result-v1", {
		executionMode: "plan",
	}),
	analytical(
		"reviewer",
		"Perform a broad read-only review against objective and acceptance criteria.",
		"review",
		"review-result-v1",
	),
	analytical(
		"scout",
		"Perform fast, shallow repository orientation and locate probable symbols.",
		"exploration",
		"scout-result-v1",
	),
	analytical(
		"security",
		"Review trust boundaries, authorization, secrets, and unsafe defaults.",
		"security",
		"security-result-v1",
	),
	{
		name: "worker",
		aliases: [],
		version: 1,
		description: "Implement one authorized bounded task using policy, transactions, checkpoints, and validation.",
		role: "implementation",
		provider: WORKER_PROVIDER,
		model: WORKER_MODEL,
		modelResolutionPolicy: "strict",
		executionMode: "execute",
		allowedTools: WORKER_TOOLS,
		deniedTools: ["publish", "merge", "git_push", "npm_publish"],
		deniedEffects: ["publishes", "merges", "mutatesReleaseTags", "scopeExpansion"],
		requiredCapabilities: ["workspace-lease", "checkpoint", "transaction", "rollback"],
		budget: { maxModelTurns: 20, maxToolCalls: 80, maxWallTimeMs: 600_000, maxOutputTokens: 8_000 },
		concurrency: { parallelSafe: false, maximumInstances: 1 },
		recursion: { maySpawnSubagents: false, maximumDepth: 0 },
		inputSchema: "subagent-context-packet-v1",
		outputSchema: "worker-result-v1",
		fallbackAgents: [],
	},
	analytical(
		"cavecrew-investigator",
		"Deeply trace one concrete code or runtime flow without mutation.",
		"investigation",
		"cavecrew-investigation-result-v1",
		{
			aliases: ["cavecrew-investigate"],
			budget: { maxModelTurns: 12, maxToolCalls: 48, maxWallTimeMs: 180_000, maxOutputTokens: 5_000 },
		},
	),
	{
		...analytical(
			"cavecrew-reviewer",
			"Compactly review a narrowly bounded diff without mutation.",
			"review",
			"cavecrew-review-result-v1",
			{
				aliases: ["cavecrew-review"],
			},
		),
	},
	{
		name: "cavecrew-builder",
		aliases: ["cavecrew-build"],
		version: 1,
		description: "Apply one narrowly bounded one- or two-file change as a restricted worker specialization.",
		role: "implementation",
		provider: WORKER_PROVIDER,
		model: WORKER_MODEL,
		modelResolutionPolicy: "strict",
		executionMode: "execute",
		allowedTools: BUILDER_TOOLS,
		deniedTools: ["publish", "merge", "git_push", "npm_publish", "subagent"],
		deniedEffects: ["publishes", "merges", "mutatesReleaseTags", "scopeExpansion", "externalWrites"],
		requiredCapabilities: ["workspace-lease", "checkpoint", "transaction", "rollback"],
		budget: { maxModelTurns: 12, maxToolCalls: 40, maxWallTimeMs: 300_000, maxOutputTokens: 5_000 },
		concurrency: { parallelSafe: false, maximumInstances: 1 },
		recursion: { maySpawnSubagents: false, maximumDepth: 0 },
		inputSchema: "subagent-context-packet-v1",
		outputSchema: "cavecrew-build-result-v1",
		fallbackAgents: ["worker"],
	},
] as const;

const REQUIRED_SCHEMA_FIELDS: Record<string, readonly string[]> = {
	"cavecrew-investigation-result-v1": [
		"objective",
		"summary",
		"flow",
		"rootCauses",
		"relevantFiles",
		"unknowns",
		"recommendedNextAgent",
	],
	"cavecrew-build-result-v1": [
		"objective",
		"status",
		"filesChanged",
		"validations",
		"rollbackState",
		"remainingRisks",
	],
	"cavecrew-review-result-v1": ["verdict", "findings", "missingTests", "acceptanceGaps"],
	"planner-result-v1": ["scope", "nonGoals", "implementationSteps", "risks", "tests", "acceptanceCriteria"],
	"scout-result-v1": ["candidateLocations", "relevantSymbols", "confidence", "recommendedNextRole"],
	"worker-result-v1": ["status", "filesChanged", "validations"],
};

function validateModelReference(provider: string, model: string): string | null {
	if (!provider || !/^[a-z0-9-]+$/u.test(provider)) return "INVALID_PROVIDER";
	if (!model || model.startsWith("~") || /[\s;|&`$]/u.test(model)) return "INVALID_MODEL_REFERENCE";
	if (!/^[a-zA-Z0-9._:/-]+$/u.test(model)) return "INVALID_MODEL_REFERENCE";
	return null;
}

function cloneDefinition(definition: SubagentDefinition): SubagentDefinition {
	return {
		...definition,
		aliases: [...definition.aliases],
		allowedTools: [...definition.allowedTools],
		deniedTools: [...definition.deniedTools],
		deniedEffects: [...definition.deniedEffects],
		requiredCapabilities: [...definition.requiredCapabilities],
		budget: { ...definition.budget },
		concurrency: { ...definition.concurrency },
		recursion: { ...definition.recursion },
		fallbackAgents: [...definition.fallbackAgents],
		resultCompression: definition.resultCompression ? { ...definition.resultCompression } : undefined,
	};
}

export class SubagentRegistry {
	private readonly definitions: Map<string, SubagentDefinition>;
	private readonly aliases: Map<string, string>;
	private readonly diagnostics: RegistryDiagnostic[];

	private constructor(definitions: readonly SubagentDefinition[], diagnostics: RegistryDiagnostic[]) {
		this.definitions = new Map();
		this.aliases = new Map();
		this.diagnostics = [...diagnostics];
		for (const definition of definitions) this.definitions.set(definition.name, cloneDefinition(definition));
		for (const definition of definitions)
			for (const alias of definition.aliases) this.aliases.set(alias, definition.name);
	}

	static create(definitions: readonly SubagentDefinition[] = BUILTIN_SUBAGENT_DEFINITIONS): SubagentRegistry {
		const diagnostics: RegistryDiagnostic[] = [];
		const names = new Set<string>();
		const aliases = new Map<string, string>();
		for (const definition of definitions) {
			if (names.has(definition.name))
				diagnostics.push({
					code: "DUPLICATE_CANONICAL_NAME",
					message: `Duplicate agent ${definition.name}`,
					agent: definition.name,
				});
			names.add(definition.name);
			if (validateModelReference(definition.provider, definition.model))
				diagnostics.push({
					code: "INVALID_MODEL",
					message: `Invalid model policy for ${definition.name}`,
					agent: definition.name,
				});
			if (
				definition.executionMode === "observe" &&
				definition.allowedTools.some((tool) => ["edit", "write", "publish", "merge"].includes(tool))
			)
				diagnostics.push({
					code: "OBSERVE_MUTATION_TOOL",
					message: `Observe agent ${definition.name} declares mutation tool`,
					agent: definition.name,
				});
			if (definition.concurrency.maximumInstances < 1 || definition.recursion.maximumDepth < 0)
				diagnostics.push({
					code: "INVALID_LIMIT",
					message: `Invalid limits for ${definition.name}`,
					agent: definition.name,
				});
			for (const alias of definition.aliases) {
				const prior = aliases.get(alias);
				if (prior && prior !== definition.name)
					diagnostics.push({
						code: "DUPLICATE_ALIAS",
						message: `Alias ${alias} is ambiguous`,
						agent: definition.name,
					});
				aliases.set(alias, definition.name);
			}
		}
		for (const definition of definitions) {
			for (const fallback of definition.fallbackAgents) {
				if (!names.has(fallback)) {
					diagnostics.push({
						code: "INVALID_FALLBACK",
						message: `${definition.name} references unknown fallback ${fallback}`,
						agent: definition.name,
					});
				}
			}
		}
		for (const definition of definitions) {
			const visiting = new Set<string>();
			const walk = (name: string): void => {
				if (visiting.has(name)) {
					diagnostics.push({
						code: "FALLBACK_CYCLE",
						message: `Fallback cycle includes ${name}`,
						agent: definition.name,
					});
					return;
				}
				visiting.add(name);
				const next = definitions.find((candidate) => candidate.name === name);
				for (const fallback of next?.fallbackAgents ?? []) walk(fallback);
				visiting.delete(name);
			};
			walk(definition.name);
		}
		return new SubagentRegistry(
			[...definitions].sort((left, right) => left.name.localeCompare(right.name)),
			diagnostics,
		);
	}

	list(): SubagentDefinition[] {
		return [...this.definitions.values()].map(cloneDefinition).sort((a, b) => a.name.localeCompare(b.name));
	}
	aliasesList(): Array<{ alias: string; name: string }> {
		return [...this.aliases.entries()]
			.map(([alias, name]) => ({ alias, name }))
			.sort((a, b) => a.alias.localeCompare(b.alias));
	}
	diagnosticsList(): RegistryDiagnostic[] {
		return [...this.diagnostics];
	}
	validate(): { valid: boolean; diagnostics: RegistryDiagnostic[] } {
		return { valid: this.diagnostics.length === 0, diagnostics: this.diagnosticsList() };
	}

	resolve(
		requestedAgent: string,
		options: { referencingSkill?: string; availableModels?: readonly string[] } = {},
	): ResolvedSubagent | SubagentResolutionError {
		const canonicalName = this.definitions.has(requestedAgent) ? requestedAgent : this.aliases.get(requestedAgent);
		if (!canonicalName)
			return {
				code: "SUBAGENT_NOT_REGISTERED",
				requestedAgent,
				referencingSkill: options.referencingSkill,
				availableAgents: this.list().map((definition) => definition.name),
				automaticFallbackAttempted: false,
			};
		const definition = this.definitions.get(canonicalName);
		if (!definition)
			return {
				code: "SUBAGENT_NOT_REGISTERED",
				requestedAgent,
				referencingSkill: options.referencingSkill,
				availableAgents: this.list().map((item) => item.name),
				automaticFallbackAttempted: false,
			};
		const model = resolveSubagentModel(definition, options.availableModels);
		if (!model.ok)
			return {
				...model.error,
				requestedAgent,
				referencingSkill: options.referencingSkill,
				availableAgents: this.list().map((item) => item.name),
				automaticFallbackAttempted: false,
			};
		return { definition, model: model.value };
	}
}

export function resolveSubagentModel(
	definition: SubagentDefinition,
	availableModels?: readonly string[],
): { ok: true; value: SubagentModelResolution } | { ok: false; error: SubagentResolutionError } {
	const configuredModel = definition.model.startsWith("~") ? definition.model.slice(1) : definition.model;
	const invalid = validateModelReference(definition.provider, configuredModel);
	if (invalid)
		return {
			ok: false,
			error: {
				code: "SUBAGENT_MODEL_UNAVAILABLE",
				requestedAgent: definition.name,
				availableAgents: [],
				automaticFallbackAttempted: false,
			},
		};
	const exactReference = `${definition.provider}/${configuredModel}`;
	if (
		availableModels &&
		availableModels.length > 0 &&
		!availableModels.includes(configuredModel) &&
		!availableModels.includes(exactReference)
	) {
		return {
			ok: false,
			error: {
				code: "SUBAGENT_MODEL_UNAVAILABLE",
				requestedAgent: definition.name,
				availableAgents: [...availableModels],
				automaticFallbackAttempted: false,
			},
		};
	}
	return {
		ok: true,
		value: {
			agent: definition.name,
			configuredProvider: definition.provider,
			configuredModel: definition.model,
			resolvedProvider: definition.provider,
			resolvedModel: configuredModel,
			resolutionKind: definition.model.startsWith("~") ? "provider_alias" : "exact",
			reasonCode: definition.model.startsWith("~") ? "PROFILE_MARKER_STRIPPED" : "CONFIGURED_EXACT_REFERENCE",
			recordedAt: new Date().toISOString(),
		},
	};
}

export function validateSubagentOutput(
	schema: string,
	output: unknown,
): { valid: true; value: Record<string, unknown> } | { valid: false; error: SubagentResolutionError } {
	if (!REQUIRED_SCHEMA_FIELDS[schema] || typeof output !== "object" || output === null || Array.isArray(output))
		return {
			valid: false,
			error: {
				code: "SUBAGENT_OUTPUT_SCHEMA_INVALID",
				requestedAgent: "unknown",
				availableAgents: [],
				automaticFallbackAttempted: false,
			},
		};
	const object = output as Record<string, unknown>;
	if (REQUIRED_SCHEMA_FIELDS[schema].some((field) => !(field in object)))
		return {
			valid: false,
			error: {
				code: "SUBAGENT_OUTPUT_SCHEMA_INVALID",
				requestedAgent: "unknown",
				availableAgents: [],
				automaticFallbackAttempted: false,
			},
		};
	return { valid: true, value: object };
}

export function validateSkillAgentReferences(
	skillName: string,
	skillSource: string,
	content: string,
	registry: SubagentRegistry = SubagentRegistry.create(),
): SkillDependencyDiagnostic[] {
	const names = [
		...content.matchAll(/(?:cavecrew-[a-z0-9-]+|librarian|pentester|planner|reviewer|scout|security|worker)/gu),
	].map((match) => match[0]);
	const diagnostics: SkillDependencyDiagnostic[] = [];
	for (const name of [...new Set(names)]) {
		const result = registry.resolve(name, { referencingSkill: skillName });
		if ("code" in result)
			diagnostics.push({
				code: "SKILL_DEPENDENCY_INVALID",
				skillName,
				skillSource,
				missingAgent: name,
				recommendedRemediation: `Register or repair the exact agent reference ${name} before activating ${skillName}.`,
			});
	}
	return diagnostics;
}

export function getCanonicalSubagentRegistry(): SubagentRegistry {
	return SubagentRegistry.create();
}
export function assertCanonicalProductionAgents(agentNames: readonly string[]): void {
	const known = new Set(
		getCanonicalSubagentRegistry()
			.list()
			.map((definition) => definition.name),
	);
	const unknown = agentNames.filter((name) => !known.has(name));
	if (unknown.length > 0) throw new Error(`PRODUCTION_AGENT_OUTSIDE_CANONICAL_REGISTRY: ${unknown.join(", ")}`);
}

export const SUBAGENT_POLICY_EFFECTS = {
	observe: [...OBSERVE_EFFECTS],
	plan: [...PLAN_EFFECTS],
	execute: [...EXECUTE_EFFECTS],
} as const;
