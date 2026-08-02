import type { Context, Message, Tool, Usage } from "@apholdings/jensen-ai";

export interface StableContextPrefix {
	systemPrompt: string;
	tools: Tool[];
}

export interface DynamicContextSuffix {
	hostContext?: string;
	messages: Message[];
}

export interface ContextCacheSnapshot {
	prefixFingerprint: string;
	systemFingerprint: string;
	toolsFingerprint: string;
	stablePrefixBytes: number;
	dynamicSuffixBytes: number;
	provider: string;
	model: string;
}

export interface ContextCacheDiagnostics extends ContextCacheSnapshot {
	prefixChanged: boolean;
	changeReasons: Array<"initial" | "system" | "tools" | "provider" | "model">;
	continuity: "initial" | "continued" | "invalidated";
	cachedInputTokens?: number;
	cacheWriteTokens?: number;
	uncachedInputTokens?: number;
}

export interface CacheStableContext {
	stablePrefix: StableContextPrefix;
	dynamicSuffix: DynamicContextSuffix;
	providerContext: Context;
	snapshot: ContextCacheSnapshot;
}

function normalizeNewlines(value: string): string {
	return value.replace(/\r\n?/g, "\n");
}

function canonicalize(value: unknown, normalizeText: boolean, seen: Set<object>): unknown {
	if (typeof value === "string") {
		return normalizeText ? normalizeNewlines(value) : value;
	}
	if (value === null || typeof value === "boolean" || typeof value === "number") {
		return value;
	}
	if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
		return undefined;
	}
	if (Array.isArray(value)) {
		return value.map((item) => canonicalize(item, normalizeText, seen) ?? null);
	}
	if (typeof value === "object") {
		if (seen.has(value)) {
			throw new TypeError("Cannot canonicalize a cyclic context value");
		}
		seen.add(value);
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			const item = canonicalize((value as Record<string, unknown>)[key], normalizeText, seen);
			if (item !== undefined) {
				result[key] = item;
			}
		}
		seen.delete(value);
		return result;
	}
	return undefined;
}

/** Deterministic JSON for cache metadata. Arrays retain their semantic order. */
export function toCanonicalContextJson(value: unknown, options: { normalizeText?: boolean } = {}): string {
	return JSON.stringify(canonicalize(value, options.normalizeText === true, new Set<object>()));
}

function canonicalizeToolSchema(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(canonicalizeToolSchema);
	}
	if (value === null || typeof value !== "object") {
		return typeof value === "string" ? normalizeNewlines(value) : value;
	}
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) {
		const schemaValue = (value as Record<string, unknown>)[key];
		if (key === "required" && Array.isArray(schemaValue) && schemaValue.every((item) => typeof item === "string")) {
			result[key] = [...schemaValue].sort();
		} else {
			result[key] = canonicalizeToolSchema(schemaValue);
		}
	}
	return result;
}

async function sha256(value: string): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function byteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function canonicalizeTools(tools: Tool[] | undefined): Tool[] {
	return (tools ?? [])
		.map((tool) => ({
			name: normalizeNewlines(tool.name),
			description: normalizeNewlines(tool.description),
			parameters: canonicalizeToolSchema(tool.parameters) as Tool["parameters"],
		}))
		.sort((left, right) => {
			const byName = left.name.localeCompare(right.name);
			if (byName !== 0) return byName;
			const byDescription = left.description.localeCompare(right.description);
			if (byDescription !== 0) return byDescription;
			return toCanonicalContextJson(left.parameters).localeCompare(toCanonicalContextJson(right.parameters));
		});
}

export async function buildCacheStableContext(options: {
	systemPrompt: string;
	dynamicPrompt?: string;
	messages: Message[];
	tools?: Tool[];
	provider: string;
	model: string;
}): Promise<CacheStableContext> {
	const systemPrompt = normalizeNewlines(options.systemPrompt);
	const tools = canonicalizeTools(options.tools);
	const hostContext = options.dynamicPrompt ? normalizeNewlines(options.dynamicPrompt) : undefined;
	const dynamicMessages: Message[] = hostContext
		? [
				{
					role: "user",
					content: [{ type: "text", text: `<host-context>\n${hostContext}\n</host-context>` }],
					timestamp: 0,
				},
				...options.messages,
			]
		: options.messages;

	const stablePrefix: StableContextPrefix = { systemPrompt, tools };
	const dynamicSuffix: DynamicContextSuffix = { hostContext, messages: options.messages };
	const systemJson = toCanonicalContextJson(systemPrompt, { normalizeText: true });
	const toolsJson = toCanonicalContextJson(tools, { normalizeText: true });
	const stableJson = toCanonicalContextJson(stablePrefix, { normalizeText: true });
	const dynamicJson = toCanonicalContextJson(dynamicSuffix);
	const [systemFingerprint, toolsFingerprint, prefixFingerprint] = await Promise.all([
		sha256(systemJson),
		sha256(toolsJson),
		sha256(stableJson),
	]);

	return {
		stablePrefix,
		dynamicSuffix,
		providerContext: {
			systemPrompt,
			messages: dynamicMessages,
			tools,
		},
		snapshot: {
			prefixFingerprint,
			systemFingerprint,
			toolsFingerprint,
			stablePrefixBytes: byteLength(stableJson),
			dynamicSuffixBytes: byteLength(dynamicJson),
			provider: options.provider,
			model: options.model,
		},
	};
}

export function createContextCacheDiagnostics(
	current: ContextCacheSnapshot,
	previous: ContextCacheSnapshot | undefined,
	usage: Usage,
): ContextCacheDiagnostics {
	const changeReasons: ContextCacheDiagnostics["changeReasons"] = [];
	if (!previous) {
		changeReasons.push("initial");
	} else {
		if (previous.systemFingerprint !== current.systemFingerprint) changeReasons.push("system");
		if (previous.toolsFingerprint !== current.toolsFingerprint) changeReasons.push("tools");
		if (previous.provider !== current.provider) changeReasons.push("provider");
		if (previous.model !== current.model) changeReasons.push("model");
	}
	const providerChanged = previous !== undefined && previous.provider !== current.provider;
	const modelChanged = previous !== undefined && previous.model !== current.model;

	return {
		...current,
		prefixChanged: previous !== undefined && previous.prefixFingerprint !== current.prefixFingerprint,
		changeReasons,
		continuity: !previous ? "initial" : providerChanged || modelChanged ? "invalidated" : "continued",
		cachedInputTokens: usage.cache?.readTokens,
		cacheWriteTokens: usage.cache?.writeTokens,
		uncachedInputTokens: usage.cache?.uncachedInputTokens,
	};
}
