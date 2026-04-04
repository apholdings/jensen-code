import type { AgentTool } from "@apholdings/jensen-agent-core";
import { type Static, Type } from "@sinclair/typebox";

const webSearchSchema = Type.Object({
	query: Type.String({ description: "Search query" }),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results to return (default: 5, max: 10)" })),
});

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const REQUEST_TIMEOUT_MS = 10000;
const DUCKDUCKGO_LITE_URL = "https://lite.duckduckgo.com/lite/";
const DUCKDUCKGO_LITE_PROVIDER = "duckduckgo-lite" as const;
const USER_AGENT = "jensen-code-web-search";

const HTML_ENTITY_MAP: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

export type WebSearchToolInput = Static<typeof webSearchSchema>;

export interface WebSearchResult {
	title: string;
	url: string;
	snippet: string;
	source?: string;
}

export interface WebSearchToolDetails {
	provider: typeof DUCKDUCKGO_LITE_PROVIDER;
	query: string;
	resultCount: number;
	results: WebSearchResult[];
}

export interface WebSearchToolOptions {
	fetch?: typeof fetch;
}

export function createWebSearchTool(options?: WebSearchToolOptions): AgentTool<typeof webSearchSchema> {
	const fetchImpl = options?.fetch ?? fetch;

	return {
		name: "web_search",
		label: "web_search",
		description:
			"Search the public web using DuckDuckGo Lite. Returns bounded read-only results with title, url, snippet, and source domain. No API key required.",
		parameters: webSearchSchema,
		isConcurrencySafe: () => true,
		execute: async (_toolCallId: string, { query, limit }: WebSearchToolInput) => {
			const normalizedQuery = query.trim();
			if (!normalizedQuery) {
				throw new Error("Query must not be empty");
			}

			const effectiveLimit = normalizeLimit(limit);
			const results = await searchDuckDuckGoLite(normalizedQuery, effectiveLimit, fetchImpl);
			const details: WebSearchToolDetails = {
				provider: DUCKDUCKGO_LITE_PROVIDER,
				query: normalizedQuery,
				resultCount: results.length,
				results,
			};

			if (results.length === 0) {
				return {
					content: [{ type: "text", text: `No web results found for "${normalizedQuery}".` }],
					details,
				};
			}

			return {
				content: [{ type: "text", text: formatResultsForPrompt(normalizedQuery, results) }],
				details,
			};
		},
	};
}

export async function searchDuckDuckGoLite(
	query: string,
	limit: number = DEFAULT_LIMIT,
	fetchImpl: typeof fetch = fetch,
): Promise<WebSearchResult[]> {
	const response = await fetchImpl(`${DUCKDUCKGO_LITE_URL}?q=${encodeURIComponent(query)}`, {
		headers: {
			Accept: "text/html,application/xhtml+xml",
			"User-Agent": USER_AGENT,
		},
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});

	if (!response.ok) {
		throw new Error(`DuckDuckGo Lite search failed: ${response.status}`);
	}

	const html = await response.text();
	return parseDuckDuckGoLiteResults(html, normalizeLimit(limit));
}

export function parseDuckDuckGoLiteResults(html: string, limit: number = DEFAULT_LIMIT): WebSearchResult[] {
	const results: WebSearchResult[] = [];
	const resultPattern =
		/<a(?=[^>]*class=['"]result-link['"])(?=[^>]*href="([^"]+)")[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a(?=[^>]*class=['"]result-link['"])|<\/table>|<form action="\/lite\/"|$)/gi;

	for (const match of html.matchAll(resultPattern)) {
		if (results.length >= normalizeLimit(limit)) {
			break;
		}

		const [, rawHref, rawTitle, tail = ""] = match;
		const url = resolveDuckDuckGoHref(rawHref);
		const title = cleanHtmlText(rawTitle);
		const snippet = cleanHtmlText(matchSection(tail, /<td class=['"]result-snippet['"]>([\s\S]*?)<\/td>/i) ?? "");
		const displaySource = cleanHtmlText(
			matchSection(tail, /<span class=['"]link-text['"]>([\s\S]*?)<\/span>/i) ?? "",
		);
		const source = deriveSource(url, displaySource);

		if (!title || !url) {
			continue;
		}

		results.push({
			title,
			url,
			snippet,
			source,
		});
	}

	return results;
}

function normalizeLimit(limit: number | undefined): number {
	if (typeof limit !== "number" || !Number.isFinite(limit)) {
		return DEFAULT_LIMIT;
	}

	return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

function matchSection(value: string, pattern: RegExp): string | undefined {
	return pattern.exec(value)?.[1];
}

function resolveDuckDuckGoHref(rawHref: string): string | undefined {
	try {
		const decodedHref = decodeHtmlEntities(rawHref);
		const redirectUrl = new URL(decodedHref, "https://duckduckgo.com");
		return redirectUrl.searchParams.get("uddg") ?? redirectUrl.toString();
	} catch {
		return undefined;
	}
}

function deriveSource(url: string | undefined, displaySource: string): string | undefined {
	if (url) {
		try {
			return new URL(url).hostname.replace(/^www\./, "") || undefined;
		} catch {
			// Fall back to the provider-supplied display source.
		}
	}

	const cleanedSource = displaySource
		.replace(/^https?:\/\//, "")
		.split("/")[0]
		?.trim();
	return cleanedSource || undefined;
}

function cleanHtmlText(value: string): string {
	return decodeHtmlEntities(value.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " "))
		.replace(/\s+/g, " ")
		.trim();
}

function decodeHtmlEntities(value: string): string {
	return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (_match, entity: string) => {
		if (entity.startsWith("#x") || entity.startsWith("#X")) {
			const codePoint = Number.parseInt(entity.slice(2), 16);
			return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : _match;
		}

		if (entity.startsWith("#")) {
			const codePoint = Number.parseInt(entity.slice(1), 10);
			return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : _match;
		}

		return HTML_ENTITY_MAP[entity] ?? _match;
	});
}

function formatResultsForPrompt(query: string, results: WebSearchResult[]): string {
	const lines = [`Web search results for "${query}" via DuckDuckGo Lite:`];

	for (const [index, result] of results.entries()) {
		lines.push(`${index + 1}. ${result.title}`);
		lines.push(`   URL: ${result.url}`);
		if (result.source) {
			lines.push(`   Source: ${result.source}`);
		}
		lines.push(`   Snippet: ${result.snippet || "(no snippet provided)"}`);
	}

	return lines.join("\n");
}

export const webSearchTool = createWebSearchTool();
