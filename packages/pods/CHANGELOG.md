# @apholdings/jensen-pods

## 1.7.1

### Patch Changes

- @apholdings/jensen-agent-core@1.7.1

## 1.7.0

### Minor Changes

- 6a9e948: Semantic workspace intelligence (1.7.0)

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

### Patch Changes

- Updated dependencies [6a9e948]
  - @apholdings/jensen-agent-core@1.7.0

## 1.6.2

### Patch Changes

- b565a26: Add a canonical policy-bound subagent registry with explicit OpenRouter model routing, typed unknown-agent resolution, structured output contracts, and validated Cavecrew investigator, builder, and reviewer roles.
- 708dac4: Wire canonical subagent resolution, isolated context packets, parent output validation, and deterministic transactional Cavecrew orchestration into runtime dispatch. Make release artifact integrity checks build their inputs before verification.
- Updated dependencies [b565a26]
- Updated dependencies [708dac4]
  - @apholdings/jensen-agent-core@1.6.2

## 1.6.1

### Patch Changes

- fb0f065: Complete operability replay, safe re-execution, MCP transports, validation, storage diagnostics, and release-state classification for the 1.6 contract.
- Updated dependencies [fb0f065]
  - @apholdings/jensen-agent-core@1.6.1

## 1.6.0

### Minor Changes

- 24c2d95: Add canonical run observability projections, deterministic render and projection replay, evidence and diagnostic inspection, sanitized support-bundle previews, and conservative MCP configuration/schema/effect validation surfaces.

### Patch Changes

- Updated dependencies [24c2d95]
  - @apholdings/jensen-agent-core@1.6.0

## 1.5.0

### Patch Changes

- @apholdings/jensen-agent-core@1.5.0

## 1.4.0

### Patch Changes

- Updated dependencies [3485c3c]
  - @apholdings/jensen-agent-core@1.4.0

## 1.3.0

### Patch Changes

- Updated dependencies [a65bbd5]
  - @apholdings/jensen-agent-core@1.3.0

## 1.2.1

### Patch Changes

- @apholdings/jensen-agent-core@1.2.1

## 1.2.0

### Patch Changes

- @apholdings/jensen-agent-core@1.2.0

## 1.1.12

### Patch Changes

- Updated dependencies [64aab5a]
  - @apholdings/jensen-agent-core@1.1.12

## 1.1.11

### Patch Changes

- dcc565a: Prevent Windows shell commands from hanging after launching persistent background processes, while preserving output, timeout, and process-cleanup semantics.
- Updated dependencies [dcc565a]
  - @apholdings/jensen-agent-core@1.1.11

## 1.1.10

### Patch Changes

- Updated dependencies [1dfcae4]
  - @apholdings/jensen-agent-core@1.1.10

## 1.1.9

### Patch Changes

- @apholdings/jensen-agent-core@1.1.9

## 1.1.8

### Patch Changes

- @apholdings/jensen-agent-core@1.1.8

## 1.1.7

### Patch Changes

- @apholdings/jensen-agent-core@1.1.7

## [Unreleased]

## 1.1.6

### Patch Changes

- @apholdings/jensen-agent-core@1.1.6

## 1.1.5

### Patch Changes

- @apholdings/jensen-agent-core@1.1.5

## 1.1.4

### Patch Changes

- @apholdings/jensen-agent-core@1.1.4

## 1.1.2

### Patch Changes

- @apholdings/jensen-agent-core@1.1.2

## 1.1.1

### Patch Changes

- @apholdings/jensen-agent-core@1.1.1

## 1.1.0

### Patch Changes

- @apholdings/jensen-agent-core@1.1.0

## 1.0.9

### Patch Changes

- @apholdings/jensen-agent-core@1.0.9

## [1.1.3] - 2026-07-09

## [1.0.8] - 2026-06-26

### Patch Changes

- @apholdings/jensen-agent-core@1.0.8

## 1.0.7

### Patch Changes

- @apholdings/jensen-agent-core@1.0.7

## 1.0.5

### Patch Changes

- Removed orphaned `WorkingContextPanel` TUI component and its test file, completing the working-context panel removal cleanup. No breaking API changes.
- Updated dependencies
  - @apholdings/jensen-agent-core@1.0.5

## 1.0.4

### Patch Changes

- Updated dependencies
  - @apholdings/jensen-agent-core@1.0.4

## 1.0.3

### Patch Changes

- Release: Add powershell tool, memory snapshots, working-context surface, get_working_context RPC, and /ultraplan command
- Updated dependencies
  - @apholdings/jensen-agent-core@1.0.3

## 1.0.2

### Patch Changes

- @apholdings/jensen-agent-core@1.0.2

## 0.57.7

### Patch Changes

- Refactored interactive mode components to use a new BorderedBox for a cleaner, transparent UI with rounded borders in tool executions and user messages.
- Updated dependencies
  - @apholdings/jensen-agent-core@0.57.7

## 0.57.4

### Patch Changes

- @apholdings/jensen-agent-core@0.57.4

## 0.57.3

### Patch Changes

- @apholdings/jensen-agent-core@0.57.3

## 0.57.2

### Patch Changes

- Updated dependencies
  - @apholdings/jensen-agent-core@0.57.2

## 0.1.3

### Patch Changes

- Promote `JENSEN.md` as the preferred project instruction file, keep `AGENTS.md` as a supported fallback with deprecation diagnostics, and update the related interactive messaging and documentation.
- Updated dependencies
  - @apholdings/jensen-agent-core@0.1.3

## 0.1.0

### Minor Changes

- 2f3d37c: chore: version bump all packages

### Patch Changes

- a55721e: Normalize package publish metadata and internal dependency ranges for the Changesets-based release flow.
- Updated dependencies [2f3d37c]
  - @apholdings/jensen-agent-core@0.1.0
