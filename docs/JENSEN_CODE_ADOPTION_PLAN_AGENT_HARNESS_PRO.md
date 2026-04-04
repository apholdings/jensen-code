# Adoption Plan: agent_harness_pro → jensen-code

## Chosen Bounded Scope

Two improvements were selected for this bounded pass:

### 1. Rich Tool Prompt Descriptions

**Problem:** jensen-code uses terse one-line tool descriptions (`toolDescriptions` object in `system-prompt.ts`), giving the LLM minimal guidance about tool behavior, safety rules, or best practices.

**Solution:** Created `src/core/tools/tools-prompt-data.ts` with rich LLM-facing instructions for all 7 built-in tools (read, bash, edit, write, grep, find, ls). Each description covers:
- Usage and when to use
- Parameters with descriptions
- Behavior details
- Safety notes
- Best practices

This follows the agent_harness_pro pattern where each tool has dedicated prompt instructions (e.g., `tools/BashTool/prompt.ts`).

**Why selected:** Highest leverage per token of code changed. Improves model behavior immediately without changing any tool implementation or API.

### 2. /doctor Diagnostics Command

**Problem:** jensen-code has no proactive diagnostics. Users don't know their config/extension/model health at a glance.

**Solution:** Added `/doctor` slash command with 6 health checks:
1. **Config files** — JENSEN.md/AGENTS.md/CLAUDE.md detection
2. **Settings** — .pi/settings.json validity
3. **Extensions** — Count of loaded extensions
4. **Skills** — Count of loaded skills
5. **Themes** — Count of loaded themes
6. **Model** — Current model and API key status
7. **Git** — Repository status and uncommitted changes
8. **Shell** — Basic shell functionality check

**Why selected:** Quick implementation, immediate operator value, no API changes, easy to extend.

## Files Changed (Pass 1: Tool Prompts + Diagnostics)

| File | Type | Change |
|------|------|--------|
| `packages/coding-agent/src/core/tools/tools-prompt-data.ts` | NEW | Rich tool prompt descriptions for all 7 built-in tools |
| `packages/coding-agent/src/core/system-prompt.ts` | MOD | Replaced `toolDescriptions` object with `getToolDescription()` calls |
| `packages/coding-agent/src/core/doctor.ts` | NEW | Diagnostics module with 8 health checks and formatted output |
| `packages/coding-agent/src/core/slash-commands.ts` | MOD | Added `/doctor` to BUILTIN_SLASH_COMMANDS |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | MOD | Added /doctor handler and help reference |

## Pass 2: Visible Orchestrator Plan Tracking

### Chosen Bounded Scope
The next priority after pass 1 is visible orchestrator plan/todo tracking:
- a model-callable `todo_write` tool that the LLM uses to track tasks
- in-memory session state backing the todo list
- an operator-visible TUI component that updates in real time as the model calls `todo_write`
- state model: `pending | in_progress | completed` with `content` and `activeForm` fields

This follows agent_harness_pro's TodoWriteTool pattern (tools/TodoWriteTool/) but is implemented independently for jensen-code's architecture.

### Files Changed (Pass 2)

| File | Type | Change |
|------|------|--------|
| `packages/coding-agent/src/core/tools/todo-write.ts` | NEW | Built-in `todo_write` tool with TypeBox schema and validation |
| `packages/coding-agent/src/core/tools/index.ts` | MOD | Export `todoWriteTool` and `createTodoWriteTool` |
| `packages/coding-agent/src/core/tools/tools-prompt-data.ts` | MOD | Added `todo_write` tool prompt description |
| `packages/coding-agent/src/core/agent-session.ts` | MOD | Added `_todos` state, `getTodos()`, `_setTodos()`, `todo_update` event, tool registration |
| `packages/coding-agent/src/modes/interactive/components/todo-list.ts` | NEW | TUI component rendering todo status + task list |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | MOD | Wired todo list container, `todo_update` event handler, /doctor in help |

## Verification Performed

| Check | Result |
|-------|--------|
| `npm run check` (biome + tsc + typecheck) | ✅ PASS — all packages |
| No type errors | ✅ Clean |
| No lint warnings | ✅ Clean |
| `buildSystemPrompt()` API unchanged | ✅ Confirmed |
| Tool behavior unchanged (pass 1) | ✅ Only prompt text affected |
| /doctor registered in slash commands | ✅ In BUILTIN_SLASH_COMMANDS |
| /doctor handler wired in interactive mode | ✅ Handles text === "/doctor" case |
| todo_write in default active tools | ✅ In default tool list |
| memory_write in default active tools | ✅ In default tool list |
| todo_update event defined | ✅ In AgentSessionEvent union |
| memory_update event defined | ✅ In AgentSessionEvent union |
| TodoListComponent mounted in init() | ✅ addIfMissing(this.ui, this.todoContainer) |
| buildSessionContext injects memory | ✅ `memoryContext` inserted before branch messages |
| todo snapshots restored on session load | ✅ `sessionContext.todos` restored into AgentSession |
| compaction summary augmented with active state | ✅ `_augmentCompactionSummary()` used in manual + auto compaction |
| targeted session-memory test added | ✅ `packages/coding-agent/src/core/session-memory.test.ts` |

## Architecture Alignment

- **No external dependencies added** — doctor.ts uses only node:child_process, node:fs, node:path
- **No API changes** — buildSystemPrompt() signature unchanged, backward compatible with toolSnippets
- **No tool implementation changes** — prompt extraction is purely text-level
- **No TUI framework changes** — /doctor uses existing TUI components
- **Monorepo boundaries respected** — only coding-agent package modified

## Pass 3: Compaction + Memory

### Chosen bounded scope
- preserve active todo and memory state through the real compaction path
- add a bounded session-local structured memory model
- inject memory into the actual model-facing context path via `buildSessionContext()`
- persist todo snapshots so visible plan tracking survives resume and compaction
- expose active working state to the operator through `/session` and a compact memory status line

### Files changed (Pass 3)

