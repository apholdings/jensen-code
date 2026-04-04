# Memory Handling Implementation

## Objective

Add a bounded, real memory model to jensen-code that:
- is actually stored
- survives compaction and session resume
- is injected into the real model-facing context path
- remains coherent with visible todo/plan tracking

## Chosen scope

Session-local structured memory only.

Why this scope:
- jensen-code already has session JSONL persistence through `SessionManager`
- there was no existing standalone memory subsystem
- session-local memory is enough to improve long-running work without inventing a global knowledge base
- it aligns with the existing todo/plan surface and session lifecycle

## State model

Implemented in `packages/coding-agent/src/core/memory.ts`:

```ts
interface MemoryItem {
  key: string;
  value: string;
  timestamp: string;
}
```

Related snapshot state:

```ts
interface TodoSnapshotItem {
  content: string;
  activeForm: string;
  status: "pending" | "in_progress" | "completed";
}
```

Custom session entry types used:
- `session_memory`
- `session_todos`

## Storage path

Memory is stored in the existing session JSONL file via `SessionManager.appendCustomEntry(...)` wrappers:
- `appendSessionMemory(items)`
- `appendSessionTodos(todos)`

Implemented in:
- `packages/coding-agent/src/core/session-manager.ts`

This means memory and todos survive:
- compaction
- resume
- process restart
- branch navigation through the session tree path

## Real model-facing injection path

Memory is injected in the actual context reconstruction path:
1. `SessionManager.buildSessionContext()` reads the latest `session_memory` custom entry on the active branch
2. It constructs a synthetic `memoryContext` message at the start of the returned `messages` list
3. `packages/coding-agent/src/core/messages.ts` converts `memoryContext` into a model-visible user message
4. `packages/agent/src/agent-loop.ts` sends that message through the normal `llmContext.messages` path

This is the real context path, not dead storage.

## Tool surface

Implemented new built-in tool:
- `packages/coding-agent/src/core/tools/memory-write.ts`

Behavior:
- `action: "set"` stores/updates a memory item by key
- `action: "clear"` clears session memory

Registered in:
- `packages/coding-agent/src/core/tools/index.ts`
- `packages/coding-agent/src/core/agent-session.ts`

Also documented in:
- `packages/coding-agent/src/core/tools/tools-prompt-data.ts`

## Todo coherence

The previous visible todo system was in-memory only. This pass also persists todo snapshots to session entries.

Updated path:
- `todo_write` still updates live UI through `todo_update`
- `_setTodos()` now also writes `session_todos` entries via `SessionManager.appendSessionTodos()`
- on session load/switch, `AgentSession` restores todos from `buildSessionContext().todos`

This keeps plan/todo state coherent with compaction and resume.

## Operator-visible behavior

Interactive mode now shows memory state in two places:
1. a compact memory status line in the TUI surface (`memoryStatusContainer`)
2. `/session` now includes a `Working State` section showing:
   - active memory items
   - active todo items

Files:
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`

## Verification

Added targeted test:
- `packages/coding-agent/src/core/session-memory.test.ts`

Verified:
- latest session memory is injected into `buildSessionContext()` messages
- memory keys overwrite cleanly
- invalid memory data is ignored
- formatted memory text is stable

Also verified with:
- `npm run check`

## `/memory` operator workflow

A first-class operator command surface now exists in interactive mode:
- `/memory` or `/memory list` or `/memory show` — list active session memory items
- `/memory get <key>` — show one item in full
- `/memory set <key> <value>` — set/update one memory item
- `/memory clear` — clear all session memory
- `/memory clear <key>` — remove one memory item
- `/memory review` — review freshness heuristics for stored memory
- `/memory history` — show memory snapshot timeline for current branch

Implementation files:
- `packages/coding-agent/src/core/slash-commands.ts`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`

## Freshness review

Freshness is bounded and heuristic.

Implemented in:
- `packages/coding-agent/src/core/memory-review.ts`

