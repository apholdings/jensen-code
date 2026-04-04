# Memory UI Implementation

## Objective

Add a dedicated interactive memory editor/review UI on top of the existing session-local persisted memory backend, without changing storage or prompt-path semantics.

## UI shape chosen

A bounded keyboard-driven memory editor component mounted through the existing interactive-mode selector/prompt-owner flow.

Why this shape:
- reuses jensen-code's existing `showSelector` / `mountPromptOwner` / `restoreCanonicalEditor` architecture
- avoids introducing a foreign modal framework
- keeps all mutations routed through real `AgentSession` methods
- keeps `/memory` textual subcommands intact for scriptable/operator-direct usage

## Entry behavior

- `/memory` opens the interactive memory editor UI
- `/memory show` also opens the interactive memory editor UI
- existing textual workflows remain:
  - `/memory list`
  - `/memory get <key>`
  - `/memory set <key> <value>`
  - `/memory clear`
  - `/memory clear <key>`
  - `/memory review`

## Component

Implemented in:
- `packages/coding-agent/src/modes/interactive/components/memory-editor.ts`

Modes:
- `list`
- `review`
- `history`
- `history_detail`
- `history_diff`
- `add_key`
- `add_value`
- `edit_key`
- `edit_value`
- `confirm_delete`
- `confirm_clear`

Capabilities:
- inspect current active memory items
- see value previews and age labels
- see stale/review markers from the existing freshness heuristic
- add a new memory item
- edit an existing memory item
- delete an item with explicit confirmation
- clear all items with explicit confirmation
- review stale vs fresh sections using the existing heuristic data
- **history view**: inspect memory snapshot timeline (press `h` from list mode)
  - shows snapshots newest-first
  - selecting a snapshot and pressing Enter shows full detail
  - detail view shows all items in that snapshot
  - UI explicitly labels history as "snapshot timeline · not event log"

### Explicit Baseline Picker

UI-first explicit baseline picker allowing the operator to arm any snapshot as the baseline and diff it against any other snapshot. Includes a bounded two-step compare chooser for explicit target selection.

**State model:**
- `armedBaselineIndex: number | null` — chronological index of the armed baseline snapshot
- `diffBaseIndex: number | null` — base snapshot for the current diff pair
- `compareStep: "none" | "target_picking"` — tracks explicit two-step target selection
- Baseline is purely UI state; no persistence change

**Keybindings:**

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

**UI markers:**
- history list: `[baseline]` on armed snapshot line; subtitle shows baseline age + snapshot number
- history list (target_picking): subtitle shows `[baseline: <age>]` and `[selecting target: <age>]`; selected line shows `[target]` marker; `(same snapshot)` shown when baseline === target
- history detail: `[baseline]` after age label when viewing the armed snapshot
- history detail (target_picking): subtitle shows `[baseline: <age>]` and `[selecting target: <age>]`
- history diff: header shows `Baseline:` (not `Base:`) when explicit baseline armed

**Semantic rules:**
- baseline → target diff always uses `computeMemorySnapshotDiff(baseline, target)`
- if target is older than baseline, UI still shows `baseline → target` honestly
- comparing a snapshot to itself shows "No changes between snapshots" cleanly
- adjacent diff (`d` without armed baseline) preserved as the quick default
- `Escape` in target-picking exits target-picking but keeps the baseline armed — operator can re-enter target-picking or clear with `c`
- `c` in target-picking clears the baseline AND exits target-picking

**Honest framing:** baseline selection is UI state over the existing snapshot backend; compare semantics are baseline → target; this remains snapshot-based, not event provenance; "(same snapshot)" annotation when comparing a snapshot to itself.

## Real backend wiring

The component does not maintain a fake shadow backend.
Its callbacks are wired directly to:
- `session.getMemoryItems()`
- `session.getMemoryHistory()`
- `session.setMemoryItem()`
- `session.deleteMemoryItem()`
- `session.clearMemory()`

This means:
- edits and removals persist through the real session JSONL path
- `memory_update` events continue to drive normal status updates
- model-facing memory injection remains unchanged and real
- history view derives from real session snapshot timeline

## Freshness/review behavior

The UI uses the existing helper from:
- `packages/coding-agent/src/core/memory-review.ts`

Semantics preserved:
- age labels: `today`, `yesterday`, `N days ago`, `unknown age`
- stale threshold: 7 days
- stale items marked for review
- explicit wording that freshness is heuristic and older memory should be verified

The UI does not overclaim freshness accuracy.

## Exact files changed

| File | Change |
|------|--------|
| `packages/coding-agent/src/modes/interactive/components/memory-editor.ts` | New interactive memory editor component |
| `packages/coding-agent/src/modes/interactive/components/memory-editor.test.ts` | Targeted UI component tests |
| `packages/coding-agent/src/modes/interactive/components/index.ts` | Exported memory editor component |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | `/memory` no-arg path opens UI; existing subcommands preserved |

## Memory history / audit mode

The interactive memory UI now also includes a history/audit mode sourced from real persisted session entries.

Behavior:
- `h` from list mode opens history mode
- history mode shows memory snapshots for the current branch
- snapshots are displayed newest first for operator relevance
- a snapshot detail view shows the full memory state at that point
- the current active snapshot is marked `[current]`
- the UI explicitly states that this is a `snapshot timeline · not event log`

### Snapshot diff mode (history_diff)

From `history_detail` mode, pressing `d` opens `history_diff` mode:
- Compares the selected snapshot against its immediate previous snapshot
- Both snapshots are identified with relative age labels and timestamps
- Sections rendered when non-empty:
  - `+ Added` (green) — keys only in the target snapshot
  - `- Removed` (red) — keys only in the base snapshot
  - `~ Changed` (blue) — keys in both snapshots with different values (shows old→new preview)
- Each section truncated to `maxVisible` items
- `↑↓` navigate to different target snapshots (base stays fixed)
- `Escape` returns to `history_detail`

Uses the shared `computeMemorySnapshotDiff()` from `core/memory-diff.ts` — one computation path for text and UI.

Backend source:
- `session.getMemoryHistory()`
- `SessionManager.getMemoryHistory()`

This uses persisted `session_memory` custom entries only and does not fabricate per-operation events.

## Verification

Targeted tests:
- `packages/coding-agent/src/modes/interactive/components/memory-editor.test.ts`
  - 17 tests passing
- `packages/coding-agent/src/core/session-memory.test.ts`
  - 9 tests passing
- `packages/coding-agent/src/core/memory-review.test.ts`
  - 3 tests passing

Additional verification:
- `npm run check`

## What was intentionally deferred

- no dedicated external-editor-based memory editing flow
- no multi-line rich memory editor semantics beyond bounded single-value editing
- no workspace/global memory selector model
- no auto-prune or expiry policy
- no separate overlay stack or new TUI framework abstractions
- no true event-sourced memory audit log; history remains snapshot-based