| File | Type | Change |
|------|------|--------|
| `packages/coding-agent/src/core/memory.ts` | NEW | Session-local structured memory model and helpers |
| `packages/coding-agent/src/core/tools/memory-write.ts` | NEW | Built-in `memory_write` tool |
| `packages/coding-agent/src/core/messages.ts` | MOD | Added `memoryContext` message type and LLM conversion |
| `packages/coding-agent/src/core/session-manager.ts` | MOD | Added session memory/todo persistence helpers and context injection |
| `packages/coding-agent/src/core/agent-session.ts` | MOD | Added memory state, persistence, restore flow, and compaction summary augmentation |
| `packages/coding-agent/src/core/tools/index.ts` | MOD | Registered `memory_write` and ensured todo/memory are in built-in tools |
| `packages/coding-agent/src/core/tools/tools-prompt-data.ts` | MOD | Added `memory_write` prompt guidance |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | MOD | Added memory status rendering and `/session` working-state visibility |
| `packages/coding-agent/src/core/session-memory.test.ts` | NEW | Targeted tests for memory injection/helpers |
| `packages/coding-agent/src/core/memory-review.ts` | NEW | Freshness-review helper for operator `/memory review` |
| `packages/coding-agent/src/core/memory-review.test.ts` | NEW | Targeted tests for freshness heuristics |
| `docs/CONTEXT_COMPACTION_IMPLEMENTATION.md` | NEW | Compaction implementation evidence |
| `docs/MEMORY_HANDLING_IMPLEMENTATION.md` | NEW | Memory implementation evidence |

## Remaining Backlog (Prioritized)

| Priority | Improvement | Scope | Notes |
|----------|-------------|------|-------|
| 1 | Swarm/operator task lifecycle | Medium-High | Model agent_harness_pro's task state tracking for subagent execution (see swarm follow-up below) |
| 2 | Memory freshness policy | Medium | Extend bounded review heuristics into clearer stale-memory lifecycle semantics |
| 3 | Settings validation errors | Medium | Add Zod-style human-readable validation errors for config files |
| 4 | Custom error hierarchy | Medium | Add specific error types for config parsing, shell failures, session errors |
| 5 | Context-based keybindings | Medium | Add binding contexts for different UI states |
| 6 | Skill frontmatter schema | Medium | Add YAML frontmatter to SKILL.md for metadata |

## Pass 5: Memory History / Audit View

### Chosen bounded scope
- derive memory history from real persisted `session_memory` custom entries already stored in session JSONL
- present that history through `/memory history`
- integrate a history mode into the existing interactive memory editor UI
- keep the model-facing memory injection path unchanged
- be explicit that history is snapshot-based, not a true event log

### Files changed (Pass 5)

| File | Type | Change |
|------|------|--------|
| `packages/coding-agent/src/core/memory.ts` | MOD | Added `MemoryHistorySnapshot` type |
| `packages/coding-agent/src/core/session-manager.ts` | MOD | Added `getMemoryHistory()` over persisted current-branch snapshots |
| `packages/coding-agent/src/core/agent-session.ts` | MOD | Added `getMemoryHistory()` accessor |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | MOD | Added `/memory history` textual output |
| `packages/coding-agent/src/modes/interactive/components/memory-editor.ts` | MOD | Added history and history-detail modes reachable from the editor UI |
| `packages/coding-agent/src/core/session-memory.test.ts` | MOD | Added history extraction tests |
| `docs/MEMORY_HISTORY_IMPLEMENTATION.md` | NEW | Memory history implementation evidence |

## Pass 4: Interactive Memory UI

### Chosen bounded scope
- open a dedicated interactive memory UI from `/memory`
- keep the existing textual `/memory` subcommands intact
- reuse the existing session-local persisted memory backend
- support inspect/review/edit/remove/clear flows with explicit confirmation for destructive actions
- keep freshness semantics bounded and heuristic

### Files changed (Pass 4)

| File | Type | Change |
|------|------|--------|
| `packages/coding-agent/src/modes/interactive/components/memory-editor.ts` | NEW | Dedicated interactive memory editor/review component |
| `packages/coding-agent/src/modes/interactive/components/memory-editor.test.ts` | NEW | Targeted UI component tests |
| `packages/coding-agent/src/modes/interactive/components/index.ts` | MOD | Exported memory editor component |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | MOD | `/memory` now opens the UI on the no-arg path while preserving subcommands |
| `docs/MEMORY_UI_IMPLEMENTATION.md` | NEW | Interactive memory UI evidence |

## Pass 6: Memory Snapshot Diff

### Chosen bounded scope

Add a bounded memory snapshot diff view comparing adjacent real persisted snapshots. No backend redesign, no fake event log, one shared diff computation path for text and UI.

### Shared computation path

Added `packages/coding-agent/src/core/memory-diff.ts` with a single pure function:

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

One computation path shared by textual command and interactive UI.

### Files changed (Pass 6)

| File | Type | Change |
|------|------|--------|
| `packages/coding-agent/src/core/memory-diff.ts` | NEW | Shared pure diff function and types |
| `packages/coding-agent/src/core/session-memory.test.ts` | MOD | 7 targeted diff tests |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | MOD | `/memory diff` and `/memory history diff` commands |
| `packages/coding-agent/src/modes/interactive/components/memory-editor.ts` | MOD | `history_diff` mode, `d` key from detail mode |
| `docs/MEMORY_DIFF_IMPLEMENTATION.md` | NEW | Memory diff implementation evidence |

### Operator surfaces

**Textual:** `/memory diff` — compares current snapshot vs previous on current branch. Sections rendered only when non-empty. Honest labeling throughout.

**Interactive UI:** from `history_detail` mode, press `d` — opens `history_diff` showing base→target diff with both snapshots identified. `↑↓` navigates target, `Escape` returns to detail.

## Pass 7: Two-Step Compare Chooser for Memory History

### Chosen bounded scope
UI-assisted two-step compare chooser: arm any snapshot as baseline, explicitly pick a target, then open diff. No persistence redesign, adjacent diff preserved as quick default.

### Shared computation path
Baseline picker is purely UI state over the existing snapshot backend. Always uses `computeMemorySnapshotDiff(base, target)` for diff computation. The base is set to the armed baseline when explicit; otherwise defaults to adjacent previous snapshot.

### State model
- `armedBaselineIndex: number | null` — chronological index of explicitly armed baseline snapshot
- `diffBaseIndex: number | null` — base snapshot for the current diff pair
- `compareStep: "none" | "target_picking"` — tracks explicit target-picking step
- `selectedIndex` — current selection (chronological index in detail/diff modes, reversed display index in list mode)

### UX Flow
```
armed baseline + d ──→ target_picking (baseline stays armed)
                            ├─ Enter / d ──→ history_diff
                            ├─ c ──→ baseline cleared + compareStep = "none"
                            └─ Escape ──→ compareStep = "none" (baseline kept)
```

### Files changed (Pass 7)

