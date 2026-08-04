# Evidence-Driven Adaptive Orchestration

Jensen's adaptive orchestration subsystem (1.9.0) selects the right execution strategy
for each task using **durable evidence** — not another hardcoded agent workflow. It
answers, with an auditable, replayable decision:

> Which topology (single agent / reviewer / Cavecrew / skill)? Which model and provider?
> Which retrieval strategy and budget class? When to escalate or de-escalate? When to
> fall back or degrade? Which evidence supports the call? Has the routing policy
> regressed? Can the exact decision be replayed?

The subsystem lives in `packages/coding-agent/src/core/routing/` and exposes
`jensen routing …` CLI commands, versioned RPC operations, doctor diagnostics, and
dashboard projections.

## Decision flow

```
task & runtime context
→ deterministic feature extraction
→ applicable candidate generation
→ hard policy filtering
→ evidence lookup
→ candidate scoring
→ uncertainty assessment
→ orchestration decision
→ execution
→ outcome capture
→ evaluation linkage
→ policy diagnostics
```

Encoded in `engine.ts::decide()`.

## Authority hierarchy

```
user authorization
> deterministic safety and effect policy
> workspace and transaction authority
> hard provider and budget constraints
> explicit operator routing overrides
> validated routing policy
> evaluation-backed candidate scores
> runtime heuristics
> model recommendation
```

## Mandatory invariants

Routing **never**:

- overrides the safety policy
- grants new tool authority
- expands workspace scope
- exceeds the operator budget
- enables a live provider implicitly
- promotes a policy automatically
- self-modifies code or policy

Every decision is addressable (`decisionId`), versioned (policy version), includes
provenance, and is replayable. Missing evidence and uncertainty are explicit. Shadow
decisions have zero execution effects. Promotion requires explicit gates; rollback is
available. The cache is never authoritative; durable events remain authoritative.

## Module map

| Concern | File |
| --- | --- |
| Canonical types | `types.ts` |
| Deterministic feature extraction | `features.ts` |
| Candidate generation + hard filtering | `candidates.ts` |
| Deterministic baseline policy | `baseline.ts` |
| Evidence scoring + multi-objective selection | `scoring.ts` |
| Decision engine | `engine.ts` |
| Zero-effect shadow routing | `shadow.ts` |
| Counterfactual evaluation | `counterfactual.ts` |
| Offline policy optimization | `optimizer.ts` |
| Promotion / rollback | `promotion.ts` |
| Escalation / de-escalation | `escalation.ts` |
| Fallback / degradation | `fallback.ts` |
| Budget-class selection | `budget.ts` |
| Long-horizon integration | `long-horizon.ts` |
| Drift detection | `drift.ts` |
| Durable store / events / replay | `store.ts` |
| CLI surfaces | `cli.ts` |
| RPC service | `rpc.ts` |
| CLI helpers | `cli-helpers.ts` |

## Feature extraction

`extractFeatures(task | TaskContext, options)` returns a versioned
`OrchestrationFeatureVector` with a content `featureHash`. It is deterministic —
identity function of its inputs — so decisions replay exactly. Missing values are
explicit (`undefined`). Model-assisted category/ambiguity labels are optional and
separately labeled; they can **never** override the deterministic risk features
(`mutationRisk`, `requiresMutation`, `requiresRelease`, security sensitivity).
Features never include protected personal attributes.

## Candidate generation & hard filtering

`generateCandidates` builds a bounded, deterministically-ordered cartesian set from
canonical registries only. It never invents a provider, model, skill, or agent.
`applyHardPolicy` then applies hard filters (workspace, tool effects, network, provider/
model allowlists, cost/model-call/subagent/recursion/affected-file bounds, local-only,
live-provider authorization). Hard rejection **cannot** be overcome by a higher
evaluation score.

## Deterministic baseline

`baselineSelect(features)` matches explicit rules (`baseline-release`,
`baseline-high-risk-mutation`, `baseline-bounded-implementation`,
`baseline-small-exact-lookup`, `baseline-default`) with deterministic precedence. It
needs no evaluations, no live providers, no network, and works when the evaluation
store is unavailable. Each rule carries an ID; the baseline is replayable.

## Evidence scoring, uncertainty, multi-objective selection

- `scoreCandidate` maps evidence to a score. **Missing evidence stays undefined, never
  zero.** Safety failures remain separate hard constraints and are never averaged away
  (`aggregateScore` returns `-Infinity` below a safety floor).
