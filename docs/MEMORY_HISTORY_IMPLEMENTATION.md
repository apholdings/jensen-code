# Memory History Implementation

## Objective

Add a bounded session-memory history/audit view that shows the real memory snapshot timeline from persisted session entries, without redesigning memory persistence or adding fake history.

## Approach

Use the existing session-local persisted backend (`session_memory` custom entries in session JSONL files). Each time memory is updated, a new snapshot is appended to the session. The history view derives from these persisted snapshots.

**Honest about the model**: Current persistence is snapshot-based, not event-sourced. Each snapshot contains the complete memory state at that point, not individual add/update/delete events. The UI explicitly labels this as "snapshot timeline · not event log".

## Files Changed

| File | Type | Change |
|------|------|--------|
| `packages/coding-agent/src/core/memory.ts` | MOD | Added `MemoryHistorySnapshot` interface |
| `packages/coding-agent/src/core/session-manager.ts` | MOD | Added `getMemoryHistory()` method |
| `packages/coding-agent/src/core/agent-session.ts` | MOD | Added `getMemoryHistory()` accessor delegating to SessionManager |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | MOD | Added `/memory history` textual command |
| `packages/coding-agent/src/modes/interactive/components/memory-editor.ts` | MOD | Added `history` and `history_detail` modes, key `h` handler |
| `packages/coding-agent/src/core/session-memory.test.ts` | MOD | Added targeted tests for `getMemoryHistory()` |
| `docs/MEMORY_HANDLING_IMPLEMENTATION.md` | MOD | Added history section |
| `docs/MEMORY_UI_IMPLEMENTATION.md` | MOD | Added history UI section |
| `docs/MEMORY_HISTORY_IMPLEMENTATION.md` | NEW | This file |

## Implementation Details

### Step 1 — Backend: MemoryHistorySnapshot type

Added to `packages/coding-agent/src/core/memory.ts`:

```ts
export interface MemoryHistorySnapshot {
  entryId: string;
  parentId: string | null;
  recordedAt: string;
  items: MemoryItem[];
  isCurrent: boolean;
}
```

### Step 2 — SessionManager.getMemoryHistory()

Added to `packages/coding-agent/src/core/session-manager.ts`:

```ts
getMemoryHistory(): MemoryHistorySnapshot[] {
  const branch = this.getBranch();
  const snapshots: Array<{...}> = [];

  for (const entry of branch) {
    if (entry.type === "custom" && entry.customType === SESSION_MEMORY_CUSTOM_TYPE) {
      snapshots.push({
        entryId: entry.id,
        parentId: entry.parentId,
        timestamp: entry.timestamp,
        items: parseMemoryItems(entry.data),
      });
    }
  }

  // Mark last snapshot as current
  if (snapshots.length > 0) {
    snapshots[snapshots.length - 1]!.isCurrent = true;
  }

  return snapshots.map((s, idx) => ({
    entryId: s.entryId,
    parentId: s.parentId,
    recordedAt: s.timestamp,
    items: s.items,
    isCurrent: idx === snapshots.length - 1,
  }));
}
```

Semantics:
- Walks the current branch (root to leaf)
- Only includes `session_memory` custom entries
- Returns in chronological order (oldest first)
- Marks the latest snapshot as `isCurrent: true`
- Only follows current branch, not sibling branches

### Step 3 — AgentSession.getMemoryHistory()

Added to `packages/coding-agent/src/core/agent-session.ts`:

```ts
getMemoryHistory(): readonly MemoryHistorySnapshot[] {
  return this.sessionManager.getMemoryHistory();
}
```

Delegates to SessionManager. Does not change model-facing memory injection behavior.

### Step 4 — `/memory history` textual command

Extended `handleMemoryCommand()` in `interactive-mode.ts`:

