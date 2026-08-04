# Evaluation Runtime

Jensen evaluation data is stored under `.jensen/evaluations`.

```text
.jensen/evaluations/
  store.json
  artifacts/<artifact-id>/
    manifest.json
    result.json
  baselines/
  temporary/
```

`store.json` and artifact manifests use schema version `1`. An artifact is ready only after its result and manifest are written in a temporary directory and atomically promoted into `artifacts/<artifact-id>`. Temporary entries are never treated as ready artifacts. Artifact IDs are content hashes and path traversal is rejected.

`jensen doctor eval` is read-only. It does not create the store, manifests, or directories. A missing store before the first evaluation is a passing absent state; a valid empty store is also passing. Incomplete temporary state is degraded and ready-artifact, index, schema, permission, hash, and JSON failures are failures. JSON and human output use the same diagnostic result and exit code:

- `0`: pass, including absent or disabled optional evaluation state;
- `1`: warning or degraded state;
- `2`: required check failure;
- `3`: invalid doctor invocation or schema request;
- `4`: internal diagnostic failure.

Use `jensen eval run <pack> --mode fixture` for deterministic execution. Repetitions are retained individually and `jensen eval stability <artifact-id>` reports stable pass, stable fail, flaky, or insufficient samples. Flaky outcomes cannot be hidden by averaging.

`jensen eval replay <artifact-id>` and `jensen eval rescore <artifact-id>` read immutable evidence, perform no model or tool calls by default, and write a new result identity without changing the original. Live evaluation is disabled by default and requires `JENSEN_EVAL_LIVE=1`, `--mode live`, `--live`, `--confirm-live`, an explicit provider profile, and positive budgets.

`jensen eval prune --preview` is non-mutating. `--execute` removes only temporary evaluation remnants; baselines, release evidence, referenced reports, and source fixtures are preserved. Failure clustering uses canonical assertion and run identity fields; optional model explanations cannot define cluster IDs.

## Binary builds

The coding-agent package declares `chromium-bidi` explicitly and the private repository package keeps the resolver hoisted for Bun compilation. The binary script installs from the lockfile, builds from a clean checkout, runs startup/evaluation/doctor smoke tests on extracted targets, and writes `binary-manifest.json` plus `SHA256SUMS`. Release assets are built from the canonical release commit; an existing asset is never silently overwritten.

Npm publication, source release, and binary distribution are distinct gates. A Jensen release is complete only after package publication, evaluation/doctor smoke, binary build and smoke, asset upload, and independent checksum verification converge.

## Sandboxed candidates

`--mode sandbox` materializes an immutable fixture into a dedicated sandbox identity. Candidate processes run with an allowlisted environment, workspace-bound paths, bounded wall time, output, disk, process, tool, and cost budgets, and owned descendant cleanup. Fixture-provider execution is not sandboxed candidate execution. Symlinks and Windows junction escapes are rejected; a failed sandbox is retained only when explicitly requested and retained evidence is read-only to evaluators.

The sandbox emits durable lifecycle events (`EVAL_SANDBOX_ALLOCATED`, `EVAL_SANDBOX_MATERIALIZED`, `EVAL_SANDBOX_VERIFIED`, candidate terminal events, launcher identity/authorization/rejection events, and cleanup/retention events). Candidate policy is immutable after start and cannot grant child agents broader effects.

## Candidate launcher identity

The executable that starts the Jensen evaluation candidate is the *candidate launcher*. It is authorized by **identity — a validated absolute path to the verified runtime executable — not by its basename**. This is a hard security boundary:

- Renaming the binary (`pi`, `pi-renamed`, `jensen`, `jensen-test`) must not change its identity, and must not break sandbox execution.
- An unrelated executable that merely shares the basename is **not** trusted.
- A PATH-precedence or symlink attack cannot substitute another executable for the launcher.
- Scenario content cannot override or expand the launcher identity; the launcher is injected by the evaluation runtime separately from candidate policy.
- The launcher starts the Jensen candidate runtime and does **not** grant the candidate permission to invoke arbitrary executables sharing a name.

