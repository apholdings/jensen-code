# Durable Mission Graph & Multi-Repository Program Execution (2.0.0)

The Mission subsystem adds a durable, versioned execution graph that
orchestrates work across one or more declared repositories. It is a pure,
deterministic core (with a thin I/O store) so it can be unit-tested offline and
exercised through `jensen mission …`.

## Command surface

```
jensen mission create <definition.json>   create and store a mission graph
jensen mission validate <id|file>         validate a mission graph
jensen mission plan <id|file>             schedule plan (waves + critical path)
jensen mission graph <id|file>            objectives, deps, critical path
jensen mission start <id>                 promote DRAFT -> ACTIVE
jensen mission status <id>                objective/mission status
jensen mission replay <id>                replay the event log (zero effects)
jensen mission reconcile --preview <id>   post-reboot reconciliation (no mutation)
jensen doctor mission                     health-check the mission store
```

The store root defaults to `~/.jensen/missions` and can be overridden with
`JENSEN_MISSION_STORE`.

## Model

- **Mission Graph** (`MissionGraphDocumentV1`): versioned (`revision`), hashed
  (`digest` = canonical sha-256 of the semantic payload), with an explicit
  `scope.repositories` list that a mission cannot expand.
- **Objectives**: explicit dependencies, declared repositories, acceptance
  criteria, optional approval gate / external blocker / budget / routing policy,
  and a status driven by a legal-transition state machine.
- **Contracts**: typed producer → consumer bindings with compatibility and
  stale detection.
- **Repositories & worktrees**: canonical identity, isolation boundaries,
  escape blocking, drift detection.
- **Scheduler**: dependency readiness, bounded parallel waves, write-conflict
  serialization, critical path, budget bounds.
- **Integration**: transactional confirm with checkpoints and localized
  rollback.
- **Durability**: atomic store, append-only replayable event log,
  repository-scoped leases, reboot recovery and reconciliation.

## Invariants

- A mission cannot expand its own scope; objectives cannot grant authority.
- Repositories/worktrees are identifier-authoritative; cross-repository
  mutations require explicit authority (held lease).
- Parallelism never violates dependencies; leases are repository-scoped;
  checkpoints precede mutation.
- Human approval nodes cannot be auto-approved or self-approved; external
  blockers cannot be fabricated; completion requires all hard gates.
- Reboot does not duplicate objectives/commits/PRs/publications; a dead
  process's authority is never reused; independent completed work is preserved.
- Replay has zero effects.

## Tests

`packages/coding-agent/test/mission/*` covers graph validation/hashing/critical
path, scheduling and write-conflict serialization, repository identity and
worktree isolation, contracts and integration rollback, approvals and external
blockers, the durable store / event log / leases, engine state machines, and the
reboot-recovery fixtures.
