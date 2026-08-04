# Changelog

## 1.8.2

### Patch Changes

- 3f46ae6: Complete the production evaluation runtime with real sandbox lifecycle enforcement, opt-in live-provider execution, independent reviewers, paired Cavecrew comparisons, versioned evaluation RPC operations, bounded dashboard projections, protected retention and pruning, and single-commit release provenance checks.
- Updated dependencies [3f46ae6]
  - @apholdings/jensen-ai@1.8.2
  - @apholdings/jensen-tui@1.8.2

## 1.8.1

### Patch Changes

- Harden the evaluation artifact store and doctor exit semantics, complete deterministic replay, stability, retrieval, clustering, pruning, RPC, and dashboard projections, and make binary builds resolve Playwright's Chromium BiDi dependency from a clean checkout with verified release manifests.
- Updated dependencies
  - @apholdings/jensen-ai@1.8.1
  - @apholdings/jensen-tui@1.8.1

## 1.8.0

### Minor Changes

- 7447be7: Add a versioned evaluation runtime with deterministic scenario packs, isolated fixtures, replay-safe artifacts, baseline comparison, safety release gates, metrics, and the `jensen eval` CLI.

### Patch Changes

- Updated dependencies [7447be7]
  - @apholdings/jensen-ai@1.8.0
  - @apholdings/jensen-tui@1.8.0

## 1.7.1

### Patch Changes

- @apholdings/jensen-ai@1.7.1
- @apholdings/jensen-tui@1.7.1

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
  - @apholdings/jensen-ai@1.7.0
  - @apholdings/jensen-tui@1.7.0

## 1.6.2

### Patch Changes

- b565a26: Add a canonical policy-bound subagent registry with explicit OpenRouter model routing, typed unknown-agent resolution, structured output contracts, and validated Cavecrew investigator, builder, and reviewer roles.
- 708dac4: Wire canonical subagent resolution, isolated context packets, parent output validation, and deterministic transactional Cavecrew orchestration into runtime dispatch. Make release artifact integrity checks build their inputs before verification.
- Updated dependencies [b565a26]
- Updated dependencies [708dac4]
  - @apholdings/jensen-ai@1.6.2
  - @apholdings/jensen-tui@1.6.2

## 1.6.1

### Patch Changes

- fb0f065: Complete operability replay, safe re-execution, MCP transports, validation, storage diagnostics, and release-state classification for the 1.6 contract.
- Updated dependencies [fb0f065]
  - @apholdings/jensen-ai@1.6.1
  - @apholdings/jensen-tui@1.6.1

## 1.6.0

### Minor Changes

- 24c2d95: Add canonical run observability projections, deterministic render and projection replay, evidence and diagnostic inspection, sanitized support-bundle previews, and conservative MCP configuration/schema/effect validation surfaces.

### Patch Changes

- Updated dependencies [24c2d95]
  - @apholdings/jensen-ai@1.6.0
  - @apholdings/jensen-tui@1.6.0

## 1.5.0

### Patch Changes

- @apholdings/jensen-ai@1.5.0
- @apholdings/jensen-tui@1.5.0

## 1.4.0

### Patch Changes

- @apholdings/jensen-ai@1.4.0
- @apholdings/jensen-tui@1.4.0

## 1.3.0

### Patch Changes

- @apholdings/jensen-ai@1.3.0
- @apholdings/jensen-tui@1.3.0

## 1.2.1

### Patch Changes

- @apholdings/jensen-ai@1.2.1
- @apholdings/jensen-tui@1.2.1

## 1.2.0

### Patch Changes

- @apholdings/jensen-ai@1.2.0
- @apholdings/jensen-tui@1.2.0

## 1.1.12

### Patch Changes

- Updated dependencies [64aab5a]
  - @apholdings/jensen-ai@1.1.12
  - @apholdings/jensen-tui@1.1.12

## 1.1.11

### Patch Changes

- dcc565a: Prevent Windows shell commands from hanging after launching persistent background processes, while preserving output, timeout, and process-cleanup semantics.
- Updated dependencies [dcc565a]
  - @apholdings/jensen-ai@1.1.11
  - @apholdings/jensen-tui@1.1.11

## 1.1.10

### Patch Changes

- Updated dependencies [1dfcae4]
  - @apholdings/jensen-ai@1.1.10
  - @apholdings/jensen-tui@1.1.10

