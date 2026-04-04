# Agent Harness Pro Parity Plan

## 1. Objective / Scope / Hard Stops

Objective: produce a bounded, code-grounded import plan for five reference features in `../agent_harness_pro`, compared against current `jensen-code`, in this priority order:
1. Kairos
2. `/compact`
3. Ultraplan
4. Swarm parity / hardening confidence
5. Buddy

This slice is recon and design only.

Hard stops:
- no product-feature implementation
- no broad architecture rewrite
- no remote-server copy plan for Ultraplan
- no guesses past code evidence
- Kairos internals behind `agent_harness_pro/assistant/index.js` and `agent_harness_pro/assistant/gate.js` are partially blocked because those files were not available in the local checkout

---

## 2. Decision Matrix

| Feature | What agent_harness_pro actually does | jensen-code parity status | Recommended disposition | Narrowest next slice |
|---|---|---|---|---|
| Kairos | Assistant-mode wrapper around a strict brief-only output contract, assistant-session attach flow, and feature/trust gating. Core visible behavior is: user-visible output must go through `SendUserMessage`, with `isBriefOnly` and `kairosActive` state driving that contract. | Partial primitives only: `AgentSession.sendUserMessage()` exists, but there is no brief-only session mode, no attach/viewer flow, and no Kairos gating. | Adapt, not import as-is. Start with the brief-only output contract only. | Add a local brief-only mode in `packages/coding-agent` that routes visible assistant output through `sendUserMessage()` and suppresses normal streamed assistant prose when enabled. |
| `/compact` | Manual compaction command with session-memory-first fallback, explicit post-compact cleanup, preserved-segment ordering, and reinjection semantics for slash-command-triggered compaction. | Equivalent core feature already exists and is strong. jensen-code already persists compaction entries and augments summaries with active memory/todo state. | Adapt selected hardening only. Do not rewrite compaction architecture. | Add a bounded post-compaction cleanup contract and verify preserved-state invariants around compaction/resume, without changing the session model. |
| Ultraplan | Remote long-running planning mode: slash/keyword trigger launches a remote plan-mode session, polls for approved plan output, then lets the user keep execution remote or bring the plan back local. | Missing as a product feature, but local building blocks exist: `subagent` protocol, working-context persistence for memory/todos, and explicit delegated-work honesty markers. | Redesign locally. Defer remote parity. | Add a local-only explicit planning command that runs a planner subagent and persists the resulting approved plan into session memory/todo state. |
| Swarm parity / hardening | File-backed task identity and task-list reset, local/remote child task state machines, notifications, and blocking graph (`blocks` / `blockedBy`) around delegation. | Partial. jensen-code has real `subagent` execution plus working-context visibility, but delegated tracking is ephemeral, coarse, and not per-child for parallel/chain. | Keep current design; harden confidence and granularity. | Track each parallel/chain child as its own delegated-work item and define explicit blocked/failure semantics before considering persistence changes. |
| Buddy | Companion watcher feature with prompt injection, footer invocation, bubble/sprite UI, and companion-specific state. | Missing. No analogous feature. | Defer. | None. |

---

## 3. Per-Feature Notes

### Kairos

**Reference behavior**
- `agent_harness_pro/main.tsx` strips `assistant` argv so the normal TUI launches, then later attaches as a viewer for an assistant session.
- In the attach path, `main.tsx` sets `setKairosActive(true)`, `setUserMsgOptIn(true)`, and starts REPL with `assistantInitialState` including `isBriefOnly: true`, `kairosEnabled: false`, and `replBridgeEnabled: false`.
- `agent_harness_pro/main.tsx` also appends `assistantModule.getAssistantSystemPromptAddendum()` when KAIROS is enabled and trusted, after `checkHasTrustDialogAccepted()` and `kairosGate.isKairosEnabled()`.
- `agent_harness_pro/bootstrap/state.ts` exposes `getKairosActive()` / `setKairosActive()`.
- `agent_harness_pro/state/AppStateStore.ts` includes `isBriefOnly` and Kairos-related session state.
- `agent_harness_pro/tools/BriefTool/BriefTool.ts` makes `SendUserMessage` the visible-output channel. `isBriefEnabled()` is `(getKairosActive() || getUserMsgOptIn()) && isBriefEntitled()`.
- `agent_harness_pro/commands/brief.ts` toggles `isBriefOnly` and keeps opt-in state synchronized.

**User contract**
- Kairos is not just “think longer.”
- It is primarily an assistant/session mode that changes how the model is expected to communicate with the user.
- The strongest portable contract is brief-only output, not the full assistant attachment stack.

