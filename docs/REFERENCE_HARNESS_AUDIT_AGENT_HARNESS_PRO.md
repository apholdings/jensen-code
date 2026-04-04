# Reference Harness Audit: agent_harness_pro

## Objective

Study /home/magnus/software/agent_harness_pro as a reference CLI/agent harness, extract the strongest architectural and ergonomic ideas, compare them against jensen-code, and identify concrete bounded improvements.

## Repos Studied

| Repo | Role | Type |
|------|------|------|
| /home/magnus/software/jensen-code | Target (modifiable) | Multi-package monorepo (coding-agent, ai, agent-core, tui, web-ui, mom, pods) |
| /home/magnus/software/agent_harness_pro | Reference (read-only) | Single-repo CLI agent harness (Anthropic Claude Code architecture) |

## Relevant Files Inspected

### agent_harness_pro
| File/Dir | Purpose |
|----------|---------|
| `commands.ts` | Command registry (50+ slash commands), conditional loading |
| `commands/doctor/` | Doctor diagnostics screen |
| `commands/*.tsx` | Individual command implementations |
| `Tool.ts` | Universal Tool interface with render/permission hooks |
| `tools/*/prompt.ts` | LLM-facing tool instructions per tool |
| `tools/BashTool/prompt.ts` | Example: rich conditional tool instructions |
| `utils/settings/settings.ts` | Multi-source config with drop-in patches |
| `utils/settings/validation.ts` | Zod-based validation with human-readable errors |
| `utils/doctorDiagnostic.ts` | Doctor check implementation |
| `utils/status*.tsx` | Status notices system |
| `ink/` | Custom Ink fork with char pooling, virtual DOM, Yoga layout |
| `components/` | React/Ink UI components |
| `services/` | Domain services (compact, mcp, memory, analytics) |
| `skills/` | Skill loading and discovery |
| `tasks/` | Task state machine with subagents |
| `keybindings/` | Context-based keyboard bindings |

### jensen-code
| File/Dir | Purpose |
|----------|---------|
| `packages/coding-agent/src/cli/args.ts` | CLI argument parsing (20+ args) |
| `packages/coding-agent/src/cli/` | CLI surface (args, session-picker, config-selector, list-models) |
| `packages/coding-agent/src/core/system-prompt.ts` | System prompt construction (terse toolDescriptions) |
| `packages/coding-agent/src/core/slash-commands.ts` | Built-in slash command registry |
| `packages/coding-agent/src/core/tools/index.ts` | Tool registry and factory functions |
| `packages/coding-agent/src/core/tools/*.ts` | Individual tool implementations |
| `packages/coding-agent/src/modes/interactive/` | Interactive TUI mode |
| `packages/coding-agent/src/core/agent-session.ts` | Session lifecycle (106KB) |
| `packages/coding-agent/src/core/model-registry.ts` | Model/provider configuration |
| `packages/coding-agent/src/core/extensions/` | Extension loading and execution |
| `packages/coding-agent/src/core/diagnostics.ts` | Existing diagnostics module (lightweight) |
| `packages/tui/src/` | TUI library (differential rendering) |
| `packages/agent/src/` | Agent runtime (event streaming, tools) |

## What Makes agent_harness_pro Strong

### 1. Rich LLM-Facing Tool Instructions
Each tool has a dedicated `prompt.ts` file with:
- Detailed usage descriptions
- When-to-use guidance
- Conditional instructions (feature flags, git settings, sandbox mode)
- Multi-paragraph explanations the LLM actually reads
- Example: `tools/BashTool/prompt.ts` has 290 lines of rich instructions including git workflows, background tasks, safety rules, timeout configurations

**Impact:** Models get explicit, context-rich guidance about tool behavior instead of one-liners.

### 2. Proactive Diagnostics (doctor/status)
- `/doctor` command: comprehensive system health check
- `statusNotices`: proactive warnings surfaced in the UI
- Checks cover: installation type, config validity, shell setup, package manager, ripgrep, update permissions, multiple installations, aliases
- Error hierarchy: `ClaudeError`, `ConfigParseError`, `ShellError`, `TelemetrySafeError`

**Impact:** Users know their setup health immediately and get actionable fix guidance.

