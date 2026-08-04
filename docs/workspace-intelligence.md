# Jensen Workspace Intelligence (1.7.0)

Durable, local-first workspace indexing and hybrid lexical/symbolic/semantic
retrieval. The workspace index is a disposable, rebuildable *projection* of the
authoritative current workspace. It is never an execution authority.

## Core invariants

- **Workspace files remain authoritative.** The index never writes source files
  and never rolls back source state.
- **Git state remains authoritative.** Git metadata is a bounded ranking and
  invalidation signal only, never a rollback mechanism.
- **LSP results are current-state evidence.** Document symbols are tied to the
  content hash / document version of the current file.
- **The index is rebuildable and disposable.** Any generation can be discarded
  and rebuilt from current files. Index state is never packaged or committed.
- **The index is never an execution authority.** Retrieval results cannot
  authorize tools; mutation paths revalidate current file hashes first.
- **Stale results are explicit.** A result labeled `stale`/`possibly_stale` is
  never presented as `current` without revalidation.
- **Privacy by default.** Source is only sent to explicitly configured local
  embedding backends; remote embedding is opt-in policy-only.

## Authority hierarchy

```
current workspace files
  > current Git identity
  > current LSP/compiler state
  > retained evidence artifacts
  > durable index projection
  > cache
  > model interpretation
```

## Architecture

```
workspace discovery → file classification → content extraction → lexical chunks
→ symbols/LSP relationships → Git metadata → optional local embeddings
→ durable index segments → query understanding → candidate generation
→ filtering → fusion → reranking → evidence-backed results → bounded context packet
```

### Workspace identity

`identity.ts` resolves a canonical, symlink/junction-safe root plus a Git
identity (repository common dir, worktree id, branch, HEAD). The workspace id is
a stable hash of `(gitRepositoryId, worktreeId, normalizedRoot)` — never conflating
two repositories with the same folder name, never conflation worktrees, no secret
content embedded. Detached HEAD and non-Git workspaces are supported.

### Storage backend

`storage.ts` uses the Node.js built-in `node:sqlite` (`DatabaseSync`) — zero new
dependency, no native compiler, transactional, cross-platform, crash-recoverable
(WAL). Lexical search uses a portable postings-table + Okapi BM25 implementation
that does not depend on FTS5 availability, so results are identical across
platforms/Node builds. Storage defaults to a user cache directory:

- Linux: `~/.cache/jensen/index/<workspaceId>`
- macOS: `~/Library/Caches/jensen/index/<workspaceId>`
- Windows: `%LOCALAPPDATA%\jensen\index\<workspaceId>`

Index data is always outside the source tree by default and never committed.

### Index generations

Indexing is versioned (`schemaVersion`), atomic, and per-workspace. Builds create
a `building` generation that is not query authority; queries always use the most
recent validated `ready` generation. An interrupted build is discardable, and the
previous ready generation remains serving until the new one is ready. Old schemas
rebuild safely.

### File discovery and classification

`discovery.ts` walks the workspace deterministically (sorted), respecting
`.gitignore`, an optional `.jensenindexignore`, workspaces boundaries, symlink /
junction escapes (never traversed), max file size, and cache/vendor/binary/lockfile
exclusion. `classify.ts` maps paths to `source | test | documentation |
configuration | schema | migration | build | generated | vendor | binary |
secret-sensitive | lockfile | unknown`. Secret-sensitive files (`.env`, keys,
credentials, SSH material, npm auth, etc.) are metadata-excluded: never chunked,
never embedded, never returned by search.

### Chunking

`chunk.ts` produces content-addressed chunks preferring symbol boundaries →
markdown/config sections → bounded line windows. Chunk identity is stable while
content is unchanged and changes when content changes. CRLF/LF and BOM handled;
unsupported encodings surface as errors; chunking never modifies files.

### Lexical retrieval

`lexical.ts` implements a portable postings + BM25 full-text search with
identifier-aware tokenization (camelCase, snake_case, kebab, separators),
exact/prefix/phrase/path/symbol-name search, language and file-class filters,
bounded results, stable tie-breaking, deterministic ranking, and parameter-bound
queries (no injection).

### Symbolic index and LSP

`symbols.ts` provides a deterministic heuristic line-based parser (no language
server required) for TS/JS, Python, C#, Java, Go, Rust, and markdown/config
sectioning, plus an LSP document-symbol merge path. `relations` carry source
(`lsp` | `parser` | `lexical_inference`) and confidence; lexically inferred call
graphs are never presented as authoritative. Missing LSP degrades gracefully to
parser-only symbols; stale LSP data is invalidated.

### Git metadata

`git.ts` collects tracked/untracked state, last-modifying commit, change count and
a worktree fingerprint (`gitHead | branch | statusSnapshot`). History is bounded
and shallow-clone-safe; dirty state is represented; current content stays
authoritative. Git signals are used only for bounded ranking/invalidation.

### Embeddings

`embedding.ts` defines a pluggable backend interface. Backends: `disabled`,
`fixture` (deterministic local hash-based, the no-paid-dependency default),
`local` (loopback OpenAI-compatible endpoint, e.g. llama.cpp/Ollama), and `remote`
(opt-in, requires explicit policy authorization). **Remote embedding is disabled by
default** and never enabled implicitly. Embedding text is prepared deterministically
(path, language, symbol, truncated chunk), token-aware, and excludes sensitive,
generated, and vendor content. Failed embeddings degrade gracefully and never
disable lexical retrieval.

