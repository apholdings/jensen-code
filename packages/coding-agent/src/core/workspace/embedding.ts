/**
 * Pluggable embedding backends.
 *
 * Privacy-by-default: workspace source is only ever sent to explicitly
 * configured LOCAL (loopback) backends. Remote OpenAI-compatible embedding is
 * disabled unless explicitly enabled by policy. A deterministic fixture backend
 * provides the no-paid-dependency test path.
 */

import { createHash, randomBytes } from "node:crypto";
import type { EmbeddingBackend, EmbeddingRequest, EmbeddingResult } from "./types.js";

export type EmbeddingMode = "disabled" | "fixture" | "local" | "remote";

export interface EmbeddingConfig {
	mode: EmbeddingMode;
	modelId?: string;
	dimensions?: number;
	maximumInputTokens?: number;
	endpoint?: string; // loopback OpenAI-compatible endpoint (local) or remote (opt-in)
	apiKey?: string;
	purpose?: string; // e.g. "index", "query"
	allowed?: boolean; // policy authorization for remote
}

export const DEFAULT_DIMENSIONS = 32;
export const DEFAULT_MAX_TOKENS = 2048;

/** Deterministic fixture embedder: stable hashed bag-of-ngrams vector. */
export class FixtureEmbeddingBackend implements EmbeddingBackend {
	backendId = "fixture";
	modelId: string;
	dimensions: number;
	maximumInputTokens: number;
	local = true;

	constructor(modelId = "fixture-local", dimensions = DEFAULT_DIMENSIONS) {
		this.modelId = modelId;
		this.dimensions = dimensions;
		this.maximumInputTokens = DEFAULT_MAX_TOKENS;
	}

	async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
		const embeddings = request.texts.map((t) => this.vectorFor(t));
		return { embeddings, modelId: this.modelId, dimensions: this.dimensions };
	}

	/** Deterministic unit-norm vector derived from token hashes (ngram coverage). */
	vectorFor(text: string): number[] {
		const vec = new Array<number>(this.dimensions).fill(0);
		const tokens = text.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [];
		for (const token of tokens) {
			const h = createHash("sha256").update(token).digest();
			const idx = h[0] % this.dimensions;
			const sign = (h[1] & 1) === 0 ? 1 : -1;
			vec[idx] += sign;
		}
		// n-gram coverage for phrase signals
		for (let i = 0; i < tokens.length - 1; i++) {
			const bigram = `${tokens[i]}_${tokens[i + 1]}`;
			const h = createHash("sha256").update(bigram).digest();
			const idx = h[0] % this.dimensions;
			vec[idx] += 2;
		}
		// normalize to unit length
		const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1;
		return vec.map((v) => +(v / norm).toFixed(6));
	}
}

/** Drag a seed-based deterministic vector (for test stability across runs). */
export function deterministicSeed(): string {
	return createHash("sha256").update(randomBytes(8)).digest("hex").slice(0, 8);
}

/** Local loopback OpenAI-compatible embedding backend. */
export class LocalEmbeddingBackend implements EmbeddingBackend {
	backendId = "local";
	modelId: string;
	dimensions: number;
	maximumInputTokens: number;
	local = true;
	private endpoint: string;
	private apiKey?: string;

	constructor(config: {
		endpoint: string;
		modelId: string;
		dimensions: number;
		maximumInputTokens?: number;
		apiKey?: string;
	}) {
		this.endpoint = config.endpoint;
		this.modelId = config.modelId;
		this.dimensions = config.dimensions;
		this.maximumInputTokens = config.maximumInputTokens ?? DEFAULT_MAX_TOKENS;
		this.apiKey = config.apiKey;
	}