**jensen-code comparison**
- `packages/coding-agent/src/core/agent-session.ts` has `sendUserMessage()` and exposes it to extensions.
- No equivalent `isBriefOnly` session mode exists.
- No assistant attach/viewer flow exists.
- No Kairos trust/gating subsystem exists.

**Recommendation**
- Do not import Kairos as a top-level mode yet.
- Treat the first import as a brief-only output contract in the local session runtime.
- Defer assistant attach flow and trust/gate parity until the missing harness Kairos internals are available.

### `/compact`

**Reference behavior**
- `agent_harness_pro/commands/compact/index.ts` registers `/compact` and allows optional custom summarization instructions.
- `agent_harness_pro/commands/compact/compact.ts` runs this flow:
  1. drop messages before the latest compact boundary
  2. if no custom instructions, try session-memory compaction first
  3. otherwise use reactive-only compaction if enabled, else `microcompact` + traditional `compactConversation`
  4. clear caches and run post-compact cleanup
- `agent_harness_pro/utils/processUserInput/processSlashCommand.tsx` special-cases `result.type === 'compact'`, appends slash-command synthetic messages into `messagesToKeep`, resets microcompact state, and rebuilds the transcript with `buildPostCompactMessages()`.
- `agent_harness_pro/services/compact/compact.ts` defines post-compact ordering as boundary -> summary -> kept messages -> attachments -> hook results.
- `agent_harness_pro/services/compact/sessionMemoryCompact.ts` annotates preserved segments and avoids splitting tool-pair invariants.
- `agent_harness_pro/services/compact/postCompactCleanup.ts` resets caches/state but intentionally does not wipe invoked-skill context.

**jensen-code comparison**
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` handles `/compact` and `/compact <instructions>`.
- `packages/coding-agent/src/core/agent-session.ts` aborts the current run, prepares compaction, executes compaction, appends a compaction entry, rebuilds the session context, and returns the summary.
- `packages/coding-agent/src/core/session-manager.ts` reinjects compaction summaries and current memory snapshots into future model context.
- `packages/coding-agent/src/core/agent-session.ts` `_augmentCompactionSummary()` explicitly appends `## Active Session Memory` and `## Active Todo State`.
- `packages/coding-agent/src/core/messages.ts` sends compaction summaries back into the model-visible message list.

**Parity assessment**
- jensen-code already has real `/compact` behavior and is stronger than the reference on explicit memory/todo carry-forward.
- The main parity gaps are hardening details, not headline behavior:
  - no explicit post-compact cleanup contract mirroring the reference cleanup surface
  - no preserved-segment/tool-pair invariants equivalent to the harness session-memory path
  - no slash-command reinjection logic because the session model is different

**Recommendation**
- Keep current compaction architecture.
- Import only the cleanup/invariant ideas that fit jensen-code's session model.

### Ultraplan

**Reference behavior**
- `agent_harness_pro/commands/ultraplan.tsx` exposes `/ultraplan <prompt>` and a bare usage path; help text describes an advanced multi-agent plan mode running in Claude Code on the web while the local terminal stays free.
- `agent_harness_pro/utils/processUserInput/processUserInput.ts` and `agent_harness_pro/utils/ultraplan/keyword.ts` also launch it from keyword detection in normal prompts.
- `agent_harness_pro/commands/ultraplan.tsx` launches remote planning via `teleportToRemote({ permissionMode: 'plan', ultraplan: true, ... })`, registers a remote task, and polls for completion.
- `agent_harness_pro/utils/ultraplan/ccrSession.ts` scans remote events for approved plan output, using `## Approved Plan:` and `__ULTRAPLAN_TELEPORT_LOCAL__` markers, and distinguishes `executionTarget: 'remote' | 'local'`.
- `agent_harness_pro/utils/teleport.tsx` shows the real dependency load: OAuth tokens, org UUID, `/v1/sessions`, remote environment selection, GitHub clone or bundle fallback, and plan-mode control requests.

**Actual value proposition**
- Ultraplan is not “just longer planning.”
- It provides:
  - higher-budget planning
  - asynchronous execution so the local terminal stays free
  - an explicit approval/choice point for where execution should happen next

**jensen-code comparison**
- `packages/coding-agent/examples/extensions/subagent/index.ts` already supports explicit planner-like delegation via `single`, `parallel`, and `chain`.
- `packages/coding-agent/src/core/working-context.ts` and `packages/coding-agent/src/core/agent-session.ts` already distinguish persisted memory/todos from live delegated work.
- Delegated work is explicitly non-persisted current-process state, so it is the wrong place to store durable planning output.

