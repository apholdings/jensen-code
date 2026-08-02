# Reasonix Cache-Stable Context Engine Research

## Source and provenance

- Repository: <https://github.com/esengine/DeepSeek-Reasonix>
- Primary inspection point: GitHub stable release `desktop-v1.19.1`
- Release commit: `9053b3be1784a73cc6879835cdeeab6900aea8ca`
- Default branch inspected separately: `main-v2` at `c46e3af1c2732fe2b3dedb0bd47eb39a629357d2`
- License: MIT, Copyright 2026 Reasonix Contributors

Reasonix was used as architectural research input. Jensen's implementation is independent and Jensen-native; no Reasonix source was copied or closely adapted. No third-party source notice is required beyond this provenance record.

The default branch contains changes newer than the stable release, mainly serialized missing-tool-reasoning warning state and delivery-readiness fixes. The inspected provider changes add reasoning-warning identity and policy behavior, not newer cache-shaping mechanisms, so the stable release remains the implementation baseline for this research.

## Inspected source paths

- `internal/agent/cache_shape.go` and `internal/agent/cache_shape_test.go`
- `internal/agent/cache_diagnostics_test.go`
- `internal/agent/session.go`, `compact.go`, and `prune.go`
- `internal/checkpoint/checkpoint.go`, `internal/control/checkpoint.go`, and `internal/evidence`
- `internal/agent/execute_one.go` and planner/executor loop code
- `internal/provider/provider.go`
- `internal/provider/openai/openai.go`
- `internal/provider/anthropic/anthropic.go`
- `internal/provider/responses/responses.go`
- session persistence code under `internal/store` and `internal/agent`
- `internal/cli/run_metrics.go`, `internal/cli/cache_tag_test.go`, and `internal/cli/run_metrics_test.go`
- `benchmarks/context-maintenance-e2e/main.go` and cache-stability tests under `internal/agent`, `internal/provider`, and `internal/recovery`

## Observed mechanisms

Reasonix derives a metadata-only prefix shape from the system contract, canonical tool definitions, and the prepend-only conversation prefix. Tool schemas are normalized before hashing, and prefix comparisons classify changes such as system, tools, or log rewrite. Provider requests retain planner/executor separation and reject stateful response continuity when the persisted conversation-prefix digest no longer matches.

Session events, checkpoints, evidence, and execution state remain durable and authoritative. Cache metadata can optimize or explain a request but cannot recover or decide execution state. Compaction and pruning use deterministic boundaries, preserve tool-call/result relationships, and retain evidence references. Planner rollback and executor continuation operate on separate session state.

Usage normalization distinguishes provider-reported absence from an explicit zero. The stable release reads DeepSeek prompt-cache hit/miss fields, OpenAI cached-input detail, and Anthropic cache read/write fields. CLI cache diagnostics remain hidden when a provider reports no cache fields.

Reasonix also exercises seed, idle, and resume turns in its context-maintenance benchmark, reporting prefix continuity, pruning, cache hits, and cache misses without treating cache outcomes as correctness evidence.

## Ideas applied to Jensen

- Typed stable-prefix and dynamic-suffix regions in the real agent invocation path.
- Canonical newline, object-key, JSON Schema `required`, and tool ordering rules.
- SHA-256 fingerprints for the logical cacheable prefix and its system/tool components.
- Metadata-only diagnostics with explicit provider/model continuity invalidation.
- Capability-based cache telemetry that preserves unknown versus explicit zero.
- Deterministic compaction checkpoints containing addressable tool-result hashes while retaining complete evidence in Jensen's durable JSONL session tree.
- Tests that compare synthetic turns and verify stable-prefix continuity independently from dynamic prompt changes.

## Ideas rejected or narrowed

- Jensen does not adopt Reasonix's planner/executor storage model. Jensen already has durable session trees and a separate long-horizon state machine; replacing either would create a competing authority.
- Jensen does not make provider cache identifiers authoritative or persist provider response continuity as execution state. Provider/model switches explicitly invalidate continuity assumptions.
- Jensen does not add DeepSeek-specific routing. Cache telemetry is optional across existing Anthropic, OpenAI-compatible, Responses, Google, Gemini CLI, Vertex, and Bedrock paths.
- Jensen does not expose raw stable prompts in diagnostics. Fingerprints and byte counts provide observability without leaking repository instructions, user content, secrets, or hidden reasoning.
- Jensen does not use free-form summaries as the sole compacted state. Existing durable entries remain replayable, and deterministic checkpoint metadata records the continuation boundary and tool evidence.

## Jensen-specific design boundary

Jensen's stable prefix contains normalized system contracts, applicable repository instructions, skill contracts, and canonical provider-visible tools. Host state—including date, cwd, repository branch/worktrees, and local documentation paths—is injected as the first dynamic user-region message before durable conversation messages. User requests, execution state, observations, timestamps, and tool results remain dynamic.

The prefix fingerprint describes Jensen's exact logical stable representation. Individual providers may encode system and tool blocks differently, so provider and model are recorded alongside the fingerprint and continuity is invalidated on either change. Cache telemetry is observational only; the session tree, compaction boundary, long-horizon ledger, and trusted-context rules remain authoritative.