Behavior:
- each memory item keeps its recorded ISO timestamp
- `/memory review` computes an age label (`today`, `yesterday`, `N days ago`, `unknown age`)
- items older than `7` days are marked as `review recommended`
- the UX explicitly says freshness is heuristic and the operator should verify before relying on older memory

This follows the reference harness direction from `memdir/memoryAge.ts`: be conservative and avoid overclaiming accuracy.

## Memory history / audit view

Session memory snapshots are persisted as `session_memory` custom entries in the session JSONL file. A bounded history/audit view allows operators to inspect the memory timeline for the current branch.

### Backend implementation

Implemented in:
- `packages/coding-agent/src/core/memory.ts`
- `packages/coding-agent/src/core/session-manager.ts`

```ts
interface MemoryHistorySnapshot {
  entryId: string;
  parentId: string | null;
  recordedAt: string;
  items: MemoryItem[];
  isCurrent: boolean;
}
```

`SessionManager.getMemoryHistory()` walks the current branch and extracts all `session_memory` custom entries:
- Returns snapshots in chronological order (oldest first)
- Marks the latest snapshot on the current branch as `isCurrent: true`
- Only follows the current branch, not sibling branches

Because persistence is snapshot-based (not event-sourced), each snapshot contains the complete memory state at that point, not individual add/update/delete events. This is honest about the underlying model.

### Exposed through AgentSession

`AgentSession.getMemoryHistory()` delegates to `SessionManager.getMemoryHistory()`.

### Textual command: `/memory history`

Shows:
- Branch history header noting snapshot count and oldest-first order
- Each snapshot with relative age label, item count, timestamp
- Item summary (key + preview) for each snapshot
- Current snapshot marked with `[current]`

### Interactive UI: history mode

The memory editor component (`memory-editor.ts`) supports:
- `h` key from list mode opens history view
- History shows snapshots newest-first (current state most relevant)
- Selecting a snapshot and pressing Enter shows full detail view
- Detail view shows all items in that snapshot with timestamps
- Arrow keys navigate between snapshots in detail view
- Escape returns to history list or back to main list

Keybindings:
- `↑↓` — navigate snapshots
- `Enter` — view selected snapshot detail
- `←→` — previous/next snapshot (in detail mode)
- `Escape` — back to history list / back to main list

Important: The UI explicitly labels history as "snapshot timeline · not event log" to avoid overclaiming about the underlying model.

### Tests

Added to `packages/coding-agent/src/core/session-memory.test.ts`:
- returns empty array when no snapshots
- returns single snapshot with isCurrent: true
- returns multiple snapshots in chronological order
- only follows current branch, not sibling branches
- includes entryId and parentId in snapshots

## Interactive memory UI

A dedicated interactive memory editor/review UI now exists on top of the same backend.

Entry behavior:
- `/memory` opens the interactive memory UI
- `/memory show` also opens the interactive memory UI
- explicit textual subcommands still work for direct command usage