## 1.1.9

### Patch Changes

- @apholdings/jensen-ai@1.1.9
- @apholdings/jensen-tui@1.1.9

## 1.1.8

### Patch Changes

- @apholdings/jensen-ai@1.1.8
- @apholdings/jensen-tui@1.1.8

## 1.1.7

### Patch Changes

- @apholdings/jensen-ai@1.1.7
- @apholdings/jensen-tui@1.1.7

## [Unreleased]

## 1.1.6

### Patch Changes

- Updated dependencies
  - @apholdings/jensen-ai@1.1.6
  - @apholdings/jensen-tui@1.1.6

## 1.1.5

### Patch Changes

- @apholdings/jensen-ai@1.1.5
- @apholdings/jensen-tui@1.1.5

## 1.1.4

### Patch Changes

- @apholdings/jensen-ai@1.1.4
- @apholdings/jensen-tui@1.1.4

## 1.1.2

### Patch Changes

- @apholdings/jensen-ai@1.1.2
- @apholdings/jensen-tui@1.1.2

## 1.1.1

### Patch Changes

- @apholdings/jensen-ai@1.1.1
- @apholdings/jensen-tui@1.1.1

## 1.1.0

### Patch Changes

- @apholdings/jensen-ai@1.1.0
- @apholdings/jensen-tui@1.1.0

## 1.0.9

### Patch Changes

- @apholdings/jensen-ai@1.0.9
- @apholdings/jensen-tui@1.0.9

## [1.1.3] - 2026-07-09

## [1.0.8] - 2026-06-26

### Patch Changes

- Updated dependencies
  - @apholdings/jensen-ai@1.0.8
  - @apholdings/jensen-tui@1.0.8

## 1.0.7

### Patch Changes

- Updated dependencies
  - @apholdings/jensen-ai@1.0.7
  - @apholdings/jensen-tui@1.0.7

## 1.0.5

### Patch Changes

- Removed orphaned `WorkingContextPanel` TUI component and its test file, completing the working-context panel removal cleanup. No breaking API changes.
- @apholdings/jensen-ai@1.0.5
- @apholdings/jensen-tui@1.0.5

## 1.0.4

### Patch Changes

- @apholdings/jensen-ai@1.0.4
- @apholdings/jensen-tui@1.0.4

## 1.0.3

### Patch Changes

- Release: Add powershell tool, memory snapshots, working-context surface, get_working_context RPC, and /ultraplan command
- Updated dependencies
  - @apholdings/jensen-ai@1.0.3
  - @apholdings/jensen-tui@1.0.3

## 1.0.2

### Patch Changes

- @apholdings/jensen-ai@1.0.2
- @apholdings/jensen-tui@1.0.2

## 0.57.7

### Patch Changes

- Refactored interactive mode components to use a new BorderedBox for a cleaner, transparent UI with rounded borders in tool executions and user messages.
- Updated dependencies
  - @apholdings/jensen-ai@0.57.7
  - @apholdings/jensen-tui@0.57.7

## [1.1.3] - 2026-07-09

## [0.57.6] - 2026-03-26

## 0.57.4

### Patch Changes

- Updated dependencies
  - @apholdings/jensen-tui@0.57.4
  - @apholdings/jensen-ai@0.57.4

## 0.57.3

### Patch Changes

- Updated dependencies
  - @apholdings/jensen-tui@0.57.3
  - @apholdings/jensen-ai@0.57.3

## 0.57.2

### Patch Changes

- @apholdings/jensen-ai@0.57.2
- @apholdings/jensen-tui@0.57.2

## 0.1.3

### Patch Changes

- Promote `JENSEN.md` as the preferred project instruction file, keep `AGENTS.md` as a supported fallback with deprecation diagnostics, and update the related interactive messaging and documentation.
- Updated dependencies
  - @apholdings/jensen-ai@0.1.3
  - @apholdings/jensen-tui@0.1.3

## 0.1.0

### Minor Changes

- 2f3d37c: chore: version bump all packages

### Patch Changes

- a55721e: Normalize package publish metadata and internal dependency ranges for the Changesets-based release flow.
- Updated dependencies [a55721e]
- Updated dependencies [2f3d37c]
  - @apholdings/jensen-ai@0.1.0
  - @apholdings/jensen-tui@0.1.0

