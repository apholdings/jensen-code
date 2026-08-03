---
"@apholdings/jensen-code": minor
---

Adaptive long-horizon runtime (1.5.0):

- Add a provider-independent, durable, append-only execution-budget ledger with
  idempotent replay accounting, a budget hierarchy (global → user → run → phase
  → role → subagent), soft/hard thresholds, estimated/actual reconciliation,
  and unknown-pricing classification. Subagent usage is charged to both child
  and parent.
- Add a protected finalization validation reserve usable only by approved
  lifecycle stages and returned to the parent after terminal completion.
- Add a model capability registry with explicit unknown-capability state and
  effective-date pricing, and deterministic role-based model routing
  (planner/executor/researcher/reviewer/summarizer/tool_repair/recovery/
  subagent) producing explainable reason codes with policy-constrained bounded
  escalation.
- Add bounded provider-health tracking (decay, no futile auth retries,
  deterministic fallback).
- Add structured progress observations with deterministic weights and a bounded
  stall detector (none → warning → strategy_review → pivot_required → blocked)
  fed by the 1.4.0 Tool Storm Breaker.
- Add bounded, materially-different strategy pivots with scope-expansion
  rejection and STRATEGY_EXHAUSTED blocking.
- Add evidence-backed machine-readable success criteria and a deterministic
  readiness gate wired into the canonical APPROVE_COMPLETION boundary
  (READINESS_GATE_BLOCKED).
- Add an independent reviewer role that cannot waive criteria, authorize
  publication, or override readiness.
- Add a typed skill manifest system with permission intersection (user ∩ parent
  ∩ allowlist ∩ mode) and five bounded read-only built-in skills.
- Add isolated bounded subagents (no implicit secrets, no default mutation,
  recursion/concurrency/depth limits, cancellation propagation, parent
  validation of child output) and typed context handoff.
- Add deterministic run statistics and CLI surfaces
  (`jensen run budget|stats|strategies|stalls|criteria|subagents`,
  `jensen doctor routing|budgets`, `jensen skills list|inspect`).
- Harden release recovery with an idempotent lifecycle state machine: a stale
  dist-tag after a confirmed publication is PUBLISHED_TAGS_PROPAGATING, never a
  publication failure; recovery never republishes an existing version and never
  moves an existing tag.