Implemented in:
- `packages/coding-agent/src/modes/interactive/components/memory-editor.ts`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`

Capabilities:
- inspect active session memory clearly
- review stale vs fresh items using the existing heuristic system
- add new memory items
- edit existing memory items
- remove one item with explicit confirmation
- clear all with explicit confirmation

The component uses the real backend methods directly:
- `getMemoryItems()`
- `setMemoryItem()`
- `deleteMemoryItem()`
- `clearMemory()`

## Verification additions

Added targeted tests:
- `packages/coding-agent/src/core/session-memory.test.ts`
- `packages/coding-agent/src/core/memory-review.test.ts`
- `packages/coding-agent/src/modes/interactive/components/memory-editor.test.ts`

Verified in this pass:
- `/memory` command is registered in built-in slash commands
- `/memory` no-arg path opens the dedicated UI
- existing textual `/memory` subcommands remain coherent
- memory inspection uses the real session memory state (`session.getMemoryItems()`)
- memory mutation commands use the real persistence path (`setMemoryItem`, `deleteMemoryItem`, `clearMemory`)
- `/memory review` freshness output is derived from actual stored timestamps
- interactive memory UI uses the same real mutation methods and updates visible state immediately
- memory still injects into the real model-facing context path through `buildSessionContext()`
- targeted memory editor tests pass
- `npm run check` passes

## Memory history / audit behavior

A bounded history/audit layer now exists on top of the same session backend.

Backend source:
- `SessionManager.getMemoryHistory()` walks the current branch and collects persisted `session_memory` custom entries
- `AgentSession.getMemoryHistory()` exposes that timeline to interactive mode

Important semantics:
- history is derived from real persisted snapshots in session JSONL
- history follows the current branch only
- each history item represents the complete memory state at that point in time
- this is not a true event log for set/update/delete/clear actions

Operator surfaces:
- `/memory history` textual output
- history mode inside the interactive memory UI

## What was intentionally deferred
- no workspace-global or user-global memory store
- no stale-memory decay or expiry policy beyond bounded review warnings
- no semantic retrieval or embeddings
- no dedicated external-editor/file-backed memory editing flow
- no event-sourced memory audit stream; current history remains snapshot-based

## Memory snapshot diff

A bounded diff view compares adjacent real persisted snapshots without redesigning the backend.

### Shared computation path

`packages/coding-agent/src/core/memory-diff.ts` exposes a single pure function:

```ts
computeMemorySnapshotDiff(
  previous: MemoryHistorySnapshot | undefined,
  current: MemoryHistorySnapshot,
): MemorySnapshotDiff
```

Output:
- `added`: keys only in current
- `removed`: keys only in previous
- `changed`: keys in both with different value strings
- `isInitialSnapshot`: true when previous was undefined

The diff is derived from adjacent real persisted snapshots and is NOT a true operation log. It cannot attribute changes to specific add/update/delete/clear operations.

### Operator surfaces

**Textual:** `/memory diff` (also accepts `/memory history diff`)
- compares current snapshot vs previous snapshot on the current branch (adjacent default)
- `/memory diff <baselineId> <targetId>` — explicit compare using real snapshot IDs
- shows "Initial snapshot" honestly when no previous exists
- sections: Added, Removed, Changed — only rendered when non-empty
- explicitly labeled "(snapshot comparison · not an event log)"

**Interactive UI:** from history detail mode, press `d`
- opens `history_diff` mode comparing the selected snapshot against its immediate predecessor
- both snapshots are identified by relative age and timestamp
- sections: + Added (green), - Removed (red), ~ Changed (old→new preview)
- `↑↓` navigates to different target snapshots (base remains fixed)
- `Escape` returns to history detail

Both surfaces use the same shared `computeMemorySnapshotDiff()` — one computation path for text and UI.

### Baseline Picker — Two-Step Compare Chooser (Pass 7)

UI-assisted two-step compare chooser: arm any snapshot as baseline, explicitly pick a target, then open diff. No persistence redesign, adjacent diff preserved as quick default.

**State:** `armedBaselineIndex: number | null` — purely UI state, no persistence change. `compareStep: "none" | "target_picking"` — tracks explicit target-picking step.

**Keybindings:**

| Mode | Key | Action |
|------|-----|--------|
| baseline armed | `d` | Enter target-picking step |
| target_picking | `↑↓` | Select target |
| target_picking | `Enter` / `d` | Confirm target → open diff |
| target_picking | `c` | Clear baseline + exit picking |
| target_picking | `Escape` | Exit picking, keep baseline |
| no baseline | `d` | Adjacent diff immediately (quick default) |

**UI markers:** `[baseline]` in history list/detail; `[baseline: <age>]` + `[selecting target: <age>]` in target-picking; `[target]` on selected line; `Baseline:` label in diff header when explicit.

**Honest framing:** baseline selection is UI state over the existing snapshot backend; "(same snapshot)" annotation when comparing a snapshot to itself; this remains snapshot-based, not event provenance.

See `docs/MEMORY_COMPARE_IMPLEMENTATION.md` for full evidence.

### Explicit Snapshot-ID Compare (Pass 8)

Direct snapshot-ID comparison for the textual `/memory diff` command using `entryId` values from `getMemoryHistory()`.

**Syntax:** `/memory diff <baselineId> <targetId>`

**ID discovery:** `/memory history` shows short IDs (first 8 chars) in brackets after each snapshot, with a usage hint explaining accepted forms:
```
Use /memory diff <baselineId> <targetId> to compare any two snapshots.
IDs shown in brackets ([xxxxxxxx]) can be copied directly; brackets are optional.
Accepted: full entryId, 8-char short ID, or strict unique prefix.
```

**Strict resolution:** `SessionManager.resolveMemorySnapshotSelector(input)` and `AgentSession.resolveMemorySnapshotSelector(input)` resolve selectors with strict unique-prefix semantics:
- Resolution order: exact full ID, exact short ID (8 chars), strict unique prefix
- Supports optional brackets: `[abcd1234]` copied from history output
- Ambiguous prefixes are rejected with matching candidates listed
- No fuzzy matching, no hidden lookup rules

**Behavior:**

| Input | Outcome |
|-------|---------|
| `/memory diff` | Adjacent diff: current vs previous (unchanged default) |
| `/memory diff <id1> <id2>` | Explicit compare using those two snapshots |
| Ambiguous prefix | Clear error listing matching candidate IDs |
| Invalid or missing ID | Clear error listing which selector failed |
| Same ID for both | "Baseline and target are the same snapshot — no changes to show." |

This is direct snapshot-ID comparison over current-branch persisted snapshots, not a provenance log. Prefix matching is strict unique-prefix only.

See `docs/MEMORY_DIFF_IMPLEMENTATION.md` for full evidence.

### Files changed

| File | Change |
|------|--------|
| `packages/coding-agent/src/core/memory-diff.ts` | NEW — shared pure diff function and types |
| `packages/coding-agent/src/core/session-manager.ts` | Added `findMemorySnapshotById()` method; Added `resolveMemorySnapshotSelector()` with strict resolution and `MemorySnapshotResolution` type |
| `packages/coding-agent/src/core/agent-session.ts` | Added `findMemorySnapshotById()` accessor; Added `resolveMemorySnapshotSelector()` accessor |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | Added `/memory diff` command; history shows usage hint and short IDs; diff uses strict resolver with full-ID output |
| `packages/coding-agent/src/modes/interactive/components/memory-editor.ts` | Added `history_diff` mode |
| `packages/coding-agent/src/core/session-memory.test.ts` | 7 targeted diff tests; 9 new `resolveMemorySnapshotSelector` tests |

### Pass 9: Bounded Copy-Friendly Ergonomics

Bounded ergonomic improvements for the text-based `/memory diff` workflow: copy-friendly bracket notation, strict deterministic resolution, clear error messaging, improved history output guidance, and deterministic test coverage.

#### Resolution semantics
`SessionManager.resolveMemorySnapshotSelector(input)` and `AgentSession.resolveMemorySnapshotSelector(input)` use bracket-tolerant, strict semantics:
- Exact full entryId match (always wins)
- Exact short-ID match (first 8 chars of an entryId)
- Strict unique prefix match — prefix must resolve to exactly one snapshot
- Supports optional surrounding brackets: `[abcd1234]` copied from `/memory history` output
- Empty input → `error: "empty"`
- No match → `error: "not_found"` with empty candidates
- Ambiguous prefix → `error: "ambiguous"` with all matching candidate IDs listed

No fuzzy matching. No hidden lookup rules. Resolution is strictly deterministic.

#### /memory history output guidance
`/memory history` shows each snapshot's short ID (first 8 chars) in brackets with a usage hint:
```
Use /memory diff <baselineId> <targetId> to compare any two snapshots.
IDs shown in brackets ([xxxxxxxx]) can be copied directly; brackets are optional.
Accepted: full entryId, 8-char short ID, or strict unique prefix.
```

Short IDs are shown as `[xxxxxxxx]` after each age label. Brackets are optional on input.

#### /memory diff command path
`handleMemoryCommand()` uses the shared resolution helper for explicit ID compare:
- Resolves both baseline and target selectors via `resolveMemorySnapshotSelector()`
- Reports FULL resolved IDs in output header (full `entryId` shown, not just short form)
- Reports ambiguity clearly with candidate list
- Reports no-match clearly with failed selector name
- Reports same-snapshot honestly without implying a diff was computed
- Adjacent diff (no IDs provided) unchanged

#### Syntax fixes applied
Fixed escaped backtick template literal issue in `interactive-mode.ts`:
- Lines 739 and 754 used `\`[\${cand.slice(0, 8)}]\`` which confused the Biome parser (invalid `\]` escape sequence in template literal)
- Replaced with string concatenation: `"  " + theme.fg("muted", \`[\${cand.slice(0, 8)}]\`) + " " + cand`
- Verified: `npm run check` passes cleanly

