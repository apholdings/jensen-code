import { describe, expect, it } from "vitest";
import { DeepResearchEngine } from "./research.js";
import { WebSearchProviderRegistry } from "./search.js";
import type { WebFetchRequest, WebFetchResponse, WebSearchProvider, WebSearchResult } from "./types.js";

/**
 * Fetch-enforcement policy:
 * - deep_research collects evidence only through the secure fetcher (web_fetch).
 * - shell/curl output is never imported as evidence by the research engine.
 * - a failed fetch cannot become a directly supported claim.
 */

const RESULTS: WebSearchResult[] = [
	{
		title: "Primary source",
		url: "https://docs.example.com/a",
		snippet: "base damage 225",
		provider: "searxng",
		engine: "bing",
		rank: 1,
	},
	{
		title: "Second source",
		url: "https://agency.gov/b",
		snippet: "base damage 225",
		provider: "searxng",
		engine: "brave",
		rank: 2,
	},
	{
		title: "Inaccessible source",
		url: "https://blocked.example.net/c",
		snippet: "base damage 999",
		provider: "searxng",
		engine: "brave",
		rank: 3,
	},
];

function provider(): WebSearchProvider {
	return {
		id: "searxng",
		capabilities: { freshness: true, language: true, region: false, categories: true, safeSearch: true },
		search: async (request) => ({
			provider: "searxng",
			query: request.query,
			results: RESULTS,
			rawResultCount: RESULTS.length,
			deduplicatedCount: 0,
			durationMs: 1,
		}),
		healthCheck: async () => ({ provider: "searxng", status: "healthy" }),
	};
}

function makeEngine(fetchImpl: (request: WebFetchRequest) => Promise<WebFetchResponse>) {
	const registry = new WebSearchProviderRegistry([provider(), { ...provider(), id: "duckduckgo-lite" as const }]);
	return new DeepResearchEngine(
		registry,
		"searxng",
		{ fetch: fetchImpl },
		{
			maxQueries: 2,
			maxSources: 3,
			maxBytes: 10_000,
			maxBrowserRenders: 0,
			maxElapsedMs: 5000,
			maxParallelFetches: 2,
		},
	);
}

describe("fetch enforcement in deep_research", () => {
	it("collects evidence only through the secure fetcher, never shell output", async () => {
		const fetchedUrls: string[] = [];
		const engine = makeEngine((request) => {
			fetchedUrls.push(request.url);
			const id = request.url.includes("gov") ? "web-b" : "web-a";
			const content = "base damage 225";
			return Promise.resolve({
				evidence: {
					evidenceId: id,
					sourceType: "web",
					requestedUrl: request.url,
					finalUrl: request.url,
					canonicalUrl: request.url,
					title: id,
					retrievedAt: "2026-08-02T00:00:00.000Z",
					contentType: "text/html",
					extractor: "readability",
					contentSha256: id.padEnd(64, "0"),
					completeContentLocation: `session:tool-result:${id}`,
					completeContent: content,
					relevantPassages: [{ id: `p-${id}`, text: content, startLine: 1, endLine: 1 }],
					outboundLinks: [],
					bytesDownloaded: 50,
					bytesExtracted: content.length,
					truncated: false,
					untrusted: true,
				},
				content,
				rendered: false,
				durationMs: 1,
			});
		});
		const result = await engine.run({ objective: "Find base damage", maxSources: 2 });
		// Every selected/evidence source passed through the fetcher.
		expect(fetchedUrls.length).toBeGreaterThan(0);
		expect(fetchedUrls.every((url) => url.startsWith("https://"))).toBe(true);
		expect(result.bundle.evidence.every((e) => e.sourceType === "web")).toBe(true);
	});

	it("does not convert a failed fetch into a directly supported claim", async () => {
		const engine = makeEngine(() => Promise.reject(new Error("SOURCE_BLOCKED")));
		const result = await engine.run({ objective: "Find base damage", maxSources: 2 });
		expect(result.partial).toBe(true);
		expect(result.events.some((event) => event.type === "SOURCE_REJECTED")).toBe(true);
		// The blocked source's claimed 999 must not appear as a direct claim.
		expect(result.bundle.claims.some((claim) => claim.text.includes("999"))).toBe(false);
		expect(result.bundle.contradictions.length).toBe(0);
	});
});
