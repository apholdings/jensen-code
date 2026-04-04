# Memory Compare Implementation (Two-Step Compare Chooser)

## Objective

Add a UI-assisted two-step compare chooser to the interactive memory history editor. The operator arms a baseline snapshot, then explicitly picks a target snapshot before opening the diff. No persistence redesign, no command semantics changes, adjacent diff preserved as quick default.

## Approach

The two-step compare chooser is a bounded UI state layer over the existing snapshot backend. It does not modify:
- persistence (still snapshot-based via `session_memory` custom entries)
- diff computation (still via `computeMemorySnapshotDiff(base, target)`)
- `/memory` textual commands
- adjacent diff as the quick default

## State Model

```ts
/** Index (in original chronological order) of the explicitly armed baseline snapshot */
private armedBaselineIndex: number | null = null;

/** Index of the base snapshot for diff mode (the earlier snapshot in the pair) */
private diffBaseIndex: number | null = null;

/**
 * Tracks the explicit two-step compare chooser flow.
 * - "none": no compare chooser active
 * - "target_picking": baseline is armed; operator is selecting a target snapshot
 */
private compareStep: "none" | "target_picking" = "none";
```

`armedBaselineIndex` is in original chronological order (matching `getMemoryHistory()` return order). When entered from history list mode (where `selectedIndex` is reversed display order), it is converted: `chronologicalIndex = snapshots.length - 1 - displayIndex`.

## UX Flow

```
history list / history detail
  │
  ├─ b ──→ armed baseline (compareStep = "none")
  │
  └─ d ──→ compareStep = "target_picking" ──→ Enter or d ──→ history_diff
                │
                ├─ c ──→ baseline cleared + compareStep = "none"
                └─ Escape ──→ compareStep = "none" (baseline kept)
```

No baseline armed:
```
history list / history detail
  │
  └─ d ──→ history_diff (adjacent default, immediately)
```

## Keybindings

| Mode | Key | Action |
|------|-----|--------|
| history list | `b` | Arm currently selected snapshot as baseline |
| history list | `c` | Clear armed baseline |
| history list | `d` (no baseline) | Diff adjacent → selected (quick default) |
| history list | `d` (baseline armed) | Enter target-picking step |
| history list (target_picking) | `↑↓` | Select target snapshot |
| history list (target_picking) | `Enter` / `d` | Confirm target → open diff |
| history list (target_picking) | `c` | Clear baseline and exit target-picking |
| history list (target_picking) | `Escape` | Exit target-picking, keep baseline |
| history detail | `b` | Arm current snapshot as baseline |
| history detail | `c` | Clear armed baseline |
| history detail | `d` (no baseline) | Diff adjacent → selected (quick default) |
| history detail | `d` (baseline armed) | Enter target-picking step |
| history detail (target_picking) | `↑↓←→` | Select target snapshot |
| history detail (target_picking) | `Enter` / `d` | Confirm target → open diff |
| history detail (target_picking) | `c` | Clear baseline and exit target-picking |
| history detail (target_picking) | `Escape` | Exit target-picking, keep baseline |
| history diff | `c` | Clear armed baseline |

## Diff Semantics

`computeMemorySnapshotDiff(base, target)` is always used. The semantics of which snapshots are passed:

```
if (armedBaselineIndex !== null) {
  diffBaseIndex = armedBaselineIndex;  // explicit baseline
} else {
  diffBaseIndex = selectedIndex > 0 ? selectedIndex - 1 : 0;  // adjacent default
}
targetIndex = selectedIndex;
```

## UI Markers

### History list (target_picking active)
- Subtitle shows: `[baseline: <age>]` and `[selecting target: <age>]`
- Selected line shows `[target]` marker
- If baseline === target: subtitle shows `(same snapshot)`
- Baseline snapshot line no longer shows `[baseline]` (replaced by subtitle annotation)

### History detail (target_picking active)
- Subtitle shows: `[baseline: <age>]` and `[selecting target: <age>]`
- If baseline === target: subtitle shows `(same snapshot)`

