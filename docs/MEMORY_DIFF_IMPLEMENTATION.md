# Memory Diff Implementation

## Objective

Add a bounded memory snapshot diff view for jensen-code using the real persisted session_memory snapshot history. No backend redesign, no fake event log, one shared diff computation path for text and UI.

## Approach

Because persistence is snapshot-based (not event-sourced), the diff derives from adjacent real persisted snapshots and is NOT a true operation log. It cannot tell you which specific add/update/delete operation produced a given change.

The implementation:
- Creates one shared pure computation function in `core/memory-diff.ts`
- Exposes it through `/memory diff` textual command
- Exposes it through `history_diff` mode in the interactive memory editor
- Preserves all existing memory, history, and editor behavior

## Files Changed

| File | Type | Change |
|------|------|--------|
| `packages/coding-agent/src/core/memory-diff.ts` | NEW | Shared pure diff function and types |
| `packages/coding-agent/src/core/session-memory.test.ts` | MOD | 7 targeted diff tests |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | MOD | `/memory diff` and `/memory history diff` |
| `packages/coding-agent/src/modes/interactive/components/memory-editor.ts` | MOD | `history_diff` mode, `d` key from detail |
| `docs/MEMORY_DIFF_IMPLEMENTATION.md` | NEW | This file |
| `docs/MEMORY_HISTORY_IMPLEMENTATION.md` | MOD | Added pass 6 section |
| `docs/MEMORY_HANDLING_IMPLEMENTATION.md` | MOD | Added diff section |
| `docs/MEMORY_UI_IMPLEMENTATION.md` | MOD | Added history_diff mode |
| `docs/JENSEN_CODE_ADOPTION_PLAN_AGENT_HARNESS_PRO.md` | MOD | Added pass 6 |
| `docs/REFERENCE_HARNESS_AUDIT_AGENT_HARNESS_PRO.md` | MOD | Added pass 6 |

## Step 1 — Shared Snapshot Diff Computation

Created `packages/coding-agent/src/core/memory-diff.ts`:

### Types

```ts
interface DiffAdded {
  type: "added";
  key: string;
  value: string;
}

interface DiffRemoved {
  type: "removed";
  key: string;
  value: string;
}

interface DiffChanged {
  type: "changed";
  key: string;
  previousValue: string;
  currentValue: string;
}

interface MemorySnapshotDiff {
  added: DiffAdded[];
  removed: DiffRemoved[];
  changed: DiffChanged[];
  isInitialSnapshot: boolean;
}
```

### Function

```ts
function computeMemorySnapshotDiff(
  previous: MemoryHistorySnapshot | undefined,
  current: MemoryHistorySnapshot,
): MemorySnapshotDiff
```

Semantics:
- `added`: key only in current (not in previous)
- `removed`: key only in previous (not in current)
- `changed`: key in both, value strings differ
- Unchanged keys are omitted from the result
- If `previous` is undefined, all current keys are `added` and `isInitialSnapshot` is true
- Pure function — no side effects, no backend calls

This diff is derived from adjacent real persisted snapshots and is NOT a true operation log.

## Step 2 — Targeted Tests

Added 7 tests to `packages/coding-agent/src/core/session-memory.test.ts`:

| Test | Description |
|------|-------------|
| empty previous vs current with items → all added | isInitialSnapshot: true when previous is undefined |
| added only | New key in current only |
| removed only | Key in previous not in current |
| changed only | Key in both with different value string |
| mixed added/removed/changed | All three types present simultaneously |
| unchanged excluded | Keys with same value in both are omitted |
| both empty | No snapshots — all arrays empty |

## Step 3 — `/memory diff` Textual Command

Extended `handleMemoryCommand()` in `interactive-mode.ts`:

**Command:** `/memory diff` (alias: `/memory history diff`)

**Behavior:**
1. Gets memory history from current branch
2. If no snapshots: "No memory snapshots found. Nothing to diff against."
3. If only one snapshot (no previous): Shows "Initial snapshot" with item count honestly
4. Otherwise: computes diff between current (latest) and previous snapshot
5. Renders sections (only when non-empty): Added, Removed, Changed
6. Labels: "(snapshot comparison · not an event log)"

**Output format:**
```
Comparing: 2h ago → 30m ago
2024-01-01T10:00:00.000Z → 2024-01-01T11:30:00.000Z
(snapshot comparison · not an event log)

+ Added (1)
  + key: value preview

- Removed (1)
  - key: value preview

~ Changed (1)
  ~ key:
    old value preview
    new value preview
```

