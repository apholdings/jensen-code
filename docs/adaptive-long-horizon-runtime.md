# Adaptive Long-Horizon Runtime (1.5.0)

The adaptive long-horizon runtime makes long-running execution adaptive while the
model can never bypass deterministic controls. It lives under
`packages/coding-agent/src/core/long-horizon/adaptive/` and reuses Jensen's
pure-function, deterministic, frozen-snapshot conventions.

## Authority hierarchy

```text
user authorization
> deterministic policy
> durable execution state
> verified evidence
> adaptive strategy
> model recommendation
```

An adaptive component may choose a different safe strategy, but may not relax
policy, expand user authorization, alter the workspace boundary, invent budget,
hide failures, authorize publication, confirm completion without evidence,
replace durable execution state, bypass checkpoints/leases/transactions, or
execute untrusted web/repository/tool content as instructions.

## Lifecycle

```text
objective → success criteria → execution plan → budget allocation
→ model-role selection → bounded execution → structured progress measurement
→ continue / retry / pivot / escalate / block → independent readiness review
→ evidence-backed completion
```

## Durable budget ledger (`budget-ledger.ts`)

- Append-only, idempotent, replay-safe ledger. Totals are derived by replay, so
  resume never double charges and cancellation never erases consumed budget.
- Hierarchy: global → user → run → phase → role → subagent. A child budget can
  never exceed the unallocated parent remainder (`resolveBudgetHierarchy`).
- Soft/hard thresholds plus a protected **finalization reserve** and **recovery
  reserve** (`evaluateThresholds`, `reserveFinalization`). At a hard threshold
  Jensen returns a typed `BudgetBlock`.
- Estimated amounts are reconciled with provider actuals (`reconcileEntry`);
  unknown pricing is classified explicitly; cached-input usage is tracked
  separately; subagent usage is charged to both child and parent.

## Model capability registry (`capability-registry.ts`)

Deterministic capability resolution from explicit flags — never model names, and
never "expensive is better". Unknown capability state is explicit. Pricing
carries an `effectiveAt` and never rewrites historical budget records.

## Role-based routing (`model-router.ts`)

`routeForRole` consumes structured evidence (risk, type, phase, remaining budget,
health, failures, stall, required independence) and returns an explainable
`ModelRouteDecision` with `reasonCodes`. A model can recommend escalation but
never self-authorize it (`escalation.ts` requires evidence + policy + budget).

## Provider health (`provider-health.ts`)

Bounded rolling evidence per provider/model/endpoint with decay. Authentication
failures never trigger futile retries; rate limits respect retry hints; fallback
is deterministic and preserves task requirements.

## Structured progress (`progress.ts`) and stall detector (`stall-detector.ts`)

Progress is authoritative only on a verifiable structured state change; prose,
repeated reads/searches/commands, and reformatting are rejected. Weights are
deterministic. The stall detector walks bounded stages
(none → warning → strategy_review → pivot_required → blocked) and is fed
call-level no-progress evidence from the 1.4.0 Tool Storm Breaker. State-changing
polls are legitimate, not stall.

## Strategy pivots (`strategy.ts`)

Pivots are materially-different, evidence-backed, scope-preserving, and bounded
(`maxStrategyPivots`, `maxPivotsPerPhase`). Cosmetic rewrites are rejected;
exhaustion returns `STRATEGY_EXHAUSTED` and blocks.

## Success criteria and readiness (`criteria.ts`, `readiness.ts`)

Machine-readable criteria require evidence (test claims need test artifacts,
publication claims need registry verification, user observations need real user
evidence). The deterministic readiness gate is wired into the canonical
`APPROVE_COMPLETION` boundary in `execution-state-machine.ts` and returns
`READINESS_GATE_BLOCKED` when not ready. A model reviewer cannot force readiness.

## Reviewer (`reviewer.ts`)

Bounded independent reviewer returns structured, addressable findings. It cannot
execute mutating tools by default, waive user criteria, publish, or override
readiness.

## Typed skills (`skills.ts`, `builtin-skills.ts`)

Skill manifests are data, not code: typed inputs, output schema, allowed tools,
denied effects, execution mode, budget, timeout, success criteria, model role,
version, provenance. Effective permissions are the intersection of user
authorization ∩ parent policy ∩ skill allowlist ∩ execution mode. Skills can
never authorize publication.

## Isolated bounded subagents (`subagents.ts`)

Isolated context, bounded toolset/budget/lifetime, cancellation propagation,
durable events, structured output the parent must validate, no implicit secrets,
no default mutation, and recursion/concurrency/depth limits.

## Context handoff (`context-handoff.ts`)

Typed packets with only objective, criteria, selected evidence, file refs,
structured state, bounded failures, constraints, and output schema — never
reasoning, transcripts, logs, secrets, or stale cached conclusions as authority.

## Statistics and CLI (`stats.ts`, `cli.ts`)

Deterministic aggregation. Surfaces: `jensen run budget|stats|strategies|stalls|
criteria|subagents <run-id>`, `jensen doctor routing|budgets`,
`jensen skills list|inspect`.

## Release recovery (`scripts/release-state-machine.mjs`)

A stale dist-tag after a confirmed publication is `PUBLISHED_TAGS_PROPAGATING`,
never a publication failure. `classifyReleaseState` and `recoveryDecision`
encode the idempotent lifecycle
(NOT_PUBLISHED → PUBLISHED_TAGS_PROPAGATING → PUBLISHED_TAGS_CONVERGED → TAGGED →
GITHUB_RELEASED → COMPLETE). Recovery never republishes an existing version and
never moves an existing tag. See `scripts/release-state-machine.test.mjs`.

## Invariants honored

- Hard budgets cannot be overridden by models.
- Finalization reserve cannot be spent early.
- Model routing is policy-constrained and explainable.
- Stall is measured from structured progress; model prose is never progress
  authority.
- Pivots are bounded and replayable; escalation requires evidence.
- Subagents cannot expand scope; child outputs are not automatically trusted.
- Completion requires verified acceptance; durable state remains authoritative;
  cache is never authoritative; user work is never silently reset; no secrets
  are exposed.
