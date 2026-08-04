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