- Shows snapshot count and ordering info
- Displays newest first (current state most relevant)
- Each snapshot shows: age label, item count, timestamp, short ID (first 8 chars of `entryId`)
- Short IDs are shown in brackets `[xxxxxxxx]` for copy/paste use in `/memory diff <baselineId> <targetId>`
- Item summary (key + first 30 chars) for each snapshot
- Current snapshot marked with `[current]`

### Step 5 — Interactive history mode in memory editor

Extended `memory-editor.ts`:

**New modes:**
- `history` — list of snapshots (newest first)
- `history_detail` — full contents of selected snapshot

**Keybindings:**
- `h` from list mode opens history view
- `↑↓` navigate snapshots
- `Enter` view selected snapshot detail
- `←→` switch between snapshots (in detail mode)
- `b` arm current snapshot as baseline (history list and history detail)
- `c` clear armed baseline (history list, history detail, history diff)
- `d` diff: if baseline armed, enter target-picking; if no baseline, diff adjacent immediately
- `Enter` / `d` confirm target and open diff (in target-picking step)
- `Escape` back to history list / back to main list (in target-picking, exits picking and keeps baseline)

**Honest labeling:**
- Title bar shows "snapshot timeline · not event log"
- Detail view notes when viewing the current state
- Baseline markers explicitly labeled as `[baseline]`
- Diff header shows `Baseline:` (not `Base:`) when explicit baseline is armed

### Step 6 — Tests

Added to `packages/coding-agent/src/core/session-memory.test.ts`:

```ts
describe("getMemoryHistory", () => {
  it("returns empty array when no memory snapshots exist")
  it("returns single snapshot with isCurrent true")
  it("returns multiple snapshots in chronological order (oldest first)")
  it("only follows current branch, not sibling branches")
  it("includes entryId and parentId in snapshots")
})
```

## Verification

| Check | Result |
|-------|--------|
| `npm run check` | ✅ PASS |
| `getMemoryHistory` tests | ✅ PASS |
| `/memory history` command works | ✅ Verified |
| Memory editor `h` key opens history | ✅ Verified |
| History only shows current branch | ✅ Verified |
| Current snapshot marked correctly | ✅ Verified |

## What Was NOT Changed

- No changes to memory persistence (still snapshot-based via custom entries)
- No fake event log or diff computation
- No changes to model-facing memory injection path
- No changes to other memory editor modes (list, review, edit, delete, clear)
- No changes to TUI library or other packages

## Pass 6: Memory Snapshot Diff

### Chosen bounded scope

Add a bounded memory snapshot diff view that compares adjacent real persisted snapshots. No backend redesign, no fake event log, no duplication of diff logic.

### Files changed

| File | Type | Change |
|------|------|--------|
| `packages/coding-agent/src/core/memory-diff.ts` | NEW | Shared `computeMemorySnapshotDiff()` pure function and types |
| `packages/coding-agent/src/core/session-memory.test.ts` | MOD | Added 7 targeted diff tests |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | MOD | Added `/memory diff` textual command |
| `packages/coding-agent/src/modes/interactive/components/memory-editor.ts` | MOD | Added `history_diff` mode, `d` key from detail mode |
| `docs/MEMORY_DIFF_IMPLEMENTATION.md` | NEW | Memory snapshot diff evidence |

### Core: shared diff computation

Added `packages/coding-agent/src/core/memory-diff.ts` with:

```ts
interface MemorySnapshotDiff {
  added: DiffAdded[];
  removed: DiffRemoved[];
  changed: DiffChanged[];
  isInitialSnapshot: boolean;
}

function computeMemorySnapshotDiff(
  previous: MemoryHistorySnapshot | undefined,
  current: MemoryHistorySnapshot,
): MemorySnapshotDiff
```

Semantics:
- `added`: key only in current
- `removed`: key only in previous
- `changed`: key in both, value strings differ
- Unchanged keys are omitted
- If `previous` is undefined, all current keys are `added` and `isInitialSnapshot` is true
- Pure function — no side effects, no backend calls

This diff is derived from adjacent real persisted snapshots and is NOT a true operation log. It cannot tell you which specific add/update/delete operation produced a given change.