| File | Type | Change |
|------|------|--------|
| `packages/coding-agent/src/modes/interactive/components/memory-editor.ts` | MOD | Added `compareStep` state, target-picking handlers in history/history_detail modes, UI markers and hints |
| `packages/coding-agent/src/modes/interactive/components/memory-editor.test.ts` | MOD | Updated diff tests for two-step flow; added 12 new two-step chooser tests |
| `docs/MEMORY_COMPARE_IMPLEMENTATION.md` | MOD | Updated to document two-step compare chooser |
| `docs/MEMORY_UI_IMPLEMENTATION.md` | MOD | Updated baseline picker section |
| `docs/MEMORY_HISTORY_IMPLEMENTATION.md` | MOD | Updated keybindings table |
| `docs/MEMORY_DIFF_IMPLEMENTATION.md` | MOD | Updated explicit baseline semantics |
| `docs/MEMORY_HANDLING_IMPLEMENTATION.md` | MOD | Updated baseline picker section |
| `docs/JENSEN_CODE_ADOPTION_PLAN_AGENT_HARNESS_PRO.md` | MOD | Updated this pass |
| `docs/REFERENCE_HARNESS_AUDIT_AGENT_HARNESS_PRO.md` | MOD | Updated pass 7 |

### Operator surfaces

**Keybindings:**

| Mode | Key | Action |
|------|-----|--------|
| history list / detail | `b` | Arm currently selected snapshot as baseline |
| history list / detail | `c` | Clear armed baseline |
| history list / detail | `d` (no baseline) | Diff adjacent → selected (quick default, immediate) |
| history list / detail | `d` (baseline armed) | Enter target-picking step |
| history list / detail (target_picking) | `↑↓` or `↑↓←→` | Select target snapshot |
| history list / detail (target_picking) | `Enter` / `d` | Confirm target → open diff |
| history list / detail (target_picking) | `c` | Clear baseline and exit target-picking |
| history list / detail (target_picking) | `Escape` | Exit target-picking, keep baseline armed |
| history diff | `c` | Clear armed baseline |

**UI markers:**
- history list (target_picking): subtitle shows `[baseline: <age>]` + `[selecting target: <age>]`; selected line shows `[target]`
- history detail (target_picking): same subtitle annotation; `(same snapshot)` when baseline === target
- history diff: header shows `Baseline:` (not `Base:`) when explicit baseline is armed

**Honest semantics:**
- baseline is UI state over the existing snapshot backend
- compare semantics are baseline → target (not event log)
- if target is older/newer than baseline, UI still shows `baseline → target` honestly
- comparing a snapshot to itself shows "(same snapshot)" annotation and "No changes between snapshots"
- adjacent diff (`d` without armed baseline) still works immediately as quick default
- `Escape` in target-picking preserves the baseline — operator can re-enter picking or clear with `c`

### Preservation of existing behavior
- Existing history view remains
- Adjacent diff (`d` without armed baseline) works as quick default (immediate, no target-picking)
- Existing `/memory` textual commands unchanged
- `computeMemorySnapshotDiff()` unchanged — only which snapshots are passed as base/target changes

## Pass 8: Explicit Snapshot-ID Compare

### Chosen bounded scope
Direct snapshot-ID comparison for the textual `/memory diff` command using `entryId` values from `getMemoryHistory()`. No UI redesign, no provenance log. Bounded ergonomic improvements for copy-friendly ID input.

### Strict resolution helper
`SessionManager.resolveMemorySnapshotSelector(input)` and `AgentSession.resolveMemorySnapshotSelector(input)` resolve selectors with strict unique-prefix semantics:
- Resolution order: exact full entryId, exact short ID (8 chars), strict unique prefix
- Supports optional brackets: `[abcd1234]` copied from history output
- Ambiguous prefixes rejected with matching candidates listed
- No fuzzy matching, no hidden lookup rules

### History output includes usage hint
`/memory history` now includes a hint explaining accepted forms for `/memory diff` IDs.

### Canonical syntax
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
| `docs/MEMORY_HISTORY_IMPLEMENTATION.md` | MOD | Updated history output |
| `docs/REFERENCE_HARNESS_AUDIT_AGENT_HARNESS_PRO.md` | MOD | Updated pass 8 |
| `docs/JENSEN_CODE_ADOPTION_PLAN_AGENT_HARNESS_PRO.md` | MOD | Updated pass 8 |

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
- No provenance log — this is direct snapshot-ID comparison over current-branch persisted snapshots
- No fuzzy matching or hidden lookup rules
- No multi-snapshot range comparison
- Adjacent diff default preserved unchanged
- No changes to the interactive memory editor

## Swarm/Operator Follow-Up Plan

### Current state
jensen-code's todo tracking is session-local, model-driven, and now persisted in session custom entries. The visible plan exists in the interactive TUI and survives session resume. The subagent/orchestration layer uses the global Jensen swarm protocol (defined in JENSEN.md) with role-pure agents launched via the `subagent` extension.

### Reference evidence
agent_harness_pro's swarm task tracking comes from:
- `tools/AgentTool/AgentTool.tsx` — subagent execution coordinator
- `tasks/LocalAgentTask/LocalAgentTask.tsx` — background agent state machine (status, progress, todo_list parsed from remote logs)
- `tasks/RemoteAgentTask/RemoteAgentTask.tsx` — remote agent polling + todo extraction
- `tools/TeamCreateTool/TeamCreateTool.ts` — team/swarm creation establishing task directory identity
- `utils/tasks.ts` — TodoV2 persistence model with blocking graph

### What should grow next
1. **Task identity for subagent execution** — When a subagent is spawned via `subagent`, track it in session state with: task name, spawned_at, status (running/done/failed), and a todo reference. This maps subagent execution directly to the visible plan surface.
2. **Dedicated plan entry type** — Todo snapshots already persist via custom session entries; a future `plan_entry` SessionEntry variant would formalize that state and improve tooling clarity.
3. **Parent session subagent awareness** — Interactive-mode should show active subagent tasks alongside the parent session's todo list, distinguishing "what I'm doing" from "what my children are doing."
4. **Blocking dependencies** — Model the TodoV2 blocking graph (`blocks`/`blockedBy`) for task ordering in multi-step workflows.

### Exact jensen-code surfaces
- `packages/coding-agent/src/core/agent-session.ts` — host for subagent task state
- `packages/coding-agent/src/core/session-manager.ts` — new `PlanEntry` SessionEntry type
- `packages/coding-agent/src/modes/interactive/components/todo-list.ts` — extend to show subagent status
- `packages/agent/src/` — subagent task lifecycle events to wire into plan state
- `~/.jensen/agent/agents/` — role-pure agent definitions (existing swarm protocol)

