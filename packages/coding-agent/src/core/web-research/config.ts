import { type WebResearchConfig, WebResearchError } from "./types.js";

const DEFAULT_SEARXNG_URL = "http://127.0.0.1:18888";

function integerEnvironment(
	environment: NodeJS.ProcessEnv,
	name: string,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	const raw = environment[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new WebResearchError(
			"INVALID_CONFIGURATION",
			`${name} must be an integer between ${minimum} and ${maximum}`,
		);
	}
	return value;
}

function booleanEnvironment(environment: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
	const raw = environment[name];
	if (raw === undefined || raw === "") return fallback;
	if (raw === "1" || raw === "true") return true;
	if (raw === "0" || raw === "false") return false;
	throw new WebResearchError("INVALID_CONFIGURATION", `${name} must be true, false, 1, or 0`);
}

function searchProvider(environment: NodeJS.ProcessEnv): WebResearchConfig["primarySearchProvider"] {
	const value = environment.JENSEN_WEB_SEARCH_PROVIDER ?? "auto";
	if (value === "auto" || value === "searxng" || value === "duckduckgo-lite") return value;
	throw new WebResearchError(
		"INVALID_CONFIGURATION",
		"JENSEN_WEB_SEARCH_PROVIDER must be auto, searxng, or duckduckgo-lite",
	);
}

function searxngUrl(environment: NodeJS.ProcessEnv): string {
	const value = environment.JENSEN_SEARXNG_URL ?? DEFAULT_SEARXNG_URL;
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch (error) {
		throw new WebResearchError("INVALID_CONFIGURATION", "JENSEN_SEARXNG_URL must be an absolute HTTP URL", {
			cause: error,
		});
	}
	if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
		throw new WebResearchError(
			"INVALID_CONFIGURATION",
			"JENSEN_SEARXNG_URL must be HTTP(S) and must not contain credentials",
		);
	}
	parsed.hash = "";
	parsed.search = "";
	return parsed.toString().replace(/\/$/, "");
}

export function loadWebResearchConfig(environment: NodeJS.ProcessEnv = process.env): WebResearchConfig {
	return {
		primarySearchProvider: searchProvider(environment),
		searxngUrl: searxngUrl(environment),
		searchTimeoutMs: integerEnvironment(environment, "JENSEN_WEB_SEARCH_TIMEOUT_MS", 10_000, 250, 120_000),
		fetchTimeoutMs: integerEnvironment(environment, "JENSEN_WEB_FETCH_TIMEOUT_MS", 20_000, 500, 180_000),
		maxResponseBytes: integerEnvironment(
			environment,
			"JENSEN_WEB_FETCH_MAX_BYTES",
			5 * 1024 * 1024,
			1024,
			50 * 1024 * 1024,
		),
		maxDecompressedBytes: integerEnvironment(
			environment,
			"JENSEN_WEB_FETCH_MAX_DECOMPRESSED_BYTES",
			10 * 1024 * 1024,
			1024,
			100 * 1024 * 1024,
		),
		maxRedirects: integerEnvironment(environment, "JENSEN_WEB_FETCH_MAX_REDIRECTS", 5, 0, 10),
		maxSearchResults: integerEnvironment(environment, "JENSEN_WEB_SEARCH_MAX_RESULTS", 10, 1, 50),
		safeSearch: booleanEnvironment(environment, "JENSEN_WEB_SAFE_SEARCH", true),
		userAgent:
			environment.JENSEN_WEB_USER_AGENT?.trim() ||
			"Jensen-Code-Web-Research/1.0 (+https://github.com/apholdings/jensen-code)",
		browserExecutablePath: environment.JENSEN_PLAYWRIGHT_EXECUTABLE_PATH?.trim() || undefined,
		research: {
			maxQueries: integerEnvironment(environment, "JENSEN_RESEARCH_MAX_QUERIES", 4, 1, 12),
			maxSources: integerEnvironment(environment, "JENSEN_RESEARCH_MAX_SOURCES", 6, 1, 20),
			maxBytes: integerEnvironment(
				environment,
				"JENSEN_RESEARCH_MAX_BYTES",
				20 * 1024 * 1024,
				1024,
				100 * 1024 * 1024,
			),
			maxBrowserRenders: integerEnvironment(environment, "JENSEN_RESEARCH_MAX_BROWSER_RENDERS", 1, 0, 4),
			maxElapsedMs: integerEnvironment(environment, "JENSEN_RESEARCH_MAX_ELAPSED_MS", 120_000, 1000, 600_000),
			maxParallelFetches: integerEnvironment(environment, "JENSEN_RESEARCH_MAX_PARALLEL_FETCHES", 3, 1, 8),
		},
	};
}
