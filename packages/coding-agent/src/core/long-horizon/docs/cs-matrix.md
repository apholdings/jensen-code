# Continuation Scheduler State Transition Matrix

## Scheduler States

| State | Description |
|-------|-------------|
| IDLE | No active continuation cycle. Ready to accept SCHEDULE. |
| SCHEDULED | A continuation has been scheduled. Awaiting DISPATCH. |
| DISPATCHED | A continuation has been dispatched. Awaiting CONSUME. |

## Events

| Kind | From State | To State | Revision Delta |
|------|-----------|----------|----------------|
| SCHEDULE | IDLE | SCHEDULED | +1 |
| DISPATCH | SCHEDULED | DISPATCHED | +1 |
| CONSUME | DISPATCHED | IDLE | +1 |
| CANCEL | SCHEDULED or DISPATCHED | IDLE | +1 |
| ABANDON | SCHEDULED or DISPATCHED | IDLE | +1 |

## Full Cycle

```
IDLE@0
  --SCHEDULE-->
SCHEDULED@1
  --DISPATCH-->
DISPATCHED@2
  --CONSUME-->
IDLE@3
```

A second cycle begins from scheduler revision 3.

## Cycle Identity

- `SCHEDULE`: `cycleId === eventId` (the schedule event IS the cycle anchor)
- `DISPATCH`, `CONSUME`, `CANCEL`, `ABANDON`: `request.cycleId === the eventId of the SCHEDULE event that opened the active cycle`

## Revision Guards

### requestSchedulerRevision
- Included in the event digest
- Included in every idempotency fingerprint
- Exact retry compares against the persisted original request revision

### observedExecutionRevision
- Included in every event and digest
- Not part of the caller fingerprint
- Must be nondecreasing
- Must never exceed the supplied current execution revision

### Per-Operation Rules

| Operation | observedExecutionRevision Rule |
|-----------|-------------------------------|
| SCHEDULE | `observedExecutionRevision == expectedExecutionRevision` |
| DISPATCH | `observedExecutionRevision == active expectedExecutionRevision` |
| CONSUME | `observedExecutionRevision == active expectedExecutionRevision` |
| CANCEL | `observedExecutionRevision >= active expectedExecutionRevision` |
| ABANDON | `observedExecutionRevision > active expectedExecutionRevision` |

## Missing Scheduler Behavior

| Operation | Behavior |
|-----------|----------|
| continuation init | Creates IDLE revision 0 |
| schedule (rev 0) | Allowed: construct IDLE in memory, persist directly as SCHEDULED revision 1 |
| schedule (rev > 0) | ENOENT |
| inspect | ENOENT |
| validate | ENOENT |
| dispatch | ENOENT |
| consume | ENOENT |
| cancel | ENOENT |
| abandon | ENOENT |

## Error Codes

| Code | Condition |
|------|-----------|
| IDEMPOTENCY_CONFLICT | Reusing eventId with different fingerprint |
| STALE_SCHEDULER_REVISION | expectedSchedulerRevision != actual schedulerRevision |
| INVALID_STATE | Scheduler not in required state for operation |
| INVALID_CYCLE | cycleId does not match active SCHEDULE event |
| CYCLE_NOT_SUPERSEDED | ABANDON when executionRevision == expectedExecutionRevision |
| EXECUTION_REVISION_MISMATCH | executionRevision < expectedExecutionRevision |
| INVALID_REQUEST | Malformed request (missing fields, invalid types) |
| CONTRACT_DIGEST_MISMATCH | Scheduler contractDigest != supplied contract digest |
| ENOENT | Scheduler file not found |
| INVALID_SCHEDULER_RECORD | Structural corruption of scheduler record |

## Event Digest

- Excludes `createdAt` and `eventDigest`
- Includes all required fields explicitly
- Includes conditional fields (`expectedExecutionRevision`, `dispatchedContinuationId`, `resultDigest`) only when present
- `previousEventDigest` is `null` for the first event, never an empty string
- Format: `sha256:<64 lowercase hexadecimal characters>`

## History Digest

- SHA-256 of concatenation of all event digest strings (with `sha256:` prefixes)
- `null` when events array is empty

## Idempotency

- Exact retries (same eventId, same fingerprint) return the persisted original event unchanged
- Retries after terminal state return the existing event unchanged
- Different fingerprint with same eventId → IDEMPOTENCY_CONFLICT

## Validation Order (Mutations)

1. Structural integrity
2. Contract binding
3. Execution binding
4. Request syntax
5. eventId lookup and idempotency handling
6. Fresh-state and fresh-revision guards
7. Mutation
8. Atomic persistence

Event lookup occurs before fresh guards, including terminal or current-state guards.

## Threat Model

The unkeyed event hash chain and semantic replay protect against:
- Accidental mutation
- Partial rewriting
- Internally inconsistent rewriting
- Broken ordering
- Broken replay

They do NOT protect against:
- A privileged writer capable of rewriting the complete record and all digests consistently