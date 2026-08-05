# Changelog

## 1.10.0

### Minor Changes

- 1f51e24: Add durable Mission Graph and multi-repository program execution.

  Introduces a durable, versioned, scope-explicit execution graph in
  `@apholdings/jensen-code` (`jensen mission …`, `jensen doctor mission`) for
  orchestrating work across one or more declared repositories:

  - A versioned, hashed **Mission Graph** whose identity is a canonical sha-256
    of its semantic payload; revisions are monotonic, completed history is
    preserved, and a mission can never expand its own scope.
  - Authoritative **repository identity** (canonical, credential-free) and
    **worktree allocation** with isolation boundaries; symlink / junction escape
    and any allocation of the operator worktree are rejected; undeclared
    repository drift is detected.
  - A dependency-aware **scheduler** with deterministic parallel waves, a
    configurable parallelism bound, per-repository **write-conflict
    serialization**, **critical-path** analysis, and mission/objective budget
    bounds.
  - Typed **contracts** linking producers to consumers with compatibility and
    stale-contract detection, and transactional **integration** (checkpoint →
    validate → confirm) with **localized rollback** that preserves independent
    completed work.
  - **Human approval gates** (no self-approval, principal-verified, scope
    enforced, rejectable, expirable) and **external blockers** that require
    concrete evidence and cannot be fabricated.
  - Objective and mission **state machines**, repository-scoped **leases**,
    atomic durable storage, an append-only replayable **event log**, and
    **reboot recovery**: a reboot never duplicates an objective, commit, PR or
    publication, treats a recorded dead process as `missing` (never reusing stale
    process or lease authority), and preserves independent completed work.

  Safety invariants preserved: objectives cannot grant one another authority,
  approval nodes cannot be auto-approved, external blockers cannot be fabricated,
  routing never overrides mission policy, evaluation cannot grant authority, and
  replay has zero external effects. All CLI/diagnostic paths run offline on
  deterministic fixtures in normal CI.

### Patch Changes

- Updated dependencies [1f51e24]
  - @apholdings/jensen-ai@1.10.0

## 1.9.0

### Minor Changes

- 0432891: Add evidence-driven adaptive orchestration subsystem.

  Introduces a canonical, evidence-driven orchestration decision engine in
  `@apholdings/jensen-code` (`jensen routing …`) that selects the execution
  strategy for each task using durable, replayable evidence rather than
  hardcoded workflows:

  - Deterministic task feature extraction with a versioned schema.
  - Candidate generation from canonical registries only, bounded and
    deterministically ordered, with hard policy filtering (workspace, tool
    effects, network, provider/model allowlists, cost, model-call, subagent,
    local-only, live-provider authorization).
  - A deterministic baseline policy with explicit rule IDs and precedence that
    works offline and during evaluation-store failure.
  - Evaluation-informed scoring with explicit uncertainty and missing-evidence
    handling (missing evidence is never zero); safety failures stay separate hard
    constraints and are never averaged away.
  - Multi-objective selection across correctness/safety/reliability/cost/latency
    with explicit, versioned weights and operator-authoritative objective.
  - Zero-effect shadow routing and labeled counterfactual evaluation.
  - Conservative offline policy optimization from content-addressed datasets with
    explicit safety/correctness/flakiness promotion gates and idempotent rollback.
  - Typed escalation / de-escalation and fallback / degradation with hard bounds,
    operator budget ceilings, and a mandatory finalization reserve.
  - Budget-class selection, skill/subagent topology selection, retrieval strategy
    selection, and long-horizon integration at governed phase boundaries.
  - Durable addressable events, replayable decisions, and deterministic bounded
    drift detection (quality/cost/latency/failure-cluster/retrieval/flakiness/
    policy-selection).
  - CLI (`jensen routing …`, `jensen doctor routing`), versioned RPC operations,
    and dashboard projections.

  Authority hierarchy: user authorization > safety/effect policy > workspace and
  transaction authority > hard constraints > operator overrides > validated policy

  > evaluation-backed scores > heuristics > model recommendation.

  Safety invariants preserved: routing never overrides safety, never grants new
  tool authority, never expands workspace scope, never exceeds the operator
  budget, never enables a live provider implicitly, and never promotes a policy
  automatically. All CLI/RPC/diagnostic paths run offline on deterministic
  fixtures in normal CI (no paid API calls).

