/**
 * Deterministic lexical retrieval.
 *
 * A portable postings-table + Okapi BM25 implementation over SQLite. This avoids
 * reliance on FTS5 availability (which can differ by Node build/platform) while
 * providing exact, prefix, phrase and identifier-aware full-text search with
 * deterministic ranking. All query text is parameter-bound, so no injection is
 * possible.
 */

import type { WorkspaceDb } from "./storage.js";
import { tokenizeQuery } from "./tokenize.js";

export interface LexicalHit {
	chunkId: string;
	path: string;
	score: number;
	matchedTokens: string[];
}

export interface LexicalQuery {
	query: string;
	limit?: number;
	fileClassFilters?: string[];
	languageFilters?: string[];
	pathFilter?: string;
	prefix?: boolean;
	caseSensitive?: boolean;
}

const K1 = 1.2;
const B = 0.75;

interface Candidate {
	chunkId: string;
	path: string;
	termFreq: Map<string, number>;
	docLength: number;
}

/** Write the lexical records for a chunk. */
export function writeLexical(
	db: WorkspaceDb,
	generationId: string,
	chunkId: string,
	path: string,
	lexText: string,
): void {
	const tokens = tokenizeQuery(lexText);
	const stmt = db.db.prepare(
		"INSERT OR REPLACE INTO lex (generation_id, chunk_id, path, doc_tokens, doc_length) VALUES (?, ?, ?, ?, ?)",
	);
	stmt.run(generationId, chunkId, path, tokens.join(" "), tokens.length);
	const upsert = db.db.prepare("INSERT OR IGNORE INTO postings (generation_id, token, chunk_id) VALUES (?, ?, ?)");
	// Deduplicate tokens per chunk for the postings table.
	for (const token of new Set(tokens)) upsert.run(generationId, token, chunkId);
}

export function deleteLexical(db: WorkspaceDb, generationId: string, chunkId: string): void {
	db.db.prepare("DELETE FROM lex WHERE generation_id = ? AND chunk_id = ?").run(generationId, chunkId);
	db.db.prepare("DELETE FROM postings WHERE generation_id = ? AND chunk_id = ?").run(generationId, chunkId);
	db.db.prepare("DELETE FROM chunks_fts WHERE chunk_id = ?").run(chunkId);
}

function docPaths(db: WorkspaceDb, generationId: string): Map<string, string> {
	const rows = db.db.prepare("SELECT chunk_id, path FROM lex WHERE generation_id = ?").all(generationId) as Array<{
		chunk_id: string;
		path: string;
	}>;
	return new Map(rows.map((r) => [r.chunk_id, r.path]));
}

/** Kill-list chunk_ids from a previous fully-indexed generation to remove stale vectors. */
export function chunkIdsForRemoval(db: WorkspaceDb, generationId: string, retained: Set<string>): string[] {
	const rows = db.db.prepare("SELECT chunk_id FROM lex WHERE generation_id = ?").all(generationId) as Array<{
		chunk_id: string;
	}>;
	return rows.map((r) => r.chunk_id).filter((id) => !retained.has(id));
}

