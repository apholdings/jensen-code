/**
 * Workspace Intelligence public facade.
 *
 * Provides a single entry point for building, refreshing, querying and
 * diagnosing a durable workspace index. The index is always a disposable,
 * rebuildable projection of the authoritative current workspace.
 */

import { mkdirSync, rmSync } from "node:fs";
import { embeddingSummary, resolveIndexConfig, type WorkspaceIndexConfig } from "./config.js";
import { resolveEmbeddingBackend } from "./embedding.js";
import { type ResolvedWorkspaceIdentity, resolveWorkspaceIdentity, workspaceIndexDir } from "./identity.js";
import { type BuildOptions, type BuildReport, WorkspaceIndexer } from "./indexer.js";
import { planQuery } from "./planner.js";
import { executeRetrieval, revalidateResult } from "./retrieve.js";
import { WorkspaceDb } from "./storage.js";
import type { EmbeddingBackend, RetrievalPlan, WorkspaceRetrievalResult } from "./types.js";
import { VectorIndex } from "./vectors.js";

export interface IndexStatus {
	workspaceId: string;
	root: string;
	storageDir: string;
	hasReadyGeneration: boolean;
	currentGeneration?: string;
	generationCount: number;
	schemaVersion: number;
	embedding: ReturnType<typeof embeddingSummary>;
	fileCount?: number;
	chunkCount?: number;
	symbolCount?: number;
	embeddingCount?: number;
	freshnessCheck?: "current" | "possibly_stale" | "stale" | "unknown";
}

export interface SearchOptions {
	query: string;
	mode?: "lexical" | "semantic" | "symbol" | "hybrid" | "path";
	limit?: number;
	languageFilters?: string[];
	fileClassFilters?: string[];
	pathFilter?: string;
	currentFile?: string;
	currentSymbol?: string;
	freshOnly?: boolean;
	taskRole?: string;
}

export class WorkspaceIndex {
	readonly identity: ResolvedWorkspaceIdentity;
	readonly config: WorkspaceIndexConfig;
	readonly storageDir: string;
	private db: WorkspaceDb;
	private embedding?: EmbeddingBackend;

	constructor(cwd: string, config?: Partial<WorkspaceIndexConfig>) {
		this.config = resolveIndexConfig(config);
		this.identity = resolveWorkspaceIdentity(cwd);
		this.storageDir = workspaceIndexDir(this.config.storageRoot ?? "", this.identity.workspaceId);
		mkdirSync(this.storageDir, { recursive: true });
		this.db = WorkspaceDb.open(this.storageDir, this.identity.workspaceId);
	}

	close(): void {
		this.db.close();
	}

	/** Resolve the configured embedding backend, or a supplied override for tests. */
	private getEmbedding(override?: EmbeddingBackend): EmbeddingBackend {
		if (override) return override;
		if (!this.embedding) this.embedding = resolveEmbeddingBackend(this.config.embedding);
		return this.embedding;
	}

	async build(opts: BuildOptions = {}): Promise<BuildReport> {
		const indexer = new WorkspaceIndexer(this.db, this.identity, this.config);
		return indexer.build({ ...opts, embedBackend: this.getEmbedding(opts.embedBackend) });
	}

	async refresh(opts: BuildOptions = {}): Promise<BuildReport> {
		const indexer = new WorkspaceIndexer(this.db, this.identity, this.config);
		return indexer.refresh({ ...opts, embedBackend: this.getEmbedding(opts.embedBackend) });
	}

