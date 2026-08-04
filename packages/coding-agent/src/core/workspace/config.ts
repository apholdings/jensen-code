/**
 * Workspace index configuration.
 *
 * Defaults are privacy-preserving: the local deterministic fixture embedding
 * backend is on by default (no external data leaves the machine), and remote
 * embedding is always opt-in. Storage defaults to a user-level cache directory
 * outside the source tree.
 */

import type { EmbeddingMode } from "./embedding.js";
import { defaultIndexRoot } from "./identity.js";

export interface WorkspaceIndexConfig {
	storageRoot?: string;
	embedding: {
		mode: EmbeddingMode;
		modelId?: string;
		dimensions?: number;
		maximumInputTokens?: number;
		endpoint?: string;
		apiKey?: string;
		allowed?: boolean;
	};
	maxFileBytes?: number;
	historyDepth?: number;
	additionalIgnores?: string[];
	includeLockfilesAsMetadata?: boolean;
	secretScanner?: boolean;
	maximumResults?: number;
	maximumContextTokens?: number;
}

export function defaultIndexConfig(): WorkspaceIndexConfig {
	return {
		storageRoot: defaultIndexRoot(),
		embedding: {
			mode: "fixture",
			modelId: "fixture-local",
			dimensions: 32,
			maximumInputTokens: 2048,
			allowed: false,
		},
		maxFileBytes: 8 * 1024 * 1024,
		historyDepth: 5,
		includeLockfilesAsMetadata: false,
		secretScanner: true,
		maximumResults: 50,
		maximumContextTokens: 4096,
	};
}

/**
 * Resolve effective config from disk (optional JENSEN-index.json) merged over
 * defaults and environment knobs. Environment never enables remote embedding
 * implicitly.
 */
export function resolveIndexConfig(overrides?: Partial<WorkspaceIndexConfig>): WorkspaceIndexConfig {
	const base = defaultIndexConfig();
	let mode: EmbeddingMode = base.embedding.mode;
	const envMode = process.env.JENSEN_INDEX_EMBEDDINGS;
	if (envMode === "disabled" || envMode === "fixture" || envMode === "local" || envMode === "remote") {
		mode = envMode;
	}
	const cfg = { ...base, ...overrides, embedding: { ...base.embedding, ...(overrides?.embedding ?? {}) } };
	// Environment storage-root override (for tests/tools, never comitted state).
	const envRoot = process.env.JENSEN_INDEX_STORAGE_ROOT;
	if (envRoot) cfg.storageRoot = envRoot;
	if (mode !== base.embedding.mode) cfg.embedding = { ...cfg.embedding, mode };
	if (cfg.embedding.mode === "remote") {
		// Remote requires explicit policy; if allowed is not true, degrade to fixture.
		if (!cfg.embedding.allowed) {
			cfg.embedding.mode = "fixture";
		}
	}
	return cfg;
}

export function embeddingSummary(cfg: WorkspaceIndexConfig): {
	mode: EmbeddingMode;
	modelId?: string;
	dimensions?: number;
	endpoint?: string;
	local: boolean;
	policyRequired: boolean;
} {
	const local =
		cfg.embedding.mode === "fixture" || cfg.embedding.mode === "local" || cfg.embedding.mode === "disabled";
	return {
		mode: cfg.embedding.mode,
		modelId: cfg.embedding.modelId,
		dimensions: cfg.embedding.dimensions,
		endpoint: cfg.embedding.endpoint,
		local,
		policyRequired: cfg.embedding.mode === "remote",
	};
}
