# Semantic Workspace Intelligence — Research Notes

Scope: durable, local-first workspace indexing and hybrid lexical/symbolic/semantic
retrieval for Jensen 1.7.0. Research was conducted against primary sources and reference
implementations, then interpreted into Jensen-native architecture.

## Primary sources studied

- **Node.js built-in SQLite module (`node:sqlite`, `DatabaseSync`)** — Node 22.5+ API for
  synchronous embedded SQLite. On Node 22.22 it provides the FTS5 virtual table module
  and R-tree. Reference: https://nodejs.org/api/sqlite.html and https://sqlite.org/fts5.html.
  Decision: use `node:sqlite` as the durable index backend. Rationale: zero new
  dependency, no native compiler required, bundled and cross-platform, deterministic and
  transactional, supports FTS5 lexical full-text search. FTS5 is a compile-time option; on
  platforms where the bundled SQLite lacks FTS5 (observed reports exist for some macOS /
  newer Node builds), the lexical layer falls back to a pure-JS inverted index with
  identical ranking semantics. This keeps lexical indexing operational everywhere.
- **SQLite FTS5** (https://sqlite.org/fts5.html) — full-text virtual table, BM25 ranking,
  unicode61 tokenizer, prefix queries, phrase queries. Used for exact/prefix/phrase search.
- **Reciprocal Rank Fusion (RRF)** — Cormack, Clarke & Büttcher, 2009, "Reciprocal Rank
  Fusion Online Learning" (SIGIR 2009). Fusion formula `sum 1/(k + rank)` with k=60.
  Used as the deterministic, score-normalization-free fusion of lexical/symbolic/semantic
  candidate rankings.
- **BM25** — Robertson & Zaragoza's "The Probabilistic Relevance Framework: BM25 and
  Beyond" (FnTIR 2009). FTS5 `bm25()` ranking approximates Okapi BM25.
- **tree-sitter** — incremental general-purpose parsing (https://tree-sitter.github.io/).
  Evaluated but rejected for the shipped dependency set: adding the runtime requires
  per-language grammar native/generated bindings and complicates portability. Syntax
  awareness is instead layered as LSP document symbols (when a server is present) with a
  deterministic heuristic parser providing lexical symbol boundaries for TS/JS, Python,
  C#, Java, Go, Rust and config/markdown sectioning. Documented in `docs/chunking.md`.
- **Language Server Protocol** (https://microsoft.github.io/language-server-protocol/) —
  document symbols (`textDocument/documentSymbol`), definitions, references. Jensen's
  existing LSP integration (`packages/coding-agent/src/core/lsp`) provides a current-state
  evidence source for symbol and relationship indexing. Results are bound to document
  version / content hash and treated as current-state evidence, never as authority.
- **Git** — worktree identity via `git rev-parse --git-common-dir` and `--show-toplevel`,
  `git status --porcelain` for dirty state, bounded history for metadata. Used only for
  ranking/invalidation signals; current workspace content remains authoritative.
- **Sourcegraph / Zoekt / ripgrep** — reviewed as reference implementations for
  repository search and ignore semantics. Jensen adopts ripgrep-style `.gitignore` handling
  through the already-present `ignore` npm package and its own discover walker rather than
  shelling out to ripgrep for indexing.
- **USearch / hnswlib / LanceDB** — approximate nearest-neighbor libraries evaluated for
  vector storage. Rejected for the core path: native binaries, npm packaging and Windows
  CI concerns would compromise release portability for marginal speed on workspace-scale
  corpora. Jensen ships an exact, deterministic vector scan as the default backend, which
  is deterministic for tests and ample for bounded candidate counts. A pluggable
  `VectorBackend` interface allows replacing it without changing retrieval semantics.

## Rejected mechanisms

- Cloud-hosted vector database — violates privacy-by-default and no-paid-dependency.
- Uploading source to a remote embedding provider by default — disabled by default; remote
  OpenAI-compatible embedding is opt-in policy-only, and local (loopback) OpenAI-style
  endpoints are supported for local models (llama.cpp, Ollama).
- Native ANN dependencies (hnswlib, USearch, LanceDB) for the default path — portability,
  Windows CI and compiler-free install constraints.
- tree-sitter as a mandatory dependency for the shipped path — portability; hybrid approach
  above.
- Git history as a rollback/authority mechanism — Git metadata is a bounded ranking and
  invalidation signal only.

## Jensen-native architecture decisions

- Durable backend: `node:sqlite` (synchronous, transactional, bundled). FTS5 when
  available, deterministic pure-JS lexical fallback otherwise.
- Storage root: platform-specific user index directory
  (Linux `~/.cache/jensen/index`, macOS `~/Library/Caches/jensen/index`,
  Windows `%LOCALAPPDATA%\jensen\index`), isolated per canonical workspace identity,
  never committed, never packaged, never inside the workspace by default.
- Index generation model: atomic "building → ready" generations; queries always use the
  most recent validated ready generation; interrupted builds are discarded or recoverable.
- Authority hierarchy preserved: current workspace files > git identity > LSP > retained
  evidence > durable index > cache > model interpretation.
- Deterministic query planning, fusion (RRF), heuristic reranking, and a deterministic
  embedding fixture; local OpenAI-style loopback embedding backend; disabled by default for
  substantive source (privacy-by-default).
- Addressable, evidence-backed results with content-hash revalidation and explicit
  stale/current labeling.

## License / provenance

- `node:sqlite`: part of Node.js (MIT).
- SQLite: public domain.
- RRF/BM25: described in academic literature; no licensing constraint on implementation.
- All code implemented from scratch in TypeScript against Jensen architecture.

Research note path: `docs/research/semantic-workspace-intelligence.md`.