### History diff header
- When explicit baseline is armed: shows `Baseline:` (not `Base:`)
- When no baseline armed: shows `Base:` (adjacent diff default)

## Honest Framing

The UI explicitly labels:
- "snapshot timeline · not event log" in the title bar
- "Baseline:" label when explicit baseline is armed (honest about what was selected)
- "Base:" label when using adjacent default (honest that this is the default, not explicit)
- "Selecting target:" during the target-picking step — clearly indicates an active comparison flow
- If target is older/newer than baseline, the diff still shows `baseline → target` — no reordering is implied
- "(same snapshot)" annotation when baseline and target are the same

Comparing a snapshot to itself yields "No changes between snapshots." cleanly.

## Files Changed

| File | Type | Change |
|------|------|--------|
| `packages/coding-agent/src/modes/interactive/components/memory-editor.ts` | MOD | Added `compareStep` state, target-picking flow in `handleHistoryInput`/`handleHistoryDetailInput`, UI markers, action hints |
| `packages/coding-agent/src/modes/interactive/components/memory-editor.test.ts` | MOD | Updated diff tests to reflect two-step flow; added 12 new two-step chooser tests |
| `docs/MEMORY_COMPARE_IMPLEMENTATION.md` | MOD | Updated to document two-step compare chooser |
| `docs/MEMORY_UI_IMPLEMENTATION.md` | MOD | Updated baseline picker section |
| `docs/MEMORY_HISTORY_IMPLEMENTATION.md` | MOD | Updated keybindings table |
| `docs/MEMORY_DIFF_IMPLEMENTATION.md` | MOD | Updated explicit baseline semantics |
| `docs/MEMORY_HANDLING_IMPLEMENTATION.md` | MOD | Updated baseline picker section |
| `docs/JENSEN_CODE_ADOPTION_PLAN_AGENT_HARNESS_PRO.md` | MOD | Updated pass 7 |
| `docs/REFERENCE_HARNESS_AUDIT_AGENT_HARNESS_PRO.md` | MOD | Updated pass 7 |

## Implementation Details

### compareStep State

```ts
private compareStep: "none" | "target_picking" = "none";
```

`compareStep` is orthogonal to `mode`. It layers on top of `history` and `history_detail` modes:
- In `history` or `history_detail` mode with `compareStep = "target_picking"`, the render and key handlers show the explicit target-picking UI.
- When diff opens (`mode = "history_diff"`), `compareStep` resets to `"none"`.

### 'd' key with baseline armed (new behavior)

```ts
if (keyData === "d") {
    if (snapshots.length < 2 && this.armedBaselineIndex === null) {
        this.requestRender();
        return;
    }
    if (this.armedBaselineIndex !== null) {
        // Enter explicit target-picking step
        this.compareStep = "target_picking";
        this.requestRender();
        return;
    }
    // No baseline: adjacent diff immediately (quick default)
    const targetChronologicalIndex = snapshots.length - 1 - this.selectedIndex;
    this.diffBaseIndex = targetChronologicalIndex > 0 ? targetChronologicalIndex - 1 : 0;
    this.mode = "history_diff";
    this.requestRender();
    return;
}
```

### Enter / d key in target-picking (confirms and opens diff)

```ts
if (kb.matches(keyData, "selectConfirm") || keyData === "\n" || keyData === "d") {
    if (snapshots.length > 0 && this.armedBaselineIndex !== null) {
        const targetChronologicalIndex = snapshots.length - 1 - this.selectedIndex;
        this.diffBaseIndex = this.armedBaselineIndex;
        this.compareStep = "none";
        this.mode = "history_diff";
        this.requestRender();
    }
    return;
}
```

### Escape in target-picking (cancels without losing baseline)

```ts
if (kb.matches(keyData, "selectCancel")) {
    this.compareStep = "none";
    this.requestRender();
    return;
}
```

### 'c' key in target-picking (clears baseline and exits)

```ts
if (keyData === "c") {
    this.armedBaselineIndex = null;
    this.compareStep = "none";
    this.requestRender();
    return;
}
```