### 3. Multi-Source Config with Drop-in Patches
- Settings merge from 7+ sources (local → user → project → dynamic → enterprise → claudeai → managed)
- Drop-in directory convention (`managed-settings.d/`) — alphabetically sorted fragments
- Zod validation with formatted, human-readable errors
- Change detection for hot reloads

**Impact:** Enterprise-ready configuration with policy fragmentation support.

### 4. Universal Tool Interface
- Single `Tool<Input, Output, Progress>` type for all tools
- `buildTool()` provides safe defaults
- Optional methods: `renderToolResultMessage()`, `getToolUseSummary()`, `extractSearchText()`
- Permission integration: `validateInput()`, `checkPermissions()`

**Impact:** Consistent tool contracts across built-in and MCP tools.

### 5. Lazy Command Loading
- Commands loaded on first invocation, not eagerly
- Conditional imports via feature flags (`feature('KAIROS')`, etc.)
- Dead code elimination at build time

**Impact:** Fast startup regardless of command count.

### 6. Context-Based Keybindings
- Separate binding contexts: Global, Chat, Autocomplete, Settings, Confirmation
- Clean keybinding management with activation/inactivation

**Impact:** No key conflicts between different UI states.

## Comparative Findings

### What agent_harness_pro does better

| Area | agent_harness_pro | jensen-code |
|------|-------------------|-------------|
| Tool prompts | Dedicated `prompt.ts` per tool, conditional logic | One-line `toolDescriptions` object |
| Diagnostics | `/doctor` command, status notices, 15+ checks | No diagnostics command |
| Config system | 7+ source merge, drop-in patches, Zod validation | JSON load, basic merge |
| Error types | Custom error hierarchy, telemetry-safe variants | Generic `Error` usage |
| Lazy loading | Conditional imports, feature gates | Eager module loads |
| Tool contract | Universal `Tool<I,O,P>` type with optional hooks | `AgentTool<any>` with simpler contract |
| Keybindings | Context-based (separate bindings per UI state) | Flat keybinding map |
| Skills | Frontmatter schema, lazy loading, effort levels | Markdown SKILL.md, no frontmatter |

### What jensen-code already does better

| Area | jensen-code | agent_harness_pro |
|------|-------------|-------------------|
| Architecture | Clean separation (ai, agent, coding-agent, tui as packages) | Monolithic ~800+ files |
| Extensions | TypeScript extension API with tool/command/UI registration | Plugin system tied to MCP/react |
| TUI | Own differential rendering engine with synchronized output | Ink.js fork with React/JSX dependency |
| Licensing | MIT, open source | Proprietary (Anthropic) |
| Providers | 20+ LLM providers unified through jensen-ai | Primarily Claude (Anthropic API) |
| Extension system | Clean extension points (tools, commands, shortcuts) | Plugin system with feature flags |
| Session tree branching | Single-file JSONL with tree structure and `/tree` UI | JSONL with timestamp-based filtering |

### Adoption Decisions

#### Adopt directly in spirit
1. **Rich tool prompts** — Extract LLM-facing tool instructions from one-liners to detailed per-tool guidance (implemented)
2. **Diagnostics system** — Add `/doctor` slash command with key health indicators (implemented)

#### Adapt rather than copy
1. **Config validation pipeline** — jensen-code benefits from the validation-error pattern but should use its existing settings manager
2. **Lazy command loading** — Not worth complexity for current command count (~20 commands)
3. **Context-based keybindings** — Worth adopting incrementally as new UI states are added

#### Avoid (conflicts with jensen-code goals)
1. **React/Ink dependency** — jensen-code's TUI is dependency-light, differential rendering; adding React contradicts this
2. **Feature-gated modules** — jensen-code doesn't need build-time feature flags
3. **MCP integration** — jensen-code explicitly avoids MCP (philosophy: "Build CLI tools with READMEs")
4. **Telemetry/analytics** — jensen-code has no telemetry surface
5. **Sandboxing** — jensen-code philosophy: "Run in a container, or build your own with extensions"

#### Too risky/expensive right now
1. **Universal Tool interface rewrite** — `AgentTool<any>` works well; rewrite scope is too large
2. **Custom error hierarchy** — Requires changes across all packages; incremental adoption later
3. **Zod validation for settings** — jensen-code uses TypeBox; mixing validation libraries adds overhead
4. **Drop-in config patches** — No current use case for enterprise fragments