- `selectBest` combines explicit versioned weights per policy, penalizes uncertainty,
  and uses deterministic tie-breaking. Objective policies: `quality_first`, `balanced`,
  `cost_constrained`, `latency_constrained`, `local_only`, `high_assurance`.
- `assessConfidence` returns `high|medium|low|insufficient_evidence`.

## Shadow routing & counterfactual

`shadowEvaluate` computes what a shadow policy *would* have selected with **zero
execution effects** — no tool calls, no model calls, no workspace mutation, no extra
provider cost. Shadow decisions are durable. `evaluateCounterfactual` produces
clearly-labeled, non-causal estimates with explicit estimator, compatibility, and
uncertainty — never retroactively changing a completed run's authority.

## Policy optimization, promotion, rollback

`generateRoutingPolicy` derives a ranking from an **immutable, content-addressed**
evaluation dataset. It identifies evidence gaps and dominated candidates, never uses
candidate self-report as a label, and never activates a policy. `promotePolicy` requires
schema validation, dataset integrity, baseline comparison, safety/correctness/flakiness
gates, cost/latency policy, and explicit operator authorization. The old policy is
retained; the active-policy pointer is swapped atomically. `rollbackPolicy` is
idempotent.

## Escalation, fallback, budget

- `decideTransition` escalates/de-escalates on typed signals with hard max-transition
  bounds; de-escalation can never remove a required reviewer/validation.
- `resolveFallback` is typed: operator → validated policy → deterministic baseline →
  safe degraded → typed blocked. No fuzzy substitution, no surprise paid provider.
- `selectBudget`/`canEscalate` bound budget classes with a mandatory finalization
  reserve; operator ceilings are authoritative; escalation needs remaining reserve.

## Long-horizon integration

Routing reconsiders only at governed boundaries (`initial_planning`,
`post_investigation`, `pre_mutation`, `post_validation_failure`, `pre_review`,
`pre_release`) — never after every tool call. Phase state remains authoritative; a
transaction must complete or roll back before an incompatible strategy change; routing
changes never rewrite history; context handoff is bounded and validated.

## Durable events, replay, drift

- `store.ts` appends bounded, sanitized `OrchestrationEvent`s correlated with runs and
  phases.
- Every decision is a durable, addressable `OrchestrationDecision` that
  `replayDecision`/`jensen routing replay` reconstruct with zero provider/model/tool
  effects and zero workspace mutation. If required evidence is missing, replay fails
  explicitly.
- `computeDrift`/`detectDrift` detect quality/cost/latency/failure-cluster/retrieval/
  flakiness/policy-selection drift with deterministic bounded detectors, minimum sample
  counts, and no unsupported statistical certainty. Drift never auto-promotes; it
  produces evaluation recommendations.

## CLI

```
jensen routing status
jensen routing decide --task "..."
jensen routing explain <decision-id>
jensen routing replay <decision-id>
jensen routing compare <decision-a> <decision-b>
jensen routing candidates
jensen routing features
jensen routing evidence
jensen routing shadow status|compare
jensen routing policy list|inspect|validate|compare|generate|promote|rollback
jensen routing drift status|inspect
jensen doctor routing
```

All support `--json`. Read-only diagnostic commands have **no execution effects** and
run offline on deterministic fixtures in normal CI (no paid APIs).

## RPC

Versioned `routing.*` operations mirror the CLI: `status`, `decide`, `explain`, `replay`,
`compare`, `candidates`, `features`, `shadowStatus`, `shadowCompare`, `policyList`,
`policyInspect`, `policyValidate`, `policyCompare`, `policyPromote`, `policyRollback`,
`driftStatus`, `driftInspect`. Promotion/rollback require explicit authorization;
everything else is a bounded projection.

## Doctor

`jensen doctor routing` checks active policy existence/validity, candidate registries,
drift-detector health, and baseline availability. A `fail` status returns a nonzero exit
code. The doctor is read-only.

## What routing does NOT do

- Routing does not override safety.
- Active policies are versioned; promotion is explicit.
- Evaluation evidence may be insufficient — this is stated, never hidden.
- Shadow routing has zero effects.
- Live providers remain explicitly authorized.
- No autonomous self-modification occurs.
- The deterministic baseline remains available.
- Operator overrides are durable and visible.

## Offline / deterministic behavior

Ordinary CI and the CLI touch only deterministic fixture evidence
(`cli-helpers.ts::fixtureEvidence`) and fixture providers. No paid API calls occur in
normal CI. Routing state is stored under `<agentDir>/routing/` (or
`JENSEN_ROUTING_ROOT` for isolated testing) and is never packaged into npm/binary
artifacts.
