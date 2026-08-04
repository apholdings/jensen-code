---
"@apholdings/jensen-code": patch
---

Durable TODO conflict recovery and progress-aware loop protection

Fixes a production defect where two stale `todo_update` rejections separated by
productive work were misclassified as a consecutive no-progress loop, returning
`REPEATED_TODO_UPDATE_LOOP` and terminating the active run
(`TODO_READ_REQUIRED` was forced on the model, then the run was terminated).

Behavior changes:

- A stale `todo_update` revision is recovered internally and deterministically:
  the engine reads the current state, rebases the non-conflicting intent exactly
  once (bounded, max 1 attempt), and applies it. The model no longer needs to
  issue `todo_read` purely to satisfy an internal concurrency protocol.
- TODO failures are typed and nonfatal (`TODO_REVISION_STALE`,
  `TODO_REBASE_CONFLICT`, `TODO_ITEM_NOT_FOUND`, etc.) with
  `runMustContinue=true`. They never terminate the run and never interrupt
  validation, rollback, cleanup, lease release, or final response.
- Loop detection is progress-aware: any authoritative intervening progress
  (file writes, test results, successful non-TODO tool calls, a newer
  `todo_read` revision) resets the consecutive TODO failure chain. Only genuine
  consecutive no-progress loops (>= 3 identical failure fingerprints with no
  progress) are surfaced, via a typed `TODO_NO_PROGRESS_LOOP` that degrades the
  TODO tool for the turn rather than terminating execution.
- Mutation intents are idempotent via a bounded ledger: exact retries return the
  original result and never double-apply, duplicate-create and duplicate
  transitions are blocked.
- Status transitions are validated against an explicit state machine; terminal
  items (`completed`/`cancelled`) cannot regress through a stale update.
- `todo_write` and `todo_update` retain their existing payload shapes
  (backward compatible). `todo_write` replacement semantics are unchanged and
  are not used as a recovery mechanism for stale `todo_update`.
- Added read-only operability surfaces: `jensen todo status|inspect|verify`
  and `jensen doctor todo`, with `--json` output.
- Added a bounded, sanitized TODO event log (revision/intent correlated) for
  auditability and replay; replay never executes TODO mutations.