### Patch Changes

- Updated dependencies [0432891]
  - @apholdings/jensen-ai@1.9.0

## 1.8.3

### Patch Changes

- @apholdings/jensen-ai@1.8.3

## 1.8.2

### Patch Changes

- 3f46ae6: Complete the production evaluation runtime with real sandbox lifecycle enforcement, opt-in live-provider execution, independent reviewers, paired Cavecrew comparisons, versioned evaluation RPC operations, bounded dashboard projections, protected retention and pruning, and single-commit release provenance checks.
- Updated dependencies [3f46ae6]
  - @apholdings/jensen-ai@1.8.2

## 1.8.1

### Patch Changes

- Harden the evaluation artifact store and doctor exit semantics, complete deterministic replay, stability, retrieval, clustering, pruning, RPC, and dashboard projections, and make binary builds resolve Playwright's Chromium BiDi dependency from a clean checkout with verified release manifests.
- Updated dependencies
  - @apholdings/jensen-ai@1.8.1

## 1.8.0

### Minor Changes

- 7447be7: Add a versioned evaluation runtime with deterministic scenario packs, isolated fixtures, replay-safe artifacts, baseline comparison, safety release gates, metrics, and the `jensen eval` CLI.

### Patch Changes

- Updated dependencies [7447be7]
  - @apholdings/jensen-ai@1.8.0

## 1.7.1

### Patch Changes

- @apholdings/jensen-ai@1.7.1

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

## 1.6.2

### Patch Changes

- b565a26: Add a canonical policy-bound subagent registry with explicit OpenRouter model routing, typed unknown-agent resolution, structured output contracts, and validated Cavecrew investigator, builder, and reviewer roles.
- 708dac4: Wire canonical subagent resolution, isolated context packets, parent output validation, and deterministic transactional Cavecrew orchestration into runtime dispatch. Make release artifact integrity checks build their inputs before verification.
- Updated dependencies [b565a26]
- Updated dependencies [708dac4]
  - @apholdings/jensen-ai@1.6.2

## 1.6.1

### Patch Changes

- fb0f065: Complete operability replay, safe re-execution, MCP transports, validation, storage diagnostics, and release-state classification for the 1.6 contract.
- Updated dependencies [fb0f065]
  - @apholdings/jensen-ai@1.6.1

## 1.6.0

### Minor Changes

- 24c2d95: Add canonical run observability projections, deterministic render and projection replay, evidence and diagnostic inspection, sanitized support-bundle previews, and conservative MCP configuration/schema/effect validation surfaces.

### Patch Changes

- Updated dependencies [24c2d95]
  - @apholdings/jensen-ai@1.6.0

## 1.5.0

### Patch Changes

- @apholdings/jensen-ai@1.5.0

## 1.4.0

### Minor Changes

- 3485c3c: Code intelligence & tool reliability (1.4.0):

  - Add native Language Server Protocol (LSP) subsystem with nine read-only,
    parallel-safe tools (`lsp_definition`, `lsp_references`, `lsp_implementations`,
    `lsp_hover`, `lsp_diagnostics`, `lsp_document_symbols`, `lsp_workspace_symbols`,
    `lsp_rename_preview`, `lsp_status`), zero-mutation rename preview, and
    transactional rename apply through the existing checkpoint/transaction manager
    with `failOnNewLspErrors` validation gates.
  - Add provider-independent tool-call normalization pipeline (schema flattening,
    conservative argument repair that never invents semantic values, truncated-JSON
    recovery, tightly-bounded tool-call scavenging).
  - Add Tool Storm Breaker with call fingerprints, staged duplicate/no-progress
    thresholds, typed errors, and bounded read-only cache reuse.
  - Add parallel-safe deterministic scheduler: only explicitly `parallelSafe`
    read-only tools run concurrently, mutations are serial barriers, with
    dependency analysis, bounded concurrency, deterministic result ordering and
    cancellation propagation.
  - Add durable background-job registry (`job_start|status|list|logs|stop|restart|adopt`)
    with authoritative process-tree ownership, PID-reuse protection, bounded
    sanitized logs, and long-horizon completion gates.
  - Add `collectExecutionDiagnostics` for `jensen doctor lsp|tools|scheduler|jobs`.