## Licensing / Boundary Notes

- agent_harness_pro appears to be based on Anthropic's Claude Code CLI (proprietary)
- Only patterns and interaction design were studied
- No code was copied from agent_harness_pro
- Improvements in jensen-code were written from scratch based on understanding the patterns

## Top Opportunities (Priority Order)

| Priority | Improvement | Effort | Rationale |
|----------|-------------|--------|-----------|
| 1 | Visible plan/todo tracking | **Done** (pass 2) | Core operator concern — model-driven todo tool + TUI surface |
| 2 | Rich tool prompts | **Done** (pass 1) | Highest impact on model behavior, lowest risk |
| 3 | Diagnostics system | **Done** (pass 1) | Quick wins for operator awareness |
| 4 | Swarm/operator task lifecycle | Medium-High | Subagent execution tracking mapped to visible plan |
| 5 | Persistent plan state | Medium | SessionEntry variant for plan recovery across /resume |
| 6 | Settings validation errors | Medium | Improves onboarding, catches misconfigurations |

## Pass 2 Reference Analysis

### Files Studied in agent_harness_pro
| File | Pattern Found |
|------|---------------|
| `tools/TodoWriteTool/TodoWriteTool.ts` | Model-callable full-list replacement, AppState.todos integration |
| `tools/TodoWriteTool/prompt.ts` | Rich LLM instructions for when/how to track tasks |
| `utils/todo/types.ts` | TodoItem schema: content, activeForm, status (pending/in_progress/completed) |
| `utils/tasks.ts` | TodoV2 file-backed persistence with blocking graph |
| `tools/TaskCreateTool/TaskCreateTool.ts` | TodoV2 task creation |
| `tools/TaskUpdateTool/TaskUpdateTool.ts` | TodoV2 status transitions + blocking |
| `hooks/useTasksV2.ts` | fs.watch + useSyncExternalStore for real-time UI |
| `components/TaskListV2.tsx` | Visible task list with status icons |
| `tasks/LocalAgentTask/LocalAgentTask.tsx` | Subagent state machine (status, progress, todoList parsed from remote) |
| `tasks/RemoteAgentTask/RemoteAgentTask.tsx` | Remote agent polling + todo extraction from logs |
| `tools/AgentTool/AgentTool.tsx` | Subagent coordinator — registers foreground/background tasks |
| `tools/TeamCreateTool/TeamCreateTool.ts` | Swarm team creation |

## Pass 3 Reference Analysis: Compaction + Memory

### Compact files studied in agent_harness_pro
| File | Pattern Found |
|------|---------------|
| `commands/compact/compact.ts` | Manual compact orchestration, cleanup, session-memory-first path |
| `commands/compact/index.ts` | `/compact` command registration |
| `services/compact/compact.ts` | Post-compact message ordering and preserved state model |
| `services/compact/sessionMemoryCompact.ts` | Session-memory-aware compaction path |
| `services/compact/autoCompact.ts` | Auto-compaction trigger logic |
| `services/compact/microCompact.ts` | Pre-compaction trimming strategy |
| `services/compact/postCompactCleanup.ts` | Cleanup of stale caches/state after compaction |
| `components/CompactSummary.tsx` | Operator-visible compact summary |
| `components/messages/CompactBoundaryMessage.tsx` | Transcript boundary marker |
| `utils/messages.ts` | Compact boundary slicing contract |
| `query.ts` / `QueryEngine.ts` | Compact result injection into future model context |
| `utils/sessionStorage.ts` | Resume-time preserved segment relinking |

### Memory files studied in agent_harness_pro
| File | Pattern Found |
|------|---------------|
| `commands/memory/memory.tsx` | Memory command/editor UX |
| `services/SessionMemory/sessionMemory.ts` | Session memory extraction + update scheduling |
| `services/SessionMemory/sessionMemoryUtils.ts` | Session memory config + loading |
| `services/SessionMemory/prompts.ts` | Anti-bloat/anti-empty memory prompts |
| `memdir/memdir.ts` | Memory file system model |
| `memdir/findRelevantMemories.ts` | Bounded retrieval selection |
| `utils/attachments.ts` | Retrieval + attachment injection path |
| `utils/messages.ts` | Memory injection wrapping and freshness text |
| `memdir/memoryAge.ts` | Staleness warning text |
| `components/memory/MemoryFileSelector.tsx` | Operator-visible memory target selection |
| `components/memory/MemoryUpdateNotification.tsx` | Post-update operator confirmation UX |
| `utils/claudemd.ts` | Memory file discovery/load order and include semantics |