## Step 4 — Interactive Memory Editor: history_diff Mode

Extended `memory-editor.ts`:

### New mode: `history_diff`

**Entry:** From `history_detail` mode, press `d`

**Display:**
- Header identifying both snapshots:
  - Base: `<relative age> — <full timestamp>`
  - Target: `<relative age> — <full timestamp>`
- Sections (only shown when non-empty):
  - `+ Added (N)` — green
  - `- Removed (N)` — red
  - `~ Changed (N)` — yellow, shows old→new preview
- Each section truncated to `maxVisible` items

**Navigation:**
- `↑↓` — navigate to different target snapshots (base stays fixed)
- `Escape` — return to `history_detail`

**Title bar:** Shows "Memory History — Snapshot Diff" and "(snapshot timeline · not event log)"

### State

- `diffBaseIndex: number | null` — index of the base snapshot for the diff pair
- When entering `history_diff` from `history_detail`, base is set to `selectedIndex - 1` (or 0 if at index 0)

### Reuse

Uses the same `computeMemorySnapshotDiff()` as the textual command — one computation path for both surfaces.

### Explicit Baseline Semantics

The diff computation path is unchanged. What changes is which snapshots are passed as base and target, and the new two-step compare chooser for explicit target selection.

**Diff base/target selection:**

| Scenario | Base | Target |
|----------|------|--------|
| Explicit baseline armed | `armedBaselineIndex` | `selectedIndex` |
| No baseline armed (adjacent default) | `selectedIndex - 1` (or 0) | `selectedIndex` |

`armedBaselineIndex` is purely UI state. It does not persist across sessions. Clearing the baseline restores the adjacent-diff default.

**Two-step compare chooser:**

When a baseline is armed, `d` enters an explicit target-picking step (`compareStep = "target_picking"`) rather than immediately opening the diff. This gives the operator a chance to visually confirm which snapshot will be the target before the diff is computed.

In target-picking state:
- UI subtitle shows `[baseline: <age>]` and `[selecting target: <age>]`
- Selected snapshot shows `[target]` marker
- `Enter` or `d` confirms the target and opens the diff
- `Escape` exits target-picking but keeps the baseline armed
- `c` clears the baseline and exits target-picking
- `(same snapshot)` annotation appears if baseline === target

When no baseline is armed, `d` still opens the adjacent diff immediately (preserved quick default).

The diff header labels the base as `Baseline:` when an explicit baseline is armed (honest: this is the explicitly selected base, not the default adjacent). When no baseline is armed, the label remains `Base:`.

The `armedBaselineIndex` is in original chronological order (same basis as `getMemoryHistory()` returns). When used from history list mode (where `selectedIndex` is reversed display order), it is converted: `chronologicalIndex = snapshots.length - 1 - displayIndex`.

## Step 5 — Preservation of Existing Behavior

Verified unchanged:
- `/memory history` textual output
- `/memory list`, `/memory get`, `/memory set`, `/memory clear`, `/memory review`
- Memory editor: list, add, edit, delete, clear, review, history, history_detail modes
- Model-facing memory injection
- Session persistence path

## Verification

| Check | Result |
|-------|--------|
| `npm run check` | ✅ PASS |
| `computeMemorySnapshotDiff` tests (7 tests) | ✅ PASS |
| `MemoryEditorComponent` tests (17 tests) | ✅ PASS |
| `/memory diff` command registered | ✅ Verified |
| `/memory history diff` alias works | ✅ Verified |
| Memory editor `d` key enters diff mode | ✅ Verified |
| `d` with only one snapshot shows message | ✅ Verified |
| Diff sections only shown when non-empty | ✅ Verified |

## What Was NOT Changed

- No backend redesign
- No fake event log or fabricated operation attribution
- No duplication of diff logic in UI and command paths
- No changes to existing memory/history/editor modes
- No changes to model-facing memory injection path
- No changes to session persistence
- No changes to other packages (tui, ai, agent, etc.)

## Step 6 — Explicit Snapshot-ID Compare

Added direct snapshot-ID compare syntax using `entryId` values from `getMemoryHistory()`.

### New canonical syntax

```
/memory diff <baselineId> <targetId>
```

The alias `/memory history diff <baselineId> <targetId>` is also accepted.

### Discovery: IDs visible in `/memory history` output

`/memory history` now shows each snapshot's short ID (first 8 characters of `entryId`) in brackets, with a usage hint:

```
Branch history · 3 snapshots · oldest first
Each snapshot is a complete memory state at that point (not individual changes).

Use /memory diff <baselineId> <targetId> to compare any two snapshots.
IDs shown in brackets ([xxxxxxxx]) can be copied directly; brackets are optional.
Accepted: full entryId, 8-char short ID, or strict unique prefix.

2h ago [current] · 3 items · 2026-04-01T15:00:00 · [4e10b608]
```

### Strict resolution helper

Added to `SessionManager` and exposed via `AgentSession.resolveMemorySnapshotSelector(input)`:

```ts
interface MemorySnapshotResolution {
  snapshot: MemoryHistorySnapshot | undefined;
  matchedInput: string;
  resolvedId: string | undefined;
  error: "not_found" | "ambiguous" | "empty" | undefined;
  candidates: string[];
}
```

Resolution order:
1. Exact full entryId match (always wins)
2. Exact short-ID match (first 8 chars of an entryId)
3. Strict unique prefix match — prefix must resolve to exactly one snapshot

Supports optional surrounding brackets copied from history output: `[abcd1234]`

**Prefix matching is strict**: ambiguous prefixes (matching multiple snapshots) are rejected with a clear error listing all matching candidates. No fuzzy matching, no hidden lookup rules.

### Behavior

| Invocation | Behavior |
|-----------|----------|
| `/memory diff` | Adjacent diff: current vs previous (unchanged default) |
| `/memory diff <baselineId> <targetId>` | Explicit compare using those two snapshots |
| `/memory history diff <baselineId> <targetId>` | Same as above (alias) |
| Ambiguous prefix | Clear error listing matching candidate IDs |
| No match / not found | Clear error listing which selector failed |
| Same ID for both | "Baseline and target are the same snapshot — no changes to show." |

### Output for explicit compare

When two valid IDs are provided, the output clearly labels both snapshots with full IDs:

```
Baseline: 2h ago — 2026-04-01T15:00:00.000Z
        ID: [4e10b608] 4e10b608-abcd-1234-efgh-567890123456
Target:   30m ago — 2026-04-01T16:30:00.000Z
        ID: [8a3f2c1d] 8a3f2c1d-abcd-1234-efgh-567890123456
(snapshot comparison · not an event log)
```

### Error output for ambiguous prefix

```
Snapshot resolution failed in current branch history.

Baseline ID is ambiguous: abc
  [abc12345] abc12345-...
  [abc67890] abc67890-...
  [abcabcde] abcabcde-...

Run /memory history to see available snapshot IDs (shown in brackets after each age label).
Accepted forms: full entryId, short ID (8 chars), or strict unique prefix. Brackets are optional.
```

### Error output for missing ID

```
Snapshot resolution failed in current branch history.

Baseline ID not found: abc12345
Target ID not found: xyz99999

Run /memory history to see available snapshot IDs (shown in brackets after each age label).
Accepted forms: full entryId, short ID (8 chars), or strict unique prefix. Brackets are optional.
```

### Implementation details

The diff command handler:
1. Parses `parts[2]` (baseline) and `parts[3]` (target) from the command string
2. If both IDs are provided: calls `session.resolveMemorySnapshotSelector()` for each
3. If either resolution fails: renders a clear error with error kind and candidates listed
4. If same ID for both: renders honest "same snapshot" message (no diff computation)
5. Otherwise: passes the resolved snapshots to `computeMemorySnapshotDiff()` — the shared path

The adjacent diff default (`/memory diff` with no IDs) is fully preserved with identical output.

### Files changed

| File | Change |
|------|--------|
| `packages/coding-agent/src/core/session-manager.ts` | Added `findMemorySnapshotById()` method; Added `resolveMemorySnapshotSelector()` with strict resolution and `MemorySnapshotResolution` type |
| `packages/coding-agent/src/core/agent-session.ts` | Added `resolveMemorySnapshotSelector()` accessor delegating to SessionManager |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | `/memory history` shows usage hint; `/memory diff` uses strict resolver with full-ID output and ambiguous/not-found errors with candidates |
| `packages/coding-agent/src/core/session-memory.test.ts` | Added `resolveMemorySnapshotSelector` tests (9 new tests) |
| `docs/MEMORY_DIFF_IMPLEMENTATION.md` | Updated to document strict resolution |
| `docs/MEMORY_COMPARE_IMPLEMENTATION.md` | Updated explicit ID compare section |
| `docs/MEMORY_HANDLING_IMPLEMENTATION.md` | Updated diff section |
| `docs/MEMORY_HISTORY_IMPLEMENTATION.md` | Updated history output section |
| `docs/REFERENCE_HARNESS_AUDIT_AGENT_HARNESS_PRO.md` | Updated pass 8 |
| `docs/JENSEN_CODE_ADOPTION_PLAN_AGENT_HARNESS_PRO.md` | Updated pass 8 |