## Notes on What Was NOT Changed

- No changes to the TUI library (tui package)
- No changes to the agent runtime (agent package)
- No changes to the LLM provider abstraction (ai package)
- No changes to extension API or loading
- No external dependencies added
- No changes to print/RPC mode rendering (todo/memory UI remains interactive-mode only)
- No giant rewrite of the existing compaction algorithm
- No workspace-global memory system in this pass

## Pass 9: Bounded Copy-Friendly Ergonomics

### Chosen bounded scope
Bounded ergonomic improvements for the text-based `/memory diff` workflow: copy-friendly bracket notation, strict deterministic resolution, clear error messaging, improved history output guidance, and deterministic test coverage for all resolution paths.

### Resolution helper
`SessionManager.resolveMemorySnapshotSelector(input)` and `AgentSession.resolveMemorySnapshotSelector(input)` resolve selectors with bracket-tolerant, strict semantics:
- Exact full entryId match (always wins)
- Exact short-ID match (first 8 chars)
- Strict unique prefix match — prefix must resolve to exactly one snapshot
- Supports optional brackets: `[abcd1234]` copied from history output
- Empty input returns `error: "empty"`
- Not-found returns `error: "not_found"` with empty candidates
- Ambiguous prefix returns `error: "ambiguous"` with all matching candidate IDs

### History output guidance
`/memory history` shows short IDs as `[xxxxxxxx]` in brackets after each age label, with a usage hint explaining accepted forms:
```
Use /memory diff <baselineId> <targetId> to compare any two snapshots.
IDs shown in brackets ([xxxxxxxx]) can be copied directly; brackets are optional.
Accepted: full entryId, 8-char short ID, or strict unique prefix.
```

### /memory diff command path
`handleMemoryCommand()` uses the shared resolution helper for explicit ID compare:
- Resolves both baseline and target selectors via `resolveMemorySnapshotSelector()`
- Reports FULL resolved IDs in diff output header (full `entryId` shown)
- Reports ambiguity clearly with candidate list
- Reports no-match clearly with failed selector
- Reports same-snapshot honestly without implying a diff was computed
- Adjacent diff (no IDs) unchanged

### Syntax fixes applied
Fixed escaped backtick template literal issue in `interactive-mode.ts`:
- Lines 739 and 754 used `\`[\${cand.slice(0, 8)}]\`` which confused the Biome parser (invalid `\]` escape)
- Replaced with `theme.fg("muted", \`[\${cand.slice(0, 8)}]\`)` using string concatenation instead

### Tests added
33 total tests in `session-memory.test.ts`:
| Test | Coverage |
|------|----------|
| exact full entryId | Exact full ID resolution |
| exact short ID (first 8 chars) | Short ID resolution |
| bracketed short ID | Bracket-stripping from history output |
| bracketed full ID | Bracket-stripping for full IDs |
| strict unique prefix match | Unique prefix resolution |
| ambiguous prefix with controlled IDs (deterministic) | New: uses controlled IDs with shared prefix to reliably test ambiguity rejection |
| ambiguous prefix (probabilistic) | Ambiguous rejection with candidates listed |
| not_found for nonexistent ID | Not-found error |
| empty selector | Empty input rejection |
| same-snapshot comparison | Honest same-snapshot resolution |
| empty candidates when unambiguous | Candidates array correctness |

### Type fix
Fixed `InstanceType<typeof SessionManager>` TypeScript error in test helper — `SessionManager` is already an instance type; using it as `InstanceType<typeof SessionManager>` fails because the constructor is not abstract. Changed to `SessionManager` directly.

### Files changed (Pass 9)

| File | Type | Change |
|------|------|--------|
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | MOD | Fixed escaped backtick template literal syntax for error candidate lines (lines 739, 754) |
| `packages/coding-agent/src/core/session-memory.test.ts` | MOD | Added deterministic ambiguous-prefix test with controlled IDs; fixed type annotation in `makeSnapshots` helper |
| `docs/REFERENCE_HARNESS_AUDIT_AGENT_HARNESS_PRO.md` | MOD | Added pass 9 |
| `docs/JENSEN_CODE_ADOPTION_PLAN_AGENT_HARNESS_PRO.md` | MOD | Added pass 9 |
| `docs/MEMORY_HANDLING_IMPLEMENTATION.md` | MOD | Added pass 9 |
| `docs/MEMORY_HISTORY_IMPLEMENTATION.md` | MOD | Added pass 9 |
| `docs/MEMORY_DIFF_IMPLEMENTATION.md` | MOD | Added pass 9 |
| `docs/MEMORY_COMPARE_IMPLEMENTATION.md` | MOD | Added pass 9 |

### Verification

| Check | Result |
|-------|--------|
| `npm run check` | ✅ PASS |
| Targeted tests (33 tests) | ✅ PASS |
| All resolution paths tested deterministically | ✅ PASS |
| Biome parse errors resolved | ✅ PASS |
| TypeScript errors resolved | ✅ PASS |

## Pass 10: Dedicated Snapshot Selector Resolver Module

### Chosen bounded scope
- keep the existing snapshot backend and compare surfaces intact
- extract selector normalization + deterministic resolution into one dedicated helper module
- rewire `SessionManager.resolveMemorySnapshotSelector()` to delegate to that helper
- move detailed selector semantics into a dedicated test module while keeping a small SessionManager integration surface for current-branch semantics

### Files changed (Pass 10)

| File | Type | Change |
|------|------|--------|
| `packages/coding-agent/src/core/snapshot-selector-resolver.ts` | MOD | Finalized dedicated pure resolver contract: normalization, exact full ID, exact short ID, strict unique prefix, ambiguity/no-match handling |
| `packages/coding-agent/src/core/session-manager.ts` | MOD | Replaced inline selector resolution logic with delegation to shared resolver helper |
| `packages/coding-agent/src/core/snapshot-selector-resolver.test.ts` | NEW | Dedicated resolver tests for normalization, precedence, ambiguity, no-match, same-snapshot compatibility |
| `packages/coding-agent/src/core/session-memory.test.ts` | MOD | Trimmed resolver coverage to SessionManager integration/current-branch semantics |
| `docs/REFERENCE_HARNESS_AUDIT_AGENT_HARNESS_PRO.md` | MOD | Added pass 10 reference notes |
| `docs/JENSEN_CODE_ADOPTION_PLAN_AGENT_HARNESS_PRO.md` | MOD | Added pass 10 plan/evidence |
| `docs/MEMORY_HANDLING_IMPLEMENTATION.md` | MOD | Added resolver module section |
| `docs/MEMORY_HISTORY_IMPLEMENTATION.md` | MOD | Added selector-contract section |
| `docs/MEMORY_DIFF_IMPLEMENTATION.md` | MOD | Added dedicated resolver implementation note |
| `docs/MEMORY_COMPARE_IMPLEMENTATION.md` | MOD | Added shared selector-contract note |