## [0.1.5] - 2026-03-21

## [0.57.5] - 2026-03-24

## [0.0.1] - 2026-03-15

- Reset version for Jensen Code fork
- Updated branding to Jensen Code
- Synchronized with monorepo baseline

---

## Inherited Upstream History (pi-mono)

## [0.57.1] - 2026-03-07

## [0.57.0] - 2026-03-07

## [0.56.3] - 2026-03-06

## [0.56.2] - 2026-03-05

## [0.56.1] - 2026-03-05

## [0.56.0] - 2026-03-04

## [0.55.4] - 2026-03-02

## [0.55.3] - 2026-02-27

## [0.55.2] - 2026-02-27

## [0.55.1] - 2026-02-26

## [0.55.0] - 2026-02-24

## [0.54.2] - 2026-02-23

## [0.54.1] - 2026-02-22

## [0.54.0] - 2026-02-19

## [0.53.1] - 2026-02-19

## [0.53.0] - 2026-02-17

## [0.52.12] - 2026-02-13

## [0.52.11] - 2026-02-13

## [0.52.10] - 2026-02-12

### Fixed

- Made model selector search case-insensitive by normalizing query tokens, fixing auto-capitalized mobile input filtering ([#1443](https://github.com/badlogic/pi-mono/issues/1443))

## [0.52.9] - 2026-02-08

## [0.52.8] - 2026-02-07

## [0.52.7] - 2026-02-06

## [0.52.6] - 2026-02-05

## [0.52.5] - 2026-02-05

## [0.52.4] - 2026-02-05

## [0.52.3] - 2026-02-05

## [0.52.2] - 2026-02-05

## [0.52.1] - 2026-02-05

## [0.52.0] - 2026-02-05

## [0.51.6] - 2026-02-04

## [0.51.5] - 2026-02-04

## [0.51.4] - 2026-02-03

## [0.51.3] - 2026-02-03

## [0.51.2] - 2026-02-03

## [0.51.1] - 2026-02-02

## [0.51.0] - 2026-02-01

## [0.50.9] - 2026-02-01

## [0.50.8] - 2026-02-01

## [0.50.7] - 2026-01-31

## [0.50.6] - 2026-01-30

## [0.50.5] - 2026-01-30

## [0.50.3] - 2026-01-29

## [0.50.2] - 2026-01-29

### Added

- Exported `CustomProviderCard`, `ProviderKeyInput`, `AbortedMessage`, and `ToolMessageDebugView` components for custom UIs ([#1015](https://github.com/badlogic/pi-mono/issues/1015))

## [0.50.1] - 2026-01-26

## [0.50.0] - 2026-01-26

## [0.49.3] - 2026-01-22

### Changed

- Updated tsgo to 7.0.0-dev.20260120.1 for decorator support ([#873](https://github.com/badlogic/pi-mono/issues/873))

## [0.49.2] - 2026-01-19

## [0.49.1] - 2026-01-18

## [0.49.0] - 2026-01-17

## [0.48.0] - 2026-01-16

## [0.47.0] - 2026-01-16

## [0.46.0] - 2026-01-15

## [0.45.7] - 2026-01-13

## [0.45.6] - 2026-01-13

## [0.45.5] - 2026-01-13

## [0.45.4] - 2026-01-13

## [0.45.3] - 2026-01-13

## [0.45.2] - 2026-01-13

## [0.45.1] - 2026-01-13

## [0.45.0] - 2026-01-13

## [0.44.0] - 2026-01-12

## [0.43.0] - 2026-01-11

## [0.42.5] - 2026-01-11

## [0.42.4] - 2026-01-10

## [0.42.3] - 2026-01-10

## [0.42.2] - 2026-01-10

## [0.42.1] - 2026-01-09

## [0.42.0] - 2026-01-09

## [0.41.0] - 2026-01-09

## [0.40.1] - 2026-01-09

## [0.40.0] - 2026-01-08

## [0.39.1] - 2026-01-08

## [0.39.0] - 2026-01-08

## [0.38.0] - 2026-01-08

## [0.37.8] - 2026-01-07

## [0.37.7] - 2026-01-07

## [0.37.6] - 2026-01-06

## [0.37.5] - 2026-01-06

## [0.37.4] - 2026-01-06

## [0.37.3] - 2026-01-06

## [0.37.2] - 2026-01-05

## [0.37.1] - 2026-01-05

## [0.37.0] - 2026-01-05

## [0.36.0] - 2026-01-05

## [0.35.0] - 2026-01-05

## [0.34.2] - 2026-01-04

## [0.34.1] - 2026-01-04

## [0.34.0] - 2026-01-04

## [0.33.0] - 2026-01-04

## [0.32.3] - 2026-01-03

## [0.32.2] - 2026-01-03

## [0.32.1] - 2026-01-03

## [0.32.0] - 2026-01-03

## [0.31.1] - 2026-01-02

## [0.31.0] - 2026-01-02

### Breaking Changes

- **Agent class moved to `@apholdings/jensen-agent-core`**: The `Agent` class, `AgentState`, and related types are no longer exported from this package. Import them from `@apholdings/jensen-agent-core` instead.

- **Transport abstraction removed**: `ProviderTransport`, `AppTransport`, `AgentTransport` interface, and related types have been removed. The `Agent` class now uses `streamFn` for custom streaming.

- **`AppMessage` renamed to `AgentMessage`**: Now imported from `@apholdings/jensen-agent-core`. Custom message types use declaration merging on `CustomAgentMessages` interface.

- **`UserMessageWithAttachments` is now a custom message type**: Has `role: "user-with-attachments"` instead of `role: "user"`. Use `isUserMessageWithAttachments()` type guard.

- **`CustomMessages` interface removed**: Use declaration merging on `CustomAgentMessages` from `@apholdings/jensen-agent-core` instead.

- **`agent.appendMessage()` removed**: Use `agent.queueMessage()` instead.

- **Agent event types changed**: `AgentInterface` now handles new event types from `@apholdings/jensen-agent-core`: `message_start`, `message_end`, `message_update`, `turn_start`, `turn_end`, `agent_start`, `agent_end`.

### Added

- **`defaultConvertToLlm`**: Default message transformer that handles `UserMessageWithAttachments` and `ArtifactMessage`. Apps can extend this for custom message types.

- **`convertAttachments`**: Utility to convert `Attachment[]` to LLM content blocks (images and extracted document text).

- **`isUserMessageWithAttachments` / `isArtifactMessage`**: Type guard functions for custom message types.

- **`createStreamFn`**: Creates a stream function with CORS proxy support. Reads proxy settings on each call for dynamic configuration.

- **Default `streamFn` and `getApiKey`**: `AgentInterface` now sets sensible defaults if not provided:

  - `streamFn`: Uses `createStreamFn` with proxy settings from storage
  - `getApiKey`: Reads from `providerKeys` storage

- **Proxy utilities exported**: `applyProxyIfNeeded`, `shouldUseProxyForProvider`, `isCorsError`, `createStreamFn`

### Removed

- `Agent` class (moved to `@apholdings/jensen-agent-core`)
- `ProviderTransport` class
- `AppTransport` class
- `AgentTransport` interface
- `AgentRunConfig` type
- `ProxyAssistantMessageEvent` type
- `test-sessions.ts` example file

### Migration Guide

**Before (0.30.x):**

```typescript
import { Agent, ProviderTransport, type AppMessage } from '@apholdings/jensen-web-ui';

const agent = new Agent({
  transport: new ProviderTransport(),
  messageTransformer: (messages: AppMessage[]) => messages.filter(...)
});
```

**After:**

```typescript
import { Agent, type AgentMessage } from "@apholdings/jensen-agent-core";
import { defaultConvertToLlm } from "@apholdings/jensen-web-ui";

const agent = new Agent({
  convertToLlm: (messages: AgentMessage[]) => {
    // Extend defaultConvertToLlm for custom types
    return defaultConvertToLlm(messages);
  },
});
// AgentInterface will set streamFn and getApiKey defaults automatically
```

**Custom message types:**

```typescript
// Before: declaration merging on CustomMessages
declare module "@apholdings/jensen-web-ui" {
  interface CustomMessages {
    "my-message": MyMessage;
  }
}

// After: declaration merging on CustomAgentMessages
declare module "@apholdings/jensen-agent-core" {
  interface CustomAgentMessages {
    "my-message": MyMessage;
  }
}
```
