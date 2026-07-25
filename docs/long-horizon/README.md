# Long-Horizon Software Execution

The Jensen Long-Horizon benchmark measures whether a coding agent actually completes a complete software-engineering mission.

## Why This Matters

Software engineering missions are long-running, multi-step tasks: discovery, implementation, integration, testing, validation, and audit. Current agent evaluation metrics (lines changed, tool calls, turn count) answer "did the agent do something?" but never answer "did the agent actually finish everything?"

A single omitted acceptance criterion, skipped test suite, or unsupported completion claim is the difference between a successful mission and an incomplete one that silently ships with missing work.

This benchmark framework provides:

1. **Deterministic evaluation** - no model inference, no ambiguity
2. **Authoritative evidence** - file changes, command results, test outputs
3. **Fail-closed scoring** - missing information never defaults to success
4. **Provider neutrality** - evaluates any agent (Jensen, Codex, human)
5. **Identical conditions** - same snapshot, same prompt, same acceptance criteria

## How It Works

### Task Manifest

A benchmark task defines what must be done, not how. It specifies:

- Requirements with acceptance criteria
- Required evidence types (file changes, test results, command output)
- Forbidden actions (no push to main, no tag creation)
- Expected validation (test suites, diff audits)
- Budget constraints

### Run Report

An agent produces a run report describing:

- What was attempted and what was implemented
- Evidence for each requirement
- Claims made (distinguished as authoritative or non-authoritative)
- Actions taken (including any forbidden actions)
- Termination reason

### Evaluator

The deterministic evaluator:

1. Validates schema compatibility, duplicate identities, and acyclic dependency graphs
2. Matches run results to manifest requirements
3. Detects missing evaluations and omissions
4. Distinguishes authoritative evidence from unsupported claims (claims are never authoritative)
5. Detects forbidden actions
6. Validates blocker classifications
7. Detects premature completion
8. Derives effective states in dependency order (dependency-inconsistent work cannot be verified)
9. Calculates metrics including Verified Completion Ratio

### CLI Exit Codes

Process exit indicates whether evaluation executed validly. `completionGate.passed` indicates whether the benchmark subject completed the mission. The two are independent.

| Input/evaluation state            | Exit | completionGate       |
| --------------------------------- | ---: | -------------------- |
| Valid and verified                |    0 | true                 |
| Valid but benchmark subject fails |    0 | false                |
| Invalid schema or identity        |    1 | false                |
| Parse/read/write/CLI failure      |    1 | unavailable or false |

Valid evaluations always exit 0. Schema-invalid input always exits 1. Operational errors (missing files, malformed JSON, write failures) exit 1.

### Effective Termination vs Premature Completion

`effectiveTermination` and `prematureCompletion` are related but distinct fields. A run may have `effectiveTermination: "COMPLETED_WITH_UNVERIFIED_WORK"` while `prematureCompletion` is `true` — the agent truthfully reported incomplete work but stopped while applicable work remained incomplete. Not all incomplete runs map to `PREMATURE_COMPLETION` as the effective termination.

### Trust Boundary

Run reports intended for authoritative benchmarking must be produced by a trusted collector that records tool, repository, test and operator evidence independently of the evaluated agent. The evaluator does not cryptographically authenticate JSON input.

### Primary Metric: Verified Completion Ratio

```
VCR = requirements SATISFIED with authoritative evidence / all applicable requirements
```

A VCR of 1.0 means every applicable requirement was satisfied with authoritative evidence. Checkmarks and claims are not evidence.

## Fair Comparison (Jensen vs Codex)

Both agents will be evaluated against the same:

- Git snapshot
- Task prompt
- Allowed tools
- Forbidden actions
- Task manifest
- Acceptance criteria
- Evidence requirements

Comparable model budgets. Separate clean workspaces. No evaluator access during execution. Deterministic post-run evaluation.

## Implementation Status

| Milestone | Status |
|-----------|--------|
| LH-0: Benchmark Foundation | Implemented |
| LH-1: Mission Contract | Planned |
| LH-2: Execution State Machine | Planned |
| LH-3: Continuation Scheduler | Planned |
| LH-4: Progress Watchdog | Planned |
| LH-5: Completion Gate | Planned |
| LH-6: Semantic Checkpointing | Planned |
| LH-7: Independent Review | Planned |
| LH-8: Golden Benchmark Suite | Planned |
| LH-9: Adaptive Policies | Planned |