### Vector storage

`vectors.ts` stores normalized vectors and performs deterministic exact
cosine search by default (ample for bounded workspace-scale sets, deterministic
for tests). A pluggable `VectorBackend` seam allows replacing with an ANN index
without changing retrieval semantics. Dimensions are validated; model/dimension
changes invalidate incompatible vectors.

### Query planner, fusion, reranking

`planner.ts` classifies queries into modes (exact_identifier, symbol_lookup,
flow_investigation, semantic_concept, documentation, test_discovery,
configuration, historical_change, mixed) and selects bounded generators; exact
identifier queries never depend on embeddings; unavailable embeddings degrade to
lexical/symbolic. `fusion.ts` fuses candidate rankings via Reciprocal Rank Fusion
(RRF, k=60) with per-file diversity, duplicate suppression, and explicit signal
scores / reason codes, then a deterministic heuristic reranker keeps exact
matches strong. A model reranker is optional, explicit, local-by-default, and
cannot invent files/evidence or expand scope.

### Freshness and incremental indexing

Results carry a content hash and a `freshness` label (`current` | `possibly_stale`
| `stale` | `unknown`); `revalidateResult` compares indexed vs current file hash.
`indexer.ts` incremental `refresh()` detects added/modified/removed files,
rechunks only changed files, updates postings/symbols/git/embeddings, and atomically
commits a new generation. No full rebuild on small changes.

### Background jobs

Index building/refresh is designed to run under Jensen's durable background-job
infrastructure as a workspace-scoped exclusive index-writer; reads continue on the
last ready generation during a build. (See `core/jobs`.)

### Context pack and evidence

`context-packet.ts` builds a bounded `RetrievalContextPacket` and maps results to
addressable `RetrievalEvidenceRecord`s. `renderPacketAsEvidence` emits
untrusted-delimited evidence text so retrieved source cannot alter policy or
authorize tools. Evidence ids are stable and revalidatable.

### Subagent retrieval policies

Each built-in subagent declares a `retrieval` policy (allowed, mode, maxResults,
maxContextTokens, revalidateBeforeMutation) in `subagent-registry.ts`. Scout uses
lexical; cavecrew-investigator uses hybrid + LSP + Git (read-only, references
evidence ids); planner receives bounded validated evidence; worker/builder must
revalidate current file hashes before mutating; reviewer retrieves related
tests/diffs read-only. Child permissions remain the intersection of parent
authorization, policy, agent, skill and retrieval policy.

### CLI

```
jensen index status|build|refresh|rebuild|verify|generations|inspect <gen>
       |files|symbols|stats|prune [--preview|--execute] [--json] [--root <dir>]
jensen search [lexical|semantic|symbol|hybrid|path] <query> [--limit N] [--json]
jensen retrieval plan <query> | retrieval explain <result-id>
jensen doctor index|embeddings|retrieval
```

All default commands are bounded; `--json` produces machine-readable output.

### Tool surfaces

Provider-independent tools:
`workspace_search`, `workspace_search_lexical`, `workspace_search_semantic`,
`workspace_search_symbols`, `workspace_retrieval_status` (all read-only,
`readsWorkspace`, parallel-safe) and `workspace_index_refresh` (writes only
Jensen-managed runtime state, not parallel-safe). Effects are declared in
`core/safety/effects.ts`.

### Doctor

`jensen doctor index|embeddings|retrieval` and the generic `jensen doctor` surface
index storage/schema/ready-generation/freshness/embedding-mode checks
(`workspaceDoctorChecks`). Embeddings-disabled is reported as skipped/warn, not a
failure; genuine corruption is a failure. Doctor is read-only.

## Privacy and security

- No source upload by default; remote embedding is opt-in policy-only.
- Secret-sensitive files are never chunked, embedded, or returned.
- Queries are parameter-bound (no injection); path filters are workspace-bound.
- Indexed content is treated as untrusted evidence and can never authorize tools.
- Index storage is never committed and never packaged.
- Support bundles and durable events are sanitized and secret-free.

## Performance

Deterministic fixtures: small (100 files), medium (2,000), large synthetic
(10,000). Bounds: max file size, max chunk size/lines, max candidates/results,
max embedding batch, max query time. Lexical/symbolic/hybrid queries are
sub-millisecond-to-low-millisecond at workspace scale; indexing is incremental.

## Testing

Deterministic Linux/Windows-friendly fixtures cover discovery, ignore policy,
sensitive exclusion, chunking, lexical/symbolic/semantic/hybrid retrieval,
deterministic ordering, duplicate suppression, diversity, explanation, embeddings
(disabled/fixture/dimension-change/failure), freshness, incremental add/modify/
remove, generations, prune, security (injection, traversal, symlink, secrets),
revalidation, and the tool surface. Windows-specific junction/case/locking tests
run on Windows CI. No paid APIs, public endpoints, or external vector databases.

## Troubleshooting

- **No ready generation** — run `jensen index build`.
- **Embeddings disabled** — set `JENSEN_INDEX_EMBEDDINGS=fixture` or configure a
  local endpoint; lexical/symbolic still work regardless.
- **Stale results** — run `jensen index refresh`; results are revalidated by hash.
- **Corrupt index** — `jensen index verify` then `jensen index rebuild` (source is
  never touched).
- **Key paths**: `packages/coding-agent/src/core/workspace/`
