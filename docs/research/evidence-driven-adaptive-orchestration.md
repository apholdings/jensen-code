# Evidence-Driven Adaptive Orchestration — Research Notes

Scope: the adaptive orchestration / routing subsystem for Jensen 1.9.0. Research was
conducted against primary sources and reference implementations, then interpreted into
Jensen-native, safety-bound architecture. This note records papers, repositories and
versions studied, feature/routing/uncertainty/evaluation/drift methods, safety
limitations, Jensen-native decisions, rejected mechanisms, and licensing conclusions.

## Primary sources studied

### LLM routing and cascades
- **FrugalGPT** — Chen, Zaharia, Zou (Stanford, 2023), arXiv:2305.05176 / TMLR 2024.
  LLM cascade: route each query to the cheapest combination of LLMs that meets an
  accuracy target, with prompt adaptation and model approximation as complementary
  strategies. Reports up to 98% cost reduction matching best single model. Jensen
  adopts the *cascade/routing* framing: a task is routed to a candidate (model +
  topology + retrieval + budget) chosen to meet correctness/safety at bounded cost.
  FrugalGPT's "adaptation" (prompt rewriting) is rejected for production (see below).
- **RouteLLM** — lmsys/RouteLLM, arXiv:2406.18665. Learns routers from preference data
  (paired comparisons) between a strong and weak model; bidirectional; reported 85%
  cost saving at 95% GPT-4 quality on MT Bench. Jensen adopts cost/quality tradeoff
  framing and the notion of router evaluation against a fixed baseline, but rejects
  *learned neural routers* in the shipped path in favor of a deterministic, auditable,
  evaluation-backed decision engine (see "Jensen-native decisions").
- **Microsoft AutoGen routing research** — reviewed conceptually (multi-agent
  orchestration). Jensen already has Cavecrew; routing selects *when* Cavecrew is
  beneficial. No code copied.

### Offline policy evaluation & conservative improvement
- **Doubly robust estimator** — Dudík, Langford, Li (ICML 2011); contextual bandit OPE.
  Combines a regression model with inverse propensity scoring to reduce bias/variance.
  Jensen records an explicit `OffPolicyEstimator` label on counterfactual estimates and
  marks them as non-causal estimates, with uncertainty reported. The current shipped
  estimation is a labeled direct/paired estimator; DR remains an enumerated future mode
  rather than an over-claimed implementation.
- **Conservative/Mildly conservative safe offline RL** — CQL and safe-offline literature
  (e.g., mild conservatism guaranteeing `J(π) ≥ J(µ) − O(penalty)`). Jensen adopts the
  *safety-first* principle: any policy promotion must prove it does not regress safety
  below a gate, and candidate self-report is never used as a label. This is a policy
  gate, not model-weight training.
- **Safe anchoring / constrained policy optimization** — reviewed for the "rollback
  target recorded" and "active policy immutable; promotion explicit" invariants.

### Drift detection
- **ADWIN** — Bifet & Gavaldà; adaptive windowing, compares means of adjacent
  sub-windows, parameter-free change detection with mathematical guarantees.
- **Page-Hinkley** — sequential change-detection test for mean shift.
- **Fixed-threshold sliding-window baseline** — Jensen uses a deterministic
  fixed-threshold mean-delta detector over a trailing window (see drift.md), which is
  simpler than ADWIN but auditable, bounded, and label-compatible. ADWIN/Page-Hinkley are
  enumerated `method` values for future extension; no unsupported statistical certainty
  is claimed.

### Uncertainty & selective prediction
- **Selective prediction / cascaded inference / early exit** — reviewed. Jensen exposes
  explicit `confidence` on decisions ("high|medium|low|insufficient_evidence"),
  explicit `uncertainty` on candidate scores, and `selectBest` penalizes uncertainty.
  Escalation reacts to typed uncertainty signals. No hidden inference.

## Methods adopted (Jensen-native)
- **Deterministic task feature extraction** with a versioned schema, bounded feature
  count, explicit missing values, and a content hash. Model-assisted features are
  optional and separately labeled; they can never override deterministic risk features.