### Resolver contract summary
- normalization: trim whitespace, strip one surrounding pair of brackets, treat `[]` as empty
- resolution order: exact full `entryId` → exact displayed short ID (8 chars) → strict unique prefix
- ambiguity: rejected with candidate full IDs listed
- no match: explicit `not_found`
- current-branch-only semantics: supplied by `SessionManager.getMemoryHistory()` before calling the pure helper
- returned metadata includes full resolved ID for honest operator output and downstream compare use

### Intentionally deferred
- rewiring the interactive history UI to import the resolver helper directly (not needed yet because UI compare remains selection-based, not text-selector-based)
- adding a shared formatter for textual resolution errors (current command output already stays honest and unchanged)
- exposing the resolver from a broader barrel API (direct module import is sufficient for current consumers)

### Best next follow-up
Add one small shared formatter/helper for selector resolution failures so any future non-UI compare surfaces can reuse both the resolution contract and the operator-facing ambiguous/not-found messaging without duplicating text assembly in command handlers.

## Pass 11: Shared Snapshot Selector Formatter

### Chosen bounded scope
- keep snapshot resolution in `packages/coding-agent/src/core/snapshot-selector-resolver.ts`
- extract operator-facing selector messaging into one shared helper module
- rewire `/memory history` and explicit `/memory diff <baselineId> <targetId>` textual output to use that helper
- keep compare semantics and backend behavior unchanged

### Files changed (Pass 11)

| File | Type | Change |
|------|------|--------|
| `packages/coding-agent/src/core/snapshot-selector-formatter.ts` | NEW | Shared operator-facing selector guidance, failure formatting, and resolved-ID header formatting |
| `packages/coding-agent/src/core/snapshot-selector-formatter.test.ts` | NEW | Dedicated formatter tests for empty/not_found/ambiguous/guidance/header behavior |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | MOD | `/memory history` and explicit `/memory diff` now use shared selector formatter output |
| `docs/REFERENCE_HARNESS_AUDIT_AGENT_HARNESS_PRO.md` | MOD | Added pass 11 reference notes |
| `docs/JENSEN_CODE_ADOPTION_PLAN_AGENT_HARNESS_PRO.md` | MOD | Added pass 11 plan/evidence |
| `docs/MEMORY_HANDLING_IMPLEMENTATION.md` | MOD | Added shared formatter note |
| `docs/MEMORY_HISTORY_IMPLEMENTATION.md` | MOD | Added shared history-guidance note |
| `docs/MEMORY_DIFF_IMPLEMENTATION.md` | MOD | Added shared formatter contract note |
| `docs/MEMORY_COMPARE_IMPLEMENTATION.md` | MOD | Added compare-surface reuse note |

### Formatter contract summary
- `formatSnapshotSelectorHistoryGuidance()` returns the reusable copy/paste guidance for selector forms
- `formatSnapshotSelectorResolutionFailure()` maps resolver failures into one deterministic operator-facing block
- `formatResolvedSnapshotId()` and `formatExplicitDiffHeader()` centralize exact short-ID/full-ID output for explicit compare success
- `formatAdjacentDiffHeader()` centralizes the adjacent default compare header
- the formatter is pure string formatting only; resolution stays in the resolver module

### Verification

| Check | Result |
|-------|--------|
| `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run src/core/snapshot-selector-formatter.test.ts src/core/snapshot-selector-resolver.test.ts src/core/session-memory.test.ts` | ✅ PASS |
| `npm run check` | ✅ PASS |
| Empty selector formatting | ✅ Verified |
| Not-found formatting | ✅ Verified |
| Ambiguous formatting with candidate list | ✅ Verified |
| Shared history guidance text | ✅ Verified |
| Explicit compare resolved-ID header reuse | ✅ Verified |
| Adjacent diff default preserved | ✅ Verified |

### Intentionally deferred
- no print/RPC compare surface rewiring yet
- no UI selector-input workflow changes; interactive history compare remains selection-based
- no backend or storage-model changes

### Updated best next follow-up
Reuse the same shared formatter/header path in future non-UI compare surfaces beyond the current interactive command loop so compare output stays fully consistent outside the TUI.

## Pass 12: Print-Mode Non-UI Compare Reuse

### Chosen bounded scope
Select `packages/coding-agent/src/modes/print-mode.ts` as the next real non-UI compare surface.

Why this target:
- it is already a real text output surface outside `interactive-mode.ts`
- it can expose explicit selector compare output without changing backend/storage semantics
- it is the smallest honest place to reuse the shared selector formatter/header path before any broader RPC/API work

### Files changed (Pass 12)

| File | Type | Change |
|------|------|--------|
| `packages/coding-agent/src/core/memory-compare-output.ts` | NEW | Shared plain-text history/diff renderer for non-UI memory compare output, built on the existing formatter/header helpers |
| `packages/coding-agent/src/core/memory-compare-output.test.ts` | NEW | Targeted tests for history guidance, explicit diff headers, failure messaging, same-snapshot honesty, and initial-snapshot output |
| `packages/coding-agent/src/modes/print-mode.ts` | MOD | Intercepts `/memory history` and `/memory diff [baselineId targetId]` in text print mode and renders via the shared compare-output helper |
| `packages/coding-agent/src/modes/print-mode.test.ts` | NEW | Targeted tests proving print mode now exposes the non-UI compare surface |
| `docs/REFERENCE_HARNESS_AUDIT_AGENT_HARNESS_PRO.md` | MOD | Added pass 12 reference notes |
| `docs/MEMORY_HANDLING_IMPLEMENTATION.md` | MOD | Added print-mode compare reuse note |
| `docs/MEMORY_HISTORY_IMPLEMENTATION.md` | MOD | Added non-UI history surface note |
| `docs/MEMORY_DIFF_IMPLEMENTATION.md` | MOD | Added print-mode diff reuse note |
| `docs/MEMORY_COMPARE_IMPLEMENTATION.md` | MOD | Added chosen non-UI surface and defer notes |
| `docs/JENSEN_CODE_ADOPTION_PLAN_AGENT_HARNESS_PRO.md` | MOD | Added this pass |

