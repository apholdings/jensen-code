import { randomUUID } from "node:crypto";
import type { ModelRegistry } from "./model-registry.js";
import {
	getCanonicalSubagentRegistry,
	type ResolvedSubagent,
	resolveSubagentModel,
	type SubagentBudget,
	type SubagentDefinition,
	type SubagentExecutionMode,
	type SubagentModelResolution,
	type SubagentResolutionError,
	validateSubagentOutput,
} from "./subagent-registry.js";

export interface SubagentContextPacket {
	objective: string;
	roleContract: string;
	acceptanceCriteria: string[];
	selectedEvidenceIds: string[];
	selectedFileReferences: string[];
	constraints: string[];
	effectiveAllowedTools: string[];
	effectiveDeniedEffects: string[];
	effectiveExecutionMode: SubagentExecutionMode;
	effectiveBudget: SubagentBudget;
	requiredOutputSchema: string;
	parentRunId: string;
	childRunId: string;
}

export interface ParentSubagentPolicy {
	allowedTools?: readonly string[];
	deniedEffects?: readonly string[];
	executionMode?: SubagentExecutionMode;
	budget?: SubagentBudget;
	recursionDepth?: number;
	maxConcurrentChildren?: number;
}

export interface ResolvedSubagentInvocation {
	canonicalAgentName: string;
	source: "builtin" | "user" | "workspace";
	definitionVersion: number;
	provider: string;
	configuredModel: string;
	resolvedModel: string;
	modelResolutionKind: SubagentModelResolution["resolutionKind"];
	executionMode: SubagentExecutionMode;
	effectiveAllowedTools: string[];
	effectiveDeniedEffects: string[];
	effectiveBudget: SubagentBudget;
	recursionDepth: number;
	inputSchemaId: string;
	outputSchemaId: string;
	parentRunId: string;
	childRunId: string;
	definition: SubagentDefinition;
}

export type SubagentRuntimeErrorCode =
	| "SUBAGENT_RESOLUTION_FAILED"
	| "SUBAGENT_PERMISSION_CONFLICT"
	| "SUBAGENT_BUDGET_EXCEEDED"
	| "SUBAGENT_RECURSION_LIMIT"
	| "SUBAGENT_OUTPUT_INVALID";

export class SubagentRuntimeError extends Error {
	readonly code: SubagentRuntimeErrorCode;
	readonly details: Record<string, unknown>;

	constructor(code: SubagentRuntimeErrorCode, message: string, details: Record<string, unknown> = {}) {
		super(message);
		this.name = "SubagentRuntimeError";
		this.code = code;
		this.details = details;
	}
}

function minimumBudget(child: SubagentBudget, parent?: SubagentBudget): SubagentBudget {
	if (!parent) return { ...child };
	const keys: Array<keyof SubagentBudget> = [
		"maxModelTurns",
		"maxToolCalls",
		"maxWallTimeMs",
		"maxInputTokens",
		"maxOutputTokens",
		"maxCostUsd",
		"maxAffectedFiles",
	];
	const result: SubagentBudget = {};
	for (const key of keys) {
		const childValue = child[key];
		const parentValue = parent[key];
		if (childValue !== undefined && parentValue !== undefined) result[key] = Math.min(childValue, parentValue);
		else result[key] = childValue ?? parentValue;
	}
	return result;
}

function modeRank(mode: SubagentExecutionMode): number {
	return mode === "observe" ? 0 : mode === "plan" ? 1 : 2;
}

function effectiveMode(child: SubagentExecutionMode, parent?: SubagentExecutionMode): SubagentExecutionMode {
	if (!parent || modeRank(child) <= modeRank(parent)) return child;
	throw new SubagentRuntimeError(
		"SUBAGENT_PERMISSION_CONFLICT",
		`Child execution mode ${child} exceeds parent mode ${parent}`,
		{ childMode: child, parentMode: parent },
	);
}

function resolveAvailableModelIds(modelRegistry?: ModelRegistry): string[] | undefined {
	if (!modelRegistry) return undefined;
	return modelRegistry.getAll().flatMap((model) => [model.id, `${model.provider}/${model.id}`]);
}

function resolveDefinition(requestedAgent: string, availableModels?: readonly string[]): ResolvedSubagent {
	const result = getCanonicalSubagentRegistry().resolve(requestedAgent, { availableModels });
	if ("code" in result) {
		throw new SubagentRuntimeError("SUBAGENT_RESOLUTION_FAILED", `${result.code}: ${requestedAgent}`, { ...result });
	}
	return result;
}

