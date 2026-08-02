import { WebResearchEngine } from "../src/core/web-research/engine.js";
import { DuckDuckGoLiteProvider } from "../src/core/web-research/search.js";

const engine = new WebResearchEngine();
const started = performance.now();

const search = await engine.search({ query: "Node.js 24 release notes", maxResults: 5 }, "searxng");
if (search.provider !== "searxng" || search.results.length < 2) throw new Error("SearXNG discovery acceptance failed");
if (new Set(search.results.map((result) => result.url)).size !== search.results.length) {
	throw new Error("SearXNG discovery returned duplicate canonical URLs");
}

const fetched = await engine.fetch({
	url: "https://nodejs.org/en/blog/release/v24.0.0",
	passageQuery: "Node.js 24 V8 npm",
	render: "never",
	maxCharacters: 8000,
});
if (!fetched.evidence.evidenceId || !fetched.evidence.contentSha256 || fetched.content.length < 500) {
	throw new Error("Authoritative page extraction acceptance failed");
}

for (const blockedUrl of ["http://127.0.0.1", "http://169.254.169.254/latest/meta-data"]) {
	try {
		await engine.fetch({ url: blockedUrl });
		throw new Error(`SSRF acceptance unexpectedly allowed ${blockedUrl}`);
	} catch (error) {
		const code = error instanceof Error && "code" in error ? String(error.code) : "";
		if (code !== "DNS_BLOCKED") throw error;
	}
}

const fallback = new DuckDuckGoLiteProvider({
	timeoutMs: 10_000,
	maxResults: 5,
	userAgent: engine.config.userAgent,
});
const fallbackResponse = await fallback.search({ query: "Node.js documentation", maxResults: 3 });
if (fallbackResponse.provider !== "duckduckgo-lite" || fallbackResponse.results.length === 0) {
	throw new Error("DuckDuckGo Lite fallback acceptance failed");
}

const research = await engine.research({
	objective: "Identify the officially documented headline changes in Node.js 24",
	maxQueries: 2,
	maxSources: 2,
	preferredDomains: ["nodejs.org"],
	depth: "quick",
});
if (research.bundle.evidence.length === 0 || research.bundle.claims.length === 0 || !research.bundle.id) {
	throw new Error("Deep research acceptance failed to create cited evidence");
}

const diagnostics = await engine.diagnostics();
const elapsedMs = Math.round(performance.now() - started);
process.stdout.write(
	`${JSON.stringify(
		{
			status: "pass",
			search: {
				provider: search.provider,
				results: search.results.length,
				deduplicated: search.deduplicatedCount,
				durationMs: search.durationMs,
			},
			fetch: {
				evidenceId: fetched.evidence.evidenceId,
				bytesDownloaded: fetched.evidence.bytesDownloaded,
				bytesExtracted: fetched.evidence.bytesExtracted,
				durationMs: fetched.durationMs,
			},
			fallback: { provider: fallbackResponse.provider, results: fallbackResponse.results.length },
			research: {
				queries: research.queries.length,
				sources: research.bundle.evidence.length,
				claims: research.bundle.claims.length,
				partial: research.partial,
				durationMs: research.durationMs,
			},
			capabilities: {
				browser: diagnostics.browserRenderingAvailable,
				pdf: diagnostics.pdfExtractionAvailable,
			},
			telemetry: diagnostics.telemetry,
			elapsedMs,
		},
		null,
		2,
	)}\n`,
);
