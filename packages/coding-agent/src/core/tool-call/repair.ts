import {
	canonicalizeSchema,
	canonicalStableStringify,
	sha256Hex,
	stableHash,
	validateAgainstSchema,
} from "./canonicalize.js";
import { recoverTruncatedJson } from "./truncated-json.js";
import type {
	CanonicalJsonSchema,
	NormalizedToolCall,
	RepairOptions,
	RepairOutcomeKind,
	ToolCallRepair,
	TruncatedJsonOutcome,
} from "./types.js";

/**
 * Conservative, deterministic argument repair.
 *
 * Rules:
 *  - Coerce unambiguous primitive representations ("true"→true, "42"→42).
 *  - Collapse a safe singleton into the array a schema requires.
 *  - Close a clearly truncated container (via truncated-json).
 *  - Normalize a tool-name alias to the canonical name.
 *  - NEVER invent semantic values: file paths, branch names, versions,
 *    commands, URLs, recipients, destructive flags, approval scopes, policy.
 *  - Ambiguous mutating calls fail closed.
 */

const FORBIDDEN_INVENTED_FIELDS =
	/\b(path|file|dir|directory|branch|version|url|host|command|cmd|recipient|email|database|db|deploy|target|token|secret|key)\b/i;

export interface RepairContext {
	/** Canonical args already available (parsed). When absent, parse rawArgs. */
	parsedArgs?: Record<string, unknown>;
	/** Raw args string (possibly truncated JSON). */
	rawArgs?: string;
	/** Schema for validation (canonical). */
	schema: CanonicalJsonSchema;
	options?: RepairOptions;
}

/** Generate a deterministic repair id from before/after hashes. */
function makeRepairId(kind: string, before: string, after: string): string {
	return sha256Hex(`${kind}|${before}|${after}`).slice(0, 24);
}

function hashOf(obj: unknown): string {
	return sha256Hex(canonicalStableStringify(obj ?? {}));
}

/** Guard: would a repair for this field be an invented semantic value? */
function isForbiddenInvention(field: string | undefined, kind: string): boolean {
	if (kind === "invent_value") return true; // never synthesize
	if (field && FORBIDDEN_INVENTED_FIELDS.test(field.toLowerCase()) && kind.startsWith("coerce-")) return false;
	return false;
}

/** Parse the raw args, attempting truncated-JSON closure when possible. */
function parseArgs(ctx: RepairContext): {
	parsed: Record<string, unknown>;
	truncated: TruncatedJsonOutcome;
	reparsedRaw?: string;
} {
	if (ctx.parsedArgs) return { parsed: ctx.parsedArgs, truncated: { status: "not_truncated" } };
	if (ctx.rawArgs === undefined) return { parsed: {}, truncated: { status: "not_truncated" } };
	const raw = ctx.rawArgs.trim();
	if (raw === "") return { parsed: {}, truncated: { status: "not_truncated" } };
	try {
		const parsed = JSON.parse(raw);
		return {
			parsed: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {},
			truncated: { status: "not_truncated" },
		};
	} catch {
		const rec = recoverTruncatedJson(raw, {
			maxBytes: ctx.options?.maxTruncatedJsonBytes,
		});
		if (rec.value !== undefined) {
			const parsed = rec.value as Record<string, unknown>;
			return {
				parsed: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {},
				truncated: rec.outcome,
				reparsedRaw: JSON.stringify(parsed),
			};
		}
		return { parsed: {}, truncated: rec.outcome };
	}
}

