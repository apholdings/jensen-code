/**
 * Durable index storage backed by the bundled Node.js SQLite module.
 *
 * Uses `node:sqlite` (DatabaseSync) — a zero-dependency, synchronous,
 * transactional, cross-platform backend with crash recovery. Lexical search uses
 * FTS5 when the bundled SQLite provides it; otherwise a pure-JS inverted index
 * supplies equivalent semantics.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { INDEX_SCHEMA_VERSION } from "./identity.js";
import type { IndexedFileRecord, WorkspaceIndexGeneration } from "./types.js";

export type PreparedQuery = ReturnType<DatabaseSync["prepare"]>;

export interface LexicalRow {
	rowid: number;
	snippet?: string;
}

/** Detects FTS5 availability in the current Node SQLite build. */
export function detectFts5(db: DatabaseSync): boolean {
	try {
		db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS __fts_probe USING fts5(c)");
		db.exec("DROP TABLE __fts_probe");
		return true;
	} catch {
		return false;
	}
}

/**
 * A workspace index database handle.
 */
export class WorkspaceDb {
	readonly db: DatabaseSync;
	readonly workspaceId: string;
	readonly directory: string;
	readonly fts5: boolean;
	private generationCache = new Map<string, WorkspaceIndexGeneration>();

	constructor(directory: string, workspaceId: string, db: DatabaseSync, fts5: boolean) {
		this.directory = directory;
		this.workspaceId = workspaceId;
		this.db = db;
		this.fts5 = fts5;
		this.migrate();
	}

	/** Open (creating if needed) the workspace DB. */
	static open(directory: string, workspaceId: string): WorkspaceDb {
		mkdirSync(directory, { recursive: true });
		const dbPath = path.join(directory, "index.sqlite");
		const db = new DatabaseSync(dbPath);
		const fts5 = detectFts5(db);
		db.exec("PRAGMA journal_mode = WAL");
		db.exec("PRAGMA synchronous = NORMAL");
		const store = new WorkspaceDb(directory, workspaceId, db, fts5);
		store.installSchema(fts5);
		return store;
	}

	private migrate(): void {
		const rows = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
		const version = Number(rows.user_version);
		if (version > INDEX_SCHEMA_VERSION) {
			// Newer schema than this code understands: rebuild path required.
			this.db.prepare("PRAGMA user_version = 0").get();
		}
	}

