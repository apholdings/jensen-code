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
  - @apholdings/jensen-agent-core@1.10.0
  - @apholdings/jensen-code@1.10.0

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
  - @apholdings/jensen-agent-core@1.9.0
  - @apholdings/jensen-code@1.9.0

## 1.8.3

### Patch Changes

- Updated dependencies [b0fb9ee]
  - @apholdings/jensen-code@1.8.3
  - @apholdings/jensen-agent-core@1.8.3
  - @apholdings/jensen-ai@1.8.3

## 1.8.2

### Patch Changes

- 3f46ae6: Complete the production evaluation runtime with real sandbox lifecycle enforcement, opt-in live-provider execution, independent reviewers, paired Cavecrew comparisons, versioned evaluation RPC operations, bounded dashboard projections, protected retention and pruning, and single-commit release provenance checks.
- Updated dependencies [3f46ae6]
  - @apholdings/jensen-agent-core@1.8.2
  - @apholdings/jensen-ai@1.8.2
  - @apholdings/jensen-code@1.8.2

## 1.8.1

### Patch Changes

- Harden the evaluation artifact store and doctor exit semantics, complete deterministic replay, stability, retrieval, clustering, pruning, RPC, and dashboard projections, and make binary builds resolve Playwright's Chromium BiDi dependency from a clean checkout with verified release manifests.
- Updated dependencies
  - @apholdings/jensen-agent-core@1.8.1
  - @apholdings/jensen-ai@1.8.1
  - @apholdings/jensen-code@1.8.1

## 1.8.0

### Minor Changes

- 7447be7: Add a versioned evaluation runtime with deterministic scenario packs, isolated fixtures, replay-safe artifacts, baseline comparison, safety release gates, metrics, and the `jensen eval` CLI.

### Patch Changes

- Updated dependencies [7447be7]
  - @apholdings/jensen-ai@1.8.0
  - @apholdings/jensen-agent-core@1.8.0
  - @apholdings/jensen-code@1.8.0

## 1.7.1

### Patch Changes

- Updated dependencies [138f6a8]
  - @apholdings/jensen-code@1.7.1
  - @apholdings/jensen-agent-core@1.7.1
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
  - @apholdings/jensen-code@1.7.0
  - @apholdings/jensen-agent-core@1.7.0
  - @apholdings/jensen-ai@1.7.0

## 1.6.2

### Patch Changes

- b565a26: Add a canonical policy-bound subagent registry with explicit OpenRouter model routing, typed unknown-agent resolution, structured output contracts, and validated Cavecrew investigator, builder, and reviewer roles.
- 708dac4: Wire canonical subagent resolution, isolated context packets, parent output validation, and deterministic transactional Cavecrew orchestration into runtime dispatch. Make release artifact integrity checks build their inputs before verification.
- Updated dependencies [b565a26]
- Updated dependencies [708dac4]
  - @apholdings/jensen-agent-core@1.6.2
  - @apholdings/jensen-ai@1.6.2
  - @apholdings/jensen-code@1.6.2

## 1.6.1

### Patch Changes

- fb0f065: Complete operability replay, safe re-execution, MCP transports, validation, storage diagnostics, and release-state classification for the 1.6 contract.
- Updated dependencies [fb0f065]
  - @apholdings/jensen-agent-core@1.6.1
  - @apholdings/jensen-ai@1.6.1
  - @apholdings/jensen-code@1.6.1

## 1.6.0

### Minor Changes

- 24c2d95: Add canonical run observability projections, deterministic render and projection replay, evidence and diagnostic inspection, sanitized support-bundle previews, and conservative MCP configuration/schema/effect validation surfaces.

### Patch Changes

- Updated dependencies [24c2d95]
  - @apholdings/jensen-agent-core@1.6.0
  - @apholdings/jensen-ai@1.6.0
  - @apholdings/jensen-code@1.6.0

## 1.5.0

### Patch Changes