#### Tests added
33 total tests for the resolution helper in `session-memory.test.ts`:

| Test | Coverage |
|------|----------|
| exact full entryId | Exact full ID resolution |
| exact short ID (first 8 chars) | Short ID resolution |
| bracketed short ID | Bracket-stripping from history output |
| bracketed full ID | Bracket-stripping for full IDs |
| strict unique prefix match | Unique prefix resolution |
| ambiguous prefix with controlled IDs (deterministic) | New: controlled IDs with shared prefix reliably trigger ambiguity rejection |
| ambiguous prefix (probabilistic) | Ambiguous rejection with candidates listed |
| not_found for nonexistent ID | Not-found error |
| empty selector | Empty input rejection |
| same-snapshot comparison | Honest same-snapshot resolution |
| empty candidates when unambiguous | Candidates array correctness |

#### Type fix
Fixed `InstanceType<typeof SessionManager>` TypeScript error in test helper — `SessionManager` is already an instance type; the `InstanceType` wrapper fails because the constructor is not abstract. Changed to `SessionManager` directly.

#### Files changed (Pass 9)

| File | Change |
|------|--------|
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | Fixed escaped backtick template literal syntax in error candidate lines (lines 739, 754) |
| `packages/coding-agent/src/core/session-memory.test.ts` | Added deterministic ambiguous-prefix test with controlled IDs; fixed `makeSnapshots` type annotation |
| `docs/REFERENCE_HARNESS_AUDIT_AGENT_HARNESS_PRO.md` | Added pass 9 |
| `docs/JENSEN_CODE_ADOPTION_PLAN_AGENT_HARNESS_PRO.md` | Added pass 9 |
| `docs/MEMORY_HANDLING_IMPLEMENTATION.md` | Added pass 9 |
| `docs/MEMORY_HISTORY_IMPLEMENTATION.md` | Added pass 9 |
| `docs/MEMORY_DIFF_IMPLEMENTATION.md` | Added pass 9 |
| `docs/MEMORY_COMPARE_IMPLEMENTATION.md` | Added pass 9 |

