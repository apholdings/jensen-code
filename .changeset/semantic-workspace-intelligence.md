---
"@apholdings/jensen-code": minor
"@apholdings/jensen-agent-core": minor
"@apholdings/jensen-ai": minor
"@apholdings/jensen-mom": minor
"@apholdings/jensen-pods": minor
"@apholdings/jensen-tui": minor
"@apholdings/jensen-web-ui": minor
---

Semantic workspace intelligence (1.7.0)

Added durable, deterministic workspace indexing and hybrid lexical/symbolic/
semantic retrieval:

- Workspace identity resolution (symlink/junction-safe, Git-repository and
  worktree aware, secret-free).
- Durable per-workspace SQLite index on the built-in `node:sqlite` backend with
  atomic, versioned, rebuildable generations. No new dependency; no cloud or
  paid service required.
- Deterministic file discovery and classification with `.gitignore` /
  `.jensenindexignore` support, binary/vendor/cache exclusion, and conservative
  secret-sensitive-file exclusion (never chunked, embedded, or returned).
- Content-addressed, syntax-aware chunking (symbol/section/config/fallback).
- Portable postings + BM25 lexical retrieval with identifier-aware tokenization
  (exact/prefix/phrase/path/symbol) that does not depend on FTS5 availability.
- Symbolic index and relationships with heuristic parser plus LSP integration.
- Bounded Git metadata and worktree fingerprints for ranking/invalidation.
- Pluggable embedding backends: deterministic local fixture (default, no paid
  dependency), local loopback OpenAI-compatible endpoint, and opt-in remote.
  Remote embedding is disabled by default. Deterministic exact vector search.
- Deterministic query planner, reciprocal-rank fusion, and heuristic reranking
  with explicit reason codes and per-file diversity.
- Freshness labeling, content-hash revalidation, and incremental refresh
  (added/modified/removed files), plus pruning and integrity verify/rebuild.
- CLI commands (`index`, `search`, `retrieval`, `doctor index|embeddings|retrieval`),
  provider-independent workspace tools with declared effects, doctor checks,
  bounded context packets and evidence records, and per-subagent retrieval
  policies (scout, cavecrew-investigator, planner, worker, builder, reviewer).
- Deterministic Linux and Windows test suites; requires Node.js >= 22.5.0
  (bundled `node:sqlite`). The index is always a disposable, rebuildable
  projection and never an execution authority.
