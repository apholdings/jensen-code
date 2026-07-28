# Long-Horizon Autonomous Execution

## Roadmap

See [roadmap.md](./roadmap.md) for the full long-horizon development plan.

## LH-0: Benchmark Foundation (Implemented)

Deterministic benchmark evaluation system. See [benchmark-format.md](./benchmark-format.md) for the task manifest and run report schema.

## LH-1: Mission Contract and Requirement Ledger (Implemented)

Models and records execution obligations for long-running missions. LH-1 does NOT yet force the running agent to continue executing them — that enforcement begins in LH-2 and LH-3.

### Components

- **Mission Contract** ([mission-contract.md](./mission-contract.md)): Versioned JSON schema defining mission requirements, workstreams, constraints, forbidden actions, and evidence policy.
- **Requirement Ledger** ([requirement-ledger.md](./requirement-ledger.md)): Append-only, auditable ledger tracking requirement state transitions and evidence records.
- **CLI** (`jensen benchmark long-horizon`): Provider-isolated commands for contract validation, digest computation, ledger initialization, evidence insertion, transition application, and ledger inspection.

### Architecture

```
packages/coding-agent/src/core/
  benchmark/          LH-0 benchmark evaluation (remains separate)
  long-horizon/       LH-1 mission contract + ledger
    types.ts          Canonical domain types (reuses benchmark RequirementEvaluationStatus)
    mission-contract-schema.ts  Contract validation (DAG, duplicates, cycles)
    contract-digest.ts           SHA-256 deterministic digest
    requirement-ledger.ts        Ledger operations (init, evidence, transition)
    transition-policy.ts          Single canonical transition matrix
    ledger-reducer.ts             State derivation from transition log
    ledger-summary.ts             Deterministic mission summaries
    canonical-json.ts             Stable JSON serialization
    cli.ts                        CLI command handlers
    index.ts                      Public API
    fixtures/                     Golden test fixtures
```

### Key Design Decisions

1. **Shared requirement states**: LH-1 reuses `RequirementEvaluationStatus` from LH-0 benchmark types — exactly one source of truth.
2. **Trust boundary**: Agent claims are never authoritative. Transitions to SATISFIED require authoritative evidence from a trusted collector or operator.
3. **Optimistic concurrency**: Every mutable operation requires `expectedRevision`. Stale revisions are rejected atomically.
4. **Append-only**: Evidence and transitions are never deleted or modified, only appended.
5. **Deterministic**: All core functions are pure, immutable, and free of provider, filesystem, or time dependencies.

### Scope Boundary

LH-1 models and records execution obligations.

LH-1 does NOT yet:
- Automatically generate contracts from prompts (no LLM inference)
- Integrate with the agent execution loop
- Automatically resume or schedule continuations
- Run watchdog monitoring
- Perform semantic compaction
- Implement independent completion review

Those features begin in LH-2 through LH-7.

### CLI Commands

```
jensen benchmark long-horizon mission validate --contract <path>
jensen benchmark long-horizon mission digest --contract <path>
jensen benchmark long-horizon ledger init --contract <path> --output <path>
jensen benchmark long-horizon ledger validate --contract <path> --ledger <path>
jensen benchmark long-horizon ledger add-evidence --contract <path> --ledger <path> ...
jensen benchmark long-horizon ledger transition --contract <path> --ledger <path> ...
jensen benchmark long-horizon ledger inspect --contract <path> --ledger <path>
```

All commands route before model selection and provider loading.