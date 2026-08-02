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

/**
 * Deterministic regression corpus modeled on the DarkOrbit-style failure classes
 * using fictional equipment sources. No live sites, no copyrighted text.
 *
 * Fixture sources:
 * A: official historical value (2017)
 * B: official rebalance value (2019)
 * C: maintained current value (2026)
 * D: community theory about "best"
 * E: search snippet only
 */

const RESULTS: WebSearchResult[] = [
	{
		title: "Official 2017 weapon data",
		url: "https://official.example/2017-weapon",
		snippet: "Official weapon damage 212 base.",
		provider: "searxng",
		engine: "bing",
		rank: 1,
	},
	{
		title: "Official 2019 rebalance notes",
		url: "https://official.example/2019-rebalance",
		snippet: "Weapon damage changed from 212 to 225.",
		provider: "searxng",
		engine: "brave",
		rank: 2,
	},
	{
		title: "Maintained equipment database",
		url: "https://maintained.example/game/db",
		snippet: "Current weapon damage 225, upgrades to level 10.",
		provider: "searxng",
		engine: "bing",
		rank: 3,
	},
	{
		title: "Community theory",
		url: "https://wiki.example/best-build",
		snippet: "This is the best weapon, highest DPS in the game.",
		provider: "searxng",
		engine: "brave",
		rank: 4,
	},
];

function searchProvider(): WebSearchProvider {
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
	const publishedAt = url.includes("2017")
		? "2017-06-01T00:00:00.000Z"
		: url.includes("2019")
			? "2019-03-15T00:00:00.000Z"
			: "2026-05-01T00:00:00.000Z";
	const id = url.includes("2017") ? "web-a" : url.includes("2019") ? "web-b" : url.includes("db") ? "web-c" : "web-d";
	const content =
		id === "web-a"
			? "Official 2017: weapon base damage is 212."
			: id === "web-b"
				? "Official 2019 rebalance: weapon damage changed from 212 to 225."
				: id === "web-c"
					? "Maintained 2026: current weapon base damage is 225; maximum upgrade level is 10."
					: "Community theory: this weapon is the best and has the highest DPS in the game.";
	return {
		evidenceId: id,
		sourceType: "web",
		requestedUrl: url,
		finalUrl: url,
		canonicalUrl: url,
		title: id,
		retrievedAt: "2026-08-02T00:00:00.000Z",
		publishedAt,
		contentType: "text/html",
		extractor: "readability",
		contentSha256: id.padEnd(64, "0"),
		completeContentLocation: `session:tool-result:${id}`,
		completeContent: content,
		relevantPassages: [{ id: `passage-${id}`, text: content, startLine: 1, endLine: 1 }],
		outboundLinks: [],
		bytesDownloaded: 100,
		bytesExtracted: content.length,
		truncated: false,
		untrusted: true,
	};
}

function fetcherFor(_urls: string[]): { fetch(request: WebFetchRequest): Promise<WebFetchResponse> } {
	return {
		fetch: async (request) => {
			const record = evidence(request.url);
			return { evidence: record, content: record.completeContent, rendered: false, durationMs: 1 };
		},
	};
}

function engine(): DeepResearchEngine {
	const fallback = { ...searchProvider(), id: "duckduckgo-lite" as const };
	return new DeepResearchEngine(
		new WebSearchProviderRegistry([searchProvider(), fallback]),
		"searxng",
		fetcherFor(RESULTS.map((result) => result.url)),
		{
			maxQueries: 4,
			maxSources: 4,
			maxBytes: 10_000,
			maxBrowserRenders: 0,
			maxElapsedMs: 5000,
			maxParallelFetches: 2,
		},
	);
}