### Reuse semantics
- selector resolution still comes from `resolveMemorySnapshotSelector()` over current-branch persisted snapshots
- operator-facing selector failures still come from `formatSnapshotSelectorResolutionFailure()`
- explicit compare headers still come from `formatExplicitDiffHeader()`
- adjacent compare headers still come from `formatAdjacentDiffHeader()`
- history guidance still comes from `formatSnapshotSelectorHistoryGuidance()`

### What changed in behavior
Print mode text output now handles these commands locally instead of sending them to the model:
- `/memory history`
- `/memory diff`
- `/memory diff <baselineId> <targetId>`

This keeps explicit selector compare wording consistent outside `interactive-mode.ts` while leaving interactive mode, RPC mode, diff computation, session storage, compaction, and model-facing memory injection unchanged.

### Verification

| Check | Result |
|-------|--------|
| `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run src/core/snapshot-selector-formatter.test.ts src/core/memory-compare-output.test.ts src/modes/print-mode.test.ts src/core/session-memory.test.ts` | ✅ PASS |
| `npm run check` | ✅ PASS |
| Print-mode `/memory history` uses shared guidance | ✅ Verified |
| Print-mode explicit `/memory diff <baselineId> <targetId>` uses shared failure/header path | ✅ Verified |
| Same-snapshot compare stays honest in shared renderer | ✅ Verified |
| Adjacent diff default remains honest | ✅ Verified |

### Intentionally deferred
- no RPC compare command yet
- no JSON-mode compare protocol yet
- no interactive-mode refactor to consume the new plain-text renderer
- no backend/schema/storage changes

### Best next follow-up
Add one bounded RPC compare surface that reuses `memory-compare-output.ts` for text payloads or an adjacent structured payload while preserving the same selector contract and snapshot-based framing.

## Pass 13: Structured RPC memory snapshot surface

### Chosen bounded scope
Add one small structured RPC pair in `packages/coding-agent/src/modes/rpc/`:
- `get_memory_history`
- `compare_memory_snapshots`

This was chosen over plain-text RPC reuse because repo evidence already shows RPC as a typed JSON command/response surface:
- `packages/coding-agent/src/modes/rpc/rpc-types.ts`
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
- `packages/coding-agent/src/modes/rpc/rpc-client.ts`

Print mode remains the plain-text non-UI surface. RPC now gets a structured wrapper that reuses the same underlying semantics rather than a second plain-text channel.

### Files changed (Pass 13)

| File | Type | Change |
|------|------|--------|
| `packages/coding-agent/src/modes/rpc/rpc-types.ts` | MOD | Added typed payloads and command/response shapes for memory history + compare |
| `packages/coding-agent/src/modes/rpc/rpc-memory.ts` | NEW | Added structured RPC history/compare helper reusing current memory snapshot backend and selector contract |
| `packages/coding-agent/src/modes/rpc/rpc-mode.ts` | MOD | Added `get_memory_history` and `compare_memory_snapshots` handlers |
| `packages/coding-agent/src/modes/rpc/rpc-client.ts` | MOD | Added typed client helpers for the new RPC commands |
| `packages/coding-agent/src/modes/rpc/rpc-memory-snapshot.test.ts` | NEW | Added targeted tests for structured RPC semantics and current-branch behavior |
| `packages/coding-agent/docs/rpc.md` | MOD | Documented the new RPC commands and payload semantics |
| `docs/REFERENCE_HARNESS_AUDIT_AGENT_HARNESS_PRO.md` | MOD | Added pass 13 reference notes |
| `docs/MEMORY_HANDLING_IMPLEMENTATION.md` | MOD | Added structured RPC surface note |
| `docs/MEMORY_HISTORY_IMPLEMENTATION.md` | MOD | Added RPC history payload note |
| `docs/MEMORY_DIFF_IMPLEMENTATION.md` | MOD | Added RPC compare payload note |
| `docs/MEMORY_COMPARE_IMPLEMENTATION.md` | MOD | Added structured RPC reuse note |
| `docs/JENSEN_CODE_ADOPTION_PLAN_AGENT_HARNESS_PRO.md` | MOD | Added this pass |

### Reuse path
- history still comes from `SessionManager.getMemoryHistory()` over persisted current-branch `session_memory` snapshots
- explicit selector compare still resolves through `SessionManager.resolveMemorySnapshotSelector()` / `AgentSession.resolveMemorySnapshotSelector()`
- diff computation still comes from `computeMemorySnapshotDiff()`
- print mode remains the plain-text consumer of `memory-compare-output.ts`
- RPC uses a thin adjacent structured helper in `rpc-memory.ts` so semantics stay shared without forcing plain-text output into JSON

### Contract summary
- `get_memory_history` returns current-branch snapshots with explicit `branchScope: "current"` and `historyModel: "snapshot"`
- `compare_memory_snapshots` supports:
  - no selectors → adjacent latest-vs-previous compare
  - both selectors → explicit compare using the existing strict resolver contract
- selector failures are structured, not flattened into plain text:
  - `empty`
  - `not_found`
  - `ambiguous`
- resolved selector metadata returns the matched input and resolved full IDs on explicit success
- same-snapshot explicit compare returns `status: "ok"`, `sameSnapshot: true`, and an empty diff honestly
- single-snapshot adjacent compare returns `status: "initial_snapshot"` honestly

### Verification
| Check | Result |
|-------|--------|
| targeted RPC tests (`rpc-memory-snapshot.test.ts`) | ✅ PASS |
| existing selector formatter/resolver tests | ✅ PASS |
| existing print-mode compare tests | ✅ PASS |
| existing session-memory tests | ✅ PASS |
| `npm run check` | ✅ PASS |

### Intentionally deferred
- no JSON-mode `/memory ...` command parsing
- no broad RPC architecture rewrite
- no backend/storage changes
- no plain-text compare payloads inside RPC
- no print-mode refactor to consume the structured helper

### Best next follow-up
Add one small JSON-mode or SDK-level consumer that reuses the new structured RPC memory compare contract so automation can access the same payload shape without subprocess-specific glue.

## Pass 14: SDK-facing structured memory snapshot consumer