	private installSchema(fts5: boolean): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
			CREATE TABLE IF NOT EXISTS generations (
				generation_id TEXT PRIMARY KEY,
				workspace_id TEXT NOT NULL,
				schema_version INTEGER NOT NULL,
				created_at TEXT NOT NULL,
				completed_at TEXT,
				git_head TEXT,
				worktree_fingerprint TEXT NOT NULL,
				file_manifest_hash TEXT NOT NULL,
				status TEXT NOT NULL,
				file_count INTEGER NOT NULL DEFAULT 0,
				chunk_count INTEGER NOT NULL DEFAULT 0,
				symbol_count INTEGER NOT NULL DEFAULT 0,
				embedding_count INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE IF NOT EXISTS files (
				generation_id TEXT NOT NULL,
				file_id TEXT NOT NULL,
				path TEXT NOT NULL,
				language_id TEXT,
				classification TEXT NOT NULL,
				content_sha256 TEXT NOT NULL,
				size_bytes INTEGER NOT NULL,
				line_count INTEGER NOT NULL,
				git_blob_id TEXT,
				is_tracked INTEGER NOT NULL,
				is_generated INTEGER NOT NULL,
				is_sensitive INTEGER NOT NULL,
				indexed_at TEXT NOT NULL,
				PRIMARY KEY (generation_id, file_id)
			);
			CREATE TABLE IF NOT EXISTS chunks (
				generation_id TEXT NOT NULL,
				chunk_id TEXT NOT NULL,
				file_id TEXT NOT NULL,
				content_sha256 TEXT NOT NULL,
				start_line INTEGER NOT NULL,
				end_line INTEGER NOT NULL,
				start_byte INTEGER,
				end_byte INTEGER,
				language_id TEXT,
				symbol_id TEXT,
				chunk_kind TEXT NOT NULL,
				text_hash TEXT NOT NULL,
				embedding_status TEXT NOT NULL,
				text TEXT,
				PRIMARY KEY (generation_id, chunk_id)
			);
			CREATE TABLE IF NOT EXISTS symbols (
				generation_id TEXT NOT NULL,
				symbol_id TEXT NOT NULL,
				file_id TEXT NOT NULL,
				name TEXT NOT NULL,
				qualified_name TEXT,
				kind TEXT NOT NULL,
				language_id TEXT NOT NULL,
				start_line INTEGER NOT NULL,
				start_character INTEGER NOT NULL,
				end_line INTEGER NOT NULL,
				end_character INTEGER NOT NULL,
				signature_hash TEXT,
				container_symbol_id TEXT,
				PRIMARY KEY (generation_id, symbol_id)
			);
			CREATE TABLE IF NOT EXISTS relations (
				generation_id TEXT NOT NULL,
				relation_id TEXT NOT NULL,
				source_symbol_id TEXT NOT NULL,
				target_symbol_id TEXT,
				relation_type TEXT NOT NULL,
				source TEXT NOT NULL,
				confidence REAL NOT NULL,
				PRIMARY KEY (generation_id, relation_id)
			);
			CREATE TABLE IF NOT EXISTS git_meta (
				generation_id TEXT NOT NULL,
				file_id TEXT NOT NULL,
				last_commit TEXT,
				commit_time TEXT,
				change_count INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (generation_id, file_id)
			);
			CREATE TABLE IF NOT EXISTS vectors (
				generation_id TEXT NOT NULL,
				chunk_id TEXT NOT NULL,
				content_hash TEXT NOT NULL,
				model_id TEXT NOT NULL,
				dimensions INTEGER NOT NULL,
				embedding BLOB NOT NULL,
				PRIMARY KEY (generation_id, chunk_id, model_id)
			);
			CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks (generation_id, file_id);
			CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols (generation_id, name);
			CREATE INDEX IF NOT EXISTS idx_files_path ON files (generation_id, path);
			CREATE TABLE IF NOT EXISTS postings (
				generation_id TEXT NOT NULL,
				token TEXT NOT NULL,
				chunk_id TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_postings_token ON postings (generation_id, token);
			CREATE INDEX IF NOT EXISTS idx_postings_chunk ON postings (generation_id, chunk_id);
			CREATE TABLE IF NOT EXISTS lex (
				generation_id TEXT NOT NULL,
				chunk_id TEXT NOT NULL,
				path TEXT NOT NULL,
				doc_tokens TEXT NOT NULL,
				doc_length INTEGER NOT NULL,
				PRIMARY KEY (generation_id, chunk_id)
			);
		`);
		if (fts5) {
			this.db.exec(`
				CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
					chunk_id UNINDEXED,
					text,
					path UNINDEXED,
					tokenize='unicode61'
				);
			`);
		}
	}

	// ---- Generations ----

	insertGeneration(gen: WorkspaceIndexGeneration): void {
		this.db
			.prepare(
				`INSERT OR REPLACE INTO generations (
					generation_id, workspace_id, schema_version, created_at, completed_at,
					git_head, worktree_fingerprint, file_manifest_hash, status,
					file_count, chunk_count, symbol_count, embedding_count
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				gen.generationId,
				gen.workspaceId,
				gen.schemaVersion,
				gen.createdAt,
				gen.completedAt ?? null,
				gen.sourceSnapshot.gitHead ?? null,
				gen.sourceSnapshot.worktreeFingerprint,
				gen.sourceSnapshot.fileManifestHash,
				gen.status,
				gen.fileCount,
				gen.chunkCount,
				gen.symbolCount,
				gen.embeddingCount,
			);
		this.generationCache.set(gen.generationId, gen);
	}