- Updated dependencies [af149b0]
  - @apholdings/jensen-code@1.5.0
  - @apholdings/jensen-agent-core@1.5.0
  - @apholdings/jensen-ai@1.5.0

## 1.4.0

### Patch Changes

- Updated dependencies [3485c3c]
  - @apholdings/jensen-code@1.4.0
  - @apholdings/jensen-agent-core@1.4.0
  - @apholdings/jensen-ai@1.4.0

## 1.3.0

### Patch Changes

- Updated dependencies [a65bbd5]
  - @apholdings/jensen-agent-core@1.3.0
  - @apholdings/jensen-code@1.3.0
  - @apholdings/jensen-ai@1.3.0

## 1.2.1

### Patch Changes

- Updated dependencies [cbd624d]
  - @apholdings/jensen-code@1.2.1
  - @apholdings/jensen-agent-core@1.2.1
  - @apholdings/jensen-ai@1.2.1

## 1.2.0

### Patch Changes

- Updated dependencies [328c049]
  - @apholdings/jensen-code@1.2.0
  - @apholdings/jensen-agent-core@1.2.0
  - @apholdings/jensen-ai@1.2.0

## 1.1.12

### Patch Changes

- Updated dependencies [64aab5a]
  - @apholdings/jensen-ai@1.1.12
  - @apholdings/jensen-agent-core@1.1.12
  - @apholdings/jensen-code@1.1.12

## 1.1.11

### Patch Changes

- dcc565a: Prevent Windows shell commands from hanging after launching persistent background processes, while preserving output, timeout, and process-cleanup semantics.
- Updated dependencies [dcc565a]
  - @apholdings/jensen-agent-core@1.1.11
  - @apholdings/jensen-ai@1.1.11
  - @apholdings/jensen-code@1.1.11

## 1.1.10

### Patch Changes

- Updated dependencies [1dfcae4]
- Updated dependencies [4caca50]
- Updated dependencies [9b61ea2]
- Updated dependencies [c2bfd7f]
- Updated dependencies [f2bfa57]
- Updated dependencies [c9be929]
  - @apholdings/jensen-agent-core@1.1.10
  - @apholdings/jensen-ai@1.1.10
  - @apholdings/jensen-code@1.1.10

## 1.1.9

### Patch Changes

- Updated dependencies [1419cfb]
  - @apholdings/jensen-code@1.1.9
  - @apholdings/jensen-agent-core@1.1.9
  - @apholdings/jensen-ai@1.1.9

## 1.1.8

### Patch Changes

- Updated dependencies [2c2ceff]
  - @apholdings/jensen-code@1.1.8
  - @apholdings/jensen-agent-core@1.1.8
  - @apholdings/jensen-ai@1.1.8

## 1.1.7

### Patch Changes

- c322b08: Fix packaging: remove broken `main` and `types` entrypoints that referenced non-existent `dist/index.js` and `dist/index.d.ts`. Mom is a CLI-only package (bin: `mom`).
- Updated dependencies [0a60417]
  - @apholdings/jensen-code@1.1.7
  - @apholdings/jensen-agent-core@1.1.7
  - @apholdings/jensen-ai@1.1.7

## [Unreleased]

## 1.1.6

### Patch Changes

- Updated dependencies
  - @apholdings/jensen-ai@1.1.6
  - @apholdings/jensen-agent-core@1.1.6
  - @apholdings/jensen-code@1.1.6

## 1.1.5

### Patch Changes

- Updated dependencies
  - @apholdings/jensen-code@1.1.5
  - @apholdings/jensen-agent-core@1.1.5
  - @apholdings/jensen-ai@1.1.5

## 1.1.4

### Patch Changes

- Updated dependencies
  - @apholdings/jensen-code@1.1.4
  - @apholdings/jensen-agent-core@1.1.4
  - @apholdings/jensen-ai@1.1.4

## 1.1.2

### Patch Changes

- Updated dependencies
  - @apholdings/jensen-code@1.1.2
  - @apholdings/jensen-agent-core@1.1.2
  - @apholdings/jensen-ai@1.1.2

