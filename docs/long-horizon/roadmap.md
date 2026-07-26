# Long-Horizon Roadmap

## LH-0: Benchmark Foundation (Implemented)

- Canonical benchmark schemas (task manifest, run report)
- Requirement and evidence models
- Deterministic run-report ingestion
- Fail-closed evidence authority policy (claims never authoritative)
- Trusted collector boundary documented
- Duplicate identity rejection (evidence IDs, requirement IDs, run result IDs)
- Acyclic dependency graph validation (Kahn's algorithm)
- Dependency-aware verified scoring (unsatisfied dependencies exclude from VCR)
- Unweighted scoring in schema v1
- Fail-closed unknown identity handling
- Numeric field validation (non-negative, finite)
- Fail-closed requirement evaluation
- Verified Completion Ratio scoring
- Secondary diagnostic metrics (omissions, claims, forbidden actions)
- Completion gate
- Human-readable and machine-readable reports
- CLI entry point: `jensen benchmark long-horizon evaluate`
- Golden deterministic fixtures (G01-G12)
- Adversarial regression tests (A01-A20)
- Provider-neutral design

## LH-1: Mission Contract and Requirement Ledger (Implemented)

Runtime modeling of mission requirements and auditable execution tracking:

- Versioned Mission Contract schema v1 (workstreams, requirements, constraints, forbidden actions)
- Explicit versus inferred requirement provenance with mandatory rationale
- Structured acceptance criteria with minimum evidence requirements
- Requirement dependency DAG validation (Kahn's algorithm)
- Versioned Requirement Ledger v1 (append-only transitions and evidence)
- Deterministic contract-to-ledger cryptographic binding (SHA-256)
- Optimistic concurrency with stale revision rejection
- Authoritative evidence enforcement (agent claims never authoritative)
- Deterministic canonical JSON serialization
- Provider-isolated CLI commands
- Golden fixtures and comprehensive tests

## LH-2: Execution State Machine

Explicit state machine for long-horizon execution:

- States: DISCOVERY, IMPLEMENTATION, INTEGRATION, VALIDATION, AUDIT
- State transitions tracked in session
- State-aware context injection
- Progress reporting to user

## LH-3: Continuation Scheduler

Automatic continuation of long-running missions:

- Context budget monitoring
- Checkpoint before context overflow
- Automatic resume in fresh context
- Mission contract continuity across continuations

## LH-4: Progress Watchdog

Independent monitoring of agent progress:

- Detects stalled work
- Identifies circular or repetitive behavior
- Warns when requirements remain unaddressed
- Budget exhaustion prediction

## LH-5: Completion Gate and Typed Stop Reasons

Runtime integration of the completion gate:

- Pre-termination requirement audit
- Typed stop reasons with evidence
- User-facing completion summary
- Prevent premature agent shutdown

## LH-6: Semantic Checkpointing

Compression that preserves mission contract state:

- Requirement status preserved across compaction
- Evidence chains maintained
- Selective context preservation based on mission progress

## LH-7: Independent Completion Review

Post-execution independent review:

- Separate model instance reviews the completed work
- Cross-checks claims against evidence
- Identifies omissions the agent missed
- Generates independent completion report

## LH-8: Golden Cross-Model Benchmark Suite

Production benchmark suite:

- Django endpoint and tests
- Unity runtime integration
- Unity-Django contract integration
- Multi-file bug fix
- Refactor with compatibility constraints
- Release engineering
- Failing-test recovery
- Cross-host infrastructure task
- 15-30 explicit requirement task
- Instruction-precedence task

## LH-9: Adaptive Long-Horizon Policies

Learning from benchmark results:

- Adaptive budgeting based on task complexity
- Tool selection based on mission phase
- Evidence collection strategies
- Parallel work orchestration