### Verification

| Check | Result |
|-------|--------|
| `npm run check` | ✅ PASS |
| `resolveMemorySnapshotSelector` tests (9 new) | ✅ PASS |
| Exact full ID resolution | ✅ Verified |
| Exact short ID resolution | ✅ Verified |
| Bracketed short ID resolution | ✅ Verified |
| Strict unique prefix resolution | ✅ Verified |
| Ambiguous prefix rejection with candidates | ✅ Verified |
| Not-found error with clear messaging | ✅ Verified |
| Same-snapshot comparison honest | ✅ Verified |
| Adjacent diff preserved | ✅ Verified |

### What is NOT changed

- No provenance log — this is direct snapshot comparison over persisted current-branch snapshots
- No fuzzy matching or hidden lookup rules
- No multi-snapshot range comparison (would imply event attribution)
- No changes to the interactive memory editor (UI-based compare is separate)
- No changes to the diff computation path (`computeMemorySnapshotDiff` unchanged)
- Prefix matching requires exactly one match — ambiguous prefixes are always rejected

## Pass 10: Dedicated selector resolver module

The textual compare path still uses `SessionManager.resolveMemorySnapshotSelector()`, but that method now delegates to the dedicated pure helper in `packages/coding-agent/src/core/snapshot-selector-resolver.ts`.

This clarifies the contract for current and future non-UI compare consumers:
- normalization is explicit and separately tested
- precedence is explicit: full ID → displayed short ID → strict unique prefix
- ambiguity and no-match failures are explicit structured outcomes
- current-branch-only behavior is still enforced by resolving only against `getMemoryHistory()` snapshots

Dedicated tests now live in `packages/coding-agent/src/core/snapshot-selector-resolver.test.ts`, while `packages/coding-agent/src/core/session-memory.test.ts` keeps the integration proof that current-branch filtering remains intact.

## Pass 11: Shared selector messaging for textual compare

The textual compare surface now reuses a dedicated operator-facing formatter:
- `packages/coding-agent/src/core/snapshot-selector-formatter.ts`
- `packages/coding-agent/src/core/snapshot-selector-formatter.test.ts`

### Shared formatter responsibilities
- `formatSnapshotSelectorResolutionFailure()` produces the full empty/not_found/ambiguous failure block
- `formatResolvedSnapshotId()` produces the exact `[shortId] full-entryId` display used when explicit selector compare succeeds
- `formatExplicitDiffHeader()` formats the explicit compare header
- `formatAdjacentDiffHeader()` formats the adjacent default compare header

### Current consumer
`packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- `/memory diff <baselineId> <targetId>` now uses the shared failure/header formatter path
- `/memory diff` adjacent default also uses the shared adjacent-header helper

### Verification added
- dedicated formatter tests for empty selector formatting
- dedicated formatter tests for not-found formatting
- dedicated formatter tests for ambiguous formatting with candidate IDs
- dedicated formatter tests for shared history guidance and explicit-ID header output

No diff computation or backend semantics changed in this pass.

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
`/memory history` shows each snapshot's short ID (first 8 chars) in brackets with a usage hint:
```
Use /memory diff <baselineId> <targetId> to compare any two snapshots.
IDs shown in brackets ([xxxxxxxx]) can be copied directly; brackets are optional.
Accepted: full entryId, 8-char short ID, or strict unique prefix.
```

Short IDs are shown as `[xxxxxxxx]` after each age label. The hint explicitly states that brackets are optional.

### /memory diff command path
`handleMemoryCommand()` uses the shared resolution helper for explicit ID compare:
- Resolves both baseline and target selectors via `resolveMemorySnapshotSelector()`
- Reports FULL resolved IDs in output header (full `entryId` shown, not just short form)
- Reports ambiguity clearly with candidate list
- Reports no-match clearly with failed selector name
- Reports same-snapshot honestly without implying a diff was computed
- Adjacent diff (no IDs) unchanged

### Syntax fixes applied
Fixed escaped backtick template literal issue in `interactive-mode.ts`:
- Lines 739 and 754 used `\`[\${cand.slice(0, 8)}]\`` which confused the Biome parser (invalid `\]` escape in template literal)
- Replaced with string concatenation: `"  " + theme.fg("muted", \`[\${cand.slice(0, 8)}]\`) + " " + cand`
- Verified: `npm run check` passes cleanly

