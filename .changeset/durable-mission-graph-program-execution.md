---
"@apholdings/jensen-ai": minor
"@apholdings/jensen-agent-core": minor
"@apholdings/jensen-code": minor
"@apholdings/jensen-mom": minor
"@apholdings/jensen-pods": minor
"@apholdings/jensen-tui": minor
"@apholdings/jensen-web-ui": minor
---

Add durable Mission Graph and multi-repository program execution.

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
