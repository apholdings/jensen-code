import {
	WebResearchError,
	type WebSearchProvider,
	type WebSearchProviderHealth,
	type WebSearchProviderId,
	type WebSearchProviderSelection,
	type WebSearchRequest,
	type WebSearchResponse,
	type WebSearchResult,
} from "./types.js";
import { canonicalizeWebUrl, normalizeDomain } from "./url.js";

const HTML_ENTITY_MAP: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

interface SearchProviderOptions {
	fetch?: typeof fetch;
	timeoutMs: number;
	maxResults: number;
	userAgent: string;
}

interface SearxngOptions extends SearchProviderOptions {
	baseUrl: string;
}

interface SearxngResult {
	title?: unknown;
	url?: unknown;
	content?: unknown;
	publishedDate?: unknown;
	engine?: unknown;
	score?: unknown;
}

interface SearxngPayload {
	query?: unknown;
	results?: unknown;
}

function timeoutSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function elapsed(started: number): number {
	return Math.max(0, Math.round(performance.now() - started));
}

function normalizeLimit(value: number | undefined, maximum: number): number {
	if (value === undefined) return Math.min(5, maximum);
	if (!Number.isFinite(value)) throw new WebResearchError("INVALID_REQUEST", "Search result limit must be finite");
	return Math.min(maximum, Math.max(1, Math.floor(value)));
}

function normalizeResults(
	results: Omit<WebSearchResult, "rank">[],
	maximum: number,
): {
	results: WebSearchResult[];
	deduplicatedCount: number;
} {
	const seen = new Set<string>();
	const normalized: Omit<WebSearchResult, "rank">[] = [];
	let duplicates = 0;
	for (const result of results) {
		let canonical: string;
		try {
			canonical = canonicalizeWebUrl(result.url);
		} catch {
			continue;
		}
		if (seen.has(canonical)) {
			duplicates++;
			continue;
		}
		seen.add(canonical);
		normalized.push({
			...result,
			title: normalizeWhitespace(result.title),
			url: canonical,
			source: result.source ?? normalizeDomain(new URL(canonical).hostname),
		});
	}
	return {
		results: normalized.slice(0, maximum).map((result, index) => ({ ...result, rank: index + 1 })),
		deduplicatedCount: duplicates,
	};
}

function normalizeWhitespace(value: string): string {
	return value.replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim();
}

function optionalText(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? normalizeWhitespace(value) : undefined;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function decodeHtmlEntities(value: string): string {
	return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
		if (/^#x/i.test(entity)) {
			const point = Number.parseInt(entity.slice(2), 16);
			return Number.isFinite(point) ? String.fromCodePoint(point) : match;
		}
		if (entity.startsWith("#")) {
			const point = Number.parseInt(entity.slice(1), 10);
			return Number.isFinite(point) ? String.fromCodePoint(point) : match;
		}
		return HTML_ENTITY_MAP[entity] ?? match;
	});
}

function cleanHtmlText(value: string): string {
	return normalizeWhitespace(decodeHtmlEntities(value.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " "))).replace(
		/\s+([.,;:!?])/g,
		"$1",
	);
}

function resolveDuckDuckGoHref(rawHref: string): string | undefined {
	try {
		const redirect = new URL(decodeHtmlEntities(rawHref), "https://duckduckgo.com");
		return redirect.searchParams.get("uddg") ?? redirect.toString();
	} catch {
		return undefined;
	}
}