### Chosen bounded scope
Add one same-process automation surface on `AgentSession` rather than widening JSON mode or building another subprocess wrapper.

Why this target:
- `packages/coding-agent/docs/sdk.md` already positions `AgentSession` as the primary embedding API
- JSON mode (`packages/coding-agent/docs/json.md`) is still an event stream, not a typed command/response surface
- RPC already has the right payload semantics, so the smallest honest move is to share that contract directly with SDK callers

### Files changed (Pass 14)

| File | Type | Change |
|------|------|--------|
| `packages/coding-agent/src/core/memory-snapshot-contract.ts` | NEW | Shared structured history/compare types and builders moved out of RPC-specific code |
| `packages/coding-agent/src/core/agent-session.ts` | MOD | Added `getStructuredMemoryHistory()` and `compareMemorySnapshots()` SDK-facing methods reusing the shared contract |
| `packages/coding-agent/src/core/agent-session-memory-snapshot.test.ts` | NEW | Targeted SDK consumer tests proving `AgentSession` reuses the shared structured payloads |
| `packages/coding-agent/src/core/index.ts` | MOD | Exported the shared structured memory contract for direct SDK use |
| `packages/coding-agent/src/index.ts` | MOD | Re-exported the shared structured memory contract from the package root |
| `packages/coding-agent/src/modes/rpc/rpc-memory.ts` | MOD | Reduced to a thin re-export layer over the shared core builder |
| `packages/coding-agent/src/modes/rpc/rpc-types.ts` | MOD | Repointed RPC memory payload types to the shared core contract types |
| `packages/coding-agent/docs/sdk.md` | MOD | Documented the new `AgentSession` consumer surface |
| `packages/coding-agent/docs/rpc.md` | MOD | Documented that the same payload is now available directly via SDK |
| `packages/coding-agent/CHANGELOG.md` | MOD | Added Unreleased entry |

### Reuse path
- `buildStructuredMemoryHistoryData()` and `buildStructuredMemoryCompareData()` now live in `src/core/memory-snapshot-contract.ts`
- `AgentSession` calls those builders directly
- RPC reuses the same builders through `src/modes/rpc/rpc-memory.ts`
- selector resolution still comes from `resolveMemorySnapshotSelector()`
- diff computation still comes from `computeMemorySnapshotDiff()`

### Verification
- targeted SDK tests prove `AgentSession` returns the shared structured payloads and preserves same-snapshot honesty
- existing RPC tests continue to cover empty-history, initial-snapshot, selector-failure, current-branch-only, and JSON-serializable behavior
- `npm run check` remains required repo-wide verification

### Intentionally deferred
- no JSON-mode `/memory` command protocol
- no new SDK wrapper class over RPC
- no backend/storage/schema changes
- no new selector semantics

### Updated best next follow-up
Add one small higher-level SDK helper or example that demonstrates consuming the new structured `AgentSession` memory snapshot methods in a real automation flow (for example, session auditing or branch-aware memory inspection).

## Pass 16: Working Context Integration (memory + plan + delegated work)

### Chosen bounded scope
Add one compact operator-visible working-context surface in interactive mode, backed by real current session state:
- persisted session memory summary
- persisted todo / visible-plan summary
- live delegated subagent execution summary derived from real `subagent` tool lifecycle events

No persistence redesign, no fake swarm dashboard, no claim that delegated work has persisted provenance.

### Files changed (Pass 16)

| File | Type | Change |
|------|------|--------|
| `packages/coding-agent/src/core/delegated-work.ts` | NEW | Pure delegated-work helper for extracting/updating live subagent task state from real tool args/results |
| `packages/coding-agent/src/core/delegated-work.test.ts` | NEW | Targeted delegated-work helper tests |
| `packages/coding-agent/src/core/agent-session.ts` | MOD | Added live delegated-work tracking and read accessors; no persistence changes |
| `packages/coding-agent/src/core/agent-session-delegated-work.test.ts` | NEW | Targeted AgentSession live delegated-work tracking tests |
| `packages/coding-agent/src/modes/interactive/components/working-context-panel.ts` | NEW | Compact integrated panel for memory + plan + delegated-work summaries |
| `packages/coding-agent/src/modes/interactive/components/working-context-panel.test.ts` | NEW | Targeted panel rendering tests |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | MOD | Mounted panel, refreshed it from real session state, and expanded `/session` with a Working Context section |
| `docs/WORKING_CONTEXT_INTEGRATION_IMPLEMENTATION.md` | NEW | Detailed implementation evidence |
| `docs/MEMORY_HANDLING_IMPLEMENTATION.md` | MOD | Added working-context integration note |
| `docs/VISIBLE_PLAN_TRACKING_IMPLEMENTATION.md` | MOD | Added integrated operator surface note |
| `docs/REFERENCE_HARNESS_AUDIT_AGENT_HARNESS_PRO.md` | MOD | Added pass 16 reference note |
| `packages/coding-agent/CHANGELOG.md` | MOD | Added Unreleased entry |

### Contract summary
- memory and todos remain persisted snapshot-backed session state
- delegated work is live current-process state derived from real `tool_execution_start` / `tool_execution_end` events for the `subagent` tool
- `/session` now distinguishes persisted working context from live delegated execution state explicitly
- the interactive panel hides itself when all three sources are empty

### Verification
| Check | Result |
|-------|--------|
| targeted tests for delegated-work helper + AgentSession wiring + panel rendering | ✅ PASS |
| `npm run check` | ✅ PASS |
| memory/todo persistence path unchanged | ✅ Verified by unchanged `session_memory` / `session_todos` backend and repo-wide check |
| delegated state uses real tool lifecycle events only | ✅ Verified |

### Intentionally deferred
- delegated-work persistence / resume restore
- swarm task graph or blocking model
- remote child todo extraction
- print-mode or JSON-mode working-context integration beyond the new RPC surface

## Pass 17: Structured RPC working-context surface

### Chosen bounded scope
Add one typed RPC current-state command:
- `get_working_context`

This pass reuses the real interactive working-context state rather than inventing a new backend.

### Files changed (Pass 17)