## Pass 10: Dedicated snapshot selector resolver

A dedicated pure helper now owns selector normalization and deterministic snapshot resolution:
- `packages/coding-agent/src/core/snapshot-selector-resolver.ts`
- dedicated tests: `packages/coding-agent/src/core/snapshot-selector-resolver.test.ts`

`SessionManager.resolveMemorySnapshotSelector()` no longer embeds the contract inline. It now delegates to the helper while preserving current-branch-only semantics by passing `getMemoryHistory()` snapshots from the active branch.

### Contract
- trim whitespace
- strip one surrounding bracket pair copied from `/memory history`
- treat `[]` as empty input
- resolve in this order: exact full `entryId` → exact displayed short ID (8 chars) → strict unique prefix
- reject ambiguous prefixes with candidate full IDs
- reject missing selectors with explicit `not_found`
- return the full resolved ID on success for compare/debug output

### Why this remains honest
- selector resolution is still derived from real persisted `session_memory` snapshots
- current-branch-only behavior still comes from `getMemoryHistory()`
- model-facing memory injection path is unchanged; this pass only isolates the compare-selector contract

## Pass 11: Shared selector-resolution formatter

A dedicated shared formatter now owns operator-facing selector messaging while leaving resolution logic in the resolver module.

### Files
- `packages/coding-agent/src/core/snapshot-selector-formatter.ts`
- `packages/coding-agent/src/core/snapshot-selector-formatter.test.ts`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`

### Contract
- `formatSnapshotSelectorHistoryGuidance()` centralizes the copy/paste help shown with `/memory history`
- `formatSnapshotSelectorResolutionFailure()` centralizes the empty/not_found/ambiguous error block for explicit selector-based compare
- `formatResolvedSnapshotId()` centralizes `[shortId] full-entryId` display for successful explicit compare output
- `formatExplicitDiffHeader()` and `formatAdjacentDiffHeader()` centralize the compare header text for explicit and adjacent diff flows

### Boundary with the resolver
- `snapshot-selector-resolver.ts` still owns normalization and deterministic resolution
- `snapshot-selector-formatter.ts` only turns resolver outputs into stable operator-facing text
- `interactive-mode.ts` now consumes the formatter instead of assembling selector text inline

### What did NOT change
- no backend/storage changes
- no model-context injection changes
- no fuzzy matching or provenance claims

## Pass 12: Print-mode non-UI compare reuse

A real non-UI text surface now reuses the shared compare contract: `packages/coding-agent/src/modes/print-mode.ts`.

### Chosen surface
Print mode was selected over RPC for this bounded pass because it is already a plain-text output surface, so it can reuse the shared selector/history/header wording without introducing a new protocol shape.

### Shared output layer
Added `packages/coding-agent/src/core/memory-compare-output.ts`:
- `formatMemoryHistoryOutput()` — plain-text history output for non-UI surfaces
- `formatMemoryDiffOutput()` — plain-text adjacent/explicit compare output for non-UI surfaces
- `formatRelativeAgeLabel()` — shared relative-age text for the new non-UI surface

This output layer builds on the existing formatter contract rather than duplicating selector/header wording:
- `formatSnapshotSelectorHistoryGuidance()`
- `formatSnapshotSelectorResolutionFailure()`
- `formatExplicitDiffHeader()`
- `formatAdjacentDiffHeader()`

### Print-mode behavior
In text print mode, these inputs are now handled locally:
- `/memory history`
- `/memory diff`
- `/memory diff <baselineId> <targetId>`

The compare still resolves snapshots through the real current-branch session backend via `resolveMemorySnapshotSelector()`. No new storage or provenance layer was introduced.

### Verification added
- `packages/coding-agent/src/core/memory-compare-output.test.ts`
- `packages/coding-agent/src/modes/print-mode.test.ts`

Verified:
- non-UI history output reuses shared selector guidance
- non-UI explicit compare output reuses shared failure/header wording
- same-snapshot compare remains honest
- adjacent default remains snapshot-based, not event-log framed

### Deferred
- RPC compare surface
- JSON-mode compare protocol
- reusing `memory-compare-output.ts` inside interactive mode itself

## Pass 13: Structured RPC memory snapshot surface

A bounded programmatic surface now exists alongside the interactive and print-mode compare paths.

### Why structured RPC instead of plain-text RPC
Repo evidence showed RPC already operates as a typed JSON protocol:
- `packages/coding-agent/src/modes/rpc/rpc-types.ts`
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
- `packages/coding-agent/src/modes/rpc/rpc-client.ts`

So the bounded follow-up was a structured wrapper, not a plain-text RPC reuse layer. Print mode remains the plain-text non-UI surface through `packages/coding-agent/src/core/memory-compare-output.ts`.

### Files
- `packages/coding-agent/src/modes/rpc/rpc-types.ts`
- `packages/coding-agent/src/modes/rpc/rpc-memory.ts`
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
- `packages/coding-agent/src/modes/rpc/rpc-client.ts`
- `packages/coding-agent/src/modes/rpc/rpc-memory-snapshot.test.ts`

### Reuse path
- persisted backend unchanged: `session_memory` snapshots in session JSONL
- history source unchanged: `SessionManager.getMemoryHistory()`
- selector contract unchanged: `resolveMemorySnapshotSelector()` delegates to `snapshot-selector-resolver.ts`
- diff computation unchanged: `computeMemorySnapshotDiff()`
- text-only wording still lives in `snapshot-selector-formatter.ts` + `memory-compare-output.ts`
- RPC adds a thin adjacent structured helper: `rpc-memory.ts`

### Structured RPC contract
`get_memory_history`
- returns `branchScope: "current"`
- returns `historyModel: "snapshot"`
- returns current-branch snapshots with `shortId`, `itemCount`, and full items

`compare_memory_snapshots`
- no selectors → adjacent latest-vs-previous comparison
- both selectors → explicit compare using the existing full-id / short-id / strict-unique-prefix resolver contract
- structured selector failures: `empty`, `not_found`, `ambiguous`
- explicit success returns matched-input + resolved-id metadata
- same-snapshot explicit compare returns `sameSnapshot: true` with an empty diff
- single-snapshot adjacent compare returns `status: "initial_snapshot"`

### Honest relation to storage + model context
This does not change storage or context injection:
- memory still persists through `SessionManager.appendSessionMemory()`
- memory history/compare still derives from persisted snapshots on the active branch only
- model-facing memory injection still happens through `buildSessionContext()` and `memoryContext`

### Deferred
- no backend/schema rewrite
- no event-sourced provenance
- no JSON-mode `/memory` command protocol
- no broad RPC redesign

## Pass 14: SDK-facing structured memory snapshot consumer

A same-process automation surface now reuses the exact structured snapshot contract without RPC subprocess glue.

### Files
- `packages/coding-agent/src/core/memory-snapshot-contract.ts`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/agent-session-memory-snapshot.test.ts`
- `packages/coding-agent/src/modes/rpc/rpc-memory.ts`
- `packages/coding-agent/src/modes/rpc/rpc-types.ts`
- `packages/coding-agent/docs/sdk.md`
- `packages/coding-agent/docs/rpc.md`