export function parseDuckDuckGoLiteResults(html: string, limit = 5): WebSearchResult[] {
	const parsed: Omit<WebSearchResult, "rank">[] = [];
	const pattern =
		/<a(?=[^>]*class=['"]result-link['"])(?=[^>]*href=['"]([^'"]+)['"])[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a(?=[^>]*class=['"]result-link['"])|<\/table>|<form action=['"]\/lite\/['"]|$)/gi;
	for (const match of html.matchAll(pattern)) {
		const url = resolveDuckDuckGoHref(match[1]);
		const title = cleanHtmlText(match[2]);
		const tail = match[3] ?? "";
		const snippet = cleanHtmlText(/<td class=['"]result-snippet['"]>([\s\S]*?)<\/td>/i.exec(tail)?.[1] ?? "");
		if (!url || !title) continue;
		parsed.push({ title, url, snippet: snippet || undefined, provider: "duckduckgo-lite" });
	}
	return normalizeResults(parsed, limit).results;
}

export class DuckDuckGoLiteProvider implements WebSearchProvider {
	readonly id = "duckduckgo-lite" as const;
	readonly capabilities = { freshness: false, language: false, region: true, categories: false, safeSearch: false };
	private readonly fetchImpl: typeof fetch;

	constructor(private readonly options: SearchProviderOptions) {
		this.fetchImpl = options.fetch ?? fetch;
	}

	async search(request: WebSearchRequest): Promise<WebSearchResponse> {
		const query = request.query.trim();
		if (!query) throw new WebResearchError("INVALID_REQUEST", "Search query must not be empty");
		const limit = normalizeLimit(request.maxResults, this.options.maxResults);
		const started = performance.now();
		const body = new URLSearchParams({ q: query });
		if (request.region) body.set("kl", request.region);
		let response: Response;
		try {
			response = await this.fetchImpl("https://lite.duckduckgo.com/lite/", {
				method: "POST",
				headers: {
					Accept: "text/html,application/xhtml+xml",
					"Content-Type": "application/x-www-form-urlencoded",
					"User-Agent": this.options.userAgent,
				},
				body,
				signal: timeoutSignal(request.signal, this.options.timeoutMs),
			});
		} catch (error) {
			if (request.signal?.aborted)
				throw new WebResearchError("ABORTED", "DuckDuckGo search was aborted", { cause: error });
			throw new WebResearchError("PROVIDER_UNAVAILABLE", "DuckDuckGo Lite search failed", {
				cause: error,
				provider: this.id,
			});
		}
		if (!response.ok) {
			throw new WebResearchError("PROVIDER_UNAVAILABLE", `DuckDuckGo Lite search failed: ${response.status}`, {
				provider: this.id,
			});
		}
		const html = await response.text();
		const results = parseDuckDuckGoLiteResults(html, limit);
		return {
			provider: this.id,
			query,
			results,
			rawResultCount: results.length,
			deduplicatedCount: 0,
			durationMs: elapsed(started),
		};
	}

	async healthCheck(signal?: AbortSignal): Promise<WebSearchProviderHealth> {
		const started = performance.now();
		try {
			const response = await this.fetchImpl("https://lite.duckduckgo.com/lite/", {
				method: "HEAD",
				headers: { "User-Agent": this.options.userAgent },
				signal: timeoutSignal(signal, Math.min(this.options.timeoutMs, 3000)),
			});
			return response.ok
				? { provider: this.id, status: "healthy", latencyMs: elapsed(started) }
				: {
						provider: this.id,
						status: "unhealthy",
						latencyMs: elapsed(started),
						reason: `HTTP ${response.status}`,
					};
		} catch (error) {
			return { provider: this.id, status: "unknown", latencyMs: elapsed(started), reason: errorMessage(error) };
		}
	}
}

export class SearxngProvider implements WebSearchProvider {
	readonly id = "searxng" as const;
	readonly capabilities = { freshness: true, language: true, region: false, categories: true, safeSearch: true };
	private readonly fetchImpl: typeof fetch;

	constructor(private readonly options: SearxngOptions) {
		this.fetchImpl = options.fetch ?? fetch;
	}

	private searchUrl(request: WebSearchRequest): URL {
		const url = new URL("/search", `${this.options.baseUrl}/`);
		url.searchParams.set("q", request.query.trim());
		url.searchParams.set("format", "json");
		if (request.language) url.searchParams.set("language", request.language);
		if (request.freshness) url.searchParams.set("time_range", request.freshness);
		if (request.categories?.length) url.searchParams.set("categories", [...request.categories].sort().join(","));
		if (request.safeSearch !== undefined) url.searchParams.set("safesearch", request.safeSearch ? "1" : "0");
		return url;
	}

	async search(request: WebSearchRequest): Promise<WebSearchResponse> {
		const query = request.query.trim();
		if (!query) throw new WebResearchError("INVALID_REQUEST", "Search query must not be empty");
		const limit = normalizeLimit(request.maxResults, this.options.maxResults);
		const started = performance.now();
		let response: Response;
		try {
			response = await this.fetchImpl(this.searchUrl({ ...request, query }), {
				headers: { Accept: "application/json", "User-Agent": this.options.userAgent },
				signal: timeoutSignal(request.signal, this.options.timeoutMs),
			});
		} catch (error) {
			if (request.signal?.aborted)
				throw new WebResearchError("ABORTED", "SearXNG search was aborted", { cause: error });
			throw new WebResearchError("PROVIDER_UNAVAILABLE", "SearXNG search failed", {
				cause: error,
				provider: this.id,
			});
		}
		if (!response.ok) {
			throw new WebResearchError("PROVIDER_UNAVAILABLE", `SearXNG search failed with HTTP ${response.status}`, {
				provider: this.id,
			});
		}
		let payload: SearxngPayload;
		try {
			payload = (await response.json()) as SearxngPayload;
		} catch (error) {
			throw new WebResearchError("PROVIDER_RESPONSE_INVALID", "SearXNG returned invalid JSON", {
				cause: error,
				provider: this.id,
			});
		}
		if (!Array.isArray(payload.results)) {
			throw new WebResearchError("PROVIDER_RESPONSE_INVALID", "SearXNG response is missing a results array", {
				provider: this.id,
			});
		}
		const raw = payload.results as SearxngResult[];
		const mapped: Omit<WebSearchResult, "rank">[] = [];
		for (const item of raw) {
			const title = optionalText(item.title);
			const url = optionalText(item.url);
			if (!title || !url) continue;
			mapped.push({
				title,
				url,
				snippet: optionalText(item.content),
				publishedAt: optionalText(item.publishedDate),
				engine: optionalText(item.engine),
				provider: this.id,
				score: optionalNumber(item.score),
			});
		}
		const normalized = normalizeResults(mapped, limit);
		return {
			provider: this.id,
			query,
			results: normalized.results,
			rawResultCount: raw.length,
			deduplicatedCount: normalized.deduplicatedCount,
			durationMs: elapsed(started),
		};
	}

	async healthCheck(signal?: AbortSignal): Promise<WebSearchProviderHealth> {
		const started = performance.now();
		try {
			const url = new URL("/healthz", `${this.options.baseUrl}/`);
			const response = await this.fetchImpl(url, {
				headers: { "User-Agent": this.options.userAgent },
				signal: timeoutSignal(signal, Math.min(this.options.timeoutMs, 3000)),
			});
			return response.ok
				? { provider: this.id, status: "healthy", latencyMs: elapsed(started) }
				: {
						provider: this.id,
						status: "unhealthy",
						latencyMs: elapsed(started),
						reason: `HTTP ${response.status}`,
					};
		} catch (error) {
			return { provider: this.id, status: "unhealthy", latencyMs: elapsed(started), reason: errorMessage(error) };
		}
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class WebSearchProviderRegistry {
	private readonly providers = new Map<WebSearchProviderId, WebSearchProvider>();

	constructor(providers: WebSearchProvider[]) {
		for (const provider of providers) this.providers.set(provider.id, provider);
	}

	get(id: WebSearchProviderId): WebSearchProvider {
		const provider = this.providers.get(id);
		if (!provider) throw new WebResearchError("INVALID_CONFIGURATION", `Search provider ${id} is not registered`);
		return provider;
	}

	list(): WebSearchProvider[] {
		return [...this.providers.values()].sort((left, right) => left.id.localeCompare(right.id));
	}

	async search(selection: WebSearchProviderSelection, request: WebSearchRequest): Promise<WebSearchResponse> {
		if (selection !== "auto") return this.get(selection).search(request);
		const primary = this.get("searxng");
		try {
			return await primary.search(request);
		} catch (error) {
			if (error instanceof WebResearchError && (error.code === "INVALID_REQUEST" || error.code === "ABORTED"))
				throw error;
			const fallback = await this.get("duckduckgo-lite").search(request);
			return { ...fallback, fallbackFrom: primary.id };
		}
	}
}

export function createSearchProviderRegistry(options: SearxngOptions): WebSearchProviderRegistry {
	return new WebSearchProviderRegistry([new SearxngProvider(options), new DuckDuckGoLiteProvider(options)]);
}

export function resultDomain(result: WebSearchResult): string {
	try {
		return normalizeDomain(new URL(result.url).hostname);
	} catch {
		return "";
	}
}
