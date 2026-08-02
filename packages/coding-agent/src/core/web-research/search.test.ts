import { describe, expect, it, vi } from "vitest";
import {
	DuckDuckGoLiteProvider,
	parseDuckDuckGoLiteResults,
	SearxngProvider,
	WebSearchProviderRegistry,
} from "./search.js";
import { WebResearchError, type WebSearchProvider } from "./types.js";
import { canonicalizeWebUrl } from "./url.js";

const PROVIDER_OPTIONS = { timeoutMs: 1000, maxResults: 10, userAgent: "test" };

function searxng(fetchImpl: typeof fetch): SearxngProvider {
	return new SearxngProvider({ ...PROVIDER_OPTIONS, baseUrl: "http://127.0.0.1:18888", fetch: fetchImpl });
}

describe("web search providers", () => {
	it("serializes SearXNG query capabilities deterministically", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ results: [] })));
		await searxng(fetchImpl).search({
			query: "cache stable",
			language: "en",
			freshness: "week",
			categories: ["science", "general"],
			safeSearch: true,
		});
		const url = new URL(String(fetchImpl.mock.calls[0][0]));
		expect(Object.fromEntries(url.searchParams)).toEqual({
			categories: "general,science",
			format: "json",
			language: "en",
			q: "cache stable",
			safesearch: "1",
			time_range: "week",
		});
	});

	it("parses, canonicalizes, deduplicates, and preserves provider order", async () => {
		const fetchImpl: typeof fetch = async () =>
			new Response(
				JSON.stringify({
					results: [
						{
							title: " First ",
							url: "https://example.com/a?utm_source=x&b=2&a=1#fragment",
							content: "one",
							engine: "bing",
						},
						{ title: "Duplicate", url: "https://example.com/a?a=1&b=2", content: "duplicate" },
						{ title: "Second", url: "https://example.org/b", content: "two", score: 0.4 },
					],
				}),
			);
		const response = await searxng(fetchImpl).search({ query: "q", maxResults: 10 });
		expect(response.rawResultCount).toBe(3);
		expect(response.deduplicatedCount).toBe(1);
		expect(response.results.map(({ title, url, rank, provider }) => ({ title, url, rank, provider }))).toEqual([
			{ title: "First", url: "https://example.com/a?a=1&b=2", rank: 1, provider: "searxng" },
			{ title: "Second", url: "https://example.org/b", rank: 2, provider: "searxng" },
		]);
	});

	it("distinguishes empty results from malformed and failed providers", async () => {
		await expect(
			searxng(async () => new Response('{"results":[]}')).search({ query: "none" }),
		).resolves.toMatchObject({
			results: [],
		});
		await expect(searxng(async () => new Response("{}")).search({ query: "bad" })).rejects.toMatchObject({
			code: "PROVIDER_RESPONSE_INVALID",
		});
		await expect(
			searxng(async () => new Response("down", { status: 503 })).search({ query: "bad" }),
		).rejects.toMatchObject({
			code: "PROVIDER_UNAVAILABLE",
		});
	});

	it("keeps DuckDuckGo Lite compatibility", async () => {
		const html = `<table><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">Docs &amp; API</a><td class="result-snippet">Official <b>docs</b>.</td></table>`;
		expect(parseDuckDuckGoLiteResults(html)).toEqual([
			expect.objectContaining({
				title: "Docs & API",
				url: "https://example.com/docs",
				snippet: "Official docs.",
				provider: "duckduckgo-lite",
				rank: 1,
			}),
		]);
	});

	it("falls back only on operational failure, not zero results", async () => {
		let fallbackCalls = 0;
		const emptyPrimary: WebSearchProvider = {
			id: "searxng",
			capabilities: { freshness: true, language: true, region: false, categories: true, safeSearch: true },
			search: async (request) => ({
				provider: "searxng",
				query: request.query,
				results: [],
				rawResultCount: 0,
				deduplicatedCount: 0,
				durationMs: 1,
			}),
			healthCheck: async () => ({ provider: "searxng", status: "healthy" }),
		};
		const fallback: WebSearchProvider = {
			id: "duckduckgo-lite",
			capabilities: { freshness: false, language: false, region: true, categories: false, safeSearch: false },
			search: async (request) => {
				fallbackCalls++;
				return {
					provider: "duckduckgo-lite",
					query: request.query,
					results: [],
					rawResultCount: 0,
					deduplicatedCount: 0,
					durationMs: 1,
				};
			},
			healthCheck: async () => ({ provider: "duckduckgo-lite", status: "healthy" }),
		};
		const registry = new WebSearchProviderRegistry([emptyPrimary, fallback]);
		await expect(registry.search("auto", { query: "none" })).resolves.toMatchObject({ provider: "searxng" });
		expect(fallbackCalls).toBe(0);
		emptyPrimary.search = async () => {
			throw new WebResearchError("PROVIDER_UNAVAILABLE", "down", { provider: "searxng" });
		};
		await expect(registry.search("auto", { query: "fallback" })).resolves.toMatchObject({
			provider: "duckduckgo-lite",
			fallbackFrom: "searxng",
		});
		expect(fallbackCalls).toBe(1);
	});

	it("honors explicit provider selection without fallback", async () => {
		const failed = searxng(async () => new Response("down", { status: 503 }));
		const duck = new DuckDuckGoLiteProvider({
			...PROVIDER_OPTIONS,
			fetch: async () => new Response("<table></table>"),
		});
		const registry = new WebSearchProviderRegistry([failed, duck]);
		await expect(registry.search("searxng", { query: "q" })).rejects.toMatchObject({ provider: "searxng" });
	});

	it("propagates caller abort", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(searxng(fetch).search({ query: "q", signal: controller.signal })).rejects.toMatchObject({
			code: "ABORTED",
		});
	});

	it("canonical URL serialization removes trackers and sorts only unordered query parameters", () => {
		expect(canonicalizeWebUrl("HTTPS://Example.COM:443/a/?z=2&utm_campaign=x&a=1#x")).toBe(
			"https://example.com/a?a=1&z=2",
		);
	});
});