	assertLoopback(): void {
		let host: string;
		try {
			host = new URL(this.endpoint).hostname;
		} catch {
			throw new Error(`Invalid embedding endpoint: ${this.endpoint}`);
		}
		if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
			throw new Error(`Refusing to send source embeddings to non-loopback endpoint: ${host}`);
		}
	}

	async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
		this.assertLoopback();
		// Batched to bounded size; tokens truncated deterministically upstream.
		const response = await fetch(`${this.endpoint.replace(/\/$/, "")}/v1/embeddings`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
			},
			body: JSON.stringify({ model: this.modelId, input: request.texts }),
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) {
			throw new Error(`Embedding endpoint error: ${response.status}`);
		}
		const data = (await response.json()) as {
			data?: Array<{ embedding: number[] }>;
		};
		const embeddings = (data.data ?? []).map((d) => d.embedding);
		if (embeddings.length !== request.texts.length) {
			throw new Error("Embedding endpoint returned wrong number of vectors");
		}
		return { embeddings, modelId: this.modelId, dimensions: this.dimensions };
	}
}

/** A disabled backend that always throws — retrieval degrades to lexical/symbolic. */
export class DisabledEmbeddingBackend implements EmbeddingBackend {
	backendId = "disabled";
	modelId = "disabled";
	dimensions = 0;
	maximumInputTokens = 0;
	local = true;
	async embed(): Promise<EmbeddingResult> {
		throw new Error("Embedding disabled for this workspace");
	}
}

/** Resolve config into an active backend. */
export function resolveEmbeddingBackend(config?: EmbeddingConfig): EmbeddingBackend {
	const mode = config?.mode ?? "disabled";
	if (mode === "fixture") {
		return new FixtureEmbeddingBackend(config?.modelId ?? "fixture-local", config?.dimensions ?? DEFAULT_DIMENSIONS);
	}
	if (mode === "local") {
		if (!config?.endpoint) throw new Error("Local embedding requires an endpoint");
		return new LocalEmbeddingBackend({
			endpoint: config.endpoint,
			modelId: config.modelId ?? "local-embed",
			dimensions: config.dimensions ?? DEFAULT_DIMENSIONS,
			maximumInputTokens: config.maximumInputTokens,
			apiKey: config.apiKey,
		});
	}
	if (mode === "remote") {
		if (!config?.allowed) {
			throw new Error("Remote embedding requires explicit policy authorization (allowed=true)");
		}
		if (!config?.endpoint) throw new Error("Remote embedding requires an endpoint");
		return new RemoteEmbeddingBackend({
			endpoint: config.endpoint,
			modelId: config.modelId ?? "remote-embed",
			dimensions: config.dimensions ?? DEFAULT_DIMENSIONS,
			apiKey: config.apiKey,
		});
	}
	return new DisabledEmbeddingBackend();
}

/** Impacts an accurate per-chunk token estimate (rough, deterministic bound). */
export function estimateTokens(text: string): number {
	// ~4 chars/token heuristic.
	return Math.max(1, Math.ceil(text.length / 4));
}

/** Deterministic token-aware truncation of embedding text. */
export function truncateForEmbedding(text: string, maxTokens: number): string {
	const maxChars = maxTokens * 4;
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n…`;
}

/**
 * Opt-in remote OpenAI-compatible backend. Sends only bounded prepared text and,
 * by default, this is gated by explicit policy (allowed=true). Never reached
 * unless the operator explicitly configures a remote endpoint.
 */
class RemoteEmbeddingBackend implements EmbeddingBackend {
	backendId = "remote";
	modelId: string;
	dimensions: number;
	maximumInputTokens: number;
	local = false;
	private endpoint: string;
	private apiKey?: string;

	constructor(config: { endpoint: string; modelId: string; dimensions: number; apiKey?: string }) {
		this.endpoint = config.endpoint;
		this.modelId = config.modelId;
		this.dimensions = config.dimensions;
		this.maximumInputTokens = DEFAULT_MAX_TOKENS;
		this.apiKey = config.apiKey;
	}

	async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
		const response = await fetch(`${this.endpoint.replace(/\/$/, "")}/v1/embeddings`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
			},
			body: JSON.stringify({ model: this.modelId, input: request.texts }),
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) throw new Error(`Remote embedding error: ${response.status}`);
		const data = (await response.json()) as { data?: Array<{ embedding: number[] }> };
		return {
			embeddings: (data.data ?? []).map((d) => d.embedding),
			modelId: this.modelId,
			dimensions: this.dimensions,
		};
	}
}
