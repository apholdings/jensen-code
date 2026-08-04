---
"@apholdings/jensen-ai": minor
"@apholdings/jensen-agent-core": minor
"@apholdings/jensen-code": minor
"@apholdings/jensen-mom": minor
"@apholdings/jensen-pods": minor
"@apholdings/jensen-tui": minor
"@apholdings/jensen-web-ui": minor
---

Add evidence-driven adaptive orchestration subsystem.

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