### clearBaseline() (updated)

```ts
private clearBaseline(): void {
    this.armedBaselineIndex = null;
    this.compareStep = "none";
}
```

Clearing the baseline also exits any active target-picking step, since the comparison cannot proceed without a baseline.

### refresh() sync for compareStep

```ts
if (this.compareStep === "target_picking") {
    const snapshots = this.callbacks.getMemoryHistory();
    if (snapshots.length === 0) {
        this.compareStep = "none";
    }
}
```

## Tests

21 targeted tests in `packages/coding-agent/src/modes/interactive/components/memory-editor.test.ts`:

**Baseline arming (existing, still valid):**
| Test | Coverage |
|------|----------|
| b key arms current snapshot as baseline | Arming from history list |
| baseline marker visible in history list render output | `[baseline]` visible in render |
| re-arming baseline changes selected baseline | Re-arm updates armedBaselineIndex |
| b key arms current snapshot in detail mode | Arming from detail mode |
| baseline marker in history detail when viewing armed | `[baseline]` in detail render |
| c key clears armed baseline in detail mode | Clear in detail |
| c key clears baseline in history list mode | Clear in list |

**Two-step compare chooser (new):**
| Test | Coverage |
|------|----------|
| d with explicit baseline enters target-picking, Enter opens diff | Two-step flow from history list |
| d without baseline still opens adjacent diff immediately | Adjacent default preserved |
| compare same snapshot to itself yields no changes | Self-comparison in two-step flow |
| c key clears baseline in diff mode | Clear in diff mode (after two-step) |
| d enters target-picking in history list when baseline armed | Target-picking entry |
| target-picking renders [selecting target] subtitle with baseline annotation | UI state visible |
| target-picking shows [target] marker on selected line | Target marker visible |
| Enter confirms target and opens diff | Confirm flow |
| d also confirms target and opens diff from target-picking | d confirms in target-picking |
| Escape exits target-picking and keeps baseline armed | Cancel preserves baseline |
| c clears baseline and exits target-picking | Clear in target-picking |
| same snapshot as baseline and target shows (same snapshot) in subtitle | Honest self-comparison annotation |
| baseline arming still works after target-picking is cancelled | Re-arm after cancel |
| d enters target-picking in history detail when baseline armed | Target-picking from detail |
| Enter confirms target from history detail and opens diff | Confirm from detail |
| refresh exits target-picking when no snapshots remain | Edge case in refresh |

## Verification

| Check | Result |
|-------|--------|
| `npm run check` | ✅ PASS |
| Two-step compare chooser tests | ✅ PASS |
| Baseline picker tests | ✅ PASS |
| Adjacent diff still works when no baseline | ✅ PASS |
| Diff self-comparison shows no changes | ✅ PASS |
| Escape preserves baseline in target-picking | ✅ PASS |

## What Was NOT Changed

- No changes to persistence (still snapshot-based)
- No changes to `computeMemorySnapshotDiff()`
- No changes to `/memory` textual commands
- No changes to adjacent diff default behavior (still works when no baseline armed)
- No global keybinding system changes
- No changes to TUI library
- No changes to other packages
- No multi-snapshot range comparison (would imply event provenance not supported by persistence)

## Explicit Snapshot-ID Compare (Pass 8)

The textual compare surface was extended to support direct snapshot-ID comparison using `entryId` values visible in `/memory history`.

### Canonical syntax

```
/memory diff <baselineId> <targetId>
```

IDs are shown in `/memory history` output as `[xxxxxxxx]` (first 8 chars of `entryId`), with a usage hint line explaining accepted forms.

### Strict resolution

`SessionManager.resolveMemorySnapshotSelector(input)` and `AgentSession.resolveMemorySnapshotSelector(input)` resolve selectors with strict semantics:

Resolution order:
1. Exact full entryId match (always wins)
2. Exact short-ID match (first 8 chars of an entryId)
3. Strict unique prefix match — prefix must resolve to exactly one snapshot