function coercePrimitive(
	_field: string,
	value: unknown,
	schema: CanonicalJsonSchema,
): { value: unknown; kind?: string } {
	if (typeof value === "string") {
		if (schema.type === "boolean") {
			if (value === "true") return { value: true, kind: "coerce-string-boolean" };
			if (value === "false") return { value: false, kind: "coerce-string-boolean" };
			return { value };
		}
		if (schema.type === "integer" || schema.type === "number") {
			const trimmed = value.trim();
			if (/^-?\d+$/.test(trimmed)) return { value: Number(trimmed), kind: "coerce-string-integer" };
			if (schema.type === "number" && /^-?\d*\.\d+$/.test(trimmed)) {
				return { value: Number(trimmed), kind: "coerce-string-number" };
			}
			return { value };
		}
	}
	return { value };
}

function canonicalName(name: string, aliasMap?: Record<string, string>): { name: string; repaired: boolean } {
	const canonical = aliasMap?.[name];
	if (canonical && canonical !== name) return { name: canonical, repaired: true };
	return { name, repaired: false };
}

/**
 * Recursively normalize `value` against `schema`. Returns the normalized value
 * and collects repairs. Ambiguity is reported via `ambiguous`.
 */
function normalizeValue(
	field: string,
	value: unknown,
	schema: CanonicalJsonSchema,
	options: RepairOptions,
	repairs: ToolCallRepair[],
	ambiguous: string[],
	depth: number,
): unknown {
	if (depth > 32) {
		ambiguous.push(`${field}: repair depth exceeded`);
		return value;
	}
	const beforeHash = hashOf(value);

	// Primitive coercion.
	const coerced = coercePrimitive(field, value, schema);
	if (coerced.kind) {
		repairs.push({
			repairId: makeRepairId(coerced.kind, beforeHash, hashOf(coerced.value)),
			field,
			repairKind: coerced.kind,
			beforeHash,
			afterHash: hashOf(coerced.value),
			confidence: "deterministic",
		});
		value = coerced.value;
	}

	// Singleton → array when schema requires an array and ambiguity is absent.
	if (
		options.allowSingletonToArray !== false &&
		schema.type === "array" &&
		!Array.isArray(value) &&
		value !== undefined &&
		value !== null
	) {
		const wrapped = [value];
		repairs.push({
			repairId: makeRepairId("singleton-to-array", beforeHash, hashOf(wrapped)),
			field,
			repairKind: "singleton-to-array",
			beforeHash,
			afterHash: hashOf(wrapped),
			confidence: "deterministic",
		});
		value = wrapped;
	}

	// Recurse object properties.
	if (Array.isArray(value)) {
		const itemSchema = Array.isArray(schema.items) ? schema.items[0] : schema.items;
		if (itemSchema) {
			return value.map((item, i) =>
				normalizeValue(
					`${field}[${i}]`,
					item,
					itemSchema as CanonicalJsonSchema,
					options,
					repairs,
					ambiguous,
					depth + 1,
				),
			);
		}
		return value;
	}
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const record = { ...(value as Record<string, unknown>) };
		if (schema.properties) {
			for (const [key, propSchema] of Object.entries(schema.properties)) {
				if (record[key] !== undefined) {
					record[key] = normalizeValue(
						`${field}.${key}`,
						record[key],
						propSchema as CanonicalJsonSchema,
						options,
						repairs,
						ambiguous,
						depth + 1,
					);
				}
			}
		}
		// Destructive-flag ambiguity detection: if a boolean destructive flag is a
		// string that couldn't be coerced, mark ambiguous.
		if (schema.type === "object" && schema.properties) {
			for (const [key, propSchema] of Object.entries(schema.properties)) {
				const ps = propSchema as CanonicalJsonSchema;
				if (record[key] === undefined) continue;
				if (
					typeof record[key] === "string" &&
					(ps.type === "boolean" || ps.type === "integer" || ps.type === "number")
				) {
					if (coercePrimitive(key, record[key], ps).kind === undefined && record[key].trim() !== "") {
						ambiguous.push(`${field}.${key}: ambiguous ${ps.type} value '${maskValue(record[key])}'`);
					}
				}
			}
		}
		return record;
	}
	return value;
}