### Patch Changes

- @apholdings/jensen-ai@1.4.0

## 1.3.0

### Minor Changes

- a65bbd5: Add deterministic safe autonomous execution.

  - Typed tool-effect metadata (`ToolEffects`, `EffectScope`) declared on every
    production tool, plus a test that fails when a tool lacks effect metadata.
  - Deterministic policy engine (`deny > approval > allow > default`) with
    `observe` / `plan` / `execute` execution modes and baseline denial rules for
    destructive shell patterns, workspace escapes and secret material.
  - Canonical workspace-boundary enforcement with symlink/junction resolution
    and TOCTOU revalidation on every path-bearing mutation.
  - Exclusive workspace mutation lease with heartbeat and liveness-based stale
    recovery.
  - Content-addressed, integrity-protected pre-mutation checkpoints with
    bounded retention and concurrency-safe garbage collection.
  - Transactional edit batches with deterministic ordering, hash preconditions,
    validation gates, durable confirmation and idempotent, drift-aware rollback.
  - Crash-recovery classification and `jensen workspace *` CLI diagnostics.
  - Durable mutation-lifecycle events gating long-horizon step completion.

### Patch Changes

- @apholdings/jensen-ai@1.3.0

## 1.2.1

### Patch Changes

- @apholdings/jensen-ai@1.2.1

## 1.2.0

### Patch Changes

- @apholdings/jensen-ai@1.2.0

## 1.1.12

### Patch Changes

- 64aab5a: Add a cache-stable context engine with deterministic prompt regions, provider cache telemetry, metadata-only diagnostics, and addressable compaction evidence.
- Updated dependencies [64aab5a]
  - @apholdings/jensen-ai@1.1.12

## 1.1.11

### Patch Changes

- dcc565a: Prevent Windows shell commands from hanging after launching persistent background processes, while preserving output, timeout, and process-cleanup semantics.
- Updated dependencies [dcc565a]
  - @apholdings/jensen-ai@1.1.11

## 1.1.10

### Patch Changes

- 1dfcae4: Validate tool transcripts before provider calls, preserve tool spans through session restore and compaction, and enforce bounded revision-safe todo updates. Export transcript validation utilities and refresh provider model support.
- Updated dependencies [1dfcae4]
  - @apholdings/jensen-ai@1.1.10

## 1.1.9

### Patch Changes

- @apholdings/jensen-ai@1.1.9

## 1.1.8

### Patch Changes

- @apholdings/jensen-ai@1.1.8

## 1.1.7

### Patch Changes

- @apholdings/jensen-ai@1.1.7

## [Unreleased]

## 1.1.6

### Patch Changes

- Updated dependencies
  - @apholdings/jensen-ai@1.1.6

## 1.1.5

### Patch Changes

- @apholdings/jensen-ai@1.1.5

## 1.1.4

### Patch Changes

- @apholdings/jensen-ai@1.1.4

## 1.1.2

### Patch Changes

- @apholdings/jensen-ai@1.1.2

## 1.1.1

### Patch Changes

- @apholdings/jensen-ai@1.1.1

## 1.1.0

### Patch Changes

- @apholdings/jensen-ai@1.1.0

## 1.0.9

### Patch Changes