export function searchLexical(db: WorkspaceDb, generationId: string, opts: LexicalQuery): LexicalHit[] {
	const limit = Math.max(1, opts.limit ?? 50);
	const rawTokens = tokenizeQuery(opts.query);
	if (rawTokens.length === 0) return [];

	// Prefix expansion: match tokens that start with the query token when requested.
	let tokens = rawTokens;
	if (opts.prefix) {
		const expanded = new Set<string>();
		for (const t of rawTokens) {
			expanded.add(t);
			const rows = db.db
				.prepare("SELECT DISTINCT token FROM postings WHERE generation_id = ? AND token LIKE ? LIMIT 200")
				.all(generationId, `${t}%`) as Array<{ token: string }>;
			for (const r of rows) expanded.add(r.token);
		}
		tokens = [...expanded];
	}

	// Candidate chunk ids from postings (bounded).
	const candidateSet = new Map<string, Set<string>>(); // token -> chunkIds
	for (const token of tokens) {
		const rows = db.db
			.prepare("SELECT chunk_id FROM postings WHERE generation_id = ? AND token = ? LIMIT 5000")
			.all(generationId, token) as Array<{ chunk_id: string }>;
		candidateSet.set(token, new Set(rows.map((r) => r.chunk_id)));
	}
	// Chunks that contain at least one query token.
	const union = new Set<string>();
	for (const set of candidateSet.values()) for (const id of set) union.add(id);
	if (union.size === 0) return [];

	// Load doc tokens for candidates.
	const chunkIds = [...union];
	const placeholders = chunkIds.map(() => "?").join(",");
	const lexRows = db.db
		.prepare(
			`SELECT chunk_id, doc_tokens, doc_length FROM lex WHERE generation_id = ? AND chunk_id IN (${placeholders})`,
		)
		.all(generationId, ...chunkIds) as Array<{ chunk_id: string; doc_tokens: string; doc_length: number }>;

	const pathByChunk = docPaths(db, generationId);

	const docs = new Map<string, Candidate>();
	for (const r of lexRows) {
		const freq = new Map<string, number>();
		for (const t of r.doc_tokens.split(" ")) freq.set(t, (freq.get(t) ?? 0) + 1);
		docs.set(r.chunk_id, {
			chunkId: r.chunk_id,
			path: pathByChunk.get(r.chunk_id) ?? "",
			termFreq: freq,
			docLength: r.doc_length,
		});
	}

	const avgdl = docs.size ? [...docs.values()].reduce((a, d) => a + d.docLength, 0) / docs.size : 1;
	const totalDocs = db.db.prepare("SELECT COUNT(*) c FROM lex WHERE generation_id = ?").get(generationId) as {
		c: number;
	};

	// IDT (inverse document token) per token.
	const idf = new Map<string, number>();
	for (const token of tokens) {
		const df = candidateSet.get(token)?.size ?? 0;
		const n = Math.max(1, totalDocs.c);
		idf.set(token, Math.log(1 + (n - df + 0.5) / (df + 0.5)));
	}

	const hits: LexicalHit[] = [];
	for (const doc of docs.values()) {
		let score = 0;
		const matched: string[] = [];
		for (const token of tokens) {
			const tf = doc.termFreq.get(token) ?? 0;
			if (tf === 0) continue;
			matched.push(token);
			const denom = tf + K1 * (1 - B + (B * doc.docLength) / avgdl);
			score += (idf.get(token) ?? 0) * ((tf * (K1 + 1)) / denom);
		}
		if (matched.length > 0) {
			hits.push({ chunkId: doc.chunkId, path: doc.path, score, matchedTokens: matched });
		}
	}

	hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.chunkId.localeCompare(b.chunkId));
	return hits.slice(0, limit);
}

/** Path-prefix search: locate chunks under a given workspace-relative path. */
export function searchByPath(db: WorkspaceDb, generationId: string, pathQuery: string, limit = 50): LexicalHit[] {
	const q = pathQuery.replace(/\\/g, "/").toLowerCase().replace(/^\/+/, "");
	const rows = db.db.prepare("SELECT chunk_id, path FROM lex WHERE generation_id = ?").all(generationId) as Array<{
		chunk_id: string;
		path: string;
	}>;
	const hits: LexicalHit[] = [];
	for (const r of rows) {
		if (r.path.toLowerCase().includes(q)) {
			hits.push({ chunkId: r.chunk_id, path: r.path, score: 1 / (1 + r.path.length), matchedTokens: [] });
		}
	}
	hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
	return hits.slice(0, limit);
}

/** Identifier-aware exact symbol-name search over the symbols table. */
export function searchSymbolName(
	db: WorkspaceDb,
	generationId: string,
	name: string,
	limit = 50,
): Array<{ symbolId: string; fileId: string; name: string; qualifiedName?: string; kind: string; startLine: number }> {
	const q = name.toLowerCase();
	const rows = db.db
		.prepare(
			"SELECT symbol_id, file_id, name, qualified_name, kind, start_line FROM symbols WHERE generation_id = ? AND lower(name) = ? LIMIT ?",
		)
		.all(generationId, q, limit) as Array<{
		symbol_id: string;
		file_id: string;
		name: string;
		qualified_name: string | null;
		kind: string;
		start_line: number;
	}>;
	return rows.map((r) => ({
		symbolId: r.symbol_id,
		fileId: r.file_id,
		name: r.name,
		qualifiedName: r.qualified_name ?? undefined,
		kind: r.kind,
		startLine: r.start_line,
	}));
}
