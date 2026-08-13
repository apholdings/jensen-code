/**
 * Action Decoder — normalized model-output boundary.
 *
 * Normalizes heterogeneous provider/model output (native tool calls,
 * structured JSON envelopes, plain-text fallback) into the finite
 * Jensen-owned AgentAction union. The rest of the runtime never inspects raw
 * provider output directly.
 */

import type { ActionValidationFailure, AgentAction, ToolCallAction } from "./types.js";

export type ActionDecodeResult = { ok: true; action: AgentAction } | { ok: false; failure: ActionValidationFailure };

interface RawNativeToolCall {
	name?: unknown;
	id?: unknown;
	toolCallId?: unknown;
	tool_call_id?: unknown;
	arguments?: unknown;
	argumentsString?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function decodeNativeToolCall(raw: RawNativeToolCall): ToolCallAction | null {
	const name = asString(raw.name);
	if (!name) return null;

	let args: Record<string, unknown> = {};
	if (isRecord(raw.arguments)) {
		args = raw.arguments;
	} else if (typeof raw.argumentsString === "string" && raw.argumentsString.trim().length > 0) {
		try {
			const parsed: unknown = JSON.parse(raw.argumentsString);
			if (isRecord(parsed)) args = parsed;
			else return null;
		} catch {
			// Unparseable argument string — leave args empty; validation will
			// reject missing required arguments. Never fabricate args here.
		}
	}

	const id = asString(raw.toolCallId) ?? asString(raw.id) ?? asString(raw.tool_call_id) ?? `tc_${name}`;

	return { type: "tool_call", tool: name, toolCallId: id, arguments: args };
}

function decodeEnvelope(raw: Record<string, unknown>): AgentAction | null {
	const type = asString(raw.type);
	switch (type) {
		case "tool_call": {
			const tool = asString(raw.tool);
			if (!tool) return null;
			const args = isRecord(raw.arguments) ? raw.arguments : {};
			return {
				type: "tool_call",
				tool,
				toolCallId: asString(raw.toolCallId) ?? `tc_${tool}`,
				arguments: args,
				reason: asString(raw.reason),
			};
		}
		case "request_context":
			return { type: "request_context", query: asString(raw.query) ?? "" };
		case "mission_update":
			return {
				type: "mission_update",
				objective: asString(raw.objective),
				completedObjectives: Array.isArray(raw.completedObjectives)
					? raw.completedObjectives.filter((x): x is string => typeof x === "string")
					: undefined,
				note: asString(raw.note),
			};
		case "final_candidate":
			return {
				type: "final_candidate",
				summary: asString(raw.summary),
				claimedCriterionIds: Array.isArray(raw.claimedCriterionIds)
					? raw.claimedCriterionIds.filter((x): x is string => typeof x === "string")
					: undefined,
			};
		case "blocked":
			return { type: "blocked", reason: asString(raw.reason) ?? "model reported blocked" };
		case "no_op":
			return { type: "no_op", reason: asString(raw.reason) };
		default:
			return null;
	}
}

/** Recognize a plain-text completion/blocked signal for text-only fallback. */
function decodeText(text: string): AgentAction | null {
	const trimmed = text.trim();
	if (/\bFINAL_CANDIDATE\b/i.test(trimmed) || /\bMISSION_COMPLETE\b/i.test(trimmed)) {
		return { type: "final_candidate", summary: trimmed.slice(0, 512) };
	}
	if (/^BLOCKED:?\s*/i.test(trimmed)) {
		return { type: "blocked", reason: trimmed.replace(/^BLOCKED:?\s*/i, "").slice(0, 512) };
	}
	// Local models frequently wrap structured output in fenced code blocks.
	// Extract the first JSON object/array and decode it as an envelope.
	const json = extractJsonPayload(trimmed);
	if (json !== undefined) {
		return decodeEnvelope(json);
	}
	return null;
}

/**
 * Extract the first balanced JSON object/array from free-form text (including
 * ```json fenced blocks and surrounding prose). Uses a brace/string scanner so
 * nested objects are handled correctly. Returns undefined when no balanced JSON
 * payload is present.
 */
function extractJsonPayload(text: string): Record<string, unknown> | undefined {
	// Prefer the contents of a fenced code block when present.
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const candidate = fenced ? fenced[1] : text;

	const open = candidate.search(/[{[]/);
	if (open === -1) return undefined;

	const stack: string[] = [];
	let inString = false;
	let escaped = false;

	for (let i = open; i < candidate.length; i++) {
		const ch = candidate[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === "\\") {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{" || ch === "[") {
			stack.push(ch);
		} else if (ch === "}" || ch === "]") {
			const top = stack.pop();
			if ((ch === "}" && top !== "{") || (ch === "]" && top !== "[")) {
				return undefined;
			}
			if (stack.length === 0) {
				const slice = candidate.slice(open, i + 1);
				try {
					const parsed: unknown = JSON.parse(slice);
					if (isRecord(parsed)) return parsed;
				} catch {
					return undefined;
				}
			}
		}
	}
	return undefined;
}

/**
 * Decode raw model output into an AgentAction. Returns a structured failure
 * (never throws) when the output cannot be normalized.
 */
export function decodeAction(raw: unknown): ActionDecodeResult {
	if (isRecord(raw)) {
		const record = raw as RawNativeToolCall;
		// Native tool-call shape takes precedence when a tool name is present.
		const native = decodeNativeToolCall(record);
		if (native) return { ok: true, action: native };

		const envelope = decodeEnvelope(record as Record<string, unknown>);
		if (envelope) return { ok: true, action: envelope };

		return {
			ok: false,
			failure: {
				category: "UNKNOWN_ACTION_TYPE",
				message: `Unrecognized action shape: ${Object.keys(raw).join(", ") || "(empty object)"}`,
				recoverable: true,
				details: { keys: Object.keys(raw) },
			},
		};
	}

	if (typeof raw === "string") {
		const textAction = decodeText(raw);
		if (textAction) return { ok: true, action: textAction };
		// Plain text with no tool call and no signal is a non-executable turn.
		return { ok: true, action: { type: "no_op", reason: "text-only turn" } };
	}

	return {
		ok: false,
		failure: {
			category: "UNKNOWN_ACTION_TYPE",
			message: `Expected an object or string action, got ${typeof raw}`,
			recoverable: true,
		},
	};
}
