# Working Context Integration Implementation

## Objective

Create the first bounded real operator-visible integration between:
- session memory
- visible plan / todo state
- delegated subagent execution state

without rewriting persistence or swarm architecture.

## Chosen surface

A compact interactive-mode **Working Context** panel plus an expanded `/session` **Working Context** section.

Why this surface was chosen:
- memory already had dedicated `/memory` and editor workflows
- todo state already existed in `AgentSession`, but the previously-added todo-only component was not currently wired in repo reality
- real delegated-work state in repo reality was limited to live `tool_execution_start` / `tool_execution_end` events for the `subagent` tool
- interactive mode already had a clean bounded insertion point near the prompt/status area for a compact always-visible summary

This gives one truthful operator surface without inventing a fake swarm console.

## Real state consumed

### Memory
Source of truth:
- `packages/coding-agent/src/core/agent-session.ts`
  - `getMemoryItems()`
- persisted backend unchanged:
  - `packages/coding-agent/src/core/session-manager.ts`
  - `customType === "session_memory"`

Used by the panel as:
- active memory item count
- stale-item count derived from existing `reviewMemoryItems(...)`
- key preview of active memory items

### Plan / Todo
Source of truth:
- `packages/coding-agent/src/core/agent-session.ts`
  - `getTodos()`
- persisted backend unchanged:
  - `packages/coding-agent/src/core/session-manager.ts`
  - `customType === "session_todos"`

Used by the panel as:
- total todo count
- completed count
- current in-progress `activeForm`

### Delegated / Subagent work
Source of truth in repo reality:
- `packages/agent/src/agent-loop.ts`
  - emits `tool_execution_start` and `tool_execution_end`
- `packages/coding-agent/examples/extensions/subagent/index.ts`
  - `subagent` tool result details include `mode` and `results[]`
- `packages/coding-agent/src/core/agent-session.ts`
  - now tracks live delegated work state from those existing tool lifecycle events

Implemented state model:
- `packages/coding-agent/src/core/delegated-work.ts`
  - extracts delegated tasks from real `subagent` tool args/results
  - updates task status as `active | completed | error | blocked`
  - summarizes current live delegated state

Important honesty boundary:
- delegated work in v1 is **live current-process state only**
- it is not a persisted swarm history
- it is not reconstructed across resume
- memory/todos remain persisted snapshot-backed state; delegated work does not pretend to have the same provenance

## Files changed

### Core / state
- `packages/coding-agent/src/core/delegated-work.ts`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/agent-session-delegated-work.test.ts`
- `packages/coding-agent/src/core/delegated-work.test.ts`

### Interactive surface
- `packages/coding-agent/src/modes/interactive/components/working-context-panel.ts`
- `packages/coding-agent/src/modes/interactive/components/working-context-panel.test.ts`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`

### Docs
- `docs/WORKING_CONTEXT_INTEGRATION_IMPLEMENTATION.md`
- `docs/JENSEN_CODE_ADOPTION_PLAN_AGENT_HARNESS_PRO.md`
- `docs/REFERENCE_HARNESS_AUDIT_AGENT_HARNESS_PRO.md`
- `docs/MEMORY_HANDLING_IMPLEMENTATION.md`
- `docs/VISIBLE_PLAN_TRACKING_IMPLEMENTATION.md`
- `packages/coding-agent/CHANGELOG.md`

## Contract semantics

### Working Context panel
The interactive panel shows a real-time summary of:
- memory: active items + stale count + key preview
- plan: completed/total + current in-progress task
- delegated: active/done/failed live subagent runs + active agent names when width allows

The panel is hidden when all three sources are empty.

### `/session` command
`/session` now includes a `Working Context` section that explicitly distinguishes:
- persisted active memory
- persisted active plan/todo state
- live delegated subagent executions in the current process only

This keeps current state vs persistence honest.

## What was intentionally deferred

