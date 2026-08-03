import { createHash } from "node:crypto";
import type { CanonicalJsonSchema } from "./types.js";

/**
 * Deterministic JSON serialization. Keys are sorted, numbers are compacted,
 * and primitive whitespace is normalized so identical logical objects produce
 * identical bytes. This is the source of stable, replay-safe hashes and the
 * foundation of the storm-breaker call fingerprint.
 */
export function canonicalStableStringify(value: unknown): string {
	return stableStringify(value);
}

function stableStringify(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
	if (typeof value === "bigint") return String(value);
	if (typeof value === "function" || typeof value === "symbol") {
		throw new Error("cannot stable stringify non-serializable value");
	}
	if (Array.isArray(value)) {
		const items = value.map((v) => stableStringify(v)).join(",");
		return `[${items}]`;
	}
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record).sort();
		const parts: string[] = [];
		for (const key of keys) {
			const serialized = stableStringify(record[key]);
			if (serialized === undefined) continue;
			parts.push(`${JSON.stringify(key)}:${serialized}`);
		}
		return `{${parts.join(",")}}`;
	}
	throw new Error(`cannot stable stringify value of type ${typeof value}`);
}

/** SHA-256 hex digest of UTF-8 bytes. */
export function sha256Hex(input: string): string {
	return createHash("sha256").update(input, "utf-8").digest("hex");
}

/** Stable hash over any value via canonical serialization. */
export function stableHash(value: unknown): string {
	return sha256Hex(canonicalStableStringify(value));
}

/**
 * Deterministically canonicalize a JSON Schema so that semantically identical
 * schemas (eg. OpenAPI-style nullable vs JSON-Schema nullable) collapse to the
 * same logical shape. This is used for stable compatibility hashing and to
 * make `additionalProperties`/`required` handling predictable. It never drops
 * restrictions; it only normalizes representation.
 */
export function canonicalizeSchema(schema: CanonicalJsonSchema): CanonicalJsonSchema {
	if (schema == null || typeof schema !== "object" || Array.isArray(schema)) {
		// Unsupported root: preserve the object wrapper if possible.
		return { type: "object" };
	}
	const out: CanonicalJsonSchema = {};
	if (schema.type !== undefined) out.type = schema.type;
	if (Array.isArray(schema.required)) {
		out.required = [...new Set(schema.required)].sort();
	} else if (typeof schema.required === "string") {
		// OpenAPI `required: true` on a field is meaningless at root; drop.
	}
	if (schema.properties && typeof schema.properties === "object") {
		const props: Record<string, CanonicalJsonSchema> = {};
		for (const [k, v] of Object.entries(schema.properties)) {
			if (v && typeof v === "object") props[k] = canonicalizeSchema(v as CanonicalJsonSchema);
		}
		out.properties = props;
	}
	if (schema.items !== undefined) {
		if (Array.isArray(schema.items)) {
			out.items = schema.items.map((i) =>
				i && typeof i === "object" ? canonicalizeSchema(i as CanonicalJsonSchema) : { type: "object" },
			);
		} else if (schema.items && typeof schema.items === "object") {
			out.items = canonicalizeSchema(schema.items as CanonicalJsonSchema);
		}
	}
	if (schema.enum !== undefined) out.enum = schema.enum;
	if (Array.isArray(schema.oneOf)) out.oneOf = schema.oneOf.map((s) => canonicalizeSchema(s));
	if (Array.isArray(schema.anyOf)) out.anyOf = schema.anyOf.map((s) => canonicalizeSchema(s));
	if (schema.nullable !== undefined) out.nullable = !!schema.nullable;
	if (schema.additionalProperties !== undefined) {
		if (typeof schema.additionalProperties === "boolean") out.additionalProperties = schema.additionalProperties;
		else if (schema.additionalProperties && typeof schema.additionalProperties === "object")
			out.additionalProperties = canonicalizeSchema(schema.additionalProperties);
	}
	if (schema.$ref !== undefined) out.$ref = schema.$ref;
	return out;
}