### Pass 4 memory UI adoption direction

Transferable UX patterns adopted in spirit:
- dedicated operator memory surface rather than hidden state only
- explicit item visibility with concise status/freshness cues
- post-action feedback and destructive confirmation
- conservative freshness review language that avoids overclaiming

Patterns intentionally not copied because they depend on file-backed global/project memory rather than jensen-code's session-local backend:
- external editor workflow based on `$VISUAL` / `$EDITOR`
- filesystem path selection (`~/.claude/CLAUDE.md`, project files, include trees)
- file/folder memory selectors for global/project/team memory

### Pass 5 memory history / audit direction

Transferable patterns adapted in spirit:
- operator-visible memory status should remain inspectable over time, not only as current state
- notifications and review language should remain short, explicit, and honest
- current vs historical state should be clearly distinguished

Patterns intentionally avoided for pass 5:
- file-based history semantics derived from global/project memory files
- path-heavy provenance UI that would misrepresent jensen-code's session-entry backend

### Pass 6: Memory Snapshot Diff

Transferable patterns adapted in spirit:
- adjacent snapshot comparison is the honest surface for a snapshot-based persistence model
- both snapshots should be explicitly identified with timestamps in the diff UI
- "snapshot comparison · not an event log" labeling should be consistent across all surfaces

Patterns intentionally avoided:
- fabricating per-operation event attribution from snapshot diffs
- multi-snapshot range diffs that would imply event provenance jensen-code's persistence cannot support
- separate diff computation paths for text vs UI surfaces
- mtime-driven claims beyond what session entry timestamps can honestly support

### Pass 7: Two-Step Compare Chooser for Memory History

Transferable patterns adapted in spirit:
- explicit baseline arming is a bounded UI state layer over the snapshot backend
- baseline → target semantics are honest about what they compare (not event provenance)
- baseline marker in list/detail/diff views makes armed state immediately visible
- adjacent diff preserved as the quick default when no baseline is armed
- explicit target-picking step gives the operator visual confirmation before diff opens
- "(same snapshot)" annotation when baseline === target keeps framing honest

Patterns intentionally avoided:
- global keybinding system changes — only local to the memory editor history flow
- redesigning persistence or diff computation
- multi-snapshot range comparison that would imply event attribution beyond what snapshot-based persistence supports
- "event log" framing — this remains explicitly snapshot comparison
- automatically re-ordering baseline/target when target is older — UI honestly shows `baseline → target`

### Pass 8: Explicit Snapshot-ID Compare for Textual Command

Transferable patterns adapted in spirit:
- explicit snapshot IDs make the textual compare surface self-contained without requiring the UI
- short IDs in history output (first 8 chars) are copy/paste-friendly for the operator
- clear error messages when IDs are missing or not in current branch — honest about what went wrong
- same-ID honest handling — "no changes to show" without implying a diff was computed
- bracket-tolerant input — IDs copied from history output `[xxxxxxxx]` are accepted transparently

Patterns intentionally avoided:
- provenance log framing — this is direct snapshot-ID comparison over current-branch persisted snapshots
- multi-snapshot range comparison that would imply event attribution
- fabricating event attribution from snapshot diffs
- separate diff computation paths for text vs UI
- fuzzy matching or hidden lookup rules — prefix matching is strict unique-prefix only
- accepting ambiguous prefixes silently — ambiguous prefixes are rejected with candidates listed

### Pass 9: Bounded Copy-Friendly Ergonomics — /memory diff Text Workflow

Transferable patterns adapted in spirit:
- copy-friendly bracket notation: IDs shown as `[xxxxxxxx]` in history output, brackets optional on input
- strict deterministic resolution: exact full ID, exact short ID (8 chars), or strict unique prefix
- clear ambiguous-prefix rejection: shows all matching candidates, never guesses silently

Patterns intentionally avoided:
- fuzzy matching or hidden lookup rules — strict unique prefix required, ambiguous prefixes always rejected
- provenance log framing — this is direct snapshot-ID comparison over current-branch persisted snapshots
- multi-snapshot range comparison that would imply event attribution

