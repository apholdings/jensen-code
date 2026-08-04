# Durable TODO coordination and conflict recovery

The TODO subsystem is a coordination and progress-reporting facility. It is
**not** execution authority. This document describes the canonical model,
authority boundaries, and the corrected stale-revision recovery, idempotency,
and progress-aware loop protection behavior.

## Authority hierarchy

```text
user authorization
> deterministic policy
> durable long-horizon execution state
> transaction and recovery state
> validation and cleanup obligations
> TODO coordination state
> model prose
```

A stale TODO revision must never:

- terminate an otherwise healthy run;
- prevent validation, rollback, cleanup, lease release, or final synthesis;
- invalidate completed implementation work;
- alter transaction authority, acceptance criteria, or policy.

## State and revision model

- TODO state is durable but **advisory**.
- The revision is **monotonically increasing** on every applied mutation.
- Mutations use **optimistic concurrency** (`expectedRevision`).
- A canonical state hash is derived deterministically (order-independent
  `SHA-256` over the item set). Same items in any order hash identically.

## Typed mutation intents and errors

Every `todo_update` is treated as a patch intent. Failures are typed and
nonfatal:

| Code | Means |
| --- | --- |
| `TODO_REVISION_STALE` | base revision is behind current |
| `TODO_REBASE_CONFLICT` | intent conflicts with a concurrent change |
| `TODO_ITEM_NOT_FOUND` | target item no longer exists |
| `TODO_ITEM_VERSION_CONFLICT` | the same field was edited concurrently |
| `TODO_INVALID_STATUS_TRANSITION` | status transition not allowed |
| `TODO_ALREADY_APPLIED` | exact retry of an applied intent |
| `TODO_DUPLICATE_INTENT` / `TODO_SCOPE_MISMATCH` / `TODO_STATE_CORRUPT` | integrity guards |
| `TODO_NO_PROGRESS_LOOP` / `TODO_TOOL_TEMPORARILY_DEGRADED` | degradation, never termination |

`TODO_REVISION_STALE` is always `recoverable=true, runMustContinue=true`.
A TODO error is never a run-terminal instruction.

## Automatic stale-revision recovery

When `todo_update` arrives with a stale `expectedRevision`:

```text
receive intent
-> compare base revision to current
-> detect stale revision
-> internally read current state (no model turn consumed)
-> deterministically rebase the intent
-> apply if conflict-free
-> return success with rebase metadata
```

The internal read does not consume a model turn and does not require tool
availability for the rest of the turn. It is **bounded** to 1 attempt; a second
concurrent change during the rebase returns `TODO_REBASE_CONFLICT`, which is
nonfatal. There is no unbounded compare-and-swap loop.

## Rebase semantics

Rebase is deterministic and operation-aware. Using the retained base snapshot
when available, it distinguishes:

- **Conflict-free** (auto-rebase): intent updates an unrelated item; a new item
  was created concurrently; a repeated status is already applied; an
  `activeForm`/`content` change on an item no concurrent writer touched.
- **Conflict** (typed, nonfatal): the same content was edited differently; the
  item was removed concurrently; a terminal item was reopened; an exclusive
  active-item rule would be violated; a stale `replace_all` would erase
  concurrent changes.

Concurrent changes are never silently discarded. An old `replace_all` payload
can never erase newer TODO items.

## Status transitions

```text
pending -> in_progress | completed | cancelled | blocked
in_progress -> pending | completed | blocked | cancelled
blocked -> pending | in_progress | cancelled
completed -> (terminal)
cancelled -> (terminal)
```

Repeating the current status is idempotent. Named sets and transitions are
enforced on apply. `completedAt` is set only on completion.

## Idempotency

A bounded ledger records applied intents by idempotency key (scope + intent
hash + base revision):

- exact retry returns the original success;
- retry after response loss returns the original success;
- retries after restart remain idempotent within retention;
- duplicate create / duplicate transition are blocked;
- the same key with a different payload fails closed.

## Progress-aware loop detection

Loop detection distinguishes a genuine no-progress loop from incidents
separated by real progress.

Authoritative progress (resets the chain):

- successful workspace write / edit / read yielding new evidence;
- test result, command result, retrieval evidence;
- transaction state transition, completed subagent, phase change;
- `todo_read` returning a **newer** revision;
- a successful `todo_update`.

Not progress:

- model prose;
- an identical repeated read;
- an identical failed tool call; the same TODO snapshot.

A `TODO_NO_PROGRESS_LOOP` is only classified when all hold: same effective
failure fingerprint, same/equivalent intent, no authoritative progress between
attempts, no TODO state change, threshold exceeded (3 by default), and
automatic recovery already attempted. A surfaced loop degrades the TODO tool
for the turn; it never terminates the run.

## Tool Storm integration

- Internal read/rebase is not counted as a model tool storm.
- A successful rebase resets the chain; productive non-TODO work resets it.
- Identical model-requested TODO calls without progress can still be blocked.
- TODO-specific failures do not terminate the run directly; generic storm
  protection remains operational.

## Nonfatal degradation

If TODO recovery cannot complete, the subsystem degrades
(`TODO_TOOL_TEMPORARILY_DEGRADED`) without terminating execution: it may
return the current snapshot or a concise conflict summary, disable TODO
mutations for the remainder of the turn, and permit a later turn to retry.
At finalization Jensen may report "Work completed, but TODO display state could
not be synchronized." This is a warning, not a failed run, unless TODO state
was an explicit user deliverable.

## Subagent scope isolation

Each agent session owns its own TODO store and revision. Subagents run in
isolated child scopes; they cannot increment the parent revision implicitly and
cannot mutate the parent scope. Parents may project child terminal results into
their own TODO state with explicit operations. Concurrent investigators have
separate scopes.

## Operability

- `jensen todo status|inspect|verify` and `jensen doctor todo` are read-only
  diagnostics with `--json` output.
- A bounded, sanitized event log (`TODO_REVISION_STALE_DETECTED`,
  `TODO_REBASE_SUCCEEDED`, `TODO_MUTATION_COMMITTED`, etc.) is correlated with
  revision, run, turn, and intent. Replay reconstructs events but never
  executes TODO mutations.

## Troubleshooting

- **"TODO_REBASE_CONFLICT"**: the base revision was stale and the intent
  conflicted with a concurrent change. This is nonfatal; the run continues and
  no update is applied. Call `todo_read` if you want to retry.
- **"TODO_NO_PROGRESS_LOOP"**: three identical TODO failures with no
  intervening progress. The TODO tool is degraded for the turn; execution is
  not terminated.
- **"Work completed, but TODO display state could not be synchronized"**: a
  warning only; the work is valid and the run succeeded.
