/**
 * Workspace Intelligence — shared type contracts.
 *
 * These types define the durable, deterministic retrieval model for Jensen's
 * workspace index subsystem. The index is always a *projection* of the
 * authoritative current workspace; it is rebuildable and never an execution
 * authority.
 */

/** Canonical identity of a workspace within which retrieval operates. */
export interface WorkspaceIdentity {
	workspaceId: string;
	canonicalRoot: string;
	filesystemIdentity?: string;
	gitRepositoryId?: string;
	gitCommonDir?: string;
	worktreeId?: string;
	branch?: string;
	headCommit?: string;
	indexVersion: number;
}

/** A durable, versioned index generation. */
export interface WorkspaceIndexGeneration {
	generationId: string;
	workspaceId: string;
	schemaVersion: number;
	createdAt: string;
	completedAt?: string;
	sourceSnapshot: {
		gitHead?: string;
		worktreeFingerprint: string;
		fileManifestHash: string;
	};
	status: "building" | "ready" | "degraded" | "superseded" | "failed";
	fileCount: number;
	chunkCount: number;
	symbolCount: number;
	embeddingCount: number;
}

/** Content-addressed file record. */
export interface IndexedFileRecord {
	fileId: string;
	workspaceRelativePath: string;
	languageId?: string;
	classification: string;
	contentSha256: string;
	sizeBytes: number;
	lineCount: number;
	gitBlobId?: string;
	isTracked: boolean;
	isGenerated: boolean;
	isSensitive: boolean;
	indexedAt: string;
}

/** Content-addressed chunk record. */
export interface IndexedChunk {
	chunkId: string;
	fileId: string;
	contentSha256: string;
	startLine: number;
	endLine: number;
	startByte?: number;
	endByte?: number;
	languageId?: string;
	symbolId?: string;
	chunkKind: "symbol" | "section" | "paragraph" | "configuration" | "fallback_window";
	textHash: string;
	embeddingStatus: "not_requested" | "pending" | "ready" | "failed" | "excluded";
}

/** Indexed symbol record. */
export interface IndexedSymbol {
	symbolId: string;
	fileId: string;
	name: string;
	qualifiedName?: string;
	kind: string;
	languageId: string;
	startLine: number;
	startCharacter: number;
	endLine: number;
	endCharacter: number;
	signatureHash?: string;
	containerSymbolId?: string;
}

/** Symbol relationship with source + confidence. */
export interface SymbolRelation {
	relationId: string;
	sourceSymbolId: string;
	targetSymbolId?: string;
	relationType:
		| "contains"
		| "defines"
		| "references"
		| "implements"
		| "extends"
		| "imports"
		| "calls"
		| "tested_by"
		| "documented_by";
	source: "lsp" | "parser" | "lexical_inference" | "git" | "configuration";
	confidence: number;
}

/** Embedding backend contract. */
export interface EmbeddingRequest {
	texts: string[];
	metadata?: Array<{ path?: string; languageId?: string; symbolName?: string }>;
}

export interface EmbeddingResult {
	embeddings: Array<number[]>;
	modelId: string;
	dimensions: number;
}

export interface EmbeddingBackend {
	backendId: string;
	modelId: string;
	dimensions: number;
	maximumInputTokens: number;
	local: boolean;
	embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
}

/** Query planner output. */
export interface RetrievalPlan {
	queryId: string;
	mode:
		| "exact_identifier"
		| "symbol_lookup"
		| "flow_investigation"
		| "semantic_concept"
		| "documentation"
		| "test_discovery"
		| "configuration"
		| "historical_change"
		| "mixed";
	normalizedQuery: string;
	generators: Array<{ kind: string; limit: number; filters: Record<string, unknown> }>;
	reranker?: string;
	maximumResults: number;
	maximumContextTokens?: number;
}

/** Hybrid candidate score. */
export interface HybridCandidateScore {
	lexical?: number;
	semantic?: number;
	symbol?: number;
	lsp?: number;
	path?: number;
	git?: number;
	fused: number;
	reasonCodes: string[];
}

/** Addressable, evidence-backed retrieval result. */
export interface WorkspaceRetrievalResult {
	resultId: string;
	workspaceId: string;
	indexGenerationId: string;
	file: {
		workspaceRelativePath: string;
		contentSha256: string;
		classification: string;
		languageId?: string;
	};
	location: {
		startLine: number;
		startCharacter?: number;
		endLine: number;
		endCharacter?: number;
	};
	symbol?: {
		name: string;
		qualifiedName?: string;
		kind?: string;
	};
	snippet: string;
	score: HybridCandidateScore;
	evidenceId: string;
	freshness: "current" | "possibly_stale" | "stale" | "unknown";
}

/** Typed context packet injected into the bounded model context. */
export interface RetrievalContextPacket {
	query: string;
	retrievalPlanId: string;
	indexGenerationId: string;
	results: WorkspaceRetrievalResult[];
	totalEstimatedTokens: number;
	truncated: boolean;
}