	status(): IndexStatus {
		const ready = this.db.currentReadyGeneration();
		const counts = ready ? this.db.counts(ready.generationId) : undefined;
		const build = this.db.currentBuildingGeneration();
		return {
			workspaceId: this.identity.workspaceId,
			root: this.identity.canonicalRoot,
			storageDir: this.storageDir,
			hasReadyGeneration: Boolean(ready),
			currentGeneration: ready?.generationId,
			generationCount: this.db.listGenerations().length,
			schemaVersion: this.config ? 1 : 1,
			embedding: embeddingSummary(this.config),
			fileCount: counts?.files,
			chunkCount: counts?.chunks,
			symbolCount: counts?.symbols,
			embeddingCount: counts?.embeddings,
			freshnessCheck: build ? "possibly_stale" : ready ? "current" : "unknown",
		};
	}

	generations(): Array<{
		generationId: string;
		status: string;
		createdAt: string;
		fileCount: number;
		chunkCount: number;
	}> {
		return this.db.listGenerations().map((g) => ({
			generationId: g.generationId,
			status: g.status,
			createdAt: g.createdAt,
			fileCount: g.fileCount,
			chunkCount: g.chunkCount,
		}));
	}

	inspectGeneration(generationId: string): object | undefined {
		const gen = this.db.getGeneration(generationId);
		if (!gen) return undefined;
		const counts = this.db.counts(generationId);
		return { generation: gen, counts, manifestHash: this.db.fileManifestHash(generationId) };
	}

	search(opts: SearchOptions): { plan: RetrievalPlan; results: WorkspaceRetrievalResult[] } {
		const embedding = this.getEmbedding();
		const embeddingAvailable = embedding.backendId !== "disabled";
		const plan = planQuery(
			{
				query: opts.query,
				languageFilters: opts.languageFilters,
				fileClassFilters: opts.fileClassFilters,
				pathFilter: opts.pathFilter,
				currentFile: opts.currentFile,
				currentSymbol: opts.currentSymbol,
				taskRole: opts.taskRole,
				maximumResults: opts.limit ?? this.config.maximumResults,
				maximumContextTokens: this.config.maximumContextTokens,
			},
			{ embeddingAvailable },
		);
		// Mode override adjusts generators when explicitly requested.
		if (opts.mode === "lexical") plan.generators = [{ kind: "lexical", limit: plan.maximumResults, filters: {} }];
		else if (opts.mode === "symbol") plan.generators = [{ kind: "symbol", limit: plan.maximumResults, filters: {} }];
		else if (opts.mode === "path") plan.generators = [{ kind: "path", limit: plan.maximumResults, filters: {} }];
		else if (opts.mode === "semantic") {
			plan.generators = embeddingAvailable
				? [{ kind: "semantic", limit: plan.maximumResults, filters: {} }]
				: [{ kind: "lexical", limit: plan.maximumResults, filters: {} }];
		}

		const outcome = executeRetrieval(this.db, {
			plan,
			embedding,
			root: this.identity.canonicalRoot,
			freshOnly: opts.freshOnly,
		});
		return { plan, results: outcome.results };
	}

	/** Revalidate a result's content hash against the current file. */
	revalidate(result: WorkspaceRetrievalResult): WorkspaceRetrievalResult["freshness"] {
		return revalidateResult(result, this.identity.canonicalRoot);
	}

	verify(deep = false): { valid: boolean; issues: string[]; checks: Array<{ name: string; status: string }> } {
		const issues: string[] = [];
		const checks: Array<{ name: string; status: string }> = [];
		try {
			this.db.db.prepare("SELECT COUNT(*) c FROM files").get();
			checks.push({ name: "database", status: "ok" });
		} catch {
			checks.push({ name: "database", status: "corrupt" });
			issues.push("database unreadable or corrupt");
			return { valid: false, issues, checks };
		}
		const ready = this.db.currentReadyGeneration();
		if (!ready) {
			checks.push({ name: "ready_generation", status: "missing" });
		} else {
			const manifest = this.db.fileManifest(ready.generationId);
			const counts = this.db.counts(ready.generationId);
			checks.push({ name: "ready_generation", status: "ok" });
			if (manifest.size !== counts.files) issues.push("file manifest/count mismatch");
			// Dimension consistency for vectors.
			const dims = new VectorIndex(this.db).modelIdentity(ready.generationId);
			if (dims && (dims.dimensions <= 0 || dims.dimensions > 65536)) issues.push("suspicious vector dimensions");
			checks.push({ name: "vectors", status: dims ? "ok" : "none" });
		}
		if (deep) {
			// Deep: recompute manifest hash and compare to stored.
			const recomputed = this.db.fileManifestHash(ready?.generationId ?? "");
			if (ready && recomputed !== ready.sourceSnapshot.fileManifestHash) {
				issues.push("file manifest hash mismatch (index drift)");
			}
		}
		return { valid: issues.length === 0, issues, checks };
	}