- @apholdings/jensen-ai@1.0.9

## [1.1.3] - 2026-07-09

## [1.0.8] - 2026-06-26

### Patch Changes

- Updated dependencies
  - @apholdings/jensen-ai@1.0.8

## 1.0.7

### Patch Changes

- Updated dependencies
  - @apholdings/jensen-ai@1.0.7

## 1.0.5

### Patch Changes

- Removed orphaned `WorkingContextPanel` TUI component and its test file, completing the working-context panel removal cleanup. No breaking API changes.
  - @apholdings/jensen-ai@1.0.5

## 1.0.4

### Patch Changes

- Patch release
  - @apholdings/jensen-ai@1.0.4

## 1.0.3

### Patch Changes

- Release: Add powershell tool, memory snapshots, working-context surface, get_working_context RPC, and /ultraplan command
- Updated dependencies
  - @apholdings/jensen-ai@1.0.3

## 1.0.2

### Patch Changes

- @apholdings/jensen-ai@1.0.2

## 0.57.7

### Patch Changes

- Refactored interactive mode components to use a new BorderedBox for a cleaner, transparent UI with rounded borders in tool executions and user messages.
- Updated dependencies
  - @apholdings/jensen-ai@0.57.7

## [1.1.3] - 2026-07-09

## [0.57.6] - 2026-03-26

## 0.57.4

### Patch Changes

- @apholdings/jensen-ai@0.57.4

## 0.57.3

### Patch Changes

- @apholdings/jensen-ai@0.57.3

## 0.57.2

### Patch Changes

- Fix project skill discovery so only `SKILL.md` entrypoints are loaded, ignoring inventory markdown such as `README.md`.

  Add explicit package exports for `@apholdings/jensen-agent-core` so workspace consumers resolve it correctly during builds and tests.

  - @apholdings/jensen-ai@0.57.2

## 0.1.3

### Patch Changes

- Promote `JENSEN.md` as the preferred project instruction file, keep `AGENTS.md` as a supported fallback with deprecation diagnostics, and update the related interactive messaging and documentation.
- Updated dependencies
  - @apholdings/jensen-ai@0.1.3

## 0.1.0

### Minor Changes

- 2f3d37c: chore: version bump all packages

### Patch Changes

- Updated dependencies [a55721e]
- Updated dependencies [2f3d37c]
  - @apholdings/jensen-ai@0.1.0

## [0.1.5] - 2026-03-21

### Fixed

- Corrected the deferred-tools queue test to match steering semantics: queued steering messages are injected before the next LLM call after the current assistant turn finishes its tool calls.

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

### Added

- Added `transport` to `AgentOptions` and `AgentLoopConfig` forwarding, allowing stream transport preference (`"sse"`, `"websocket"`, `"auto"`) to flow into provider calls.

## [0.52.11] - 2026-02-13

## [0.52.10] - 2026-02-12

## [0.52.9] - 2026-02-08

## [0.52.8] - 2026-02-07

## [0.52.7] - 2026-02-06

### Fixed

