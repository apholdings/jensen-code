export type WebFreshness = "day" | "week" | "month" | "year";
export type WebSearchProviderId = "searxng" | "duckduckgo-lite";
export type WebSearchProviderSelection = "auto" | WebSearchProviderId;

export interface WebSearchRequest {
	query: string;
	maxResults?: number;
	language?: string;
	region?: string;
	freshness?: WebFreshness;
	categories?: string[];
	safeSearch?: boolean;
	signal?: AbortSignal;
}

export interface WebSearchResult {
	title: string;
	url: string;
	snippet?: string;
	publishedAt?: string;
	engine?: string;
	provider: WebSearchProviderId;
	rank: number;
	score?: number;
	/** Compatibility display domain; derived from the canonical URL. */
	source?: string;
}

export interface WebSearchResponse {
	provider: WebSearchProviderId;
	query: string;
	results: WebSearchResult[];
	rawResultCount: number;
	deduplicatedCount: number;
	durationMs: number;
	fallbackFrom?: WebSearchProviderId;
}

export interface WebSearchProviderHealth {
	provider: WebSearchProviderId;
	status: "healthy" | "unhealthy" | "unknown";
	latencyMs?: number;
	reason?: string;
}

export interface WebSearchProvider {
	readonly id: WebSearchProviderId;
	readonly capabilities: {
		freshness: boolean;
		language: boolean;
		region: boolean;
		categories: boolean;
		safeSearch: boolean;
	};
	search(request: WebSearchRequest): Promise<WebSearchResponse>;
	healthCheck(signal?: AbortSignal): Promise<WebSearchProviderHealth>;
}

export type WebResearchErrorCode =
	| "INVALID_CONFIGURATION"
	| "INVALID_REQUEST"
	| "PROVIDER_UNAVAILABLE"
	| "PROVIDER_RESPONSE_INVALID"
	| "TIMEOUT"
	| "ABORTED"
	| "URL_BLOCKED"
	| "DNS_BLOCKED"
	| "REDIRECT_LIMIT"
	| "RESPONSE_TOO_LARGE"
	| "CONTENT_TYPE_UNSUPPORTED"
	| "CONTENT_INVALID"
	| "BROWSER_UNAVAILABLE"
	| "PDF_ENCRYPTED"
	| "PDF_IMAGE_ONLY";

export class WebResearchError extends Error {
	readonly code: WebResearchErrorCode;
	readonly provider?: WebSearchProviderId;
	readonly sanitizedUrl?: string;

	constructor(
		code: WebResearchErrorCode,
		message: string,
		options: { cause?: unknown; provider?: WebSearchProviderId; sanitizedUrl?: string } = {},
	) {
		super(message, { cause: options.cause });
		this.name = "WebResearchError";
		this.code = code;
		this.provider = options.provider;
		this.sanitizedUrl = options.sanitizedUrl;
	}
}

export interface WebResearchConfig {
	primarySearchProvider: WebSearchProviderSelection;
	searxngUrl: string;
	searchTimeoutMs: number;
	fetchTimeoutMs: number;
	maxResponseBytes: number;
	maxDecompressedBytes: number;
	maxRedirects: number;
	maxSearchResults: number;
	safeSearch: boolean;
	userAgent: string;
	browserExecutablePath?: string;
	research: WebResearchBudget;
}

export interface WebResearchBudget {
	maxQueries: number;
	maxSources: number;
	maxBytes: number;
	maxBrowserRenders: number;
	maxElapsedMs: number;
	maxParallelFetches: number;
}

export interface WebResearchTelemetry {
	searches: number;
	queries: number;
	results: number;
	deduplicatedResults: number;
	fallbacks: number;
	fetches: number;
	fetchFailures: number;
	bytesDownloaded: number;
	bytesExtracted: number;
	renderFallbacks: number;
	ssrfBlocks: number;
	timeouts: number;
	evidenceRecords: number;
}

export type WebExtractionMode = "auto" | "html" | "text" | "json" | "xml" | "pdf";

export interface WebFetchRequest {
	url: string;
	mode?: WebExtractionMode;
	maxCharacters?: number;
	render?: "never" | "auto" | "always";
	passageQuery?: string;
	signal?: AbortSignal;
}

export interface EvidencePassage {
	id: string;
	text: string;
	startLine?: number;
	endLine?: number;
	page?: number;
}

export interface WebEvidenceRecord {
	evidenceId: string;
	sourceType: "web";
	requestedUrl: string;
	finalUrl: string;
	canonicalUrl: string;
	title?: string;
	author?: string;
	retrievedAt: string;
	publishedAt?: string;
	contentType: string;
	extractor: "readability" | "text" | "json" | "xml" | "pdf" | "playwright";
	contentSha256: string;
	completeContentLocation: string;
	completeContent: string;
	relevantPassages: EvidencePassage[];
	outboundLinks: string[];
	bytesDownloaded: number;
	bytesExtracted: number;
	truncated: boolean;
	pageCount?: number;
	untrusted: true;
}

export interface WebFetchResponse {
	evidence: WebEvidenceRecord;
	content: string;
	rendered: boolean;
	durationMs: number;
}

export type ResearchEventType =
	| "RESEARCH_STARTED"
	| "OBJECTIVE_DECOMPOSED"
	| "QUERY_PLANNED"
	| "SEARCH_COMPLETED"
	| "SOURCE_CANDIDATE_FOUND"
	| "SOURCE_SELECTED"
	| "SOURCE_FETCHED"
	| "SOURCE_REJECTED"
	| "CLAIM_EXTRACTED"
	| "CONTRADICTION_FOUND"
	| "FOLLOWUP_QUERY_PLANNED"
	| "EVIDENCE_BUNDLE_CREATED"
	| "RESEARCH_COMPLETED";