	updateGenerationStatus(
		generationId: string,
		status: WorkspaceIndexGeneration["status"],
		completedAt?: string,
	): void {
		this.db
			.prepare("UPDATE generations SET status = ?, completed_at = ? WHERE generation_id = ?")
			.run(status, completedAt ?? null, generationId);
		this.generationCache.delete(generationId);
	}

	getGeneration(generationId: string): WorkspaceIndexGeneration | undefined {
		const cached = this.generationCache.get(generationId);
		if (cached) return cached;
		const row = this.db.prepare("SELECT * FROM generations WHERE generation_id = ?").get(generationId) as
			| Record<string, unknown>
			| undefined;
		if (!row) return undefined;
		const gen = this.rowToGeneration(row);
		this.generationCache.set(generationId, gen);
		return gen;
	}

	/** Most recent generation with status ready (validation authority). */
	currentReadyGeneration(): WorkspaceIndexGeneration | undefined {
		const row = this.db
			.prepare("SELECT * FROM generations WHERE status = 'ready' ORDER BY created_at DESC LIMIT 1")
			.get() as Record<string, unknown> | undefined;
		return row ? this.rowToGeneration(row) : undefined;
	}

	currentBuildingGeneration(): WorkspaceIndexGeneration | undefined {
		const row = this.db
			.prepare("SELECT * FROM generations WHERE status = 'building' ORDER BY created_at DESC LIMIT 1")
			.get() as Record<string, unknown> | undefined;
		return row ? this.rowToGeneration(row) : undefined;
	}

	listGenerations(): WorkspaceIndexGeneration[] {
		const rows = this.db.prepare("SELECT * FROM generations ORDER BY created_at DESC").all() as Array<
			Record<string, unknown>
		>;
		return rows.map((r) => this.rowToGeneration(r));
	}

	private rowToGeneration(row: Record<string, unknown>): WorkspaceIndexGeneration {
		return {
			generationId: String(row.generation_id),
			workspaceId: String(row.workspace_id),
			schemaVersion: Number(row.schema_version),
			createdAt: String(row.created_at),
			completedAt: row.completed_at ? String(row.completed_at) : undefined,
			sourceSnapshot: {
				gitHead: row.git_head ? String(row.git_head) : undefined,
				worktreeFingerprint: String(row.worktree_fingerprint),
				fileManifestHash: String(row.file_manifest_hash),
			},
			status: row.status as WorkspaceIndexGeneration["status"],
			fileCount: Number(row.file_count),
			chunkCount: Number(row.chunk_count),
			symbolCount: Number(row.symbol_count),
			embeddingCount: Number(row.embedding_count),
		};
	}

	// ---- File / chunk / symbol writes ----