Supports optional surrounding brackets copied from history output: `[abcd1234]`.

**Ambiguous prefixes are rejected** with a clear error listing all matching candidate IDs.

### Behavior summary

| Input | Outcome |
|-------|---------|
| `/memory diff` | Adjacent diff: current vs previous (unchanged default) |
| `/memory diff <id1> <id2>` | Explicit compare of those two snapshots |
| Ambiguous prefix | Clear error listing matching candidate IDs |
| Either ID invalid/missing | Clear error listing which selector failed |
| Same ID for both | Honest "same snapshot — no changes" message |

### Honest framing

This is direct snapshot-ID comparison over current-branch persisted snapshots, not a provenance log. The implementation explicitly states "(snapshot comparison · not an event log)" in all output. Prefix matching is strict unique-prefix only — no fuzzy matching.

See `docs/MEMORY_DIFF_IMPLEMENTATION.md` for full implementation evidence.

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

### Tests added
33 total tests for the resolution helper in `session-memory.test.ts`. Key addition: deterministic ambiguous-prefix test using controlled IDs with a guaranteed shared prefix to reliably trigger and verify ambiguity rejection.

## Pass 10: Shared selector contract for compare surfaces

To make the textual compare path and future non-UI compare surfaces reuse one explicit contract, selector normalization/resolution now lives in:
- `packages/coding-agent/src/core/snapshot-selector-resolver.ts`
- tested by `packages/coding-agent/src/core/snapshot-selector-resolver.test.ts`

The compare surface continues to call `SessionManager.resolveMemorySnapshotSelector()`, but that method now delegates to the pure helper and contributes the current-branch-only snapshot list via `getMemoryHistory()`.

### Effective contract
- accepted forms: full ID, displayed short ID, bracketed short ID, strict unique prefix
- normalization: trim whitespace, strip a single surrounding bracket pair, `[]` becomes empty
- precedence: exact full ID first, then exact displayed short ID, then strict unique prefix
- ambiguity: rejected explicitly with candidates
- no-match: rejected explicitly
- same-snapshot compare remains honest because both selectors resolve to the same full `entryId`

### Deferred from this pass
- no shared text formatter for ambiguity/not-found output yet; only the resolution contract itself was centralized
- no UI selector-input flow was added; current UI compare remains selection-based and continues to use the existing snapshot-history state model

## Pass 11: Shared formatter follow-through for textual compare

The textual compare surface now uses a dedicated shared selector formatter rather than assembling selector feedback inline in `interactive-mode.ts`.

