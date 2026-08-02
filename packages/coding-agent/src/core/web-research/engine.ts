import { loadWebResearchConfig } from "./config.js";
import { SecureWebFetcher } from "./fetch.js";
import { DeepResearchEngine } from "./research.js";
import { createSearchProviderRegistry, type WebSearchProviderRegistry } from "./search.js";
import type {
	DeepResearchRequest,
	DeepResearchResponse,
	WebFetchRequest,
	WebFetchResponse,
	WebResearchConfig,
	WebResearchTelemetry,
	WebSearchProviderHealth,
	WebSearchProviderSelection,
	WebSearchRequest,
	WebSearchResponse,
} from "./types.js";

export interface WebResearchEngineOptions {
	config?: WebResearchConfig;
	registry?: WebSearchProviderRegistry;
	fetcher?: SecureWebFetcher;
}

function createTelemetry(): WebResearchTelemetry {
	return {
		searches: 0,
		queries: 0,
		results: 0,
		deduplicatedResults: 0,
		fallbacks: 0,
		fetches: 0,
		fetchFailures: 0,
		bytesDownloaded: 0,
		bytesExtracted: 0,
		renderFallbacks: 0,
		ssrfBlocks: 0,
		timeouts: 0,
		evidenceRecords: 0,
	};
}

export class WebResearchEngine {
	readonly config: WebResearchConfig;
	readonly telemetry: WebResearchTelemetry;
	readonly registry: WebSearchProviderRegistry;
	readonly fetcher: SecureWebFetcher;
	readonly deepResearch: DeepResearchEngine;

	constructor(options: WebResearchEngineOptions = {}) {
		this.config = options.config ?? loadWebResearchConfig();
		this.telemetry = createTelemetry();
		this.registry =
			options.registry ??
			createSearchProviderRegistry({
				baseUrl: this.config.searxngUrl,
				timeoutMs: this.config.searchTimeoutMs,
				maxResults: this.config.maxSearchResults,
				userAgent: this.config.userAgent,
			});
		this.fetcher = options.fetcher ?? new SecureWebFetcher(this.config, this.telemetry);
		this.deepResearch = new DeepResearchEngine(
			this.registry,
			this.config.primarySearchProvider,
			this.fetcher,
			this.config.research,
		);
	}

	async search(request: WebSearchRequest, provider?: WebSearchProviderSelection): Promise<WebSearchResponse> {
		this.telemetry.searches++;
		this.telemetry.queries++;
		const response = await this.registry.search(provider ?? this.config.primarySearchProvider, {
			...request,
			maxResults: Math.min(request.maxResults ?? 5, this.config.maxSearchResults),
			safeSearch: request.safeSearch ?? this.config.safeSearch,
		});
		this.telemetry.results += response.results.length;
		this.telemetry.deduplicatedResults += response.deduplicatedCount;
		if (response.fallbackFrom) this.telemetry.fallbacks++;
		return response;
	}

	fetch(request: WebFetchRequest): Promise<WebFetchResponse> {
		return this.fetcher.fetch(request);
	}

	research(request: DeepResearchRequest): Promise<DeepResearchResponse> {
		return this.deepResearch.run(request);
	}

	async diagnostics(signal?: AbortSignal): Promise<{
		configuredProvider: WebSearchProviderSelection;
		searxngEndpoint: string;
		providers: WebSearchProviderHealth[];
		fallbackProvider: "duckduckgo-lite";
		browserRenderingAvailable: boolean;
		pdfExtractionAvailable: true;
		budgets: WebResearchConfig["research"];
		telemetry: WebResearchTelemetry;
	}> {
		const providers = await Promise.all(this.registry.list().map((provider) => provider.healthCheck(signal)));
		return {
			configuredProvider: this.config.primarySearchProvider,
			searxngEndpoint: this.config.searxngUrl,
			providers,
			fallbackProvider: "duckduckgo-lite",
			browserRenderingAvailable: this.fetcher.browserAvailable,
			pdfExtractionAvailable: true,
			budgets: { ...this.config.research },
			telemetry: { ...this.telemetry },
		};
	}
}

let defaultEngine: WebResearchEngine | undefined;

export function getDefaultWebResearchEngine(): WebResearchEngine {
	defaultEngine ??= new WebResearchEngine();
	return defaultEngine;
}

export function resetDefaultWebResearchEngine(): void {
	defaultEngine = undefined;
}
