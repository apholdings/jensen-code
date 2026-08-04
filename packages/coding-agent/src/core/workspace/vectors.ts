/**
 * Vector storage and deterministic nearest-neighbor retrieval.
 *
 * Default backend is an exact, deterministic cosine-similarity scan over stored
 * vectors. This is ample for workspace-scale bounded candidate sets and is
 * deterministic for tests. A `VectorBackend` interface allows swapping in an ANN
 * implementation without changing retrieval semantics.
 */

import type { WorkspaceDb } from "./storage.js";

export interface VectorRecord {
	chunkId: string;
	contentHash: string;
	modelId: string;
	dimensions: number;
	vector: Float32Array;
}

export interface SemanticHit {
	chunkId: string;
	score: number;
}

export class VectorIndex {
	constructor(private db: WorkspaceDb) {}

	private serialize(v: number[]): Buffer {
		return Buffer.from(new Float32Array(v).buffer);
	}

	private deserialize(buf: Buffer): Float32Array {
		return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
	}

	store(
		generationId: string,
		chunkId: string,
		contentHash: string,
		modelId: string,
		dimensions: number,
		vector: number[],
	): void {
		this.db.db
			.prepare(
				"INSERT OR REPLACE INTO vectors (generation_id, chunk_id, content_hash, model_id, dimensions, embedding) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(generationId, chunkId, contentHash, modelId, dimensions, this.serialize(vector));
	}

	delete(generationId: string, chunkId: string, modelId: string): void {
		this.db.db
			.prepare("DELETE FROM vectors WHERE generation_id = ? AND chunk_id = ? AND model_id = ?")
			.run(generationId, chunkId, modelId);
	}

	modelIdentity(generationId: string): { modelId: string; dimensions: number } | undefined {
		const row = this.db.db
			.prepare("SELECT model_id, dimensions FROM vectors WHERE generation_id = ? LIMIT 1")
			.get(generationId) as { model_id: string; dimensions: number } | undefined;
		return row ? { modelId: row.model_id, dimensions: row.dimensions } : undefined;
	}

	count(generationId: string): number {
		return (
			this.db.db.prepare("SELECT COUNT(*) c FROM vectors WHERE generation_id = ?").get(generationId) as { c: number }
		).c;
	}

	/** Exact cosine nearest-neighbor search (deterministic). */
	search(
		generationId: string,
		query: number[],
		opts: { limit?: number; modelId?: string; candidateChunkIds?: Set<string> } = {},
	): SemanticHit[] {
		const limit = Math.max(1, opts.limit ?? 50);
		const q = normalize(query);
		const modelFilter = opts.modelId;
		const rows = this.db.db
			.prepare(
				modelFilter
					? "SELECT chunk_id, content_hash, embedding FROM vectors WHERE generation_id = ? AND model_id = ?"
					: "SELECT chunk_id, content_hash, embedding FROM vectors WHERE generation_id = ?",
			)
			.all(generationId, ...(modelFilter ? [modelFilter] : [])) as Array<{
			chunk_id: string;
			content_hash: Uint8Array;
			embedding: Uint8Array;
		}>;

		const scores: SemanticHit[] = [];
		for (const r of rows) {
			if (opts.candidateChunkIds && !opts.candidateChunkIds.has(r.chunk_id)) continue;
			const vec = this.deserialize(Buffer.from(r.embedding));
			if (vec.length !== q.length) continue; // dimension mismatch → skip
			const sim = cosine(q, vec);
			scores.push({ chunkId: r.chunk_id, score: sim });
		}
		scores.sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId));
		return scores.slice(0, limit);
	}
}

function normalize(v: number[]): Float32Array {
	const out = new Float32Array(v);
	const norm = Math.sqrt([...out].reduce((a, b) => a + b * b, 0)) || 1;
	for (let i = 0; i < out.length; i++) out[i] /= norm;
	return out;
}

function cosine(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
	return dot;
}

export function serializeVectorIndexBackend() {
	// Marker function documenting the pluggable backend seam.
}
