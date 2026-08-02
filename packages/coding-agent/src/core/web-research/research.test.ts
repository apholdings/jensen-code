import { describe, expect, it } from "vitest";
import { DeepResearchEngine } from "./research.js";
import { WebSearchProviderRegistry } from "./search.js";
import type {
	WebEvidenceRecord,
	WebFetchRequest,
	WebFetchResponse,
	WebSearchProvider,
	WebSearchResult,
} from "./types.js";

const RESULTS: WebSearchResult[] = [
	{
		title: "Vendor primary documentation",
		url: "https://docs.example.com/primary",
		snippet: "The feature is enabled and supported.",
		provider: "searxng",
		engine: "bing",
		rank: 1,
	},
	{
		title: "Government assessment",
		url: "https://agency.gov/report",
		snippet: "Independent assessment of the feature.",
		provider: "searxng",
		engine: "brave",
		rank: 2,
	},
	{
		title: "Contrary analysis",
		url: "https://analysis.example.net/report",
		snippet: "The feature is not supported in old deployments.",
		provider: "searxng",
		engine: "bing",
		rank: 3,
	},
	{
		title: "Duplicate",
		url: "https://docs.example.com/primary#copy",
		snippet: "duplicate",
		provider: "searxng",
		rank: 4,
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

function evidence(url: string): WebEvidenceRecord {
	const negative = url.includes("analysis");
	const content = negative
		? "The deployed feature is not enabled and is never supported for old deployments according to the assessment."
		: "The deployed feature is enabled and is supported for old deployments according to the assessment.";
	const id = negative ? "web-negative" : url.includes("agency") ? "web-agency" : "web-primary";
	return {
		evidenceId: id,
		sourceType: "web",
		requestedUrl: url,
		finalUrl: url,
		canonicalUrl: url,
		title: id,
		retrievedAt: "2026-08-02T00:00:00.000Z",
		contentType: "text/html",
		extractor: "readability",
		contentSha256: id.padEnd(64, "0"),
		completeContentLocation: `session:tool-result:${id}`,
		completeContent: content,
		relevantPassages: [{ id: "passage-1-1", text: content, startLine: 1, endLine: 1 }],
		outboundLinks: [],
		bytesDownloaded: 100,
		bytesExtracted: content.length,
		truncated: false,
		untrusted: true,
	};
}

function fetcher(failUrl?: string): { fetch(request: WebFetchRequest): Promise<WebFetchResponse> } {
	return {
		fetch: async (request) => {
			if (request.url === failUrl) throw new Error("fixture source failed");
			const record = evidence(request.url);
			return { evidence: record, content: record.completeContent, rendered: false, durationMs: 1 };
		},
	};
}

function engine(failUrl?: string): DeepResearchEngine {
	const fallback = { ...provider(), id: "duckduckgo-lite" as const };
	return new DeepResearchEngine(new WebSearchProviderRegistry([provider(), fallback]), "searxng", fetcher(failUrl), {
		maxQueries: 4,
		maxSources: 3,
		maxBytes: 10_000,
		maxBrowserRenders: 0,
		maxElapsedMs: 5000,
		maxParallelFetches: 2,
	});
}

describe("bounded deep research", () => {
	it("plans bounded distinct queries and collects parallel results in declared order", async () => {
		const result = await engine().run({
			objective: "Compare feature support and deployment behavior",
			maxQueries: 3,
			maxSources: 3,
		});
		expect(result.queries.length).toBeGreaterThanOrEqual(2);
		expect(result.queries.length).toBeLessThanOrEqual(3);
		expect(new Set(result.queries).size).toBe(result.queries.length);
		expect(result.providerResponses.map((response) => response.query)).toEqual(result.queries);
		expect(result.events.map((event) => event.sequence)).toEqual(result.events.map((_event, index) => index + 1));
	});

	it("reserves query budget for a bounded follow-up when initial evidence is insufficient", async () => {
		const result = await engine("https://docs.example.com/primary").run({
			objective: "Compare feature support and deployment behavior",
			maxQueries: 3,
			maxSources: 1,
		});
		expect(result.queries).toHaveLength(3);
		expect(result.events.filter((event) => event.type === "FOLLOWUP_QUERY_PLANNED")).toHaveLength(1);
		expect(result.providerResponses.map((response) => response.query)).toEqual(result.queries);
	});

	it("deduplicates sources, prefers primary domains, and creates traceable claims", async () => {
		const result = await engine().run({
			objective: "Compare feature support and deployment behavior",
			maxQueries: 2,
			maxSources: 3,
			preferredDomains: ["docs.example.com"],
		});
		expect(result.bundle.evidence[0].canonicalUrl).toBe("https://docs.example.com/primary");
		expect(new Set(result.bundle.evidence.map((item) => item.canonicalUrl)).size).toBe(result.bundle.evidence.length);
		expect(result.bundle.claims.every((claim) => claim.citations[0]?.evidenceId)).toBe(true);
		expect(result.bundle.claims[0].citations[0]).toMatchObject({
			claimId: "claim-1",
			contentSha256: expect.stringMatching(/^web-primary/),
			passageId: "passage-1-1",
		});
	});

	it("detects potential contradictions and marks affected claims", async () => {
		const result = await engine().run({
			objective: "Compare feature support and deployment behavior",
			maxSources: 3,
		});
		expect(result.bundle.contradictions.length).toBeGreaterThan(0);
		expect(result.events.some((event) => event.type === "CONTRADICTION_FOUND")).toBe(true);
		expect(result.bundle.claims.some((claim) => claim.support === "contradicted")).toBe(true);
	});

	it("recovers partial evidence when one selected source fails", async () => {
		const result = await engine("https://agency.gov/report").run({
			objective: "Compare feature support and deployment behavior",
			maxSources: 3,
		});
		expect(result.partial).toBe(true);
		expect(result.bundle.evidence.length).toBe(2);
		expect(result.events).toContainEqual(expect.objectContaining({ type: "SOURCE_REJECTED" }));
	});

	it("is deterministic for evidence identity and replay-relevant event ordering", async () => {
		const first = await engine().run({ objective: "Compare feature support and deployment behavior", maxQueries: 2 });
		const second = await engine().run({
			objective: "Compare feature support and deployment behavior",
			maxQueries: 2,
		});
		expect(first.bundle.id).toBe(second.bundle.id);
		expect(first.bundle.contentSha256).toBe(second.bundle.contentSha256);
		expect(first.events.map((event) => event.type)).toEqual(second.events.map((event) => event.type));
	});

	it("honors cancellation before any provider work", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(engine().run({ objective: "research this", signal: controller.signal })).rejects.toMatchObject({
			code: "ABORTED",
		});
	});
});
