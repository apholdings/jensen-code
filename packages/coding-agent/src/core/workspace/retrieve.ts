/**
 * Retrieval facade: executes a plan against the ready index generation and
 * produces addressable, evidence-backed, freshness-labeled results.
 *
 * Results never authorize mutation. Revalidation against current file content
 * hashes must be performed before any mutation planning.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { FixtureEmbeddingBackend, resolveEmbeddingBackend } from "./embedding.js";
import { type FusionCandidate, fuseCandidates, rerankHeuristic } from "./fusion.js";
import { sha256 } from "./guard.js";
import { type LexicalHit, searchByPath, searchLexical, searchSymbolName } from "./lexical.js";
import type { WorkspaceDb } from "./storage.js";
import type { EmbeddingBackend, RetrievalContextPacket, RetrievalPlan, WorkspaceRetrievalResult } from "./types.js";
import { VectorIndex } from "./vectors.js";

export interface RetrieveOptions {
	plan: RetrievalPlan;
	generationId?: string;
	embedding?: EmbeddingBackend;
	root?: string; // workspace root for revalidation
	freshOnly?: boolean;
	currentFile?: string;
}

export interface RetrievalOutcome {
	packet: RetrievalContextPacket;
	results: WorkspaceRetrievalResult[];
	generationId: string;
}

function chunkSymbolFor(
	db: WorkspaceDb,
	gen: string,
	chunkId: string,
): { name?: string; qualifiedName?: string; kind?: string } | undefined {
	const chunk = db.chunkById(gen, chunkId);
	if (!chunk?.symbolId) return undefined;
	const row = db.db
		.prepare("SELECT name, qualified_name, kind FROM symbols WHERE generation_id = ? AND symbol_id = ?")
		.get(gen, chunk.symbolId) as { name: string; qualified_name: string | null; kind: string } | undefined;
	return row ? { name: row.name, qualifiedName: row.qualified_name ?? undefined, kind: row.kind } : undefined;
}

export function executeRetrieval(db: WorkspaceDb, options: RetrieveOptions): RetrievalOutcome {
	const gen = options.generationId ?? db.currentReadyGeneration()?.generationId;
	if (!gen) {
		return {
			packet: {
				query: options.plan.normalizedQuery,
				retrievalPlanId: options.plan.queryId,
				indexGenerationId: "",
				results: [],
				totalEstimatedTokens: 0,
				truncated: false,
			},
			results: [],
			generationId: "",
		};
	}

	const embedding: EmbeddingBackend = options.embedding ?? resolveEmbeddingBackend();
	const embedEnabled = embedding.backendId !== "disabled";

	const generatorLists: FusionCandidate[][] = [];
	const _rank = 0;
	const pushRanked = (list: LexicalHit[], kind: string) => {
		list.forEach((h, i) => {
			generatorLists.push([{ chunkId: h.chunkId, file: h.path, ranking: i + 1, generator: kind, reasonCode: kind }]);
		});
	};

	// Run the planned generators.
	const pathFilter = options.plan.normalizedQuery ?? "";

	// 1. symbol generator (exact name / symbol lookup)
	if (options.plan.generators.some((g) => g.kind === "symbol")) {
		const firstToken = options.plan.normalizedQuery.split(" ")[0] ?? "";
		const symbolHits = searchSymbolName(db, gen, firstToken, options.plan.maximumResults);
		symbolHits.forEach((s, i) => {
			const fileName = filePathFor(db, gen, s.fileId);
			generatorLists.push([
				{
					chunkId: symbolChunkFor(db, gen, s.symbolId, s.startLine) ?? fallbackChunkFor(db, gen, s.fileId),
					file: fileName,
					ranking: i + 1,
					generator: "symbol",
					reasonCode: "symbol_name_match",
					bonus: 2,
				},
			]);
		});
	}

	// 2. lexical generator
	if (options.plan.generators.some((g) => g.kind === "lexical")) {
		const lex = searchLexical(db, gen, {
			query: options.plan.normalizedQuery,
			limit: options.plan.maximumResults,
			prefix: false,
			pathFilter,
		});
		pushRanked(lex, "lexical");
	}

	// 3. path generator
	if (options.plan.generators.some((g) => g.kind === "path")) {
		const pathHits = searchByPath(db, gen, pathFilter, 20);
		pushRanked(
			pathHits.map((h) => ({ ...h, score: h.score })),
			"path",
		);
	}

	// 4. semantic generator (bounded)
	let semanticVector: number[] | undefined;
	if (embedEnabled && options.plan.generators.some((g) => g.kind === "semantic")) {
		try {
			semanticVector = embedQuery(embedding, options.plan.normalizedQuery);
		} catch {
			semanticVector = undefined;
		}
		if (semanticVector) {
			const hits = new VectorIndex(db).search(gen, semanticVector, {
				limit: options.plan.maximumResults,
			});
			hits.forEach((h, i) => {
				const chunk = db.chunkById(gen, h.chunkId);
				generatorLists.push([
					{
						chunkId: h.chunkId,
						file: chunk?.fileId ? filePathFor(db, gen, chunk.fileId) : "",
						ranking: i + 1,
						generator: "semantic",
						reasonCode: "semantic_similarity",
					},
				]);
			});
		}
	}

	// Fuse via RRF.
	let fused = fuseCandidates(generatorLists, {
		maxPerFile: 4,
		maximumResults: options.plan.maximumResults,
	});

	// Rerank deterministically.
	const symbolChunks = new Set<string>();
	fused = rerankHeuristic(fused, {
		exactTerm: options.plan.mode === "exact_identifier" ? options.plan.normalizedQuery : undefined,
		symbolMatch: symbolChunks,
	});

	// Assemble addressable results with freshness.
	const results: WorkspaceRetrievalResult[] = [];
	for (const fr of fused.slice(0, options.plan.maximumResults)) {
		const chunk = db.chunkById(gen, fr.chunkId);
		if (!chunk) continue;
		const file = db.getFile(gen, chunk.fileId);
		if (!file) continue;
		const sym = chunkSymbolFor(db, gen, fr.chunkId);
		const snippet = (chunk.text ?? "").slice(0, 800);
		const freshness = options.freshOnly ? freshnessFor(file, options.root) : "current";
		if (options.freshOnly && freshness === "stale") continue;
		const resultId = `${gen}_${fr.chunkId}`;
		results.push({
			resultId,
			workspaceId: db.workspaceId,
			indexGenerationId: gen,
			file: {
				workspaceRelativePath: file.workspaceRelativePath,
				contentSha256: file.contentSha256,
				classification: file.classification,
				languageId: file.languageId,
			},
			location: {
				startLine: chunk.startLine,
				endLine: chunk.endLine,
			},
			symbol: sym ? { name: sym.name ?? "", qualifiedName: sym.qualifiedName, kind: sym.kind } : undefined,
			snippet,
			score: fr.score,
			evidenceId: resultId,
			freshness,
		});
	}

	// Bounded context packet.
	const totalChars = results.reduce((a, r) => a + r.snippet.length, 0);
	const maxTokens = options.plan.maximumContextTokens ?? 4096;
	const totalEstimatedTokens = Math.ceil(totalChars / 4);
	const truncated = totalEstimatedTokens > maxTokens;
	const bounded = truncated
		? results.slice(0, Math.max(1, Math.floor((maxTokens * 4) / Math.max(1, avgSnippet(results)))))
		: results;

	return {
		generationId: gen,
		results,
		packet: {
			query: options.plan.normalizedQuery,
			retrievalPlanId: options.plan.queryId,
			indexGenerationId: gen,
			results: bounded,
			totalEstimatedTokens: Math.ceil(bounded.reduce((a, r) => a + r.snippet.length, 0) / 4),
			truncated,
		},
	};
}

function avgSnippet(results: WorkspaceRetrievalResult[]): number {
	const total = results.reduce((a, r) => a + r.snippet.length, 0);
	return results.length ? Math.max(1, Math.floor(total / results.length)) : 1;
}

function embedQuery(embedding: EmbeddingBackend, text: string): number[] | undefined {
	if (embedding instanceof FixtureEmbeddingBackend) return embedding.vectorFor(text);
	return undefined;
}

function filePathFor(db: WorkspaceDb, gen: string, fileId: string): string {
	const row = db.db.prepare("SELECT path FROM files WHERE generation_id = ? AND file_id = ?").get(gen, fileId) as
		| { path: string }
		| undefined;
	return row?.path ?? "";
}

function symbolChunkFor(db: WorkspaceDb, gen: string, symbolId: string, startLine: number): string | undefined {
	const row = db.db
		.prepare(
			"SELECT chunk_id FROM chunks WHERE generation_id = ? AND symbol_id = ? AND start_line <= ? ORDER BY start_line LIMIT 1",
		)
		.get(gen, symbolId, startLine) as { chunk_id: string } | undefined;
	return row?.chunk_id;
}

function fallbackChunkFor(db: WorkspaceDb, gen: string, fileId: string): string {
	const rows = db.chunksForFile(gen, fileId);
	return rows.length ? rows[0].chunkId : "";
}

/** Revalidate a result's content hash against the current file on disk. */
export function revalidateResult(
	result: WorkspaceRetrievalResult,
	root: string,
): WorkspaceRetrievalResult["freshness"] {
	try {
		const abs = path.resolve(root, result.file.workspaceRelativePath);
		const current = readFileSync(abs, "utf-8");
		const currentSha = sha256(current);
		return currentSha === result.file.contentSha256 ? "current" : "stale";
	} catch {
		return "unknown";
	}
}

function freshnessFor(
	file: { workspaceRelativePath: string; contentSha256: string },
	root?: string,
): WorkspaceRetrievalResult["freshness"] {
	if (!root) return "current";
	try {
		const abs = path.resolve(root, file.workspaceRelativePath);
		const current = readFileSync(abs, "utf-8");
		return sha256(current) === file.contentSha256 ? "current" : "stale";
	} catch {
		return "possibly_stale";
	}
}