**Recommendation**
- Redesign Ultraplan as local-first.
- Best fit in jensen-code: both an explicit user command/mode and a planner-subagent protocol underneath it.
- Persist the approved plan into memory/todo state, not delegated-work state.
- Defer all remote parity: no teleport, no remote session polling, no web-session dependency.

### Swarm parity / hardening confidence

**Reference behavior**
- `agent_harness_pro/tools/TeamCreateTool/TeamCreateTool.ts` resets the task list, ensures the tasks directory exists, and binds leader team identity.
- `agent_harness_pro/utils/tasks.ts` persists task data on disk, including `blocks` and `blockedBy`, and uses lock-protected reset/high-water-mark logic.
- `agent_harness_pro/tasks/LocalAgentTask/LocalAgentTask.tsx` and `agent_harness_pro/tasks/RemoteAgentTask/RemoteAgentTask.tsx` manage task status transitions, stop/failure handling, and notifications.
- `agent_harness_pro/tools/AgentTool/AgentTool.tsx` is the delegation coordinator across local, remote, foreground, and background child runs.

**jensen-code comparison**
- `packages/coding-agent/examples/extensions/subagent/index.ts` already validates exactly one mode, caps parallelism, defaults `agentScope` to `user`, and confirms project-local agents when required.
- `packages/coding-agent/src/core/agent-session.ts` derives delegated-work state from real `tool_execution_start` / `tool_execution_end` events.
- `packages/coding-agent/src/core/delegated-work.ts` currently tracks one record per `subagent` tool call, not one record per child task in a parallel/chain run.
- `packages/coding-agent/src/core/working-context.ts` is explicit that delegated work is live runtime state only and resets on session switch/resume.

**Parity assessment**
- The conceptual swarm integration is present.
- Current confidence gap is operational granularity, not missing orchestration fundamentals.
- Biggest concrete gaps:
  - per-child tracking for parallel/chain runs
  - `blocked` exists in types but is not meaningfully used
  - no persisted task graph or cross-session provenance

**Recommendation**
- Keep the current local subagent architecture.
- Harden it by improving child-task tracking and failure semantics before considering persistence or task-graph imports.

### Buddy

**Reference behavior**
- `agent_harness_pro/buddy/prompt.ts` defines a companion watcher that occasionally comments in a bubble and can answer in one line when addressed by name.
- `agent_harness_pro/buddy/companion.ts` regenerates deterministic companion "bones" from the user id.
- `agent_harness_pro/components/PromptInput/PromptInput.tsx` routes the footer companion item to `/buddy`.
- `agent_harness_pro/utils/attachments.ts` and `agent_harness_pro/utils/messages.ts` inject companion intro context into the model prompt.
- `agent_harness_pro/screens/REPL.tsx` and `agent_harness_pro/state/AppStateStore.ts` add bubble/sprite/reaction UI state.

**jensen-code comparison**
- No analogous feature exists.
- Importing it would touch prompt construction, command handling, input/footer UI, and persistent UI state.

**Recommendation**
- Defer. It is UX polish, not a platform-priority parity item.

---

## 4. Recommended Implementation Order

1. **Kairos**: import the brief-only output contract only.
2. **`/compact`**: harden cleanup/invariants without rewriting compaction.
3. **Ultraplan**: design and add the local-first planner mode.
4. **Swarm parity / hardening**: improve per-child delegated tracking and blocked/failure semantics.
5. **Buddy**: keep deferred.

---

## 5. Best Next Single Implementation Slice

**Kairos slice: brief-only output contract for jensen-code interactive sessions**

Bounded scope:
- add a session-level `isBriefOnly` flag in `packages/coding-agent`
- when enabled, require user-visible assistant output to go through the existing `AgentSession.sendUserMessage()` path
- suppress normal plain-text assistant streaming in the TUI while brief-only is enabled
- keep it local-only and explicit; do not implement assistant attach/viewer behavior, trust gates, or Kairos feature flags in this slice

Why this slice first:
- it captures the strongest portable Kairos value
- it is independent of the missing harness Kairos internals
- it composes with a later local-first Ultraplan/planner workflow

---

## 6. Explicitly Deferred Work

- Kairos assistant attach/viewer mode parity
- Kairos trust/gating parity
- Kairos proactive/team internals hidden behind missing harness files
- remote Ultraplan parity (`teleport`, remote sessions API, web-session polling)
- persisted swarm task graph import (`blocks` / `blockedBy`) until child-tracking semantics are tightened locally
- buddy / companion feature work