	insertFile(
		gen: string,
		f: {
			fileId: string;
			path: string;
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
		},
	): void {
		this.db
			.prepare(
				`INSERT OR REPLACE INTO files (
					generation_id, file_id, path, language_id, classification, content_sha256,
					size_bytes, line_count, git_blob_id, is_tracked, is_generated, is_sensitive, indexed_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				gen,
				f.fileId,
				f.path,
				f.languageId ?? null,
				f.classification,
				f.contentSha256,
				f.sizeBytes,
				f.lineCount,
				f.gitBlobId ?? null,
				f.isTracked ? 1 : 0,
				f.isGenerated ? 1 : 0,
				f.isSensitive ? 1 : 0,
				f.indexedAt,
			);
	}

	insertChunk(
		gen: string,
		c: {
			chunkId: string;
			fileId: string;
			contentSha256: string;
			startLine: number;
			endLine: number;
			startByte?: number;
			endByte?: number;
			languageId?: string;
			symbolId?: string;
			chunkKind: string;
			textHash: string;
			embeddingStatus: string;
			text?: string;
		},
	): void {
		this.db
			.prepare(
				`INSERT OR REPLACE INTO chunks (
					generation_id, chunk_id, file_id, content_sha256, start_line, end_line,
					start_byte, end_byte, language_id, symbol_id, chunk_kind, text_hash, embedding_status, text
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				gen,
				c.chunkId,
				c.fileId,
				c.contentSha256,
				c.startLine,
				c.endLine,
				c.startByte ?? null,
				c.endByte ?? null,
				c.languageId ?? null,
				c.symbolId ?? null,
				c.chunkKind,
				c.textHash,
				c.embeddingStatus,
				c.text ?? null,
			);
	}

	insertSymbol(
		gen: string,
		s: {
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
		},
	): void {
		this.db
			.prepare(
				`INSERT OR REPLACE INTO symbols (
					generation_id, symbol_id, file_id, name, qualified_name, kind, language_id,
					start_line, start_character, end_line, end_character, signature_hash, container_symbol_id
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				gen,
				s.symbolId,
				s.fileId,
				s.name,
				s.qualifiedName ?? null,
				s.kind,
				s.languageId,
				s.startLine,
				s.startCharacter,
				s.endLine,
				s.endCharacter,
				s.signatureHash ?? null,
				s.containerSymbolId ?? null,
			);
	}

	insertRelation(
		gen: string,
		r: {
			relationId: string;
			sourceSymbolId: string;
			targetSymbolId?: string;
			relationType: string;
			source: string;
			confidence: number;
		},
	): void {
		this.db
			.prepare(
				"INSERT OR REPLACE INTO relations (generation_id, relation_id, source_symbol_id, target_symbol_id, relation_type, source, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(gen, r.relationId, r.sourceSymbolId, r.targetSymbolId ?? null, r.relationType, r.source, r.confidence);
	}

	insertGitMeta(
		gen: string,
		fileId: string,
		g: { lastCommit?: string; commitTime?: string; changeCount: number },
	): void {
		this.db
			.prepare(
				"INSERT OR REPLACE INTO git_meta (generation_id, file_id, last_commit, commit_time, change_count) VALUES (?, ?, ?, ?, ?)",
			)
			.run(gen, fileId, g.lastCommit ?? null, g.commitTime ?? null, g.changeCount);
	}

	getFile(gen: string, fileId: string): IndexedFileRecord | undefined {
		const row = this.db.prepare("SELECT * FROM files WHERE generation_id = ? AND file_id = ?").get(gen, fileId) as
			| Record<string, unknown>
			| undefined;
		return row
			? {
					fileId: String(row.file_id),
					workspaceRelativePath: String(row.path),
					languageId: row.language_id ? String(row.language_id) : undefined,
					classification: String(row.classification),
					contentSha256: String(row.content_sha256),
					sizeBytes: Number(row.size_bytes),
					lineCount: Number(row.line_count),
					gitBlobId: row.git_blob_id ? String(row.git_blob_id) : undefined,
					isTracked: Boolean(row.is_tracked),
					isGenerated: Boolean(row.is_generated),
					isSensitive: Boolean(row.is_sensitive),
					indexedAt: String(row.indexed_at),
				}
			: undefined;
	}

	/** Map of path → contentSha256 for the given generation. */
	fileManifest(gen: string): Map<string, string> {
		const rows = this.db.prepare("SELECT path, content_sha256 FROM files WHERE generation_id = ?").all(gen) as Array<{
			path: string;
			content_sha256: string;
		}>;
		return new Map(rows.map((r) => [r.path, r.content_sha256]));
	}

	fileIdByPath(gen: string, relPath: string): string | undefined {
		const row = this.db.prepare("SELECT file_id FROM files WHERE generation_id = ? AND path = ?").get(gen, relPath) as
			| { file_id: string }
			| undefined;
		return row?.file_id;
	}

	chunkById(
		gen: string,
		chunkId: string,
	):
		| {
				chunkId: string;
				fileId: string;
				startLine: number;
				endLine: number;
				text?: string;
				symbolId?: string;
				chunkKind: string;
		  }
		| undefined {
		const row = this.db.prepare("SELECT * FROM chunks WHERE generation_id = ? AND chunk_id = ?").get(gen, chunkId) as
			| Record<string, unknown>
			| undefined;
		return row
			? {
					chunkId: String(row.chunk_id),
					fileId: String(row.file_id),
					startLine: Number(row.start_line),
					endLine: Number(row.end_line),
					text: row.text ? String(row.text) : undefined,
					symbolId: row.symbol_id ? String(row.symbol_id) : undefined,
					chunkKind: String(row.chunk_kind),
				}
			: undefined;
	}

	chunksForFile(
		gen: string,
		fileId: string,
	): Array<{ chunkId: string; startLine: number; endLine: number; text?: string }> {
		const rows = this.db
			.prepare(
				"SELECT chunk_id, start_line, end_line, text FROM chunks WHERE generation_id = ? AND file_id = ? ORDER BY start_line",
			)
			.all(gen, fileId) as Array<{ chunk_id: string; start_line: number; end_line: number; text: string | null }>;
		return rows.map((r) => ({
			chunkId: r.chunk_id,
			startLine: r.start_line,
			endLine: r.end_line,
			text: r.text ?? undefined,
		}));
	}

	symbolsForFile(
		gen: string,
		fileId: string,
	): Array<{ symbolId: string; name: string; kind: string; startLine: number; endLine: number }> {
		const rows = this.db
			.prepare(
				"SELECT symbol_id, name, kind, start_line, end_line FROM symbols WHERE generation_id = ? AND file_id = ? ORDER BY start_line",
			)
			.all(gen, fileId) as Array<{
			symbol_id: string;
			name: string;
			kind: string;
			start_line: number;
			end_line: number;
		}>;
		return rows.map((r) => ({
			symbolId: r.symbol_id,
			name: r.name,
			kind: r.kind,
			startLine: r.start_line,
			endLine: r.end_line,
		}));
	}

	// ---- Counts (only ready generation is authoritative) ----

	counts(generationId: string): { files: number; chunks: number; symbols: number; embeddings: number } {
		const files = (
			this.db.prepare("SELECT COUNT(*) c FROM files WHERE generation_id = ?").get(generationId) as {
				c: number;
			}
		).c;
		const chunks = (
			this.db.prepare("SELECT COUNT(*) c FROM chunks WHERE generation_id = ?").get(generationId) as {
				c: number;
			}
		).c;
		const symbols = (
			this.db.prepare("SELECT COUNT(*) c FROM symbols WHERE generation_id = ?").get(generationId) as {
				c: number;
			}
		).c;
		const embeddings = (
			this.db.prepare("SELECT COUNT(*) c FROM vectors WHERE generation_id = ?").get(generationId) as {
				c: number;
			}
		).c;
		return { files, chunks, symbols, embeddings };
	}

	// ---- Transactions ----

	begin(): void {
		this.db.exec("BEGIN");
	}
	commit(): void {
		this.db.exec("COMMIT");
	}
	rollback(): void {
		this.db.exec("ROLLBACK");
	}

	close(): void {
		this.db.close();
	}

	getMeta(key: string): string | undefined {
		const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
		return row?.value;
	}

	setMeta(key: string, value: string): void {
		this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
	}

	/** Compute a stable manifest hash over the ready generation's file set. */
	fileManifestHash(generationId: string): string {
		const rows = this.db
			.prepare("SELECT path, content_sha256 FROM files WHERE generation_id = ? ORDER BY path")
			.all(generationId) as Array<{ path: string; content_sha256: string }>;
		const hash = createHash("sha256");
		for (const r of rows) hash.update(`${r.path}\u0000${r.content_sha256}\u0000`);
		return hash.digest("hex");
	}
}

export function newGenerationId(): string {
	return `gen_${randomUUID().replace(/-/g, "")}`;
}