### Tests added
33 total tests for the resolution helper in `session-memory.test.ts`. Key addition: deterministic ambiguous-prefix test using controlled IDs with a guaranteed shared prefix (`"abc00001"`, `"abc00002"`, `"abc00003"`) to reliably trigger and verify the ambiguity rejection path.

## Pass 12: Print-mode diff surface

The next real non-UI compare surface is now text print mode.

### Files
- `packages/coding-agent/src/core/memory-compare-output.ts`
- `packages/coding-agent/src/core/memory-compare-output.test.ts`
- `packages/coding-agent/src/modes/print-mode.ts`
- `packages/coding-agent/src/modes/print-mode.test.ts`

### Shared renderer
`formatMemoryDiffOutput()` provides a plain-text non-UI diff renderer that deliberately builds on the existing selector formatter/header helpers instead of reassembling those messages in print mode.

Reused pieces:
- `formatSnapshotSelectorResolutionFailure()`
- `formatExplicitDiffHeader()`
- `formatAdjacentDiffHeader()`

This means explicit selector compare in print mode now shares the same:
- empty / not_found / ambiguous messaging
- accepted selector-form guidance
- resolved-ID header contract
- snapshot-comparison-not-event-log framing

### Print-mode behavior
In text print mode, these commands now render locally:
- `/memory diff`
- `/memory diff <baselineId> <targetId>`

No diff computation changed. The renderer still calls `computeMemorySnapshotDiff()` over real persisted snapshots on the current branch.

### Verification
- targeted tests cover explicit diff headers, selector resolution failures, same-snapshot honesty, and initial-snapshot output
- print-mode tests confirm the non-UI surface is actually wired to the shared renderer

### Deferred
- RPC diff command
- JSON-mode diff payloads
- replacing interactive-mode's existing textual diff assembly with `formatMemoryDiffOutput()` in this pass

## Pass 13: Structured RPC compare payload

A bounded structured RPC compare surface now exists beside the interactive and print-mode diff paths.

### Files
- `packages/coding-agent/src/modes/rpc/rpc-types.ts`
- `packages/coding-agent/src/modes/rpc/rpc-memory.ts`
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
- `packages/coding-agent/src/modes/rpc/rpc-client.ts`
- `packages/coding-agent/src/modes/rpc/rpc-memory-snapshot.test.ts`

### Why this shape
Print mode was already the plain-text non-UI surface. RPC already expects structured JSON. So the bounded follow-up was a structured compare payload that reuses the same underlying semantics instead of tunneling plain text through JSON.

### Compare contract
`compare_memory_snapshots`
- with no selectors: adjacent latest-vs-previous compare on the current branch
- with both selectors: explicit compare using the existing strict selector resolver contract

Structured outcomes:
- `status: "empty_history"`
- `status: "initial_snapshot"`
- `status: "selector_resolution_failed"`
- `status: "ok"`

### Reuse semantics
- diff still comes from `computeMemorySnapshotDiff()`
- selector resolution still comes from `resolveMemorySnapshotSelector()`
- current-branch-only semantics still come from `getMemoryHistory()`
- same-snapshot compare remains honest through `sameSnapshot: true` plus an empty diff
- explicit selector success returns resolved full IDs and matched selector inputs
- selector failures stay structured as `empty`, `not_found`, or `ambiguous`

### Verification
`rpc-memory-snapshot.test.ts` now covers:
- adjacent compare
- initial snapshot honesty
- explicit selector success
- ambiguous / empty selector failures
- same-snapshot honesty

## Pass 14: SDK-facing structured compare consumer

A same-process automation caller can now consume the compare payload directly from `AgentSession`.

### Files
- `packages/coding-agent/src/core/memory-snapshot-contract.ts`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/agent-session-memory-snapshot.test.ts`
- `packages/coding-agent/docs/sdk.md`
- `packages/coding-agent/docs/rpc.md`

### Surface
`AgentSession.compareMemorySnapshots(options?)`
- no selectors → adjacent latest-vs-previous comparison
- both selectors → explicit compare using the existing strict selector contract
- only one selector → throws the same contract error used by RPC command validation

### Reuse semantics
- compare payloads now come from the shared `buildStructuredMemoryCompareData()` helper in `src/core/memory-snapshot-contract.ts`
- RPC continues to expose `compare_memory_snapshots`, but now reuses that same shared builder through `src/modes/rpc/rpc-memory.ts`
- diff computation still comes from `computeMemorySnapshotDiff()`
- same-snapshot and initial-snapshot honesty are unchanged
- selector failures remain `empty`, `not_found`, or `ambiguous`
