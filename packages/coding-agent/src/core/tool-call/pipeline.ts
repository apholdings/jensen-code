import { canonicalizeSchema, validateAgainstSchema } from "./canonicalize.js";
import { normalizeToolCall } from "./repair.js";
import { type ScavengeOrigin, scavengeToolCall } from "./scavenge.js";
import { applyProviderSchemaCompatibility } from "./schema-flatten.js";
import type { CanonicalJsonSchema, NormalizedToolCall, RepairOptions, SchemaCompatibilityRecord } from "./types.js";

export interface RawToolCallShape {
	name: string;
	toolCallId: string;
	/** Provider-native args (already parsed object). */
	arguments?: Record<string, unknown>;
	/** Provider-native args as a raw JSON string (possibly truncated). */
	argumentsString?: string;
	/** When a provider wraps args in an envelope, the envelope payload. */
	wrapped?: unknown;
}

export interface ToolCallPipelineOptions {
	schemaById: Record<string, CanonicalJsonSchema>;
	aliasMap?: Record<string, string>;
	repair?: RepairOptions;
	/** Provider capability for schema flattening. */
	providerCapability?: "flat" | "nested" | "unknown";
	forceFlatten?: boolean;
	/** Whether aggressive scavenging of designated tool channels is allowed. */
	allowScavenge?: boolean;
	ensureToolExists?: (name: string) => boolean;
}

export interface PipelineResult {
	normalized: NormalizedToolCall | null;
	compatibility?: SchemaCompatibilityRecord;
	scavenged?: boolean;
	blockedReason?: string;
}

/**
 * Full provider-independent canonical pipeline for a single raw tool call.
 * Policy/effect evaluation is deliberately NOT performed here (it is the
 * caller's responsibility, before execution), keeping this layer pure.
 */
export function runToolCallPipeline(raw: RawToolCallShape, opts: ToolCallPipelineOptions): PipelineResult {
	const canonicalName = normalizeName(raw.name, opts.aliasMap);
	const schema = opts.schemaById[canonicalName] ?? opts.schemaById[raw.name];
	if (!schema) {
		return { normalized: null, blockedReason: `unknown tool '${raw.name}'` };
	}

	// Provider-native structured arguments.
	const parsedArgs = raw.arguments;
	const rawArgsString = raw.argumentsString;

	const normalized = normalizeToolCall({
		name: canonicalName,
		rawName: raw.name,
		toolCallId: raw.toolCallId,
		rawArgs: rawArgsString,
		parsedArgs,
		schema,
		canonicalName,
		aliasMap: opts.aliasMap,
		options: opts.repair,
	});

	// Compatibility envelope handling only when explicitly allowed and when the
	// provider tagged the content as a tool channel (origin-dependent).
	if (
		opts.allowScavenge === true &&
		raw.wrapped !== undefined &&
		(normalized.outcome === "invalid_schema" || normalized.outcome === "ambiguous")
	) {
		for (const origin of [
			"documented_compat_envelope",
			"provider_escaped_json",
			"provider_tool_channel",
		] as ScavengeOrigin[]) {
			const scavenged = scavengeToolCall(raw.wrapped, {
				origin,
				schemaById: opts.schemaById,
				aliasMap: opts.aliasMap,
				ensureToolExists: opts.ensureToolExists,
			});
			if (scavenged) {
				return { normalized: scavenged.normalized, scavenged: true };
			}
		}
	}

	return { normalized };
}

function normalizeName(name: string, aliasMap?: Record<string, string>): string {
	return aliasMap?.[name] ?? name;
}

/** Convenience: canonical validation + schema envelope in one step. */
export function prepareSchemaForProvider(
	schema: CanonicalJsonSchema,
	providerCapability: "flat" | "nested" | "unknown" = "unknown",
	forceFlatten?: boolean,
) {
	return applyProviderSchemaCompatibility(schema, providerCapability, forceFlatten);
}

export { canonicalizeSchema, validateAgainstSchema };