### Pass 10: Dedicated Snapshot Selector Resolver Contract

Reference files revisited for clarity only:
- `commands/memory/memory.tsx`
- `components/memory/MemoryFileSelector.tsx`
- `components/memory/MemoryUpdateNotification.tsx`
- `utils/claudemd.ts`
- `memdir/memoryAge.ts`

Transferable patterns adapted in spirit:
- selector handling should be explicit and separately reasoned about, not hidden inside one command path
- compare surfaces should share one deterministic resolution contract instead of reimplementing parsing rules
- operator-facing ambiguity and no-match messaging should remain direct and honest

Patterns intentionally avoided:
- copying reference selector code or file-backed memory semantics
- widening selector rules beyond exact full ID, exact displayed short ID, bracketed short ID, and strict unique prefix
- implying backend provenance beyond current-branch snapshot resolution

### Pass 11: Shared Selector-Resolution Messaging Contract

Reference files revisited for operator-clarity patterns only:
- `commands/memory/memory.tsx`
- `components/memory/MemoryFileSelector.tsx`
- `components/memory/MemoryUpdateNotification.tsx`
- `utils/claudemd.ts`
- `memdir/memoryAge.ts`

Transferable patterns adapted in spirit:
- selector guidance should be explicit and reusable instead of assembled inline in one command branch
- ambiguity output should list concrete candidate IDs in the same copy-friendly bracketed-short-ID form already shown in history output
- accepted selector forms should be explained once and reused verbatim across compare surfaces
- explicit compare output should continue to show the resolved full snapshot IDs transparently

Patterns intentionally avoided:
- copying wording or implementation verbatim from the reference repo
- moving selector resolution logic back into UI command code
- adding fuzzy matching, backend changes, or file-backed memory semantics

### Pass 12: Print-Mode Non-UI Compare Reuse

Reference files revisited for consistency cues only:
- `commands/memory/memory.tsx`
- `components/memory/MemoryFileSelector.tsx`
- `components/memory/MemoryUpdateNotification.tsx`
- `utils/claudemd.ts`
- `memdir/memoryAge.ts`

Transferable patterns adapted in spirit:
- the next non-UI compare surface should stay text-first and operator-copyable, not invent a new backend abstraction
- compare guidance should remain identical across surfaces when selector rules are the same
- snapshot-based framing should stay explicit outside the UI as well, especially when output is plain text
- the smallest honest non-UI follow-up is a text surface that can reuse existing compare wording directly

Patterns intentionally avoided:
- copying reference CLI command implementations or wording verbatim
- introducing file-backed or global memory semantics into jensen-code's session-local backend
- implying event provenance or event-sourced behavior in plain-text compare output
- widening this pass into an RPC/API redesign

### Pass 13: Bounded RPC Memory Snapshot Surface

Reference files revisited for consistency cues only:
- `commands/memory/memory.tsx`
- `components/memory/MemoryFileSelector.tsx`
- `components/memory/MemoryUpdateNotification.tsx`
- `utils/claudemd.ts`
- `memdir/memoryAge.ts`

Transferable patterns adapted in spirit:
- one programmatic surface should expose the same real snapshot data already shown to operators
- selector rules should stay deterministic across UI, print, and programmatic consumers
- programmatic history/compare should stay explicit about current-branch scope and snapshot-based framing
- structured payloads are the honest fit when the host surface is already a typed JSON RPC protocol

Patterns intentionally avoided:
- copying reference command or component code into the RPC path
- inventing file-backed or global memory provenance for jensen-code's session-local backend
- returning plain-text blobs from RPC when the existing RPC protocol is structured
- widening the change into a general RPC redesign or backend/schema rewrite

### Pass 14: SDK-facing structured memory consumer

Reference files revisited for consistency cues only:
- `commands/memory/memory.tsx`
- `components/memory/MemoryFileSelector.tsx`
- `components/memory/MemoryUpdateNotification.tsx`
- `utils/claudemd.ts`
- `memdir/memoryAge.ts`

Transferable patterns adapted in spirit:
- the same real snapshot contract should be consumable by automation without inventing a second meaning for history or compare
- same-process consumers should reuse existing structured semantics instead of wrapping a subprocess just to recover the same payload
- snapshot-based framing and current-branch-only scope should remain explicit even when the consumer is an SDK surface