- no delegated-work persistence or resume restoration
- no new `SessionEntry` variant for swarm tasks
- no remote child todo extraction
- no swarm dependency graph / blocking model
- no broad orchestration redesign
- no fake event-sourced provenance

## Verification

Targeted tests run:
- `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run src/core/delegated-work.test.ts src/core/agent-session-delegated-work.test.ts src/modes/interactive/components/working-context-panel.test.ts`

Repo-wide verification:
- `npm run check`

Verified:
- delegated work state is derived from real `subagent` tool lifecycle events
- memory/todo persisted backends remain unchanged
- interactive panel renders combined memory + todo + delegated summaries from real state
- `/session` exposes the integrated working-context view
- full typecheck/lint/browser-smoke/web-ui checks pass

Not verified in this pass:
- tmux/manual interactive screenshot pass
- persisted delegated-work restore across resume (intentionally not implemented)

## Pass 17: RPC-first non-interactive working-context surface

### Chosen surface
A single structured RPC command:
- `get_working_context`

This was chosen because repo evidence already showed RPC is the established typed non-interactive surface:
- `packages/coding-agent/src/modes/rpc/rpc-types.ts`
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
- `packages/coding-agent/src/modes/rpc/rpc-client.ts`

Print mode already existed as a text surface, but the next bounded adoption target was a programmatic current-state contract rather than another text formatter.

### Shared summary boundary
A new shared builder now owns the working-context contract:
- `packages/coding-agent/src/core/working-context.ts`

It is reused by:
- interactive panel updates in `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- interactive `/session` working-context output in `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- RPC `get_working_context` in `packages/coding-agent/src/modes/rpc/rpc-mode.ts`

This avoids duplicating summary logic across interactive and non-interactive surfaces.

### Structured contract
`get_working_context` returns three sections on every call:
- `memory`
- `todo`
- `delegatedWork`

Honesty markers are explicit in the payload:
- `memory.isPersisted: true`
- `memory.scope: "current_branch_session_state"`
- `todo.isPersisted: true`
- `todo.scope: "current_branch_session_state"`
- `delegatedWork.isPersisted: false`
- `delegatedWork.scope: "current_process_runtime_state"`
- `delegatedWork.note: "live current-process state only; not persisted and resets on session switch/resume"`

Empty delegated work is represented honestly with zero counts and an empty `activeAgents` array, not by fabricating persistence.

### Real state reused
- memory summary from `AgentSession.getMemoryItems()`
- todo summary from `AgentSession.getTodos()`
- delegated-work summary from `AgentSession.getDelegatedWorkSummary()`

No new persistence layer was introduced.

### Files changed in this pass
- `packages/coding-agent/src/core/working-context.ts`
- `packages/coding-agent/src/core/working-context.test.ts`
- `packages/coding-agent/src/modes/interactive/components/working-context-panel.ts`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- `packages/coding-agent/src/modes/rpc/rpc-types.ts`
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
- `packages/coding-agent/src/modes/rpc/rpc-client.ts`
- `packages/coding-agent/src/modes/rpc/rpc-working-context.test.ts`
- `packages/coding-agent/docs/rpc.md`

### Verification in this pass
Targeted tests:
- `packages/coding-agent/src/core/working-context.test.ts`
- `packages/coding-agent/src/modes/rpc/rpc-working-context.test.ts`
- `packages/coding-agent/src/modes/interactive/components/working-context-panel.test.ts`
- `packages/coding-agent/src/modes/rpc/rpc-memory-snapshot.test.ts`

Repo-wide verification:
- `npm run check`

### Deferred
- no delegated-work persistence
- no JSON-mode working-context protocol
- no print-mode working-context command
- no separate history surface for delegated work

## Pass 18: SDK-facing same-process working-context surface

### Chosen surface
Add `AgentSession.getWorkingContext()` as a bounded same-process SDK method.

This was chosen because:
- `AgentSession` is already the primary SDK embedding API
- the structured working-context payload already exists in `packages/coding-agent/src/core/working-context.ts`
- the smallest honest next step is to expose that payload directly to SDK callers without subprocess or JSON-mode glue