	/** Prune superseded/failed generations and stale data. */
	prune(opts: { preview?: boolean; keepAudit?: number; activeEvidence?: Set<string> }): {
		removed: string[];
		preview: boolean;
	} {
		const keepAudit = opts.keepAudit ?? 2;
		const ready = this.db.currentReadyGeneration();
		const gens = this.db.listGenerations();
		const readyOrdered = gens
			.filter((x) => x.status === "ready")
			.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
		const removed: string[] = [];
		for (const g of gens) {
			if (g.generationId === ready?.generationId) continue;
			if (opts.activeEvidence?.has(g.generationId)) continue;
			if (g.status === "ready") {
				const index = readyOrdered.findIndex((x) => x.generationId === g.generationId);
				if (index >= 0 && index < keepAudit) continue; // retain recent ready audit generations
			}
			if (opts.preview) {
				removed.push(g.generationId);
				continue;
			}
			this.deleteGenerationData(g.generationId);
			this.db.db.prepare("DELETE FROM generations WHERE generation_id = ?").run(g.generationId);
			removed.push(g.generationId);
		}
		return { removed, preview: Boolean(opts.preview) };
	}

	private deleteGenerationData(generationId: string): void {
		for (const table of ["files", "chunks", "symbols", "relations", "git_meta", "vectors", "postings", "lex"]) {
			this.db.db.prepare(`DELETE FROM ${table} WHERE generation_id = ?`).run(generationId);
		}
	}

	/** Discard all index state for the workspace (rebuild from source). */
	async rebuild(opts: BuildOptions = {}): Promise<BuildReport> {
		// Leave old ready generation serving during rebuild; then supersede it.
		const report = await this.build(opts);
		const prev = this.db
			.listGenerations()
			.filter((g) => g.status === "ready" && g.generationId !== report.generationId);
		for (const p of prev) this.db.updateGenerationStatus(p.generationId, "superseded");
		return report;
	}