### `/memory diff` textual command

Extended `handleMemoryCommand()` in `interactive-mode.ts`:
- `/memory diff` compares current snapshot vs previous snapshot on the current branch
- `/memory history diff` is an accepted alias
- If no previous snapshot: shows "Initial snapshot" message honestly
- Sections: Added, Removed, Changed (only shown when non-empty)
- Explicitly states "(snapshot comparison · not an event log)"

### Interactive memory editor: history_diff mode

Extended `memory-editor.ts`:
- From `history_detail` mode, press `d` to enter `history_diff`
- Shows diff between selected snapshot and its immediate previous snapshot
- Header identifies both snapshots with relative age and timestamps
- Sections: `+ Added` (green), `- Removed` (red), `~ Changed` (old→new preview)
- Each section truncated to `maxVisible` items
- `↑↓` navigate to different target snapshots (base stays fixed)
- `Escape` returns to `history_detail`

Reuses shared `computeMemorySnapshotDiff()` from `core/memory-diff.ts` — same computation path as the textual command.

### Tests added

7 targeted tests in `session-memory.test.ts`:
- empty previous vs current with items → all added, isInitialSnapshot: true
- added only
- removed only
- changed only
- mixed added/removed/changed
- unchanged excluded from all sections
- both empty → all arrays empty

### Verification

| Check | Result |
|-------|--------|
| `npm run check` | ✅ PASS |
| Diff computation tests (7 tests) | ✅ PASS |
| `/memory diff` command | ✅ Verified |
| Memory editor `d` key from detail mode | ✅ Verified |

## Pass 8: Explicit Snapshot-ID Compare

Direct snapshot-ID comparison for the textual `/memory diff` command.

### Snapshot resolution helper

`SessionManager.resolveMemorySnapshotSelector(input)` resolves a snapshot with strict semantics:
- Resolution order: exact full ID, exact short ID (8 chars), strict unique prefix
- Supports optional brackets: `[abcd1234]` copied from history output
- Ambiguous prefixes are rejected with candidates listed
- Exposed via `AgentSession.resolveMemorySnapshotSelector(input)`

### History output now includes usage hint

`/memory history` now includes a hint line:
```
Use /memory diff <baselineId> <targetId> to compare any two snapshots.
IDs shown in brackets ([xxxxxxxx]) can be copied directly; brackets are optional.
Accepted: full entryId, 8-char short ID, or strict unique prefix.
```

Short IDs are shown as `[xxxxxxxx]` after each snapshot's age label.

### Explicit ID syntax

```
/memory diff <baselineId> <targetId>
```

IDs are shown in `/memory history` output as `[xxxxxxxx]` (first 8 chars of `entryId`).

### Behavior

| Invocation | Outcome |
|-----------|---------|
| `/memory diff` | Adjacent diff: current vs previous (unchanged default) |
| `/memory diff <id1> <id2>` | Explicit compare using those two snapshots |
| Ambiguous prefix | Clear error listing matching candidate IDs |
| Invalid/missing ID | Clear error listing which selector failed |
| Same ID for both | "Baseline and target are the same snapshot — no changes to show." |

### Files changed (Pass 8)

| File | Type | Change |
|------|------|--------|
| `packages/coding-agent/src/core/session-manager.ts` | MOD | Added `resolveMemorySnapshotSelector()` with strict resolution and `MemorySnapshotResolution` type |
| `packages/coding-agent/src/core/agent-session.ts` | MOD | Added `resolveMemorySnapshotSelector()` accessor |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | MOD | `/memory history` shows usage hint; `/memory diff` uses strict resolver with full-ID output and ambiguous/not-found errors |
| `packages/coding-agent/src/core/session-memory.test.ts` | MOD | Added 9 `resolveMemorySnapshotSelector` tests |
| `docs/MEMORY_DIFF_IMPLEMENTATION.md` | MOD | Updated to document strict resolution |
| `docs/MEMORY_COMPARE_IMPLEMENTATION.md` | MOD | Updated explicit ID compare section |
| `docs/MEMORY_HANDLING_IMPLEMENTATION.md` | MOD | Updated diff section |
| `docs/REFERENCE_HARNESS_AUDIT_AGENT_HARNESS_PRO.md` | MOD | Updated pass 8 |
| `docs/JENSEN_CODE_ADOPTION_PLAN_AGENT_HARNESS_PRO.md` | MOD | Updated pass 8 |