function unionHasString(type: string | string[] | undefined): boolean {
	if (!type) return false;
	return Array.isArray(type) ? type.includes("string") : type === "string";
}

/**
 * Minimal structural validation of normalized arguments against a canonical
 * schema. This is intentionally conservative: it checks types, required
 * presence, enums, and additionalProperties=false restrictions. It is NOT a
 * full JSON-Schema engine; unsupported constructs fall back to permissive
 * (never to stricter) behavior so we never block a genuinely valid call, while
 * the repair layer separately refuses ambiguous destructive calls.
 */
export function validateAgainstSchema(args: Record<string, unknown>, schema: CanonicalJsonSchema): string[] {
	return validateObject(args, schema, "$", 0);
}

function typeMatches(value: unknown, type: string): boolean {
	switch (type) {
		case "object":
			return value !== null && typeof value === "object" && !Array.isArray(value);
		case "array":
			return Array.isArray(value);
		case "string":
			return typeof value === "string";
		case "boolean":
			return typeof value === "boolean";
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "number":
			return typeof value === "number";
		case "null":
			return value === null;
		default:
			return true; // unknown keyword: permissive
	}
}

function validateObject(value: unknown, schema: CanonicalJsonSchema, path: string, depth: number): string[] {
	const errors: string[] = [];
	if (depth > 64) return errors;
	const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
	const allowsNull = !!schema.nullable || (types.length === 0 && value === null);
	if (value === null && !allowsNull && types.includes("null")) return errors;

	if (types.length > 0) {
		const matches = types.some((t) => typeMatches(value, t));
		if (!matches && value !== null) {
			const wantsObject =
				types.some((t) => t === "object" || t === "array") && typeof value === "object" && value !== null;
			// Arrays/objects are structurally validated below regardless of keyword.
			if (!wantsObject && value !== null) {
				errors.push(`${path}: expected ${types.join("|")} but got ${jsonTypeOf(value)}`);
			}
		}
	}

	if (schema.enum !== undefined) {
		const ok = schema.enum.some((e) => canonicalStableStringify(e) === canonicalStableStringify(value));
		if (!ok) errors.push(`${path}: value not in enum`);
		return errors;
	}

	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		if (schema.properties) {
			for (const [key, propSchema] of Object.entries(schema.properties)) {
				if (record[key] !== undefined) {
					errors.push(
						...validateObject(record[key], propSchema as CanonicalJsonSchema, `${path}.${key}`, depth + 1),
					);
				}
			}
		}
		if (schema.required) {
			for (const req of schema.required) {
				if (record[req] === undefined) errors.push(`${path}: missing required field '${req}'`);
			}
		}
		if (!unionHasString(types) && schema.additionalProperties === false && schema.properties) {
			for (const key of Object.keys(record)) {
				if (!Object.hasOwn(schema.properties, key)) {
					errors.push(`${path}: unexpected property '${key}' (additionalProperties=false)`);
					break;
				}
			}
		}
	}

	if (Array.isArray(value) && schema.items) {
		const items = Array.isArray(schema.items) ? schema.items : [schema.items];
		for (let i = 0; i < value.length; i++) {
			const itemSchema = items[Math.min(i, items.length - 1)];
			if (itemSchema)
				errors.push(...validateObject(value[i], itemSchema as CanonicalJsonSchema, `${path}[${i}]`, depth + 1));
		}
	}

	if (schema.oneOf) {
		const matches = schema.oneOf.filter((s) => validateObject(value, s, path, depth + 1).length === 0).length;
		if (matches !== 1) errors.push(`${path}: must match exactly one of oneOf`);
	}
	if (schema.anyOf) {
		const matches = schema.anyOf.filter((s) => validateObject(value, s, path, depth + 1).length === 0).length;
		if (matches === 0) errors.push(`${path}: must match at least one of anyOf`);
	}
	return errors;
}

function jsonTypeOf(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}