	/** Delete the entire index directory (destructive, user-invoked). */
	destroy(): void {
		this.db.close();
		try {
			rmSync(this.storageDir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}

	/** List indexed file records for a generation (bounded). */
	files(generationId?: string): Array<{ path: string; classification: string; languageId?: string }> {
		const gen = generationId ?? this.db.currentReadyGeneration()?.generationId;
		if (!gen) return [];
		const rows = this.db.db
			.prepare(
				"SELECT path, classification, language_id FROM files WHERE generation_id = ? ORDER BY path LIMIT 5000",
			)
			.all(gen) as Array<{ path: string; classification: string; language_id: string | null }>;
		return rows.map((r) => ({
			path: r.path,
			classification: r.classification,
			languageId: r.language_id ?? undefined,
		}));
	}

	symbols(generationId?: string, limit = 500): Array<{ name: string; kind: string; path: string; startLine: number }> {
		const gen = generationId ?? this.db.currentReadyGeneration()?.generationId;
		if (!gen) return [];
		const rows = this.db.db
			.prepare(
				"SELECT s.name, s.kind, f.path, s.start_line FROM symbols s JOIN files f ON f.generation_id = s.generation_id AND f.file_id = s.file_id WHERE s.generation_id = ? ORDER BY s.name LIMIT ?",
			)
			.all(gen, limit) as Array<{ name: string; kind: string; path: string; start_line: number }>;
		return rows.map((r) => ({ name: r.name, kind: r.kind, path: r.path, startLine: r.start_line }));
	}

	stats(): { files: number; chunks: number; symbols: number; embeddings: number; byLanguage: Record<string, number> } {
		const ready = this.db.currentReadyGeneration();
		if (!ready) return { files: 0, chunks: 0, symbols: 0, embeddings: 0, byLanguage: {} };
		const counts = this.db.counts(ready.generationId);
		const langRows = this.db.db
			.prepare("SELECT language_id, COUNT(*) c FROM files WHERE generation_id = ? GROUP BY language_id")
			.all(ready.generationId) as Array<{ language_id: string | null; c: number }>;
		const byLanguage: Record<string, number> = {};
		for (const r of langRows) byLanguage[r.language_id ?? "unknown"] = r.c;
		return {
			files: counts.files,
			chunks: counts.chunks,
			symbols: counts.symbols,
			embeddings: counts.embeddings,
			byLanguage,
		};
	}
}

export type { WorkspaceIndexConfig } from "./config.js";
// Re-export for convenience.
export { resolveWorkspaceIdentity, workspaceIndexDir } from "./identity.js";
export { executeRetrieval, type RetrieveOptions, revalidateResult } from "./retrieve.js";

/** Doctor checks for the workspace index subsystem (read-only). */
type WsCheckStatus = "pass" | "fail" | "warn" | "unavailable" | "skipped";
export function workspaceDoctorChecks(
	cwd: string,
): Array<{ checkId: string; component: string; status: WsCheckStatus; reasonCode: string; summary: string }> {
	const checks: Array<{
		checkId: string;
		component: string;
		status: WsCheckStatus;
		reasonCode: string;
		summary: string;
	}> = [];
	let index: WorkspaceIndex | undefined;
	try {
		index = new WorkspaceIndex(cwd);
		const status = index.status();
		const verify = index.verify();
		checks.push({
			checkId: "index.storage",
			component: "index",
			status: verify.valid ? "pass" : "fail",
			reasonCode: verify.valid ? "index_readable" : "index_corrupt",
			summary: verify.valid ? `index storage ${status.storageDir}` : verify.issues.join("; "),
		});
		checks.push({
			checkId: "index.ready_generation",
			component: "index",
			status: status.hasReadyGeneration ? "pass" : "warn",
			reasonCode: status.hasReadyGeneration ? "ready_generation_present" : "no_ready_generation",
			summary: status.hasReadyGeneration
				? `generation ${status.currentGeneration} files=${status.fileCount} chunks=${status.chunkCount} symbols=${status.symbolCount}`
				: "no ready generation — run `jensen index build`",
		});
		checks.push({
			checkId: "index.embedding_mode",
			component: "embeddings",
			status: status.embedding.mode === "disabled" ? "skipped" : "pass",
			reasonCode: `embedding_mode_${status.embedding.mode}`,
			summary: `embedding mode=${status.embedding.mode} local=${status.embedding.local} model=${status.embedding.modelId ?? "n/a"} dims=${status.embedding.dimensions ?? "n/a"}`,
		});
		checks.push({
			checkId: "index.freshness",
			component: "index",
			status:
				status.freshnessCheck === "current"
					? "pass"
					: status.freshnessCheck === "possibly_stale"
						? "warn"
						: "unavailable",
			reasonCode: `freshness_${status.freshnessCheck ?? "unknown"}`,
			summary: `index freshness ${status.freshnessCheck ?? "unknown"}`,
		});
	} catch (error) {
		checks.push({
			checkId: "index.storage",
			component: "index",
			status: "fail",
			reasonCode: "index_open_failed",
			summary: error instanceof Error ? error.message : String(error),
		});
	} finally {
		index?.close();
	}
	return checks;
}