### Chosen consumer
`AgentSession` now exposes:
- `getStructuredMemoryHistory()`
- `compareMemorySnapshots(options?)`

### Reuse path
- shared types + builders now live in `src/core/memory-snapshot-contract.ts`
- `AgentSession` calls `buildStructuredMemoryHistoryData(this)` and `buildStructuredMemoryCompareData(this, selectors?)`
- RPC keeps its existing command surface, but `src/modes/rpc/rpc-memory.ts` now re-exports those same shared builders instead of owning a parallel implementation
- selector resolution still comes from `resolveMemorySnapshotSelector()`
- diff computation still comes from `computeMemorySnapshotDiff()`

### Honest storage/model relation
- storage is still persisted `session_memory` snapshots inside the session JSONL
- history/compare remain current-branch-only and snapshot-based
- model-facing memory injection is unchanged and still happens through `buildSessionContext()` and `memoryContext`
- this pass adds no new persistence, provenance, or event-log semantics

### Verification
- targeted SDK consumer tests prove `AgentSession` returns the same shared structured payloads
- existing RPC tests still cover empty-history, initial-snapshot, explicit compare, same-snapshot honesty, selector failures, current-branch-only behavior, and JSON-serializability
- `npm run check` remains the repo-wide guardrail

## Pass 15: Canonical SDK memory snapshot example