export interface ResearchEvent {
	type: ResearchEventType;
	sequence: number;
	details: Record<string, string | number | boolean>;
}

export interface DeepResearchFacts {
	/** Temporal observations for one or more quantities. */
	temporal?: TemporalSourceFacts[];
	/** Numeric calculation validations to run. */
	numericExpressions?: NumericExpression[];
	/** Ranked recommendations paired with computed metrics. */
	rankings?: { recommendations?: RankedRecommendationItem[]; metrics?: RankedRecommendationItem[] };
	/** Values currently asserted as current (for conspiracy with temporal). */
	currentValues?: string[];
}

export interface RankedRecommendationItem {
	id: string;
	label: string;
	computedMetric: number | undefined;
}

export interface DeepResearchRequest {
	objective: string;
	freshness?: WebFreshness;
	maxQueries?: number;
	maxSources?: number;
	preferredDomains?: string[];
	excludedDomains?: string[];
	language?: string;
	depth?: "quick" | "standard" | "deep";
	facts?: DeepResearchFacts;
	signal?: AbortSignal;
}

export interface ResearchCitation {
	claimId: string;
	evidenceId: string;
	sourceUrl: string;
	sourceTitle?: string;
	retrievedAt: string;
	publishedAt?: string;
	passageId: string;
	page?: number;
	startLine?: number;
	endLine?: number;
	contentSha256: string;
	support: "direct" | "inference" | "contradicted";
}

/**
 * Exact numeric, chronological or mechanical claim support. Every exact claim
 * must trace to durable evidence plus concrete coordinates.
 */
export type ResearchSupportType =
	| "direct"
	| "corroborating"
	| "historical"
	| "contradicting"
	| "inference"
	| "snippet_only"
	| "unverified";

export interface EvidenceLocator {
	kind: "lines" | "passage" | "page" | "json_pointer";
	start?: number;
	end?: number;
	page?: number;
	passageId?: string;
	jsonPointer?: string;
}

export interface ResearchClaimSupport {
	claimId: string;
	evidenceId: string;
	supportType: ResearchSupportType;
	sourceUrl: string;
	sourceTitle?: string;
	retrievedAt: string;
	publishedAt?: string;
	effectiveAt?: string;
	contentSha256: string;
	locator: EvidenceLocator;
}

export interface ResearchClaim {
	id: string;
	text: string;
	support: "direct" | "inference" | "contradicted";
	citations: ResearchCitation[];
	/** Richer traceable support, adapted to Jensen evidence conventions. */
	supports: ResearchClaimSupport[];
}

export type TemporalValueClass =
	| "historical"
	| "current"
	| "superseded"
	| "contradiction"
	| "uncertain_current"
	| "unknown";

export interface TemporalResolution {
	sourceUrl: string;
	evidenceId?: string;
	class: TemporalValueClass;
	value?: string | number;
	effectiveAt?: string;
	supersededBy?: string;
	conflictingEvidenceIds?: string[];
	reasoning: string[];
}

export interface TemporalResolutionResult {
	resolutions: TemporalResolution[];
	currentValue?: string | number;
	unresolved: boolean;
	reasoning: string[];
}

export interface TemporalSourceFacts {
	evidenceId: string;
	sourceUrl?: string;
	/** Observed value for the quantity under study. */
	value: string | number;
	/** Effective/current date of this observation, if known. */
	effectiveAt?: string;
	publishedAt?: string;
	/** Authority rank: higher is more authoritative (0=community, 2=official). */
	authority: number;
	/** The source explicitly describes itself as maintained/current. */
	isMaintained?: boolean;
	/** The source explicitly states a value changed. */
	changeDeclaration?: string;
}

export type NumericUnit =
	| "damage_per_shot"
	| "flat_damage_bonus"
	| "percent_bonus"
	| "seconds"
	| "probability"
	| "level"
	| "count";

export interface NumericFact {
	value: number;
	unit: NumericUnit;
	target?: "all" | "player" | "npc" | "specific_npc_family";
	evidenceId: string;
	label?: string;
}

/** A computed expression, derived from typed facts where possible. */
export interface NumericExpression {
	facts: NumericFact[];
	notes?: string[];
}

export type NumericVerificationOutcome = "verified" | "unsupported" | "corrected";

export interface NumericVerification {
	id: string;
	description: string;
	outcome: NumericVerificationOutcome;
	assumed?: string;
	computed?: number;
	expected?: number;
	violation?: string;
}

export type SourceConfidence = "high" | "medium" | "low" | "unverified";

export interface ConsistencyIssue {
	kind: string;
	severity: "error" | "warning";
	message: string;
	recommendation: string;
}

export interface EvidenceBundle {
	id: string;
	objective: string;
	contentSha256: string;
	evidence: WebEvidenceRecord[];
	claims: ResearchClaim[];
	contradictions: string[];
	temporal?: TemporalResolutionResult;
	numericVerifications?: NumericVerification[];
	consistency?: ConsistencyIssue[];
	sourceConfidence?: Record<string, SourceConfidence>;
	completeContentLocation: string;
}

export interface DeepResearchResponse {
	objective: string;
	queries: string[];
	providerResponses: WebSearchResponse[];
	bundle: EvidenceBundle;
	synthesis: string;
	events: ResearchEvent[];
	partial: boolean;
	durationMs: number;
}