## 1.1.1

### Patch Changes

- Updated dependencies
  - @apholdings/jensen-code@1.1.1
  - @apholdings/jensen-agent-core@1.1.1
  - @apholdings/jensen-ai@1.1.1

## 1.1.0

### Patch Changes

- Updated dependencies
  - @apholdings/jensen-code@1.1.0
  - @apholdings/jensen-agent-core@1.1.0
  - @apholdings/jensen-ai@1.1.0

## 1.0.9

### Patch Changes

- Updated dependencies
  - @apholdings/jensen-code@1.0.9
  - @apholdings/jensen-agent-core@1.0.9
  - @apholdings/jensen-ai@1.0.9

## [1.1.3] - 2026-07-09

## [1.0.8] - 2026-06-26

### Patch Changes

- Updated dependencies
  - @apholdings/jensen-ai@1.0.8
  - @apholdings/jensen-agent-core@1.0.8
  - @apholdings/jensen-code@1.0.8

## 1.0.7

### Patch Changes

- Updated dependencies
  - @apholdings/jensen-ai@1.0.7
  - @apholdings/jensen-agent-core@1.0.7
  - @apholdings/jensen-code@1.0.7

## 1.0.5

### Patch Changes

- Removed orphaned `WorkingContextPanel` TUI component and its test file, completing the working-context panel removal cleanup. No breaking API changes.
- Updated dependencies
  - @apholdings/jensen-agent-core@1.0.5
  - @apholdings/jensen-code@1.0.5
  - @apholdings/jensen-ai@1.0.5

## 1.0.4

### Patch Changes

- Updated dependencies
  - @apholdings/jensen-agent-core@1.0.4
  - @apholdings/jensen-code@1.0.4
  - @apholdings/jensen-ai@1.0.4

## 1.0.3

### Patch Changes

- Release: Add powershell tool, memory snapshots, working-context surface, get_working_context RPC, and /ultraplan command
- Updated dependencies
  - @apholdings/jensen-code@1.0.3
  - @apholdings/jensen-agent-core@1.0.3
  - @apholdings/jensen-ai@1.0.3

## 1.0.2

### Patch Changes

- Updated dependencies [becdcc3]
  - @apholdings/jensen-code@1.0.2
  - @apholdings/jensen-agent-core@1.0.2
  - @apholdings/jensen-ai@1.0.2

## 0.57.7

### Patch Changes

- Refactored interactive mode components to use a new BorderedBox for a cleaner, transparent UI with rounded borders in tool executions and user messages.
- Updated dependencies
  - @apholdings/jensen-agent-core@0.57.7
  - @apholdings/jensen-ai@0.57.7
  - @apholdings/jensen-code@0.57.7

## [1.1.3] - 2026-07-09

## [0.57.6] - 2026-03-26

## 0.57.4

### Patch Changes

- Updated dependencies
  - @apholdings/jensen-code@0.57.4
  - @apholdings/jensen-agent-core@0.57.4
  - @apholdings/jensen-ai@0.57.4

## 0.57.3

### Patch Changes

- Updated dependencies
  - @apholdings/jensen-code@0.57.3
  - @apholdings/jensen-agent-core@0.57.3
  - @apholdings/jensen-ai@0.57.3

## 0.57.2

### Patch Changes

- Updated dependencies
  - @apholdings/jensen-code@0.57.2
  - @apholdings/jensen-agent-core@0.57.2
  - @apholdings/jensen-ai@0.57.2

## 0.1.3

### Patch Changes

- Promote `JENSEN.md` as the preferred project instruction file, keep `AGENTS.md` as a supported fallback with deprecation diagnostics, and update the related interactive messaging and documentation.
- Updated dependencies
  - @apholdings/jensen-ai@0.1.3
  - @apholdings/jensen-agent-core@0.1.3
  - @apholdings/jensen-code@0.1.3

## 0.1.0

### Minor Changes

- 2f3d37c: chore: version bump all packages