A small same-process example now makes the SDK path discoverable without requiring callers to infer it from RPC docs.

### Files
- `packages/coding-agent/examples/sdk/12-memory-snapshots.ts`
- `packages/coding-agent/docs/sdk.md`
- `packages/coding-agent/src/core/agent-session-memory-snapshot.test.ts`

### Chosen deliverable
A canonical example file, not a new helper abstraction.

Why this was chosen:
- `AgentSession` already exposes the right API
- the shared contract already exists
- the smallest caller-value improvement is a runnable example that demonstrates real status handling

### What the example does
- creates an in-memory `AgentSession`
- seeds real `session_memory` snapshots through `session.setMemoryItem(...)`
- reads structured history with `getStructuredMemoryHistory()`
- compares latest vs previous with `compareMemorySnapshots()`
- compares explicit selectors using the same short-ID/full-ID contract as other surfaces
- demonstrates `empty_history`, `initial_snapshot`, `ok`, and `selector_resolution_failed`
- explicitly frames the backend as snapshot-based, not event-sourced

### Reuse path
The example does not define new payloads or selector logic. It consumes:
- `AgentSession.getStructuredMemoryHistory()`
- `AgentSession.compareMemorySnapshots()`
which still delegate to the shared `memory-snapshot-contract.ts` builder layer.