describe("canonical regression corpus (equipment comparison)", () => {
	it("resolves historical and current values, validates arithmetic, and produces addressable citations", async () => {
		const result = await engine().run({
			objective: "Compare weapon damage across official rebalances and current maintained data",
			maxQueries: 2,
			maxSources: 3,
			facts: {
				temporal: [
					{
						evidenceId: "web-a",
						sourceUrl: "https://official.example/2017-weapon",
						value: 212,
						effectiveAt: "2017-06-01",
						publishedAt: "2017-06-01",
						authority: 2,
					},
					{
						evidenceId: "web-b",
						sourceUrl: "https://official.example/2019-rebalance",
						value: 225,
						effectiveAt: "2019-03-15",
						publishedAt: "2019-03-15",
						authority: 2,
						changeDeclaration: "changed from 212 to 225",
					},
					{
						evidenceId: "web-c",
						sourceUrl: "https://maintained.example/game/db",
						value: 225,
						isMaintained: true,
						authority: 2,
					},
				],
				numericExpressions: [
					{
						facts: [
							{ value: 225, unit: "damage_per_shot", evidenceId: "web-c" },
							{ value: 15, unit: "flat_damage_bonus", evidenceId: "web-c" },
						],
					},
				],
				currentValues: ["225"],
			},
		});

		// Temporal resolution: 212 historical, 225 current, not a contradiction.
		expect(result.bundle.temporal).toBeDefined();
		const temporal = result.bundle.temporal!;
		expect(temporal.unresolved).toBe(false);
		expect(temporal.currentValue).toBe(225);
		const classes = Object.fromEntries(temporal.resolutions.map((r) => [r.evidenceId, r.class]));
		expect(classes["web-a"]).toBe("superseded");
		expect(classes["web-c"]).toBe("current");

		// Numeric: flat +15 applied additively => 240, not 225 × 1.15.
		expect(result.bundle.numericVerifications).toHaveLength(1);
		expect(result.bundle.numericVerifications![0].outcome).toBe("verified");
		expect(result.bundle.numericVerifications![0].computed).toBe(240);

		// Addressable citations on every claim.
		expect(result.synthesis).toContain("Temporal resolution:");
		expect(result.synthesis).toContain("Numeric verification:");
		expect(result.bundle.claims.every((claim) => claim.supports[0]?.evidenceId)).toBe(true);
		expect(result.bundle.claims.every((claim) => claim.supports[0]?.contentSha256)).toBe(true);
		expect(result.bundle.sourceConfidence).toBeDefined();
	});

	it("never emits internal tool bookkeeping in the synthesis", async () => {
		const result = await engine().run({
			objective: "Compare weapon damage",
			maxQueries: 2,
			maxSources: 3,
		});
		const leakedTokens = [
			"todo_update",
			"TODO_READ_REQUIRED",
			"expectedRevision",
			"Current todo list",
			"todo_write",
			"todo_read",
		];
		for (const token of leakedTokens) {
			expect(result.synthesis.toLowerCase()).not.toContain(token.toLowerCase());
		}
		// Synthesis is a self-contained terminal report.
		expect(result.synthesis).toContain("Research objective:");
		expect(result.synthesis).toContain("untrusted evidence");
	});
});

describe("snippet-only and exact-claim policy in the canonical corpus", () => {
	it("keeps the community theory as low confidence / snippet-only and does not promote it to fact", async () => {
		const result = await engine().run({
			objective: "Determine whether a community build is best",
			maxQueries: 2,
			maxSources: 4,
			facts: {
				currentValues: ["225"],
				temporal: [
					{
						evidenceId: "web-d",
						sourceUrl: "https://wiki.example/best-build",
						value: "best",
						authority: 0,
					},
				],
			},
		});
		// Community theory must not become a high-confidence claim, and every
		// claim still carries addressable support.
		expect(result.bundle.sourceConfidence).toBeDefined();
		expect(result.bundle.sourceConfidence!["web-d"]).not.toBe("high");
		expect(result.bundle.claims.every((claim) => claim.supports[0]?.evidenceId)).toBe(true);
		expect(result.bundle.claims.every((claim) => claim.supports[0]?.contentSha256)).toBe(true);
	});
});
