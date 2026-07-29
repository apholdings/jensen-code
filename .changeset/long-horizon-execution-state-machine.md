---
"@apholdings/jensen-code": patch
---

Add Mission Execution State Machine v1 (LH-2)

- Deterministic, replayable state machine governing Mission Contract execution lifecycle
- States: PLANNING, EXECUTION, VERIFICATION, COMPLETION_REVIEW, BLOCKED, COMPLETED, FAILED, CANCELLED
- Completion path enforced: EXECUTION → VERIFICATION → COMPLETION_REVIEW → COMPLETED
- Direct EXECUTION → COMPLETED is structurally impossible
- BLOCK/RESUME preserves exact prior resumable state with snapshot/restore
- Append-only transition history with full replay validation and tamper detection
- Trusted completion: APPROVE_COMPLETION requires genuine contract-bound TrustedValidationContext with execution:complete capability
- Generic CLI rejects APPROVE_COMPLETION atomically without mutation
- Provider-isolated CLI routes: execution init/inspect/validate/transition
- Stale revision rejection, duplicate transition ID rejection, input immutability
- 30 ESM scenarios tracked and green across unit, replay, adversarial, and real child-process CLI tests
- No scheduler, watchdog, checkpointing, automatic continuation, or full completion gate (LH-3+)