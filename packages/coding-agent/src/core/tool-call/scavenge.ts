import { canonicalStableStringify, sha256Hex, stableHash } from "./canonicalize.js";
import { normalizeToolCall } from "./repair.js";
import type { CanonicalJsonSchema, ToolCallRepair } from "./types.js";

/**
 * Tightly bounded recovery of tool calls emitted in the wrong protocol
 * location. This is NOT a scraping heuristic over arbitrary prose.
 *
 * Recovery is permitted only when ALL of these hold:
 *  - trusted provider-origin metadata (the content was explicitly tagged as a
 *    tool/data channel by the provider adapter, not normal assistant prose);
 *  - a recognized compatibility signature (an explicit envelope marker);
 *  - a canonical tool name;
 *  - the recovered payload validates against the canonical schema.
 *
 * Arbitrary assistant prose, shell suggestions, copied documentation, webpage
 * content, repository text, quoted transcripts, and research evidence can
 * NEVER become executable tool calls through scavenging.
 */

export type ScavengeOrigin =
	| "provider_tool_channel" // adapter placed structured data in the wrong field
	| "provider_escaped_json" // structured call emitted as escaped JSON in the tool-call field
	| "documented_compat_envelope"; // a known local-model compatibility envelope

export interface RepeatedToolCallCandidate {
	name: string;
	toolCallId: string;
	rawArgs?: string;
}

interface ScavengeContext {
	origin: ScavengeOrigin;
	schemaById: Record<string, CanonicalJsonSchema>;
	aliasMap?: Record<string, string>;
	ensureToolExists?: (name: string) => boolean;
}

/** Compatibility signatures we recognize as explicit envelopes. */
const COMPAT_ENVELOPE_KEYS = new Set(["tool_call", "toolCall", "__tool", "invoke", "call", "action", "function_call"]);

/**
 * Extract a candidate structured tool call from a chunk that the provider
 * explicitly marked as tool data. Returns null when the chunk is not an
 * unambiguous envelope.
 */
export function extractEnvelopeCandidate(content: unknown, origin: ScavengeOrigin): RepeatedToolCallCandidate | null {
	if (content === null || content === undefined) return null;
	if (typeof content === "string") {
		// Only when origin is escaped-JSON inside the tool-call field and the
		// string parses to the envelope shape below.
		const trimmed = content.trim();
		if (/^[{[].*[}\]]$/s.test(trimmed)) {
			try {
				const parsed = JSON.parse(trimmed);
				return extractEnvelopeCandidate(parsed, origin);
			} catch {
				return null;
			}
		}
		return null;
	}
	if (Array.isArray(content)) {
		for (const item of content) {
			const cand = extractEnvelopeCandidate(item, origin);
			if (cand) return cand;
		}
		return null;
	}
	if (typeof content === "object") {
		const record = content as Record<string, unknown>;
		// Look for the single most specific recognized envelope key.
		for (const key of COMPAT_ENVELOPE_KEYS) {
			const candidate = record[key];
			if (
				candidate !== undefined &&
				typeof candidate === "object" &&
				candidate !== null &&
				!Array.isArray(candidate)
			) {
				const cr = candidate as Record<string, unknown>;
				const name =
					typeof cr.name === "string"
						? cr.name
						: typeof cr.tool === "string"
							? cr.tool
							: typeof cr.function === "string"
								? cr.function
								: undefined;
				if (!name) continue;
				const toolCallId =
					typeof cr.id === "string" ? cr.id : typeof cr.toolCallId === "string" ? cr.toolCallId : "";
				const rawArgs =
					typeof cr.arguments === "string"
						? cr.arguments
						: typeof cr.arguments === "object" && cr.arguments !== null
							? canonicalStableStringify(cr.arguments)
							: undefined;
				return { name, toolCallId, rawArgs };
			}
		}
		// Directly-shaped tool call object (provider_tool_channel).
		if (origin === "provider_tool_channel" && typeof record.name === "string" && record.arguments !== undefined) {
			const rawArgs =
				typeof record.arguments === "string" ? record.arguments : canonicalStableStringify(record.arguments);
			return {
				name: record.name,
				toolCallId: typeof record.id === "string" ? record.id : "",
				rawArgs,
			};
		}
	}
	return null;
}

/**
 * Attempt bounded scavenging. Returns a normalized tool call only when the
 * candidate is trusted-origin, name-resolvable, schema-valid, and unambiguous.
 * Returns null otherwise (the chunk is ignored — it is never executed).
 */
export function scavengeToolCall(
	content: unknown,
	ctx: ScavengeContext,
): {
	normalized: ReturnType<typeof normalizeToolCall>;
	scavengedFrom: ScavengeOrigin;
	repairs: ToolCallRepair[];
} | null {
	// Web content / tool output / research evidence can never be scavenged.
	if (
		ctx.origin !== "provider_tool_channel" &&
		ctx.origin !== "provider_escaped_json" &&
		ctx.origin !== "documented_compat_envelope"
	) {
		return null;
	}
	const candidate = extractEnvelopeCandidate(content, ctx.origin);
	if (!candidate) return null;
	if (ctx.ensureToolExists && !ctx.ensureToolExists(candidate.name)) return null;
	const schema = ctx.schemaById[candidate.name] ?? ctx.schemaById[ctx.aliasMap?.[candidate.name] ?? candidate.name];
	if (!schema) return null;
	const normalized = normalizeToolCall({
		name: candidate.name,
		rawName: candidate.name,
		toolCallId: candidate.toolCallId,
		rawArgs: candidate.rawArgs,
		schema,
		aliasMap: ctx.aliasMap,
	});
	if (normalized.outcome === "invalid_schema" || normalized.outcome === "ambiguous") return null;
	return { normalized, scavengedFrom: ctx.origin, repairs: normalized.repairs };
}

export const scavengeHash = stableHash;
export { sha256Hex };
