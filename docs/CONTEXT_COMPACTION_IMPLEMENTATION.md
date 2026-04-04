# Context Compaction Implementation

## Objective

Improve jensen-code compaction so active working state is not silently lost. The bounded implementation preserves active todo and memory state in the real model-facing context path before and after compaction.

## Existing jensen-code compaction path (kept)

Compaction already existed and was already real:
- `packages/coding-agent/src/core/agent-session.ts` — `compact()` and `_runAutoCompaction()` call `prepareCompaction()` / `compact()` and then `sessionManager.appendCompaction(...)`
- `packages/coding-agent/src/core/compaction/compaction.ts` — generates structured summaries from actual message history
- `packages/coding-agent/src/core/session-manager.ts` — `buildSessionContext()` injects compaction summaries back into future context via `CompactionEntry`
- `packages/coding-agent/src/core/messages.ts` — `convertToLlm()` turns `compactionSummary` into a model-visible user message with summary wrappers

## Bounded improvement implemented

### What changed
Compaction summaries are now augmented with explicit active working state:
- active session memory items
- active todo/plan items

This is implemented in:
- `packages/coding-agent/src/core/agent-session.ts` — `_augmentCompactionSummary()`

### Behavior
When a manual or auto compaction completes, the stored `summary` in the `CompactionResult` now appends:
- `## Active Session Memory`
- `## Active Todo State`

This ensures the compacted result itself carries the current structured working state forward, rather than relying only on raw message history.

### Why this is real
The augmented summary is not UI-only:
1. `AgentSession.compact()` / `_runAutoCompaction()` store the augmented summary in the `CompactionEntry`
2. `SessionManager.buildSessionContext()` reconstructs future context using that `CompactionEntry`
3. `convertToLlm()` sends the `compactionSummary` into the actual model-facing message list

So future model calls actually see the augmented compacted state.

## Files changed
- `packages/coding-agent/src/core/agent-session.ts`

## What was intentionally deferred
- No compaction algorithm rewrite
- No new compaction boundary/session version format
- No separate operator UI for compaction-kept state beyond the existing compaction summary surface