### Patch Changes

- a55721e: Normalize package publish metadata and internal dependency ranges for the Changesets-based release flow.
- Updated dependencies [a55721e]
- Updated dependencies [2f3d37c]
  - @apholdings/jensen-ai@0.1.0
  - @apholdings/jensen-code@0.1.0
  - @apholdings/jensen-agent-core@0.1.0

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

### Fixed

- Fixed mom startup crash caused by settings API drift by using `SettingsManager` with workspace-backed storage ([#1444](https://github.com/badlogic/pi-mono/issues/1444))

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

### Fixed

- Use coding-agent's SessionManager instead of custom MomSessionManager to fix API mismatch crash ([#595](https://github.com/badlogic/pi-mono/issues/595))

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

- `AgentTool` import moved from `@apholdings/jensen-ai` to `@apholdings/jensen-agent-core`
- `AppMessage` type renamed to `AgentMessage`
- `Attachment` type replaced with `ImageContent` for image handling
- `MomSessionManager.loadSession()` renamed to `buildSessionContex()`
- `MomSessionManager.createBranchedSessionFromEntries()` signature changed to `createBranchedSession(leafId)`
- `ProviderTransport` removed from Agent config, replaced with direct `getApiKey` callback
- `messageTransformer` renamed to `convertToLlm`
- `ANTHROPIC_API_KEY`/`ANTHROPIC_OAUTH_TOKEN` no longer checked at startup (deferred to first API call)

### Changed

- Session entries now include `id` and `parentId` fields for tree structure support
- Auth lookup now uses `AuthStorage` class instead of direct environment variable access
- Image attachments use `ImageContent` type with `data` field instead of `Attachment` with `content`
- `session.prompt()` now uses `images` option instead of `attachments`

### Added

- Support for OAuth login via coding agent's `/login` command (link `~/.pi/agent/auth.json` to `~/.pi/mom/auth.json`)

## [0.20.2] - 2025-12-13

### Fixed

- **Skill paths now use container paths**: Skill file paths in system prompt are translated to container paths (e.g., `/workspace/skills/...`) so mom can read them from inside Docker.

## [0.20.1] - 2025-12-13

### Added

- **Skills auto-discovery**: Mom now automatically discovers skills from `workspace/skills/` and `channel/skills/` directories. Skills are directories containing a `SKILL.md` file with `name` and `description` in YAML frontmatter. Available skills are listed in the system prompt with their descriptions. Mom reads the `SKILL.md` file before using a skill.

## [0.19.2] - 2025-12-12

### Added

- Events system: schedule wake-ups via JSON files in `workspace/events/`
  - Immediate events: trigger when file is created (for webhooks, external signals)
  - One-shot events: trigger at specific time (for reminders)
  - Periodic events: trigger on cron schedule (for recurring tasks)
- `SlackBot.enqueueEvent()` for queueing events (max 5 per channel)
- `[SILENT]` response marker: deletes status message, posts nothing to Slack (for periodic events with nothing to report)
- Events documentation in `docs/events.md`
- System prompt section explaining events to mom

## [0.18.8] - 2025-12-12

### Changed

- Timestamp prefix now includes timezone offset (`[YYYY-MM-DD HH:MM:SS+HH:MM]`)

## [0.18.7] - 2025-12-12

### Added

- Timestamp prefix on user messages (`[YYYY-MM-DD HH:MM:SS]`) so mom knows current date/time

### Fixed

- Sync deduplication now strips timestamp prefix before comparing

## [0.18.6] - 2025-12-12

### Fixed

- Duplicate message in context when message has attachments (sync from log didn't strip attachment section before comparing)
- Use `<slack_attachments>` delimiter for attachments in messages (easier to parse/strip)

## [0.18.5] - 2025-12-12

### Added

- `--download <channel-id>` flag to download a channel's full history including thread replies as plain text

### Fixed

- Error handling: when agent returns `stopReason: "error"`, main message is updated to "Sorry, something went wrong" and error details are posted to the thread

## [0.18.4] - 2025-12-11

### Fixed

- Attachment downloads now work correctly
  - SlackBot now receives store for processing file downloads
  - Files are downloaded in background and stored in `<channel>/attachments/`
  - Attachment paths passed to agent as absolute paths in execution environment
  - Backfill also downloads attachments from historical messages

## [0.18.3] - 2025-12-11

### Changed

- Complete rewrite of message handling architecture (#115)

  - Now uses `AgentSession` from coding-agent for session management
  - Brings auto-compaction, overflow handling, and proper prompt caching
  - `log.jsonl` is the source of truth for all channel messages
  - `context.jsonl` stores LLM context (messages sent to Claude, same format as coding-agent)
  - Sync mechanism ensures context.jsonl stays in sync with log.jsonl at run start
  - Session header written immediately on new session creation (not lazily)
  - Tool results preserved in context.jsonl for multi-turn continuity

- Backfill improvements

  - Only backfills channels that already have a `log.jsonl` file
  - Strips @mentions from backfilled messages (consistent with live messages)
  - Uses largest timestamp in log for efficient incremental backfill
  - Fetches DM channels in addition to public/private channels

- Message handling improvements

  - Channel chatter (messages without @mention) logged but doesn't trigger processing
  - Messages sent while mom is busy are logged and synced on next run
  - Pre-startup messages (replayed by Slack on reconnect) logged but not auto-processed
  - Stop command executes immediately (not queued), can interrupt running tasks
  - Channel @mentions no longer double-logged (was firing both app_mention and message events)

- Usage summary now includes context window usage
  - Shows current context tokens vs model's context window
  - Example: `Context: 4.2k / 200k (2.1%)`

### Fixed

- Slack API errors (msg_too_long) no longer crash the process

  - Added try/catch error handling to all Slack API calls in the message queue
  - Main channel messages truncated at 35K with note to ask for elaboration
  - Thread messages truncated at 20K
  - replaceMessage also truncated at 35K

- Private channel messages not being logged

  - Added `message.groups` to required bot events in README
  - Added `groups:history` and `groups:read` to required scopes in README

- Stop command now updates "Stopping..." to "Stopped" instead of posting two messages

### Added

- Port truncation logic from coding-agent: bash and read tools now use consistent 2000 lines OR 50KB limits with actionable notices

## [0.10.2] - 2025-11-27

### Breaking Changes

- Timestamps now use Slack format (seconds.microseconds) and messages are sorted by `ts` field
  - **Migration required**: Run `npx tsx scripts/migrate-timestamps.ts ./data` to fix existing logs
  - Without migration, message context will be incorrectly ordered

### Added

- Channel and user ID mappings in system prompt
  - Fetches all channels bot is member of and all workspace users at startup
  - Mom can now reference channels by name and mention users properly
- Skills documentation in system prompt
  - Explains custom CLI tools pattern with SKILL.md files
  - Encourages mom to create reusable tools for recurring tasks
- Debug output: writes `last_prompt.txt` to channel directory with full context
- Bash working directory info in system prompt (/ for Docker, cwd for host)
- Token-efficient log queries that filter out tool calls/results for summaries

### Changed

- Turn-based message context instead of raw line count (#68)
  - Groups consecutive bot messages (tool calls/results) as single turn
  - "50 turns" now means ~50 conversation exchanges, not 50 log lines
  - Prevents tool-heavy runs from pushing out conversation context
- Messages sorted by Slack timestamp before building context
  - Fixes out-of-order issues from async attachment downloads
  - Added monotonic counter for sub-millisecond ordering
- Condensed system prompt from ~5k to ~2.7k chars
  - More concise workspace layout (tree format)
  - Clearer log query examples (conversation-only vs full details)
  - Removed redundant guidelines section
- User prompt simplified: removed duplicate "Current message" (already in history)
- Tool status labels (`_→ label_`) no longer logged to jsonl
- Thread messages and thinking no longer double-logged

### Fixed

- Duplicate message logging: removed redundant log from app_mention handler
- Username obfuscation in thread messages to prevent unwanted pings
  - Handles @username, bare username, and <@USERID> formats
  - Escapes special regex characters in usernames

## [0.10.1] - 2025-11-27

### Changed

- Reduced tool verbosity in main Slack messages (#65)
  - During execution: show tool labels (with → prefix), thinking, and text
  - After completion: replace main message with only final assistant response
  - Full audit trail preserved in thread (tool details, thinking, text)
  - Added promise queue to ensure message updates execute in correct order

## [0.10.0] - 2025-11-27

### Added

- Working memory system with MEMORY.md files
  - Global workspace memory (`workspace/MEMORY.md`) shared across all channels
  - Channel-specific memory (`workspace/<channel>/MEMORY.md`) for per-channel context
  - Automatic memory loading into system prompt on each request
  - Mom can update memory files to remember project details, preferences, and context
- ISO 8601 date field in log.jsonl for easy date-based grepping
  - Format: `"date":"2025-11-26T10:44:00.123Z"`
  - Enables queries like: `grep '"date":"2025-11-26' log.jsonl`
- Centralized logging system (`src/log.ts`)
  - Structured, colored console output (green for user messages, yellow for mom activity, dim for details)
  - Consistent format: `[HH:MM:SS] [context] message`
  - Type-safe logging functions for all event types
- Usage tracking and cost reporting
  - Tracks tokens (input, output, cache read, cache write) and costs per run
  - Displays summary at end of each agent run in console and Slack thread
  - Example: `💰 Usage: 12,543 in + 847 out (5,234 cache read, 127 cache write) = $0.0234`
- Working indicator in Slack messages
  - Channel messages show "..." while mom is processing
  - Automatically removed when work completes
- Improved stop command behavior
  - Separate "Stopping..." message that updates to "Stopped" when abort completes
  - Original working message continues to show tool results (including abort errors)
  - Clean separation between status and results

### Changed

- Enhanced system prompt with clearer directory structure and path examples
- Improved memory file path documentation to prevent confusion
- Message history format now includes ISO 8601 date for better searchability
- System prompt now includes log.jsonl format documentation with grep examples
- System prompt now includes current date and time for date-aware operations
- Added efficient log query patterns using jq to prevent context overflow
- System prompt emphasizes limiting NUMBER of messages (10-50), not truncating message text
- Log queries now show full message text and attachments for better context
- Fixed jq patterns to handle null/empty attachments with `(.attachments // [])`
- Recent messages in system prompt now formatted as TSV (43% token savings vs raw JSONL)
- Enhanced security documentation with prompt injection risk warnings and mitigations
- **Moved recent messages from system prompt to user message** for better prompt caching
  - System prompt is now mostly static (only changes when memory files change)
  - Enables Anthropic's prompt caching to work effectively
  - Significantly reduces costs on subsequent requests
- Switched from Claude Opus 4.5 to Claude Sonnet 4.5 (~40% cost reduction)
- Tool result display now extracts actual text instead of showing JSON wrapper
- Slack thread messages now show cleaner tool call formatting with duration and label
- All console logging centralized and removed from scattered locations
- Agent run now returns `{ stopReason }` instead of throwing exceptions
  - Clean handling of "aborted", "error", "stop", "length", "toolUse" cases
  - No more error-based control flow

### Fixed

- jq query patterns now properly handle messages without attachments (no more errors on empty arrays)

## [0.9.4] - 2025-11-26

### Added

- Initial release of Mom Slack bot
- Slack integration with @mentions and DMs
- Docker sandbox mode for isolated execution
- Bash tool with full shell access
- Read, write, edit file tools
- Attach tool for sharing files in Slack
- Thread-based tool details (clean main messages, verbose details in threads)
- Single accumulated message per agent run
- Stop command (`@mom stop`) to abort running tasks
- Persistent workspace per channel with scratchpad directory
- Streaming console output for monitoring