### What is NOT changed

- No provenance log — this is direct snapshot-ID comparison over current-branch persisted snapshots
- No fuzzy matching or hidden lookup rules
- Adjacent diff default preserved unchanged
- No changes to the interactive memory editor

## Pass 9: Bounded Copy-Friendly Ergonomics

Bounded ergonomic improvements for the text-based `/memory diff` workflow, building on the explicit snapshot-ID compare from pass 8.

### Resolution semantics
`SessionManager.resolveMemorySnapshotSelector(input)` and `AgentSession.resolveMemorySnapshotSelector(input)` use bracket-tolerant, strict semantics:
- Exact full entryId match (always wins)
- Exact short-ID match (first 8 chars of an entryId)
- Strict unique prefix match — prefix must resolve to exactly one snapshot
- Supports optional surrounding brackets: `[abcd1234]` copied from `/memory history` output
- Empty input → `error: "empty"`
- No match → `error: "not_found"` with empty candidates
- Ambiguous prefix → `error: "ambiguous"` with all matching candidate IDs listed

No fuzzy matching. No hidden lookup rules. Resolution is strictly deterministic.

### History output guidance (copy-friendly)
`/memory history` shows each snapshot's short ID (first 8 chars) in brackets with a usage hint explaining accepted forms for `/memory diff` IDs:
```
Use /memory diff <baselineId> <targetId> to compare any two snapshots.
IDs shown in brackets ([xxxxxxxx]) can be copied directly; brackets are optional.
Accepted: full entryId, 8-char short ID, or strict unique prefix.
```

Short IDs are shown as `[xxxxxxxx]` after each age label. The hint explicitly states that brackets are optional, reducing friction for copy/paste from history output.

### /memory diff command path
`handleMemoryCommand()` uses the shared resolution helper for explicit ID compare:
- Resolves both baseline and target selectors via `resolveMemorySnapshotSelector()`
- Reports FULL resolved IDs in output header (full `entryId` shown)
- Reports ambiguity clearly with candidate list
- Reports no-match clearly with failed selector name
- Reports same-snapshot honestly without implying a diff was computed
- Adjacent diff (no IDs) unchanged

### Syntax fixes applied
Fixed escaped backtick template literal issue in `interactive-mode.ts`:
- Lines 739 and 754 used `\`[\${cand.slice(0, 8)}]\`` which confused the Biome parser
- Replaced with string concatenation: `"  " + theme.fg("muted", \`[\${cand.slice(0, 8)}]\`) + " " + cand`

### Tests added
33 total tests for the resolution helper. Key new addition: deterministic ambiguous-prefix test using controlled IDs with a guaranteed shared prefix, ensuring reliable coverage of the ambiguity rejection path.

## Pass 10: Dedicated resolver surface

Selector resolution is now split into two explicit layers:
1. `packages/coding-agent/src/core/snapshot-selector-resolver.ts` — pure normalization/resolution contract over a supplied snapshot list
2. `packages/coding-agent/src/core/session-manager.ts` — current-branch-only integration via `getMemoryHistory()`

Dedicated tests now live in `packages/coding-agent/src/core/snapshot-selector-resolver.test.ts` for:
- exact full ID
- exact displayed short ID
- bracketed short ID
- exact-short-vs-prefix precedence
- strict unique prefix success
- ambiguous prefix rejection
- no-match rejection
- same-snapshot compare compatibility

`session-memory.test.ts` retains the integration proof that SessionManager resolution stays current-branch-only and compatible with the real compare path.

