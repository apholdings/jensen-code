/**
 * Workspace indexer: full builds and incremental refresh.
 *
 * A build creates a new index generation atomically. Building generations are
 * never query authority; the most recent validated ready generation is served
 * during a build. Interrupted builds are discardable. Source files are never
 * written by the indexer.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { type ChunkOutput, chunkFile } from "./chunk.js";
import { resolveIndexConfig, type WorkspaceIndexConfig } from "./config.js";
import { discoverWorkspaceFiles } from "./discovery.js";
import { resolveEmbeddingBackend, truncateForEmbedding } from "./embedding.js";
import { collectGitMetadata, computeWorktreeFingerprint, type GitFileMeta } from "./git.js";
import { sha256 } from "./guard.js";
import { type ResolvedWorkspaceIdentity, toIdentityMeta } from "./identity.js";
import { deleteLexical, writeLexical } from "./lexical.js";
import { newGenerationId, type WorkspaceDb } from "./storage.js";
import { extractSymbolsHeuristic, markdownSections } from "./symbols.js";
import type { EmbeddingBackend, WorkspaceIndexGeneration } from "./types.js";
import { VectorIndex } from "./vectors.js";

export interface BuildOptions {
	config?: WorkspaceIndexConfig;
	signal?: AbortSignal;
	onEvent?: (event: string, payload?: Record<string, unknown>) => void;
	embedBackend?: EmbeddingBackend;
}

export interface BuildReport {
	generationId: string;
	status: WorkspaceIndexGeneration["status"];
	filesIndexed: number;
	chunksIndexed: number;
	symbolsIndexed: number;
	embeddingsIndexed: number;
	discovered: number;
	skippedIgnored: number;
	sensitiveSkipped: number;
	changed: number;
	added: number;
	removed: number;
	rebuild: boolean;
}

interface FileModel {
	fileId: string;
	relPath: string;
	content: string;
	contentSha256: string;
	classification: string;
	languageId?: string;
	sizeBytes: number;
	lineCount: number;
	isSensitive: boolean;
	chunks: ChunkOutput[];
	symbols: Array<{
		symbolId: string;
		name: string;
		qualifiedName?: string;
		kind: string;
		languageId: string;
		startLine: number;
		startCharacter: number;
		endLine: number;
		endCharacter: number;
	}>;
}

export class WorkspaceIndexer {
	private db: WorkspaceDb;
	private identity: ResolvedWorkspaceIdentity;
	private config: WorkspaceIndexConfig;

	constructor(db: WorkspaceDb, identity: ResolvedWorkspaceIdentity, config?: WorkspaceIndexConfig) {
		this.db = db;
		this.identity = identity;
		this.config = config ?? resolveIndexConfig();
	}

	get generationConfig(): WorkspaceIndexConfig {
		return this.config;
	}

	/** Full (re)build of the workspace index. */
	async build(opts: BuildOptions = {}): Promise<BuildReport> {
		const { signal } = opts;
		const onEvent = opts.onEvent ?? (() => {});
		const identity = this.identity;
		const genId = newGenerationId();
		const gen: WorkspaceIndexGeneration = {
			generationId: genId,
			workspaceId: identity.workspaceId,
			schemaVersion: toIdentityMeta(identity).indexVersion,
			createdAt: new Date().toISOString(),
			sourceSnapshot: {
				worktreeFingerprint: "",
				fileManifestHash: "",
			},
			status: "building",
			fileCount: 0,
			chunkCount: 0,
			symbolCount: 0,
			embeddingCount: 0,
		};

		// The old ready generation (if any) stays authoritative during build.
		onEvent("WORKSPACE_INDEX_BUILD_STARTED", { generationId: genId });

		const embed = opts.embedBackend ?? resolveEmbeddingBackend(this.config.embedding);
		const embedEnabled = embed.backendId !== "disabled";

		try {
			const discovery = discoverWorkspaceFiles({
				cwd: identity.canonicalRoot,
				root: identity.canonicalRoot,
				maxFileBytes: this.config.maxFileBytes,
				additionalIgnores: this.config.additionalIgnores,
				includeLockfilesAsMetadata: this.config.includeLockfilesAsMetadata,
				signal,
			});

			const fingerprintBundle = computeWorktreeFingerprint(identity.canonicalRoot, identity.worktreeId);
			gen.sourceSnapshot.worktreeFingerprint = fingerprintBundle.fingerprint;
			gen.sourceSnapshot.gitHead = fingerprintBundle.gitHead;

			this.db.insertGeneration(gen);

			const files: FileModel[] = [];
			let sensitiveSkipped = 0;

			for (const f of discovery.files) {
				if (signal?.aborted) throwObject("WORKSPACE_INDEX_BUILD_CANCELLED");
				if (f.classification.isSensitive || f.classification.isBinary) {
					// Metadata-only handling below; sensitive content never chunked.
					sensitiveSkipped++;
					continue;
				}
				const fileModel = this.modelFile(f.absolutePath, f.workspaceRelativePath, f.classification, f.sizeBytes);
				files.push(fileModel);
			}

			// Batch DB writes in a transaction for atomicity of the generation.
			this.db.begin();
			try {
				await this.writeFilesToGeneration(genId, files, embed, embedEnabled, signal, onEvent);
				const counts = this.db.counts(genId);
				gen.fileCount = counts.files;
				gen.chunkCount = counts.chunks;
				gen.symbolCount = counts.symbols;
				gen.embeddingCount = counts.embeddings;
				gen.sourceSnapshot.fileManifestHash = this.db.fileManifestHash(genId);
				gen.status = "ready";
				gen.completedAt = new Date().toISOString();
				this.db.insertGeneration(gen);
				this.db.commit();
			} catch (err) {
				this.db.rollback();
				this.db.updateGenerationStatus(genId, "failed");
				throw err;
			}

			onEvent("WORKSPACE_INDEX_GENERATION_READY", {
				generationId: genId,
				files: gen.fileCount,
				chunks: gen.chunkCount,
				symbols: gen.symbolCount,
				embeddings: gen.embeddingCount,
			});

			return {
				generationId: genId,
				status: "ready",
				filesIndexed: gen.fileCount,
				chunksIndexed: gen.chunkCount,
				symbolsIndexed: gen.symbolCount,
				embeddingsIndexed: gen.embeddingCount,
				discovered: discovery.files.length,
				skippedIgnored: discovery.skippedIgnored + discovery.skippedBinary + discovery.skippedTooLarge,
				sensitiveSkipped,
				changed: files.length,
				added: files.length,
				removed: 0,
				rebuild: true,
			};
		} catch (err) {
			const cancelled = err instanceof Object && (err as Error).name === "AbortError";
			this.db.updateGenerationStatus(genId, cancelled ? "failed" : "failed");
			if (cancelled) onEvent("WORKSPACE_INDEX_BUILD_CANCELLED", { generationId: genId });
			else onEvent("WORKSPACE_INDEX_BUILD_FAILED", { generationId: genId });
			throw err;
		}
	}

	/** Incremental refresh against the current ready generation. */
	async refresh(opts: BuildOptions = {}): Promise<BuildReport> {
		const { signal } = opts;
		const onEvent = opts.onEvent ?? (() => {});
		const identity = this.identity;
		const prev = this.db.currentReadyGeneration();
		const genId = newGenerationId();
		const gen: WorkspaceIndexGeneration = {
			generationId: genId,
			workspaceId: identity.workspaceId,
			schemaVersion: toIdentityMeta(identity).indexVersion,
			createdAt: new Date().toISOString(),
			sourceSnapshot: { worktreeFingerprint: "", fileManifestHash: "" },
			status: "building",
			fileCount: 0,
			chunkCount: 0,
			symbolCount: 0,
			embeddingCount: 0,
		};
		this.db.insertGeneration(gen);
		onEvent("WORKSPACE_INDEX_BUILD_STARTED", { generationId: genId, incremental: true });

		const embed = opts.embedBackend ?? resolveEmbeddingBackend(this.config.embedding);
		const embedEnabled = embed.backendId !== "disabled";

		try {
			const discovery = discoverWorkspaceFiles({
				cwd: identity.canonicalRoot,
				root: identity.canonicalRoot,
				maxFileBytes: this.config.maxFileBytes,
				additionalIgnores: this.config.additionalIgnores,
				includeLockfilesAsMetadata: this.config.includeLockfilesAsMetadata,
				signal,
			});

			const fingerprintBundle = computeWorktreeFingerprint(identity.canonicalRoot, identity.worktreeId);
			gen.sourceSnapshot.worktreeFingerprint = fingerprintBundle.fingerprint;
			gen.sourceSnapshot.gitHead = fingerprintBundle.gitHead;

			// Current manifest: path → contentSha256 (from previous ready generation).
			const prevManifest = prev ? this.db.fileManifest(prev.generationId) : new Map<string, string>();
			const byPath = new Map<string, { path: string; sha: string }>();

			const prevFileIds = prev
				? new Map([...prevManifest.keys()].map((p) => [p, this.db.fileIdByPath(prev.generationId, p)]))
				: new Map();

			this.db.begin();
			try {
				let added = 0;
				let changed = 0;
				let removed = 0;

				// Removed files: present in previous manifest but absent now.
				const currentPaths = new Set<string>();
				for (const f of discovery.files) {
					if (f.classification.isSensitive || f.classification.isBinary) continue;
					currentPaths.add(f.workspaceRelativePath);
					const fileModel = this.modelFile(f.absolutePath, f.workspaceRelativePath, f.classification, f.sizeBytes);
					byPath.set(f.workspaceRelativePath, { path: f.workspaceRelativePath, sha: fileModel.contentSha256 });
					const prevSha = prevManifest.get(f.workspaceRelativePath);
					if (prevSha === undefined) {
						added++;
						onEvent("WORKSPACE_INDEX_FILE_UPDATED", { path: f.workspaceRelativePath, action: "added" });
					} else if (prevSha !== fileModel.contentSha256) {
						changed++;
						onEvent("WORKSPACE_INDEX_FILE_UPDATED", { path: f.workspaceRelativePath, action: "modified" });
					}
					await this.writeFileModel(genId, fileModel, embed, embedEnabled, signal);
				}

				for (const prevPath of prevManifest.keys()) {
					if (!currentPaths.has(prevPath)) {
						removed++;
						onEvent("WORKSPACE_INDEX_FILE_REMOVED", { path: prevPath });
						const fid = prevFileIds.get(prevPath);
						if (fid) this.removeGenerationData(genId, fid, prevManifest.get(prevPath) ?? "");
					}
				}

				const counts = this.db.counts(genId);
				gen.fileCount = counts.files;
				gen.chunkCount = counts.chunks;
				gen.symbolCount = counts.symbols;
				gen.embeddingCount = counts.embeddings;
				gen.sourceSnapshot.fileManifestHash = this.db.fileManifestHash(genId);
				gen.status = "ready";
				gen.completedAt = new Date().toISOString();
				this.db.insertGeneration(gen);
				this.db.commit();

				onEvent("WORKSPACE_INDEX_GENERATION_READY", {
					generationId: genId,
					added,
					changed,
					removed,
					files: gen.fileCount,
					chunks: gen.chunkCount,
				});
				void prevFileIds;
				void byPath;
				return {
					generationId: genId,
					status: "ready",
					filesIndexed: gen.fileCount,
					chunksIndexed: gen.chunkCount,
					symbolsIndexed: gen.symbolCount,
					embeddingsIndexed: gen.embeddingCount,
					discovered: discovery.files.length,
					skippedIgnored: discovery.skippedIgnored + discovery.skippedBinary + discovery.skippedTooLarge,
					sensitiveSkipped: 0,
					changed,
					added,
					removed,
					rebuild: false,
				};
			} catch (err) {
				this.db.rollback();
				this.db.updateGenerationStatus(genId, "failed");
				throw err;
			}
		} catch (err) {
			this.db.updateGenerationStatus(genId, "failed");
			onEvent("WORKSPACE_INDEX_BUILD_FAILED", { generationId: genId });
			throw err;
		}
	}

	private removeGenerationData(genId: string, fileId: string, _contentSha: string): void {
		const chunks = this.db.chunksForFile(genId, fileId);
		for (const c of chunks) {
			deleteLexical(this.db, genId, c.chunkId);
			this.db.db.prepare("DELETE FROM vectors WHERE generation_id = ? AND chunk_id = ?").run(genId, c.chunkId);
			this.db.db.prepare("DELETE FROM chunks WHERE generation_id = ? AND chunk_id = ?").run(genId, c.chunkId);
		}
		this.db.db.prepare("DELETE FROM symbols WHERE generation_id = ? AND file_id = ?").run(genId, fileId);
		this.db.db
			.prepare(
				"DELETE FROM relations WHERE generation_id = ? AND source_symbol_id IN (SELECT symbol_id FROM symbols WHERE generation_id = ? AND file_id = ?)",
			)
			.run(genId, genId, fileId);
		this.db.db.prepare("DELETE FROM git_meta WHERE generation_id = ? AND file_id = ?").run(genId, fileId);
		this.db.db.prepare("DELETE FROM files WHERE generation_id = ? AND file_id = ?").run(genId, fileId);
	}

	private modelFile(
		abs: string,
		rel: string,
		cls: { classification: string; languageId?: string },
		sizeBytes: number,
	): FileModel {
		const content = readFileSync(abs, "utf-8");
		const contentSha256 = sha256(content);
		const fileId = sha256(`${this.identity.workspaceId}:${rel}`).slice(0, 32);
		const languageId = cls.languageId;
		const classification = cls.classification;
		const lineCount = content.replace(/\r\n/g, "\n").split("\n").length;

		let symbolsRaw = languageId ? extractSymbolsHeuristic(languageId, content) : [];
		if (languageId === "markdown" || classification === "documentation") symbolsRaw = markdownSections(content);

		const chunks = chunkFile({
			fileId,
			content,
			contentSha256,
			languageId,
			classification,
			symbols: symbolsRaw.length ? symbolsRaw : undefined,
		});

		const symbols = symbolsRaw.map((s) => ({
			symbolId: sha256(`${fileId}:${s.qualifiedName ?? s.name}`).slice(0, 32),
			name: s.name,
			qualifiedName: s.qualifiedName,
			kind: s.kind,
			languageId: s.languageId,
			startLine: s.startLine,
			startCharacter: s.startCharacter,
			endLine: s.endLine,
			endCharacter: s.endCharacter,
		}));

		return {
			fileId,
			relPath: rel,
			content,
			contentSha256,
			classification,
			languageId,
			sizeBytes,
			lineCount,
			isSensitive: false,
			chunks,
			symbols,
		};
	}

	private async writeFilesToGeneration(
		genId: string,
		files: FileModel[],
		embed: EmbeddingBackend,
		embedEnabled: boolean,
		signal?: AbortSignal,
		_onEvent: (e: string, p?: Record<string, unknown>) => void = () => {},
	): Promise<void> {
		// Git metadata in batches.
		const gitMeta = collectGitMetadata(
			this.identity.canonicalRoot,
			files.map((f) => f.relPath),
			{
				historyDepth: this.config.historyDepth,
			},
		);
		for (const f of files)
			await this.writeFileModel(genId, f, embed, embedEnabled, signal, gitMeta.files.get(f.relPath));
	}

	private async writeFileModel(
		genId: string,
		f: FileModel,
		embed: EmbeddingBackend,
		embedEnabled: boolean,
		signal?: AbortSignal,
		gitMeta?: GitFileMeta,
	): Promise<void> {
		if (signal?.aborted) throw abortError();
		this.db.insertFile(genId, {
			fileId: f.fileId,
			path: f.relPath,
			languageId: f.languageId,
			classification: f.classification,
			contentSha256: f.contentSha256,
			sizeBytes: f.sizeBytes,
			lineCount: f.lineCount,
			gitBlobId: gitMeta?.gitBlobId,
			isTracked: gitMeta?.isTracked ?? true,
			isGenerated: f.classification === "generated",
			isSensitive: f.isSensitive,
			indexedAt: new Date().toISOString(),
		});
		if (gitMeta) {
			this.db.insertGitMeta(genId, f.fileId, {
				lastCommit: gitMeta.lastCommit,
				commitTime: gitMeta.lastCommitTime,
				changeCount: gitMeta.changeCount,
			});
		}

		// Chunks
		for (const chunk of f.chunks) {
			if (signal?.aborted) throw abortError();
			const sensitiveExcluded = f.isSensitive;
			const kind = chunk.chunkKind;
			this.db.insertChunk(genId, {
				chunkId: chunk.chunkId,
				fileId: f.fileId,
				contentSha256: f.contentSha256,
				startLine: chunk.startLine,
				endLine: chunk.endLine,
				startByte: chunk.startByte,
				endByte: chunk.endByte,
				languageId: chunk.languageId,
				symbolId: chunk.symbolId,
				chunkKind: kind,
				textHash: chunk.textHash,
				embeddingStatus: sensitiveExcluded ? "excluded" : "not_requested",
				text: chunk.text,
			});

			// Lexical index (even excluded text is NOT indexed → secret policy).
			if (!sensitiveExcluded) {
				const lexText = buildLexText(f.relPath, f.languageId, chunk);
				writeLexical(this.db, genId, chunk.chunkId, f.relPath, lexText);
			}

			// Embedding (skip excluded / generated/vendor / lockfile)
			if (
				embedEnabled &&
				!sensitiveExcluded &&
				!(f.classification === "generated") &&
				f.classification !== "lockfile"
			) {
				const embedText = buildEmbedText(f.relPath, f.languageId, chunk);
				const truncated = truncateForEmbedding(embedText, embed.maximumInputTokens);
				const vector = await embedOne(embed, truncated);
				if (vector) {
					this.db.db
						.prepare("UPDATE chunks SET embedding_status = 'ready' WHERE generation_id = ? AND chunk_id = ?")
						.run(genId, chunk.chunkId);
					new VectorIndex(this.db).store(
						genId,
						chunk.chunkId,
						sha256(truncated),
						embed.modelId,
						embed.dimensions,
						vector,
					);
				}
			}
		}

		// Symbols
		for (const s of f.symbols) {
			this.db.insertSymbol(genId, {
				symbolId: s.symbolId,
				fileId: f.fileId,
				name: s.name,
				qualifiedName: s.qualifiedName,
				kind: s.kind,
				languageId: s.languageId,
				startLine: s.startLine,
				startCharacter: s.startCharacter,
				endLine: s.endLine,
				endCharacter: s.endCharacter,
				containerSymbolId: undefined,
			});
			// Self/define relation from parser source (low confidence).
			this.db.insertRelation(genId, {
				relationId: `${s.symbolId}:def`,
				sourceSymbolId: s.symbolId,
				relationType: "defines",
				source: "parser",
				confidence: 0.5,
			});
		}
	}
}

function buildLexText(rel: string, languageId: string | undefined, chunk: ChunkOutput): string {
	const nameParts = chunk.symbolId ? chunk.symbolId : "";
	return [path.posix.basename(rel), rel, languageId ?? "", nameParts, chunk.text].join(" ");
}

function buildEmbedText(rel: string, languageId: string | undefined, chunk: ChunkOutput): string {
	return [
		`path: ${rel}`,
		`language: ${languageId ?? ""}`,
		chunk.symbolId ? `symbol: ${chunk.symbolId}` : "",
		chunk.text,
	].join("\n");
}

async function embedOne(embed: EmbeddingBackend, text: string): Promise<number[] | undefined> {
	if (embed.backendId === "fixture") {
		const r = embed as unknown as { vectorFor(text: string): number[] };
		return r.vectorFor(text);
	}
	// Async local/remote backends.
	try {
		const result = await embed.embed({ texts: [text] });
		return result.embeddings[0];
	} catch {
		return undefined; // embedding failure degrades gracefully
	}
}

function throwObject(_code: string): never {
	const err = new Error("cancelled");
	err.name = "AbortError";
	throw err;
}

function abortError(): Error {
	const e = new Error("cancelled");
	e.name = "AbortError";
	return e;
}