## Pass 16: Working-context integration

Memory is now one leg of a bounded integrated operator-visible working-context surface.

### Relation to plan and delegated work
- memory remains the persisted `session_memory` snapshot-backed state
- todo/plan remains the persisted `session_todos` snapshot-backed state
- delegated work is separate live current-process state derived from real `subagent` tool lifecycle events
- the new interactive working-context panel and expanded `/session` output present those three together without claiming they share the same provenance model

### Files
- `packages/coding-agent/src/core/delegated-work.ts`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/modes/interactive/components/working-context-panel.ts`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- `docs/WORKING_CONTEXT_INTEGRATION_IMPLEMENTATION.md`

### Honest boundary
This pass does **not** persist delegated work into `session_memory` and does **not** claim delegated work history across resume. Memory persistence, restore, compaction preservation, and model-context injection remain unchanged and real.

## Pass 17: Non-interactive working-context reuse

Memory is now also exposed through a bounded structured current-state RPC surface via the shared builder in:
- `packages/coding-agent/src/core/working-context.ts`

In that payload:
- memory remains persisted current-branch session state
- memory is summarized, not exposed as a history/event stream
- the working-context payload explicitly distinguishes memory's persisted scope from delegated work's live current-process-only scope

This pass did **not** change:
- `session_memory` storage
- snapshot history/compare semantics
- model-facing memory injection
- compaction preservation behavior

## Pass 18: SDK-facing working-context surface

Memory is now also exposed through `AgentSession.getWorkingContext()` as a bounded same-process SDK method.

### Reuse path
- `AgentSession.getWorkingContext()` delegates to `buildWorkingContext()` from `working-context.ts`
- memory is surfaced through the existing `getMemoryItems()` accessor
- the method returns the same current-state payload used by RPC and interactive mode

### Files
- `packages/coding-agent/src/core/agent-session.ts` — Added `getWorkingContext()` method
- `packages/coding-agent/src/core/agent-session-working-context.test.ts` — NEW targeted SDK tests
- `packages/coding-agent/examples/sdk/13-working-context.ts` — NEW canonical SDK example
- `packages/coding-agent/docs/sdk.md` — Added Working Context SDK Surface section

### What did NOT change
- no new persistence layer
- no memory/todo storage changes
- no delegated-work persistence

## Pass 19: Bounded working-context consolidation

Memory is now consumed through the consolidated `AgentSession.getWorkingContext()` path in both interactive mode and RPC mode.

### Consolidation path
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — `updateWorkingContextPanel()` and `handleSessionCommand()` now delegate to `session.getWorkingContext()`
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts` — `get_working_context` handler now delegates to `session.getWorkingContext()`
- `packages/coding-agent/src/core/working-context.ts` contract unchanged

### Files
| File | Change |
|------|--------|
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | Removed direct `buildWorkingContext` composition; now uses `session.getWorkingContext()` |
| `packages/coding-agent/src/modes/rpc/rpc-mode.ts` | Removed direct `buildWorkingContext` composition; now uses `session.getWorkingContext()` |
| `packages/coding-agent/src/core/agent-session-working-context.test.ts` | Added consolidation proof test |

### What did NOT change
- memory storage unchanged (`session_memory` in session JSONL)
- memory snapshot history/compare semantics unchanged
- model-facing memory injection unchanged