function maskValue(v: unknown): string {
	const s = String(v);
	if (s.length > 16) return `${s.slice(0, 8)}…(${s.length})`;
	return s;
}

/**
 * Run the full normalization + conservative repair pipeline for a single raw
 * tool call. Requires a canonical tool name (already alias-resolved by caller
 * or resolved here), a tool-call id, and the provider-emitted args.
 */
export function normalizeToolCall(input: {
	name: string;
	rawName: string;
	toolCallId: string;
	rawArgs?: string;
	parsedArgs?: Record<string, unknown>;
	schema: CanonicalJsonSchema;
	canonicalName?: string;
	aliasMap?: Record<string, string>;
	options?: RepairOptions;
}): NormalizedToolCall {
	const options = input.options ?? {};
	const alias = canonicalName(input.canonicalName ?? input.name, input.aliasMap);
	const repairs: ToolCallRepair[] = [];
	const ambiguous: string[] = [];

	if (alias.repaired) {
		repairs.push({
			repairId: makeRepairId("tool-alias", sha256Hex(input.rawName), sha256Hex(alias.name)),
			field: "name",
			repairKind: "tool-name-alias",
			beforeHash: sha256Hex(input.rawName),
			afterHash: sha256Hex(alias.name),
			confidence: "deterministic",
		});
	}

	const { parsed, truncated, reparsedRaw } = parseArgs({
		rawArgs: input.rawArgs,
		parsedArgs: input.parsedArgs,
		schema: input.schema,
		options,
	});

	if (truncated.status === "unrecoverable") {
		return {
			name: alias.name,
			rawName: input.rawName,
			toolCallId: input.toolCallId,
			args: parsed,
			outcome: "invalid_schema",
			repairs,
			rawHash: sha256Hex(input.rawArgs ?? canonicalStableStringify(input.parsedArgs ?? {})),
			canonicalHash: hashOf(parsed),
			truncated,
		};
	}

	// normalization base hash from the pre-repair canonical state
	const preNormalized = parsed;
	const preHash = hashOf(preNormalized);

	const normalized = normalizeValue(
		"$",
		parsed,
		input.schema ?? canonicalizeSchema({ type: "object" }),
		options,
		repairs,
		ambiguous,
		0,
	);

	// Validate against canonical schema.
	const schemaErrors = validateAgainstSchema(normalized as Record<string, unknown>, input.schema);

	const outcome: RepairOutcomeKind =
		ambiguous.length > 0
			? "ambiguous"
			: schemaErrors.length > 0
				? "invalid_schema"
				: repairs.length > 0
					? "repaired_and_valid"
					: "valid_without_repair";

	// Deduplicate identical repair evidence.
	const uniqueRepairs = dedupeRepairs(repairs);

	// Truncated recovery evidence is a repair.
	if (truncated.status === "recovered" && options.allowTruncatedContainerClose !== false) {
		uniqueRepairs.push({
			repairId: makeRepairId("truncated-json", truncated.beforeHash, truncated.afterHash),
			repairKind: "truncated-json-close",
			beforeHash: truncated.beforeHash,
			afterHash: truncated.afterHash,
			confidence: "deterministic",
		});
		const _rp = reparsedRaw;
		void _rp;
	}

	return {
		name: alias.name,
		rawName: input.rawName,
		toolCallId: input.toolCallId,
		args: normalized as Record<string, unknown>,
		outcome,
		repairs: uniqueRepairs,
		rawHash: preHash,
		canonicalHash: hashOf(normalized),
		truncated,
	};
}

function dedupeRepairs(repairs: ToolCallRepair[]): ToolCallRepair[] {
	const seen = new Set<string>();
	const out: ToolCallRepair[] = [];
	for (const r of repairs) {
		const key = `${r.repairKind}|${r.beforeHash}|${r.afterHash}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(r);
	}
	return out;
}

export const stableObjHash = stableHash;

/** Convenience re-export for diagnostics. */
export { isForbiddenInvention };