export function resolveSubagentInvocation(options: {
	requestedAgent: string;
	parentRunId: string;
	childRunId?: string;
	parentPolicy?: ParentSubagentPolicy;
	modelRegistry?: ModelRegistry;
	source?: "builtin" | "user" | "workspace";
}): ResolvedSubagentInvocation {
	const childRunId = options.childRunId ?? randomUUID();
	const availableModels = resolveAvailableModelIds(options.modelRegistry);
	const resolved = resolveDefinition(options.requestedAgent, availableModels);
	const definition = resolved.definition;
	const parent = options.parentPolicy;

	if (parent?.allowedTools) {
		const allowed = new Set(parent.allowedTools);
		const denied = definition.allowedTools.filter((tool) => !allowed.has(tool));
		if (denied.length > 0) {
			throw new SubagentRuntimeError("SUBAGENT_PERMISSION_CONFLICT", "Child requested tools denied by parent", {
				requestedAgent: options.requestedAgent,
				deniedTools: denied,
			});
		}
	}
	if (parent?.deniedEffects) {
		const childDenied = new Set(definition.deniedEffects);
		const broadened = parent.deniedEffects.filter((effect) => !childDenied.has(effect));
		if (broadened.length > 0) {
			throw new SubagentRuntimeError("SUBAGENT_PERMISSION_CONFLICT", "Child policy is not contained by parent", {
				broadenedEffects: broadened,
			});
		}
	}
	const depth = parent?.recursionDepth ?? 0;
	if (depth > definition.recursion.maximumDepth) {
		throw new SubagentRuntimeError("SUBAGENT_RECURSION_LIMIT", "Subagent recursion depth exceeded", {
			depth,
			maximumDepth: definition.recursion.maximumDepth,
		});
	}
	const budget = minimumBudget(definition.budget, parent?.budget);
	for (const [key, value] of Object.entries(budget)) {
		if (value !== undefined && value < 0) {
			throw new SubagentRuntimeError("SUBAGENT_BUDGET_EXCEEDED", `Invalid effective budget: ${key}`);
		}
	}
	return {
		canonicalAgentName: definition.name,
		source: options.source ?? "builtin",
		definitionVersion: definition.version,
		provider: resolved.model.resolvedProvider,
		configuredModel: resolved.model.configuredModel,
		resolvedModel: resolved.model.resolvedModel,
		modelResolutionKind: resolved.model.resolutionKind,
		executionMode: effectiveMode(definition.executionMode, parent?.executionMode),
		effectiveAllowedTools: parent?.allowedTools
			? definition.allowedTools.filter((tool) => parent.allowedTools?.includes(tool))
			: [...definition.allowedTools],
		effectiveDeniedEffects: [...new Set([...(parent?.deniedEffects ?? []), ...definition.deniedEffects])],
		effectiveBudget: budget,
		recursionDepth: depth + 1,
		inputSchemaId: definition.inputSchema,
		outputSchemaId: definition.outputSchema,
		parentRunId: options.parentRunId,
		childRunId,
		definition: structuredClone(definition),
	};
}

export function createSubagentContextPacket(options: {
	invocation: ResolvedSubagentInvocation;
	objective: string;
	roleContract?: string;
	acceptanceCriteria?: readonly string[];
	selectedEvidenceIds?: readonly string[];
	selectedFileReferences?: readonly string[];
	constraints?: readonly string[];
}): SubagentContextPacket {
	const { invocation } = options;
	return Object.freeze({
		objective: options.objective,
		roleContract: options.roleContract ?? invocation.definition.description,
		acceptanceCriteria: [...(options.acceptanceCriteria ?? [])],
		selectedEvidenceIds: [...(options.selectedEvidenceIds ?? [])],
		selectedFileReferences: [...(options.selectedFileReferences ?? [])],
		constraints: [...(options.constraints ?? [])],
		effectiveAllowedTools: [...invocation.effectiveAllowedTools],
		effectiveDeniedEffects: [...invocation.effectiveDeniedEffects],
		effectiveExecutionMode: invocation.executionMode,
		effectiveBudget: { ...invocation.effectiveBudget },
		requiredOutputSchema: invocation.outputSchemaId,
		parentRunId: invocation.parentRunId,
		childRunId: invocation.childRunId,
	});
}

function parseStructuredOutput(raw: unknown): unknown {
	if (typeof raw !== "string") return raw;
	const trimmed = raw.trim();
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1];
		if (!fenced) return raw;
		try {
			return JSON.parse(fenced.trim()) as unknown;
		} catch {
			return raw;
		}
	}
}

export function validateParentSubagentOutput(options: { invocation: ResolvedSubagentInvocation; rawOutput: unknown }): {
	value: Record<string, unknown>;
	sanitizedRawOutput: string;
} {
	const parsed = parseStructuredOutput(options.rawOutput);
	const result = validateSubagentOutput(options.invocation.outputSchemaId, parsed);
	if (!result.valid) {
		throw new SubagentRuntimeError(
			"SUBAGENT_OUTPUT_INVALID",
			`SUBAGENT_OUTPUT_INVALID: child output failed parent schema validation`,
			{
				agent: options.invocation.canonicalAgentName,
				schema: options.invocation.outputSchemaId,
			},
		);
	}
	if (options.invocation.canonicalAgentName === "cavecrew-investigator") {
		const changed = result.value.filesChanged;
		if (changed !== undefined && (!Array.isArray(changed) || changed.length !== 0)) {
			throw new SubagentRuntimeError("SUBAGENT_OUTPUT_INVALID", "Investigator output claims files changed");
		}
	}
	if (options.invocation.canonicalAgentName === "cavecrew-builder") {
		const status = result.value.status;
		const filesChanged = result.value.filesChanged;
		if (status === "implemented" && typeof result.value.transactionId !== "string") {
			throw new SubagentRuntimeError("SUBAGENT_OUTPUT_INVALID", "Builder implemented result requires transactionId");
		}
		if (
			!Array.isArray(filesChanged) ||
			filesChanged.length > (options.invocation.effectiveBudget.maxAffectedFiles ?? 2)
		) {
			throw new SubagentRuntimeError("SUBAGENT_OUTPUT_INVALID", "Builder output exceeds affected-file limit");
		}
	}
	return {
		value: result.value,
		sanitizedRawOutput: typeof options.rawOutput === "string" ? options.rawOutput.slice(0, 16_000) : "[structured]",
	};
}

export function getResolvedModelForDispatch(
	definition: SubagentDefinition,
	modelRegistry?: ModelRegistry,
): SubagentModelResolution {
	const resolved = resolveSubagentModel(definition, resolveAvailableModelIds(modelRegistry));
	if (!resolved.ok)
		throw new SubagentRuntimeError("SUBAGENT_RESOLUTION_FAILED", resolved.error.code, { ...resolved.error });
	return resolved.value;
}

export type { SubagentResolutionError };
