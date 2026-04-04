# Visible Plan Tracking Implementation

## Overview
Implemented a model-driven visible todo list system for jensen-code's coding-agent. The orchestrator (LLM) creates and updates tasks via a built-in `todo_write` tool. The human operator sees the todo list update in real time during interactive sessions.

## Architecture

### Data Flow
```
LLM calls todo_write tool
    ↓
todo-write.ts: executes with full-list replacement
    ↓
AgentSession._setTodos() updates state + emits todo_update event
    ↓
InteractiveMode.handleEvent("todo_update") receives event
    ↓
TodoListComponent.update() receives new todos
    ↓
ui.requestRender() triggers TUI re-render
    ↓
TodoListComponent.render() displays updated task list
```

### State Model
```typescript
interface TodoItem {
  content: string;      // "Fix authentication bug" (imperative)
  activeForm: string;   // "Fixing authentication bug" (present continuous)
  status: "pending" | "in_progress" | "completed";
}
```

### Session Location
- `_todos: TodoItem[]` in `AgentSession` (private field)
- `getTodos()` exposes read-only view
- `_setTodos()` is internal (called only by tool callback)
- `todo_update` event extends `AgentSessionEvent` union
- initial pass used in-memory state only; current implementation also persists todo snapshots through `SessionManager.appendSessionTodos(...)` and restores them from `buildSessionContext().todos`

### UI Surface
- Component: `TodoListComponent` in `src/modes/interactive/components/todo-list.ts`
- Container: `todoContainer` mounted between `statusContainer` and `chatContainer`
- Layout: Appears between status loader and chat messages
- Visibility: Shows only when non-empty (0 lines when no todos)
- Compact mode (<80 cols): "Tasks: 2/5 done | Working: Fix auth bug"
- Expanded mode (≥80 cols): Status line + one line per task with icons

## Files Changed
| File | Change |
|------|--------|
| `src/core/tools/todo-write.ts` | New tool definition with schema + validation |
| `src/core/agent-session.ts` | Added todo state, event, tool registration, and later persistence wiring |
| `src/core/session-manager.ts` | Added persisted todo snapshot helpers |
| `src/core/tools/index.ts` | Export todo_write |
| `src/core/tools/tools-prompt-data.ts` | Added todo_write prompt description |
| `src/modes/interactive/components/todo-list.ts` | New TUI component |
| `src/modes/interactive/interactive-mode.ts` | Mounted component, wired event handler |

## Verification
- `npm run check` — PASS (all packages)
- Event flow verified: todo_write execution → _setTodos → todo_update event → handleEvent → UI update
- Tool is in default active tool set (["read", "bash", "edit", "write", "todo_write"])
- Empty list renders zero lines (container takes no vertical space)
- No dead code paths — tool is callable, state is reactive, UI is mounted

## What Was Intentionally Deferred
1. **RPC/print mode rendering** — Todo UI is interactive-mode only
2. **Blocking dependencies** — No blockedBy/blocks graph (TodoV2 feature from reference)
3. **Dedicated plan SessionEntry variant** — Todo snapshots currently use custom session entries rather than a first-class plan entry
4. **Manual operator command surface for todo editing** — still model/tool-driven

## Pass 16: Working-context integration

The current operator-visible todo surface is now a broader **Working Context** panel rather than a todo-only strip.

### Why this changed
Repo reality showed:
- todo state was still real in `AgentSession`
- memory state was real and already operator-visible elsewhere
- delegated subagent state was only available through live `tool_execution_start` / `tool_execution_end` events

So the smallest honest operator-visible improvement was one compact panel that shows all three together.

### Real state consumed
- plan/todo: `AgentSession.getTodos()`
- memory: `AgentSession.getMemoryItems()`
- delegated work: live subagent execution state now tracked in `AgentSession` from real tool lifecycle events

### Files
- `packages/coding-agent/src/core/delegated-work.ts`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/modes/interactive/components/working-context-panel.ts`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- `docs/WORKING_CONTEXT_INTEGRATION_IMPLEMENTATION.md`

### Honest boundary
Todo state remains persisted and resume-safe. Delegated work in this pass is **live current-process state only**; it is shown alongside the plan, but not falsely presented as persisted plan history.

## Pass 17: RPC working-context parity

Plan/todo state is now also available outside the interactive UI through the shared working-context builder:
- `packages/coding-agent/src/core/working-context.ts`
- surfaced through RPC `get_working_context`

Contract honesty remains explicit:
- todo summary: `isPersisted: true`, `scope: "current_branch_session_state"`
- delegated-work summary: `isPersisted: false`, `scope: "current_process_runtime_state"`

This preserves the existing truth boundary: plan/todo is persisted session state, delegated work is not.

## Pass 18: Same-process SDK working-context parity

Plan/todo state is now also available to same-process SDK callers through:
- `packages/coding-agent/src/core/agent-session.ts`
  - `AgentSession.getWorkingContext()`

This method reuses the shared working-context builder and preserves the same honesty markers already used by interactive mode and RPC:
- todo summary stays `isPersisted: true`, `scope: "current_branch_session_state"`
- delegated-work summary stays `isPersisted: false`, `scope: "current_process_runtime_state"`

This pass did not add delegated-work persistence or a new plan backend. It only exposed the existing persisted todo summary and live delegated-work summary through the same current-state contract for same-process automation.

## Pass 19: Bounded working-context consolidation

Plan/todo state is now consumed through the consolidated `AgentSession.getWorkingContext()` path in both interactive mode and RPC mode.

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
- plan/todo persistence unchanged (`session_todos` in session JSONL)
- todo backend unchanged
- delegated-work state unchanged (live current-process only)