- **Candidate generation only from canonical registries** (provider profiles, model
  registry, subagent registry, skill registry, retrieval policies, budget classes).
  Never invents a provider/model/skill/agent; bounded cartesian set; deterministic order.
- **Hard policy filtering before scoring** (workspace, tool effects, network, provider/
  model allowlists, cost/model-call/subagent/recursion bounds, local-only, live-provider
  authorization). Hard rejection cannot be overridden by a higher score.
- **Deterministic baseline policy** with explicit rule IDs and precedence, available
  even when the evaluation store fails; replayable.
- **Evaluation-informed scoring** where missing evidence stays undefined (never zero),
  safety failures remain separate hard gates, weighted aggregation is versioned and
  explicit, and uncertainty penalizes selection.
- **Multi-objective selection** across correctness/safety/reliability/cost/latency with
  explicit policies (quality_first, balanced, cost_constrained, latency_constrained,
  local_only, high_assurance) and deterministic tie-breaking.
- **Zero-effect shadow routing** and **labeled counterfactual evaluation** with explicit
  estimator, compatibility, and uncertainty.
- **Conservative offline policy optimization** with content-addressed datasets, safety/
  correctness/flakiness gates, explicit promotion, and idempotent rollback.
- **Deterministic bounded drift detection** on quality/cost/latency/failure-cluster/
  retrieval/flakiness/policy-selection dimensions; drift never auto-promotes.
- **Typed escalation/de-escalation/fallback** with hard bounds, operator budget ceilings,
  and a mandatory finalization reserve.

## Rejected mechanisms
- **Learned/neural routers, model-weight training, hidden RL** — rejected: un-auditable,
  not reproducible for the deterministic CI requirement, high maintenance.
- **Autonomous prompt rewriting in production** — rejected: routing must not silently
  alter operator semantics; model-assisted feature labels are opt-in and non-authoritative.
- **Automatic policy promotion after a single run / after CI** — rejected: promotion is
  an explicit, gated operator action; shadow and offline validation produce evidence only.
- **Fuzzy model/agent substitution, surprise paid providers** — rejected: all
  substitution is typed and visible; live providers require explicit authorization.
- **Unrestricted online exploration** — rejected: shadow decisions have zero effects;
  exploration is only offline with content-addressed immutable datasets.
- **Profiling based on protected attributes** — rejected: features never include
  protected personal attributes.
- **Remote upload of private repository content; user profiling for unrelated purposes;
  silent replacement of operator-configured models** — rejected by design and by tests.

## Safety limitations (documented explicitly)
- Decisions are estimates; "insufficient_evidence" is a first-class confidence.
- Drift detectors use deterministic window statistics, not formal statistical tests;
  results are recommendations, never authority.
- Counterfactual estimates are labeled, non-causal, and never retroactively alter a
  completed run.
- Routing never grants tool authority, never expands workspace scope, never exceeds the
  operator budget, and never enables a live provider implicitly.

## Licensing & provenance
- No nontrivial implementation code was copied from any reference. Concepts are drawn
  from the cited papers/repositories; all are permissive-academic (arXiv) or MIT/
  permissive open source (RouteLLM MIT, scikit-multiflow, River). Jensen's implementation
  is original TypeScript authored for this repository. No license obligations beyond
  acknowledgement apply; no source-text reproduction is included.

## Primary reference versions/commits
- RouteLLM: github.com/lm-sys/RouteLLM (main branch, 2024), MIT.
- FrugalGPT: arXiv:2305.05176 / TMLR 2024.
- ADWIN: Bifet & Gavaldà (2007), reference scikit-multiflow / River implementations.
- Doubly robust OPE: Dudík et al., ICML 2011.
- RouteLLM framework: github.com/nate-lrt/llm-routing (README/forks), MIT.

## Jensen-native decision architecture
The full decision flow, invariants, CLI/RPC/doctor/dashboard surfaces, event model,
replay, and security guarantees are specified in `docs/evidence-driven-adaptive-orchestration.md`
and implemented under `packages/coding-agent/src/core/routing/`.
