# Evaluation, Benchmarking, and Release Quality Gates

## Research record

Research was performed against primary repositories and specifications on August 4, 2026. The inspected repository heads were:

| System | Commit | Relevant material |
| --- | --- | --- |
| SWE-bench | `f7bbbb2ccdf479001d6467c9e34af59e44a840f9` | task instances, dataset schema, evaluator and patch/test outcome model |
| OpenAI Evals | `8eac7a7de5215c907fbddc30efdaf316913eccdd` | registry-based evals, model-graded evals, JSONL result records |
| Inspect AI | `4c0a2f35813ac36ddc69afdbddeb5d03f5790f77` | solver/scorer separation, sandboxed tools, structured samples and transcripts |
| METR public tasks | `5418666a1b026fe4d9b4203751ddb913bf949721` | task packages, agent trajectories, reproducibility and controlled environments |

The review also covered the published SWE-bench and AgentBench papers, OpenTelemetry semantic conventions for GenAI operations, and standard paired bootstrap/Wilson interval methods. The repositories and papers are research inputs only; Jensen does not copy implementation code or download third-party benchmark data during CI.

## Design decisions

- A versioned scenario is the unit of evaluation. Its serialized content hash, fixture hash, candidate identity, environment identity, evaluator version, and result artifact hash are recorded.
- Deterministic assertions and safety invariants are evaluated before semantic judges. Candidate prose, candidate metrics, and model-judge scores cannot set the verdict.
- Execution is separated from evaluation. Offline replay uses artifacts/events only; fixture and sandbox modes use isolated materialization; live mode requires `JENSEN_EVAL_LIVE=1`, `--live`, a provider choice, and a positive cost budget.
- Provider/model usage is represented as provenance-bearing metrics. Missing metrics stay `undefined`; they are never converted to zero.
- Pairwise comparisons require the same scenario version and content hash. Baselines are content-addressed, immutable by default, and promoted explicitly.
- Repeated runs retain their identities. A flaky result is explicit and cannot be reported as a clean pass.
- Semantic judges receive bounded evidence, no tools, a hidden candidate label where practical, a rubric version, and a bounded rationale. A judge-unavailable result is not a deterministic pass.
- CI uses deterministic fixture events and does not require paid APIs. Live comparisons are intentionally outside ordinary PR and release authority.

## Jensen-native implementation

The implementation lives in `packages/coding-agent/src/core/evaluation/` and reuses the existing benchmark report/event model rather than creating a second execution or replay authority. It provides scenario/pack validation, fixture materialization, deterministic assertions, metrics, semantic judging contracts, paired comparison, statistics, content-addressed artifacts, baselines, release gates, and the `jensen eval` CLI. Built-in packs cover `core-runtime`, `safe-execution`, `tool-reliability`, `todo-recovery`, `workspace-intelligence`, `cavecrew`, `mcp`, and `cross-platform`.

## Rejected mechanisms

- Automatic public leaderboard submission, arbitrary benchmark downloads, private transcript upload, hidden telemetry, and production canaries were rejected.
- A single aggregate score is not a release authority because it can hide a correctness or safety regression.
- Candidate self-report and candidate self-review are not authoritative evidence.
- An LLM judge alone cannot publish a release or override a deterministic safety failure.
- Network access and paid provider calls are not inferred from credentials.

## Provenance and licensing

The Jensen implementation is original TypeScript under the repository's MIT license. Built-in fixtures are synthetic or historical-regression summaries and contain no private repositories, credentials, or copied benchmark instances. External research references remain links and citations to their original projects; no nontrivial third-party implementation is vendored.

## References

- SWE-bench repository: https://github.com/SWE-bench/SWE-bench
- OpenAI Evals repository: https://github.com/openai/evals
- Inspect AI repository and documentation: https://github.com/UKGovernmentBEIS/inspect_ai
- METR public tasks: https://github.com/METR/public-tasks
- SWE-bench paper: https://arxiv.org/abs/2310.06770
- AgentBench paper: https://arxiv.org/abs/2308.03688
- OpenTelemetry GenAI semantic conventions: https://opentelemetry.io/docs/specs/semconv/gen-ai/
