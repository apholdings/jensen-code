---
name: cavecrew
description: Use bounded Cavecrew roles for fast orientation, deep read-only investigation, small transactional implementation, and compact read-only review.
---

# Cavecrew

Cavecrew is a validated skill. Every referenced subagent must resolve through Jensen's canonical registry before this skill becomes active. Unknown names fail with `SKILL_DEPENDENCY_INVALID`; do not substitute another role.

## Routing

- `scout`: fast initial location and shallow orientation.
- `cavecrew-investigator`: deep read-only tracing of one concrete code or runtime flow.
- `planner`: bounded architecture and implementation plan from selected evidence.
- `cavecrew-builder`: one narrowly bounded one- or two-file implementation using a transaction, checkpoint, lease, focused validation, and rollback.
- `worker`: larger authorized implementation.
- `cavecrew-reviewer`: compact read-only review of a small diff.
- `reviewer`: broad or release-level read-only review.

## Invariants

- The main agent retains authority and validates every child result.
- Investigator and reviewer cannot mutate, merge, publish, or spawn children.
- Builder is a restricted worker specialization; it cannot merge or publish and returns `CAVECREW_BUILDER_SCOPE_EXCEEDED` when the file or risk limit is exceeded.
- Child context is bounded to objective, selected evidence and file references, acceptance criteria, parent constraints, tools, effects, budget, and required output schema.
- No recursive Cavecrew spawning and no silent fallback. Any fallback requires explicit parent approval and is recorded as evidence.
- Structured outputs must validate against the role schema and evidence references must be real.

## Output schemas

`cavecrew-investigator` returns `cavecrew-investigation-result-v1`.
`cavecrew-builder` returns `cavecrew-build-result-v1`.
`cavecrew-reviewer` returns `cavecrew-review-result-v1`.
