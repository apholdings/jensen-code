---
"@apholdings/jensen-agent-core": minor
"@apholdings/jensen-code": minor
---

Add deterministic safe autonomous execution.

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