The launcher identity is resolved from the current runtime: a Node source runtime launches `node -e <inline-probe>`, while a Bun-compiled runtime launches `eval self-probe` on the same verified executable. This keeps source, packed npm, and compiled binary sandbox behavior equivalent. Launcher authorization is immutable after the sandbox starts, the launcher path is validated before spawn, and argv is passed as structured arguments (no shell interpolation). Process trees and descendants remain owned by the evaluation runtime, with authoritative timeout, cancellation, and cleanup.

## Exit and verdict semantics

`jensen eval run` maps the artifact verdict to a stable process exit code so CI can rely on the process exit, and JSON and human output use the same result object:

- `0`: evaluation completed with verdict `pass`;
- `1`: evaluation completed with verdict `fail`;
- `2`: evaluation completed with verdict `invalid`;
- `3`: evaluation cancelled or timed out;
- `4`: invocation, runtime, or internal error.

Reporting/inspection commands (`eval stability`, `eval replay`, `eval rescore`, `eval compare`) remain exit `0` when merely displaying an existing result. A completed evaluation run whose verdict is `fail`, `invalid`, or `cancelled` always exits nonzero — a process exit of `0` cannot falsely signal successful acceptance.

## Binary sandbox acceptance

Binary smoke is no longer limited to read-only commands. `build-binaries.sh` runs a **real sandboxed candidate evaluation** on every host-executable target and aborts the build before any asset is packaged or uploaded if the artifact verdict is not `pass` with process exit `0`. Windows smoke runs the equivalent sandbox scenario with `pi.exe`. The release-convergence gate requires per-artifact sandbox runtime acceptance (`source`, `packedNpm`, `registryNpm`, `builtBinary`, `downloadedBinary`); a basic `--version` smoke alone cannot produce a final PASS.

## Live providers and reviewers

Live evaluation requires `--mode live`, `--confirm-live`, an explicit provider profile, resolved model identity, positive maximum cost, model-call, and wall-time budgets, and credentials available for that profile. Credentials alone never enable live mode. OpenRouter and OpenAI-compatible profiles are supported; ordinary CI uses deterministic fake providers and makes no paid calls. Candidate and reviewer budgets are tracked separately, and typed provider failures or budget termination cannot pass a release gate.

Reviewers receive a bounded, content-addressed evidence packet rather than hidden reasoning or mutable candidate state. Reviewer identity differs from the candidate, reviewer output is schema-validated and prompt-injection checked, and deterministic safety/correctness failures remain authoritative.

`jensen eval compare-agents <scenario> --single-agent <agent> --orchestration cavecrew` runs paired candidates under equal scenario, fixture, policy, environment, and budget conditions. Cavecrew benefit is measured through correctness, safety, cost, latency, calls, retrieval, and rollback deltas; delegation alone is never a win.

## RPC, dashboard, retention, and release convergence

The versioned evaluation RPC service implements packs, scenarios, inspection, validation, execution, cancellation, status, reports, comparisons, replay/rescore, stability, baselines, gates, failures, pruning, and doctor operations. UI consumers remain projection-only and receive bounded, paginated views for active runs, failures, comparisons, semantic results, costs, flakiness, retention, and release convergence.

Retention policy version `1` protects release baselines, release-gate evidence, active comparisons, and referenced failure evidence. `jensen eval prune --preview` performs no writes and returns a deterministic manifest; `--execute` requires that manifest, an exclusive writer lease, and a content precondition. Source fixtures, active runs, baselines, and protected evidence are never deleted.

Functional evaluation is a hard release gate. Package build, npm publication, source tag, binary build/smoke, asset upload/download verification, and GitHub Release must converge on one exact release commit. The Changesets Version Packages PR is separate from the implementation PR; a release remains incomplete while any required state is pending, partial, or failed.
