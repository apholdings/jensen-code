# Reasonix Adaptive-Runtime Research

Repository inspected: `https://github.com/esengine/DeepSeek-Reasonix.git`
Local reference clone: `/home/magnus/software/reference/deepseek-reasonix`

## Commits inspected

- Stable release tag: `v1.19.4` → `b36a7e3d54a6cb88bbef8467fb5ba937f1337f34`
- Default branch (`main-v2`) head: `c46e3af1c2732fe2b3dedb0bd47eb39a629357d2`
- License: MIT (Reasonix Contributors)
- Remote origin: `https://github.com/esengine/DeepSeek-Reasonix.git` (public Reasonix).

## Relevant source paths studied

| Mechanism | Paths |
| --- | --- |
| Failure/stall budgets | `internal/recovery/budget.go`, `internal/recovery/decision.go`, `internal/recovery/types.go`, `internal/agent/repeat_failure_guard.go` |
| Strategy/scope/risk classification | `internal/recovery/rules.go`, `internal/recovery/decision.go` (`ChangeKind`) |
| Independent review / recovery gate | `internal/recovery/reviewer.go`, `internal/recovery/gate.go`, `internal/recovery/decision.go` (`Route*/Facts`) |
| Model capability registry & routing | `internal/capability/capability.go`, `internal/capability/catalog.go`, `internal/capability/ledger.go`, `internal/agent/planner_route.go`, `internal/agent/capability_gate.go`, `internal/agent/usecapability.go` |
| Model roles (planner/guardian/recovery/subagent) | `internal/agent/planner_route.go`, `internal/guardian/`, `internal/recovery/`, `reasonix.example.toml` |
| Skills | `internal/skill/` (manifest/frontmatter, paths, budgets, builtins) |
| Subagents | `internal/agent/subagent_store.go`, `internal/agent/subagent_registry_test.go`, `internal/agent/fleet.go`, `internal/agent/parallel_tasks.go`, `internal/agent/scheduler.go` |
| Session/run stats | `internal/agent/session_statistics`-style ledgers, `internal/billing/balance.go` |
| Checkpointing | `internal/checkpoint/checkpoint.go`, `internal/agent/session_lease.go`, `internal/workspacelease/` |

## Mechanisms studied

1. **Failure budgets** — `MaxOperationFailures = 3` (per exact operation), `MaxEpisodeFailures = 6` (per task since last real progress), `MaxReviewRejects = 3`, `MaxStoppedOperationRetries = 3`. Stop reasons escalate from per-operation `RouteStop` to per-turn `RouteStopTurn`. `FinalizationNudge` grants exactly one summarize-only round when budgets exhaust — a Jensen "finalization reserve" analogue.
2. **Stall / no-progress detection** — episodes count qualifying failures since last real progress; a repeat-failure guard fingerprints identical write-like failures; `Facts`/`Decide` is a pure deterministic decision engine (no locks, no model, no I/O) mapping observed facts to routes.
3. **Strategy pivots** — `ChangeKind` distinguishes `same_strategy` vs `strategy` vs `scope` vs `risk`; scope expansion surfaces as `ExpandedScope`; pivots are host-classified, not model-declared.
4. **Independent review** — recovery reviewer returns strict `ReviewVerdict` (`continue`/`confirm`) with `change_kind`; `RouteReview` hands ambiguous mutations to the isolated reviewer.
5. **Model roles/capability routing** — capability `Entry` with `Status` (ready/configured/disabled/failed/stale), `AutoUse` (off/suggest/prefer/require), `Profiles` (economy/balanced/delivery), `Requires`; `RouteDecision`/`RouteCandidate` with opaque privacy-safe `Reason` codes; two-model planner routing (`PlannerRoute*`, `PlannerDepth*`). Cheap-model routing is capability/profile driven, not "expensive is better".
6. **Skills** — SKILL.md frontmatter manifests under scoped roots, with per-skill budget overrides, tools, runAs (`subagent`), concurrency minus.
7. **Subagents** — isolated store, registry, fleet and parallel task scheduling with bounded concurrency and cleanup.
8. **Stats** — billing balance and session ledgers for cost/token telemetry.

## Strengths

- Deterministic, host-owned decision engines (no model authority over limits).
- Explicit separation of failure classification from permission/product decisions.
- Clear escalation ladder from per-operation stop to turn-stop.
- Finalization nudge reserves capacity for reporting.
- Capability/profile-driven (not name-driven) model routing.

## Limitations / unsafe mechanisms rejected for Jensen

- No dedicated durable token/cost budget **ledger with replay and idempotent accounting** (Reasonix budgets are runtime counters, not append-only durable ledgers).
- No **finalization reserve** as a first-class protected budget that cannot be spent by ordinary execution and is returned to parent after completion.
- No **typed provider/model capability registry** with explicit unknown-capability state and effective-date pricing.
- Stalls are failure-count heuristics; Jensen needs hash-based structured progress observations and deterministic progress weights.
- No **machine-readable success criteria with evidence requirements** (Jensen requirement ledger is stronger here).
- No explicit **typed skill manifest schema validation** with allowed-tool/denied-effect intersection (Jensen skills.ts is discovery-only).
- No durable **budget-aware web/LSP/job** integration.
- The US is a single-host system; multi-host distribution and marketplaces (excluded by scope) are correctly not in Jensen 1.5.0.

## Jensen-native design

Jensen implements these as a new cohesive adaptive module under the existing long-horizon package, in TypeScript, reusing Jensen's deterministic pure-function conventions:
- Durable append-only **budget ledger** (idempotent, replay-safe, no double charge on resume).
- Protected **finalization reserve** usable only by approved lifecycle stages.
- **Provider/model capability registry** with deterministic resolution and explicit unknown state.
- **Role-based model routing** producing structured `reasonCodes`, with policy-constrained bounded escalation.
- **Structured progress observations** with configurable deterministic weights; stall detector fed by the 1.4.0 Tool Storm Breaker.
- **Bounded strategy pivots** that are materially different and replayable.
- **Evidence-backed success criteria** feeding a deterministic **readiness gate** wired into the canonical completion boundary.
- **Typed skills** (allowed tools / denied effects / budget / success schema) and **isolated bounded subagents**.
- **Idempotent release-recovery state machine** for the repeated npm read-after-write failure.

## License / provenance

Reasonix is MIT. Jensen's 1.5.0 adaptive runtime is an independent TypeScript implementation informed by the public mechanisms above; no Reasonix source is copied into Jensen. Research note path: `docs/research/reasonix-adaptive-runtime.md`.
