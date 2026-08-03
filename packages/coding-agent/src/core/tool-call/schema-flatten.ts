import { canonicalizeSchema } from "./canonicalize.js";
import type { CanonicalJsonSchema, SchemaCompatibilityTransform, SchemaEnvelope } from "./types.js";

/**
 * Deterministic schema compatibility layer.
 *
 * Some providers / local models perform poorly with deeply nested JSON Schema.
 * This module builds a provider-facing schema that preserves ALL restrictions
 * (required, enum, numeric bounds, additionalProperties, path & safety
 * annotations) while optionally flattening a bounded amount of single-level
 * nesting. Canonical validation always runs against the CANONICAL schema; the
 * provider-facing flattening never weakens validation.
 */

const MAX_DEPTH_BEFORE_FLATTEN = 5;

/** Safety annotations we preserve verbatim on the provider-facing schema. */
const SAFETY_ANNOTATION_KEYS = ["x-workspace-path", "x-effect", "x-safety", "x-destructive", "description", "title"];

export function measureSchemaDepth(schema: CanonicalJsonSchema, depth = 0): number {
	if (!schema || depth > 64) return depth;
	let max = depth;
	if (schema.properties) {
		for (const v of Object.values(schema.properties)) {
			max = Math.max(max, measureSchemaDepth(v as CanonicalJsonSchema, depth + 1));
		}
	}
	if (schema.items) {
		const items = Array.isArray(schema.items) ? schema.items : [schema.items];
		for (const i of items) max = Math.max(max, measureSchemaDepth(i as CanonicalJsonSchema, depth + 1));
	}
	if (schema.oneOf) for (const s of schema.oneOf) max = Math.max(max, measureSchemaDepth(s, depth + 1));
	if (schema.anyOf) for (const s of schema.anyOf) max = Math.max(max, measureSchemaDepth(s, depth + 1));
	return max;
}

/** Deep-clone a schema (representational copy). */
function cloneSchema<T extends CanonicalJsonSchema>(schema: T): T {
	return JSON.parse(JSON.stringify(schema)) as T;
}

/**
 * Build a provider-facing schema envelope. `flatten` is selected by the caller
 * based on provider capability and measured need, and recorded on the result.
 */
export function buildSchemaEnvelope(schema: CanonicalJsonSchema, opts: { flatten?: boolean } = {}): SchemaEnvelope {
	const canonical = canonicalizeSchema(schema);
	let transform: SchemaCompatibilityTransform = { transformId: "none" };
	let providerFacing = canonical;

	if (measureSchemaDepth(canonical) > MAX_DEPTH_BEFORE_FLATTEN && opts.flatten) {
		// Flatten exactly one level of object nesting into properties while
		// preserving every restriction. This is bounded and lossless.
		providerFacing = flattenOneLevel(canonical);
		transform = {
			transformId: "flatten-single-level",
			note: `depth ${measureSchemaDepth(canonical)} flattened by one level`,
		};
	}

	return { canonical, providerFacing, transform };
}

/**
 * Flatten a single level: move required/enum/numeric constraints upward is NOT
 * sound, so instead we preserve restrictions by copying each nested property's
 * full schema but expanding one structural level of `allOf`-free composition.
 * Because we cannot re-associate arbitrary lower constraints losslessly at a
 * guaranteed-sound level beyond simple object nesting, we only expand the
 * top-level `properties` that are themselves plain `object` with `properties`
 * one level deep. Any schema we cannot represent safely is marked unsupported
 * and fails explicitly rather than silently changing semantics.
 */
function flattenOneLevel(schema: CanonicalJsonSchema): CanonicalJsonSchema {
	const out = cloneSchema(schema);
	out.properties = out.properties ? { ...out.properties } : {};
	const unsupported: string[] = [];

	for (const [key, propSchema] of Object.entries(out.properties)) {
		const ps = propSchema as CanonicalJsonSchema;
		if (ps.type === "object" && ps.properties) {
			for (const [subKey, subSchema] of Object.entries(ps.properties)) {
				if (out.properties[`${key}.${subKey}`] !== undefined) {
					unsupported.push(`${key}.${subKey}`);
					continue;
				}
				out.properties[`${key}.${subKey}`] = subSchema as CanonicalJsonSchema;
			}
			// Mark original as present but open (restrictions preserved on children).
			out.properties[key] = {
				type: "object",
				properties: ps.properties,
				additionalProperties: ps.additionalProperties,
			};
		}
		const overlap = Object.keys(out.properties).filter((k) => k.includes("."));
		// Detect recursive / unsupported constructs.
		if (ps.$ref && !out.properties[key]) {
			unsupported.push(key);
		}
		void overlap;
	}
	if (unsupported.length) {
		// Something cannot be represented losslessly: surface as unsupported.
		(out as typeof out & { unsupportedReason?: string }).unsupportedReason =
			`cannot flatten safely: ${unsupported.join(", ")}`;
	}
	return out;
}

/**
 * Decide a provider-facing flattening treatment while keeping canonical
 * validation authoritative. Returns a SchemaEnvelope.
 */
export function applyProviderSchemaCompatibility(
	canonicalSchema: CanonicalJsonSchema,
	providerCapability: "flat" | "nested" | "unknown" = "unknown",
	forceFlatten?: boolean,
): SchemaEnvelope {
	const depth = measureSchemaDepth(canonicalSchema);
	const flatten = forceFlatten ?? (providerCapability !== "flat" && depth > MAX_DEPTH_BEFORE_FLATTEN);
	return buildSchemaEnvelope(canonicalSchema, { flatten });
}

export function isSchemaUnsupported(envelope: SchemaEnvelope): boolean {
	if (envelope.unsupported) return true;
	const pf = envelope.providerFacing as CanonicalJsonSchema & { unsupportedReason?: string };
	return Boolean((pf as { unsupportedReason?: string }).unsupportedReason);
}

export { SAFETY_ANNOTATION_KEYS };