Patterns intentionally avoided:
- copying reference automation or memory command code into jensen-code
- inventing a second structured contract just because the consumer medium changed
- widening into JSON-mode redesign, backend rewrite, or fake event provenance

### Pass 16: Working-context integration reference note

Reference files revisited for operator-clarity patterns only:
- `/home/magnus/software/agent_harness_pro/commands/memory/memory.tsx`
- `/home/magnus/software/agent_harness_pro/components/memory/MemoryFileSelector.tsx`
- `/home/magnus/software/agent_harness_pro/components/memory/MemoryUpdateNotification.tsx`
- `/home/magnus/software/agent_harness_pro/utils/claudemd.ts`
- `/home/magnus/software/agent_harness_pro/memdir/memoryAge.ts`

Transferable patterns adapted in spirit:
- one compact operator surface should summarize current working context instead of forcing the operator to mentally merge separate memory, plan, and delegated-work islands
- summary text should stay explicit about what is active now versus what is merely available elsewhere
- delegated-work visibility should remain grounded in actual runtime state, not a fabricated dashboard

Patterns intentionally avoided:
- copying reference swarm/task UI or wording
- pretending jensen-code has persisted swarm provenance when repo evidence only supported live subagent tool lifecycle state
- widening this pass into a task-backend rewrite or file-backed memory model

### Pass 17: RPC working-context surface

Reference files revisited for wording/clarity patterns only:
- `/home/magnus/software/agent_harness_pro/commands/memory/memory.tsx`
- `/home/magnus/software/agent_harness_pro/components/memory/MemoryFileSelector.tsx`
- `/home/magnus/software/agent_harness_pro/components/memory/MemoryUpdateNotification.tsx`
- `/home/magnus/software/agent_harness_pro/utils/claudemd.ts`
- `/home/magnus/software/agent_harness_pro/memdir/memoryAge.ts`

Transferable patterns adapted in spirit:
- one programmatic surface should expose the same honest current-state distinctions already visible to the operator
- persisted summaries and live-only runtime summaries should be labeled directly in the contract instead of relying on implied provenance
- empty state should be represented explicitly and conservatively, not by fabricating hidden history or persistence

Patterns intentionally avoided:
- copying reference command or selector implementations
- inventing file-backed/global memory provenance for jensen-code's session-local backend
- pretending delegated work survives resume or process restart

### Pass 18: SDK-facing same-process working-context surface

Reference files revisited for wording and honesty patterns only:
- `/home/magnus/software/agent_harness_pro/commands/memory/memory.tsx`
- `/home/magnus/software/agent_harness_pro/components/memory/MemoryFileSelector.tsx`
- `/home/magnus/software/agent_harness_pro/components/memory/MemoryUpdateNotification.tsx`
- `/home/magnus/software/agent_harness_pro/utils/claudemd.ts`
- `/home/magnus/software/agent_harness_pro/memdir/memoryAge.ts`

Transferable patterns adapted in spirit:
- same-process SDK methods should delegate to the same shared builder used by subprocess and interactive surfaces
- SDK tests should verify the contract structure and honesty markers directly
- canonical examples should demonstrate real automation flows without requiring callers to infer usage

Patterns intentionally avoided:
- adding new persistence or state models to the SDK
- creating parallel builder paths for SDK vs RPC vs interactive
- pretending delegated work is persisted when repo evidence only supports live current-process state

### Pass 19: Bounded working-context consolidation

Reference files revisited for wording and honesty patterns only:
- `/home/magnus/software/agent_harness_pro/commands/memory/memory.tsx`
- `/home/magnus/software/agent_harness_pro/components/memory/MemoryFileSelector.tsx`
- `/home/magnus/software/agent_harness_pro/components/memory/MemoryUpdateNotification.tsx`
- `/home/magnus/software/agent_harness_pro/utils/claudemd.ts`
- `/home/magnus/software/agent_harness_pro/memdir/memoryAge.ts`

Transferable patterns adapted in spirit:
- consolidating the same builder path for all working-context consumers ensures consistency between SDK, RPC, and interactive surfaces
- the consolidation should not add new state models or persistence claims

Patterns intentionally avoided:
- adding new working-context surfaces or state models
- creating parallel builder paths
- changing the working-context contract