| File | Type | Change |
|------|------|--------|
| `packages/coding-agent/src/core/working-context.ts` | NEW | Shared current-state working-context contract + builder |
| `packages/coding-agent/src/core/working-context.test.ts` | NEW | Targeted contract tests including explicit empty delegated-work case |
| `packages/coding-agent/src/modes/interactive/components/working-context-panel.ts` | MOD | Panel now consumes the shared working-context contract |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | MOD | Panel and `/session` now reuse the shared builder |
| `packages/coding-agent/src/modes/rpc/rpc-types.ts` | MOD | Added `get_working_context` command/response types |
| `packages/coding-agent/src/modes/rpc/rpc-mode.ts` | MOD | Added RPC handler for `get_working_context` |
| `packages/coding-agent/src/modes/rpc/rpc-client.ts` | MOD | Added `getWorkingContext()` helper |
| `packages/coding-agent/src/modes/rpc/rpc-working-context.test.ts` | NEW | Targeted non-interactive payload tests |
| `packages/coding-agent/docs/rpc.md` | MOD | Documented the new working-context RPC surface |

### Contract summary
The payload exposes:
- persisted memory summary
- persisted todo summary
- live delegated-work summary

Honesty markers are explicit:
- `memory.isPersisted: true`, `memory.scope: "current_branch_session_state"`
- `todo.isPersisted: true`, `todo.scope: "current_branch_session_state"`
- `delegatedWork.isPersisted: false`, `delegatedWork.scope: "current_process_runtime_state"`
- delegated work note: `live current-process state only; not persisted and resets on session switch/resume`

### Verification
| Check | Result |
|-------|--------|
| targeted working-context contract tests | ✅ PASS |
| targeted RPC working-context tests | ✅ PASS |
| existing working-context panel tests | ✅ PASS |
| existing RPC memory snapshot tests | ✅ PASS |
| `npm run check` | ✅ PASS |

## Pass 18: SDK-facing same-process working-context surface

### Chosen bounded scope
Add `AgentSession.getWorkingContext()` as a bounded same-process SDK method that reuses the existing shared working-context contract.

### Why this target
- `AgentSession` is already the primary SDK embedding API
- the structured working-context payload already exists in `working-context.ts`
- the smallest honest next step is direct SDK exposure without subprocess or JSON-mode glue

### Reference files revisited for pass 18
- `/home/magnus/software/agent_harness_pro/commands/memory/memory.tsx`
- `/home/magnus/software/agent_harness_pro/components/memory/MemoryFileSelector.tsx`
- `/home/magnus/software/agent_harness_pro/components/memory/MemoryUpdateNotification.tsx`
- `/home/magnus/software/agent_harness_pro/utils/claudemd.ts`
- `/home/magnus/software/agent_harness_pro/memdir/memoryAge.ts`

### Files changed (Pass 18)

| File | Type | Change |
|------|------|--------|
| `packages/coding-agent/src/core/agent-session.ts` | MOD | Added `getWorkingContext()` method reusing `buildWorkingContext()` via existing `AgentSession` accessors |
| `packages/coding-agent/src/core/agent-session-working-context.test.ts` | NEW | Targeted SDK tests for persisted memory/todo summaries and live delegated-work provenance |
| `packages/coding-agent/examples/sdk/13-working-context.ts` | NEW | Canonical SDK example demonstrating same-process working-context usage |
| `packages/coding-agent/docs/sdk.md` | MOD | Added Working Context SDK Surface section and `AgentSession` interface entry |
| `docs/WORKING_CONTEXT_INTEGRATION_IMPLEMENTATION.md` | MOD | Added pass 18 evidence |
| `docs/MEMORY_HANDLING_IMPLEMENTATION.md` | MOD | Added pass 18 reference |
| `docs/VISIBLE_PLAN_TRACKING_IMPLEMENTATION.md` | MOD | Added same-process parity note for persisted todo vs live delegated work |
| `docs/REFERENCE_HARNESS_AUDIT_AGENT_HARNESS_PRO.md` | MOD | Added pass 18 reference note |

### SDK test coverage
- empty working context structure
- memory items reflected in working context
- persistence markers verified (memory/todo: true, delegated: false)
- JSON serializability
- provenance honesty

### Canonical example demonstrates
- creating in-memory session
- reading initial empty state
- adding and clearing memory items
- JSON serializability
- provenance honesty verification

### Verification
| Check | Result |
|-------|--------|
| `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run src/core/agent-session-working-context.test.ts` | Targeted tests |
| `npm run check` | Repo-wide verification |

### Intentionally deferred
- no new persistence layer
- no delegated-work history
- no JSON-mode protocol changes

## Pass 19: Bounded working-context consolidation

### Chosen bounded scope
Replace direct `buildWorkingContext(...)` composition in interactive mode and RPC mode with `session.getWorkingContext()`.

### Why this consolidation
The working-context contract was introduced in pass 17 and exposed via `AgentSession.getWorkingContext()` in pass 18. However, interactive mode and RPC mode were still composing the payload directly rather than delegating to the consolidated method.

This consolidation:
- removes duplicate composition logic from both modes
- ensures all working-context consumers use the same single source of truth
- preserves the shared contract in `working-context.ts` unchanged
- maintains provenance/scope honesty exactly

### Files changed (Pass 19)

| File | Type | Change |
|------|------|--------|
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | MOD | Removed `buildWorkingContext` import; `updateWorkingContextPanel()` and `handleSessionCommand()` now call `session.getWorkingContext()` |
| `packages/coding-agent/src/modes/rpc/rpc-mode.ts` | MOD | Removed `buildWorkingContext` import; `get_working_context` handler now calls `session.getWorkingContext()` |
| `packages/coding-agent/src/core/agent-session-working-context.test.ts` | MOD | Added consolidation proof test |
| `docs/WORKING_CONTEXT_INTEGRATION_IMPLEMENTATION.md` | MOD | Added pass 19 evidence |
| `docs/MEMORY_HANDLING_IMPLEMENTATION.md` | MOD | Added pass 19 reference |
| `docs/VISIBLE_PLAN_TRACKING_IMPLEMENTATION.md` | MOD | Added pass 19 reference |
| `docs/REFERENCE_HARNESS_AUDIT_AGENT_HARNESS_PRO.md` | MOD | Added pass 19 reference note |

### What did NOT change
- `packages/coding-agent/src/core/working-context.ts` contract unchanged
- `packages/coding-agent/src/core/agent-session.ts` `getWorkingContext()` method unchanged
- No payload/schema changes
- No backend changes
- No fake persistence claims
- No broad refactor

### Verification
| Check | Result |
|-------|--------|
| `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run src/core/agent-session-working-context.test.ts` | Targeted tests |
| `npm run check` | Repo-wide verification |

### Intentionally deferred
- no new working-context surfaces
- no persistence changes
- no new SDK methods