### Files
- `packages/coding-agent/src/core/snapshot-selector-formatter.ts`
- `packages/coding-agent/src/core/snapshot-selector-formatter.test.ts`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`

### Reused behaviors
- empty selector → one shared error sentence
- not_found → one shared error sentence
- ambiguous → one shared error sentence plus candidate full IDs rendered with bracketed short IDs
- explicit compare success → one shared resolved-ID header path
- adjacent compare default → one shared adjacent-header path

### Relationship to the resolver contract
- resolver still determines full/short/prefix matching and ambiguity
- formatter consumes resolver outputs and turns them into stable operator-facing text
- compare semantics remain snapshot-based and current-branch-only

## Pass 12: Bounded non-UI compare follow-through

### Chosen non-UI surface
`packages/coding-agent/src/modes/print-mode.ts`

This was the single best bounded candidate because it already produces plain text outside the TUI and could adopt the shared compare wording without a protocol redesign.

### Shared non-UI compare layer
Added `packages/coding-agent/src/core/memory-compare-output.ts`.

Responsibilities:
- render plain-text `/memory history` output for non-UI surfaces
- render plain-text `/memory diff` output for adjacent and explicit selector compare
- reuse the existing selector formatter/header helpers rather than reassembling those messages in print mode

### What print mode now supports
In text print mode, these operator inputs are handled locally:
- `/memory history`
- `/memory diff`
- `/memory diff <baselineId> <targetId>`

### Consistency guarantees
Print mode now matches the interactive textual compare contract in meaning and structure for:
- accepted selector forms
- empty / not_found / ambiguous failure messaging
- resolved full-ID honesty on explicit compare success
- same-snapshot honesty
- snapshot-based-not-event-log framing

### Intentionally deferred
- no RPC compare/history command yet
- no JSON-mode compare/history payload yet
- no broad multi-surface refactor
- no backend/storage changes

## Pass 13: Structured RPC compare/history surface

The next bounded non-UI follow-up is now implemented in RPC mode.

### Chosen RPC design
Structured JSON payloads were chosen over plain-text RPC reuse because RPC already exposes typed command/response contracts in:
- `packages/coding-agent/src/modes/rpc/rpc-types.ts`
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
- `packages/coding-agent/src/modes/rpc/rpc-client.ts`

Print mode remains the plain-text non-UI compare surface through `memory-compare-output.ts`.

### Files
- `packages/coding-agent/src/modes/rpc/rpc-types.ts`
- `packages/coding-agent/src/modes/rpc/rpc-memory.ts`
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
- `packages/coding-agent/src/modes/rpc/rpc-client.ts`
- `packages/coding-agent/src/modes/rpc/rpc-memory-snapshot.test.ts`

### Surface
- `get_memory_history`
- `compare_memory_snapshots`

### Semantics preserved across surfaces
- selector input still resolves through the same full-id / exact-short-id / strict-unique-prefix contract
- current-branch-only scope stays explicit through `branchScope: "current"`
- snapshot framing stays explicit through `historyModel: "snapshot"`
- compare semantics still use `computeMemorySnapshotDiff()`
- same-snapshot compare still returns an honest empty diff
- no provenance or event-log claims were added

### Structured compare outcomes
- `empty_history`
- `initial_snapshot`
- `selector_resolution_failed`
- `ok`

For explicit compare success, resolved selector metadata is returned so automation can see:
- raw input
- normalized matched input
- resolved full snapshot ID

For explicit compare failure, issues are returned structurally with:
- `label`
- `error`
- `matchedInput`
- candidate IDs + short IDs when ambiguous

### Verification
Targeted RPC tests now prove:
- explicit selector reuse
- ambiguous / empty failure structure
- current-branch-only behavior
- same-snapshot honesty
- JSON-serializability

### Intentionally deferred after pass 13
- no generic RPC command mux for all `/memory` subcommands
- no JSON-mode slash-command protocol
- no broad refactor to merge text and structured compare renderers
- no backend/storage changes

## Pass 14: SDK-facing structured compare/history consumer

### Chosen bounded surface
Choose the SDK-facing `AgentSession` surface instead of JSON mode or a subprocess wrapper.

Why this is the best next consumer:
- `packages/coding-agent/docs/sdk.md` already presents `AgentSession` as the primary same-process automation API
- `packages/coding-agent/docs/json.md` remains an event stream, not a typed command/response surface
- `packages/coding-agent/src/modes/rpc/rpc-client.ts` still implies subprocess glue, which this pass explicitly avoids

### Files
- `packages/coding-agent/src/core/memory-snapshot-contract.ts`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/modes/rpc/rpc-memory.ts`
- `packages/coding-agent/src/modes/rpc/rpc-types.ts`
- `packages/coding-agent/src/core/agent-session-memory-snapshot.test.ts`

### Contract consistency across surfaces
The following semantics are now shared across interactive text, print mode, RPC, and SDK:
- current-branch-only scope via `branchScope: "current"`
- snapshot framing via `historyModel: "snapshot"`
- explicit selector resolution through the existing resolver contract
- `sameSnapshot: true` honesty for self-compare
- `status: "initial_snapshot"` honesty for adjacent compare with only one snapshot
- structured selector-resolution failures without inventing a second taxonomy

### Minimal architectural move
The compare/history payload builder moved to `src/core/memory-snapshot-contract.ts`, and RPC now re-exports that shared builder instead of owning a parallel implementation. This keeps semantics identical without introducing a backend rewrite.