### Reference files revisited for this pass
- `/home/magnus/software/agent_harness_pro/commands/memory/memory.tsx`
- `/home/magnus/software/agent_harness_pro/components/memory/MemoryFileSelector.tsx`
- `/home/magnus/software/agent_harness_pro/components/memory/MemoryUpdateNotification.tsx`
- `/home/magnus/software/agent_harness_pro/utils/claudemd.ts`
- `/home/magnus/software/agent_harness_pro/memdir/memoryAge.ts`

### Reuse path
- `AgentSession.getWorkingContext()` delegates to `buildWorkingContext()` from `working-context.ts`
- The method reuses existing `AgentSession` accessors:
  - `getMemoryItems()` for persisted memory summary input
  - `getTodos()` for persisted todo summary input
  - `getDelegatedWorkSummary()` for live delegated-work summary input
- This is the same payload used by RPC `get_working_context` and the interactive working-context panel

### Files changed in this pass
- `packages/coding-agent/src/core/agent-session.ts` — Added `getWorkingContext()` method
- `packages/coding-agent/src/core/agent-session-working-context.test.ts` — NEW targeted SDK tests
- `packages/coding-agent/examples/sdk/13-working-context.ts` — NEW canonical SDK example
- `packages/coding-agent/docs/sdk.md` — Added Working Context SDK Surface section

### SDK test coverage
- empty working context structure
- memory items reflected in working context
- todo items reflected in working context
- persistence markers explicitly verified (memory/todo: true, delegated: false)
- JSON serializability
- provenance honesty (ephemeral delegated work correctly marked)

### Example demonstrated
- creating an in-memory session
- reading initial empty state
- adding and clearing memory items
- JSON serializability check
- provenance honesty verification

### Verification in this pass
Targeted tests:
- `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run src/core/agent-session-working-context.test.ts`

Repo-wide verification:
- `npm run check`

### Deferred
- no new persistence layer
- no delegated-work history
- no JSON-mode protocol changes

## Pass 19: Bounded working-context consolidation

### Chosen bounded scope
Replace direct `buildWorkingContext(...)` composition in interactive mode and RPC mode with `session.getWorkingContext()`.

This consolidates the working-context consumption path so that both modes delegate to the same single source of truth in `AgentSession`.

### Why this consolidation
The working-context contract in `packages/coding-agent/src/core/working-context.ts` was introduced in pass 17 and exposed via `AgentSession.getWorkingContext()` in pass 18. However, interactive mode and RPC mode were still composing the payload directly from session state rather than delegating to the consolidated method.

This consolidation:
- removes duplicate composition logic from both modes
- ensures all working-context consumers use the same single source of truth
- preserves the shared contract in `working-context.ts` unchanged
- maintains provenance/scope honesty exactly

### Files changed in this pass

| File | Change |
|------|--------|
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | Removed `buildWorkingContext` import; `updateWorkingContextPanel()` now calls `session.getWorkingContext()`; `handleSessionCommand()` now calls `session.getWorkingContext()` |
| `packages/coding-agent/src/modes/rpc/rpc-mode.ts` | Removed `buildWorkingContext` import; `get_working_context` handler now calls `session.getWorkingContext()` |
| `packages/coding-agent/src/core/agent-session-working-context.test.ts` | Added consolidation proof test verifying the same payload is returned by both paths |

### What did NOT change
- `packages/coding-agent/src/core/working-context.ts` contract unchanged
- `packages/coding-agent/src/core/agent-session.ts` `getWorkingContext()` method unchanged
- No payload/schema changes
- No backend changes
- No fake persistence claims
- No broad refactor

### Verification
Targeted tests:
- `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run src/core/agent-session-working-context.test.ts`

Repo-wide verification:
- `npm run check`

### Deferred
- no new working-context surfaces
- no persistence changes
- no new SDK methods