- Fixed `continue()` to resume queued steering/follow-up messages when context currently ends in an assistant message, and preserved one-at-a-time steering ordering during assistant-tail resumes ([#1312](https://github.com/badlogic/pi-mono/pull/1312) by [@ferologics](https://github.com/ferologics))

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

### Added

- Added `maxRetryDelayMs` option to `AgentOptions` to cap server-requested retry delays. Passed through to the underlying stream function. ([#1123](https://github.com/badlogic/pi-mono/issues/1123))

## [0.50.7] - 2026-01-31

## [0.50.6] - 2026-01-30

## [0.50.5] - 2026-01-30

## [0.50.3] - 2026-01-29

## [0.50.2] - 2026-01-29

## [0.50.1] - 2026-01-26

## [0.50.0] - 2026-01-26

## [0.49.3] - 2026-01-22

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

### Added

- `thinkingBudgets` option on `Agent` and `AgentOptions` to customize token budgets per thinking level ([#529](https://github.com/badlogic/pi-mono/pull/529) by [@melihmucuk](https://github.com/melihmucuk))

## [0.37.8] - 2026-01-07

## [0.37.7] - 2026-01-07

## [0.37.6] - 2026-01-06

## [0.37.5] - 2026-01-06

## [0.37.4] - 2026-01-06

## [0.37.3] - 2026-01-06

### Added

- `sessionId` option on `Agent` to forward session identifiers to LLM providers for session-based caching.

## [0.37.2] - 2026-01-05

## [0.37.1] - 2026-01-05

## [0.37.0] - 2026-01-05

### Fixed

- `minimal` thinking level now maps to `minimal` reasoning effort instead of being treated as `low`.

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

### Breaking Changes

- **Queue API replaced with steer/followUp**: The `queueMessage()` method has been split into two methods with different delivery semantics ([#403](https://github.com/badlogic/pi-mono/issues/403)):
  - `steer(msg)`: Interrupts the agent mid-run. Delivered after current tool execution, skips remaining tools.
  - `followUp(msg)`: Waits until the agent finishes. Delivered only when there are no more tool calls or steering messages.
- **Queue mode renamed**: `queueMode` option renamed to `steeringMode`. Added new `followUpMode` option. Both control whether messages are delivered one-at-a-time or all at once.
- **AgentLoopConfig callbacks renamed**: `getQueuedMessages` split into `getSteeringMessages` and `getFollowUpMessages`.
- **Agent methods renamed**:
  - `queueMessage()` → `steer()` and `followUp()`
  - `clearMessageQueue()` → `clearSteeringQueue()`, `clearFollowUpQueue()`, `clearAllQueues()`
  - `setQueueMode()`/`getQueueMode()` → `setSteeringMode()`/`getSteeringMode()` and `setFollowUpMode()`/`getFollowUpMode()`

### Fixed

- `prompt()` and `continue()` now throw if called while the agent is already streaming, preventing race conditions and corrupted state. Use `steer()` or `followUp()` to queue messages during streaming, or `await` the previous call.

## [0.31.1] - 2026-01-02

## [0.31.0] - 2026-01-02

### Breaking Changes

- **Transport abstraction removed**: `ProviderTransport`, `AppTransport`, and `AgentTransport` interface have been removed. Use the `streamFn` option directly for custom streaming implementations.

- **Agent options renamed**:

  - `transport` → removed (use `streamFn` instead)
  - `messageTransformer` → `convertToLlm`
  - `preprocessor` → `transformContext`

- **`AppMessage` renamed to `AgentMessage`**: All references to `AppMessage` have been renamed to `AgentMessage` for consistency.

- **`CustomMessages` renamed to `CustomAgentMessages`**: The declaration merging interface has been renamed.

- **`UserMessageWithAttachments` and `Attachment` types removed**: Attachment handling is now the responsibility of the `convertToLlm` function.

- **Agent loop moved from `@apholdings/jensen-ai`**: The `agentLoop`, `agentLoopContinue`, and related types have moved to this package. Import from `@apholdings/jensen-agent-core` instead.

### Added

- `streamFn` option on `Agent` for custom stream implementations. Default uses `streamSimple` from jensen-ai.

- `streamProxy()` utility function for browser apps that need to proxy LLM calls through a backend server. Replaces the removed `AppTransport`.

- `getApiKey` option for dynamic API key resolution (useful for expiring OAuth tokens like GitHub Copilot).

- `agentLoop()` and `agentLoopContinue()` low-level functions for running the agent loop without the `Agent` class wrapper.

- New exported types: `AgentLoopConfig`, `AgentContext`, `AgentTool`, `AgentToolResult`, `AgentToolUpdateCallback`, `StreamFn`.

### Changed

- `Agent` constructor now has all options optional (empty options use defaults).

- `queueMessage()` is now synchronous (no longer returns a Promise).
