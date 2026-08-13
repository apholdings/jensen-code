# @apholdings/jensen-pods

## 2.1.0

### Minor Changes

- 392db26: Jensen 2.1.0 — Reliable Agent Runtime.

  Introduces the Reliability Kernel, which moves execution authority from the model
  into Jensen. The model proposes actions and completion; Jensen owns state,
  execution, evidence, validation, and completion.

  - Mission Ledger: durable, machine-readable, session-associated mission state
    (goal, constraints, acceptance criteria, evidence, blockers) that survives
    process exit, `jensen resume <SESSION_ID>`, and context compaction.
  - Structured agent actions: model output is normalized into a finite, Jensen-owned
    action union (`tool_call`, `request_context`, `mission_update`,
    `final_candidate`, `blocked`, `no_op`).
  - Action validation: every executable action is validated before execution
    (tool exists, schema, required arguments, boundary, permission, forbidden
    actions); invalid actions are rejected with structured failures and never run.
  - Evidence Store: records what Jensen actually observed, never model claims;
    deterministic verification evidence is authoritative.
  - Verification Engine: deterministic build/test/file/search/git-diff verifiers.
  - Acceptance criteria: user-required and system-derived criteria with
    evidence-gated status; a model assertion can never mark a criterion passed.
  - Completion Gate: `FINAL_CANDIDATE` is a proposal, not completion; Jensen rejects
    premature completion with `FINALIZATION_REJECTED`.
  - Reliability Suite: deterministic adversarial scenarios (R01–R15) prove the
    trusted runtime stays safe when the model misbehaves.

    2.1.0 introduces the Reliability Kernel; advanced autonomous retry/recovery
    policy remains future work (2.1.1).

### Patch Changes

- Updated dependencies [392db26]
  - @apholdings/jensen-agent-core@2.1.0

## 2.0.2

### Patch Changes

- 10549ec: Add explicit session resume by ID.

  `jensen resume <SESSION_ID>` resolves a persisted session by exact ID, restores
  its conversation history, model/thinking configuration, memory/todos/tasks, and
  working directory, and continues writing under the same session ID rather than
  creating a new one.

  - Exact session resolution (never prefix matching, never fall back to the
    latest session).
  - Same-session continuation across repeated resume cycles.
  - Safe failure for unknown IDs (`Session not found: <id>`), corrupted session
    files (persisted bytes are never overwritten), and path-like input (never
    treated as a filesystem path).
  - Backward compatible with sessions persisted by 2.0.1 and earlier versions.
  - New regression coverage for ID lookup, file validation, continuation,
    compaction continuity, and end-to-end hydration through `createAgentSession`.

- Updated dependencies [10549ec]
  - @apholdings/jensen-agent-core@2.0.2

## 2.0.1

### Patch Changes

- 1854dad: Refresh the OpenRouter model catalog from the live OpenRouter Models API.

  Regenerates `models.generated.ts` against `https://openrouter.ai/api/v1/models`
  so every currently tool-capable OpenRouter model resolves through Jensen's
  existing OpenAI-compatible OpenRouter provider.

  Highlights from the refresh:

  - Added support for newly available OpenRouter models such as
    `x-ai/grok-4.6`, `qwen/qwen3.8-max`, `thinkingmachines/inkling-small`,
    `sakana/sakana-namazu`, `upstage/solar-pro4`, and
    `~deepseek/deepseek-v4-flash-latest`.
  - Removed OpenRouter entries that the live API no longer returns
    (`openai/gpt-5.1-chat`, `openai/gpt-5.3-chat`, `inclusionai/ling-3.0-flash:free`).
  - Dropped stale manual pricing overrides for `moonshotai/kimi-k2.5` and
    `z-ai/glm-5`; their metadata now comes straight from the live API.

  The OpenRouter provider architecture is unchanged: `openrouter` models
  continue to route through the existing `openai-completions` provider with the
  same reasoning-effort, provider-routing, and API-key handling as before.

- Updated dependencies [1854dad]
  - @apholdings/jensen-agent-core@2.0.1

## 2.0.0

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
  - @apholdings/jensen-agent-core@2.0.0

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
  - @apholdings/jensen-agent-core@1.9.0

## 1.8.3

### Patch Changes

- @apholdings/jensen-agent-core@1.8.3

## 1.8.2

### Patch Changes

- 3f46ae6: Complete the production evaluation runtime with real sandbox lifecycle enforcement, opt-in live-provider execution, independent reviewers, paired Cavecrew comparisons, versioned evaluation RPC operations, bounded dashboard projections, protected retention and pruning, and single-commit release provenance checks.
- Updated dependencies [3f46ae6]
  - @apholdings/jensen-agent-core@1.8.2

## 1.8.1

### Patch Changes

- Harden the evaluation artifact store and doctor exit semantics, complete deterministic replay, stability, retrieval, clustering, pruning, RPC, and dashboard projections, and make binary builds resolve Playwright's Chromium BiDi dependency from a clean checkout with verified release manifests.
- Updated dependencies
  - @apholdings/jensen-agent-core@1.8.1

## 1.8.0

### Minor Changes

- 7447be7: Add a versioned evaluation runtime with deterministic scenario packs, isolated fixtures, replay-safe artifacts, baseline comparison, safety release gates, metrics, and the `jensen eval` CLI.

### Patch Changes

- Updated dependencies [7447be7]
  - @apholdings/jensen-agent-core@1.8.0

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