## Pass 11: Shared history guidance text

`/memory history` no longer assembles selector help inline in `interactive-mode.ts`.

### Shared path
- `packages/coding-agent/src/core/snapshot-selector-formatter.ts` → `formatSnapshotSelectorHistoryGuidance()`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` consumes that helper for the textual history hint

### Resulting operator contract
The history hint remains explicit and copy-friendly:
- `/memory diff <baselineId> <targetId>` is the textual compare command
- bracketed short IDs shown in history can be copied directly
- accepted selector forms are stated in one shared message path

This keeps the selector-help wording reusable for future non-UI compare surfaces without changing the underlying snapshot history model.

## Pass 12: Print-mode history surface

The next real non-UI consumer of that shared history guidance is now print mode.

### Files
- `packages/coding-agent/src/core/memory-compare-output.ts`
- `packages/coding-agent/src/core/memory-compare-output.test.ts`
- `packages/coding-agent/src/modes/print-mode.ts`
- `packages/coding-agent/src/modes/print-mode.test.ts`

### Behavior
In text print mode, `/memory history` is now handled locally and rendered through `formatMemoryHistoryOutput()`.

That renderer reuses:
- `formatSnapshotSelectorHistoryGuidance()` for accepted-selector help
- `formatSnapshotShortId()` for bracketed short IDs shown beside each snapshot

### Why this is the bounded next step
- it gives a real non-UI history/compare discovery surface without changing storage or command routing globally
- it keeps the operator-facing selector guidance identical in meaning outside `interactive-mode.ts`
- it preserves current-branch snapshot semantics and does not imply an event log

### Deferred
- RPC history output
- JSON-mode history protocol
- interactive-mode refactor to use the same plain-text history renderer

## Pass 13: RPC history payload

A structured RPC history surface now exposes the same real current-branch snapshot timeline to non-UI callers.

### Files
- `packages/coding-agent/src/modes/rpc/rpc-types.ts`
- `packages/coding-agent/src/modes/rpc/rpc-memory.ts`
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
- `packages/coding-agent/src/modes/rpc/rpc-client.ts`
- `packages/coding-agent/src/modes/rpc/rpc-memory-snapshot.test.ts`

### Chosen contract
`get_memory_history` returns:
- `branchScope: "current"`
- `historyModel: "snapshot"`
- `snapshots: RpcMemorySnapshot[]`

Each RPC snapshot includes:
- full `entryId`
- copy-friendly `shortId` (same 8-char basis used by `/memory history`)
- `parentId`
- `recordedAt`
- full `items`
- `itemCount`
- `isCurrent`

### Reuse semantics
- still derives from `SessionManager.getMemoryHistory()`
- still follows the active branch only
- still represents complete snapshots, not individual operations
- does not reuse text formatting helpers because RPC already expects structured output

### Verification
`rpc-memory-snapshot.test.ts` now proves:
- empty history contract
- structured snapshot payload shape
- current-branch-only behavior when backed by `SessionManager`
- JSON-serializability of the payload

## Pass 14: SDK-facing structured history consumer

The next bounded same-process consumer is now `AgentSession` itself.

### Files
- `packages/coding-agent/src/core/memory-snapshot-contract.ts`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/agent-session-memory-snapshot.test.ts`
- `packages/coding-agent/docs/sdk.md`

### Surface
`AgentSession.getStructuredMemoryHistory()` returns the same structured history payload shape already defined for RPC:
- `branchScope: "current"`
- `historyModel: "snapshot"`
- `snapshots` with `entryId`, `shortId`, `parentId`, `recordedAt`, `items`, `itemCount`, and `isCurrent`

### Reuse semantics
- the payload builder now lives in `src/core/memory-snapshot-contract.ts`
- both SDK and RPC consume that same builder
- history still derives from `SessionManager.getMemoryHistory()` over persisted current-branch `session_memory` snapshots
- no text formatting helpers are involved because this is still structured output
