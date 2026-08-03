# Reasonix Code Intelligence & Tool Reliability — Technical Research Note

**Date**: 2026-08-03
**Inspected by**: Jensen-Code scout
**Purpose**: Deep technical reconnaissance of the Reasonix (DeepSeek) coding agent to inform independent Jensen-native architecture decisions.

## Repository and Commits Inspected

- **Repository**: https://github.com/esengine/DeepSeek-Reasonix.git
- **Default-branch commit (origin/HEAD)**: `22e18cafc0dfe27f192e8e303ffae0a0bc548eb0`
  - Date: 2026-08-03 06:00:46 +0800
  - Subject: Merge pull request #7242 from SivanCola/codex/fix-v1193-windows-authenticode
- **Latest stable tag**: `v1.19.3` → commit `15d335b86b311147442a2f5448daf9594205caa0`
  - Date: 2026-08-03 02:05:59 +0800
  - Subject: Merge pull request #7237 from esengine/release-notes/v1.19.3
- **Language**: Go (go.mod, go.sum), no package.json
- **License**: MIT (Copyright 2026 Reasonix Contributors)

## Source and Test Paths Inspected

All paths are under `internal/` (the Go source tree):

| Directory | Module | Key files |
|-----------|--------|-----------|
| `lsp/` | LSP client + manager | `manager.go`, `client.go`, `jsonrpc.go`, `position.go`, `results.go`, `tool.go` |
| `tool/` | Tool abstraction + registry | `tool.go`, `resolved.go`, `contract.go` |
| `tool/builtin/` | Built-in tools (bash, bgjobs, LSP) | `bgjobs.go`, `bash.go`, `editfile.go`, `writefile.go`, `codeindex.go`, `codeindex_treesitter.go` |
| `agent/` | Agent loop + execution | `agent.go`, `execute_one.go`, `scheduler.go`, `storm_test.go`, `repeat_failure_guard.go`, `parallel_tasks.go`, `fleet.go` |
| `jobs/` | Background job registry | `jobs.go` |
| `proc/` | Process-tree termination + tracking | `run.go`, `tracked.go`, `kill_other.go`, `hide_other.go` |
| `provider/` | Provider wire protocol + schema | `provider.go`, `schema_canonicalize.go`, `schema_validate.go`, `schema_error.go`, `schema_dialect.go` |
| `repair/` | Config repair / self-healing | `plan.go`, `startup.go`, `diagnose.go`, `update.go` |

## Mechanisms Studied

### 1. LSP Integration

**Files**: `internal/lsp/manager.go`, `client.go`, `jsonrpc.go`, `position.go`, `results.go`, `tool.go`

**How it works**:

- **Language detection**: File extension → language key via `extIndex` map (`map[string]string`), built from `ServerSpec.Extensions`. A `DefaultSpecs()` function maps 15 languages (go, rust, typescript, python, cpp, csharp, java, ruby, php, lua, bash, zig, kotlin, swift, haskell) to conventional LSP servers resolved on PATH. Extensions are the sole routing key — adding a new language from config requires zero code changes.

- **Server startup/reuse**: Lazily spawned on first query via `Manager.resolve(path)`. Concurrent first-use calls share one spawn via a `starting` channel gate (`map[string]chan struct{}`) — duplicate server launches are prevented. The `Manager.Close()` shuts down all servers via `client.close()` which sends LSP `shutdown` → `exit` → `Process.Kill()`.

- **Document synchronization**: Uses `didOpen` (first sync) / `didChange` (subsequent syncs), driven by `client.ensureSynced()`. Detects out-of-band disk edits (from any tool, including bash) by comparing `stat` attributes (size + modtime) against last-sent state. Version integer increments monotonically. No `didClose` — the session-scoped context cancels all servers on close.

- **Semantic requests**: Four tools are exported to the agent:
  - `lsp_definition` — `textDocument/definition`
  - `lsp_references` — `textDocument/references` (with `includeDeclaration: true`)
  - `lsp_hover` — `textDocument/hover`
  - `lsp_diagnostics` — waits for `textDocument/publishDiagnostics` via polling (40ms intervals, 2s deadline)

  Symbol location uses a text scan on the target line (no AST/treesitter). `parseLocations()` handles three LSP response shapes: Location, Location[], LocationLink[]. `parseHover()` handles MarkupContent, MarkedString, and MarkedString[].

- **Position encoding**: Server negotiates encoding at `initialize`. Defaults to UTF-16, switches to UTF-8 when both sides agree. `encodeChar()` converts byte offsets to the negotiated encoding.

- **Content-modified resilience**: `callRetry()` retries up to 5 times with 400ms delay when the server returns error code -32801 (ContentModified — server is mid-reindex). At the tool level, `indexingOr()` converts persistent ContentModified into a retry-shortly message rather than surfacing an error.

- **Not supported**: document symbols, workspace symbols, rename, implementations, document highlight, code actions, formatting. These are deliberate omissions.

**Strengths**:
- Zero-config language detection from file extension, user-extensible without code changes.
- Concurrent-first-use gate prevents duplicate server launches.
- Stat-based out-of-band edit detection handles any tool modifying files.
- Cross-encoding position resolution.
- Content-modified retry loop handles reindexing windows gracefully.

**Limitations**:
- No document/workspace symbols (no fuzzy "jump to symbol" without knowing the file).
- No rename refactoring — the agent must edit files manually.
- No implementations — only definition and references.
- Symbol location is text-scan based, not AST-based — fragile with unusual whitespace or comments that match the symbol text.
- The concurrency gate uses a blocking channel pattern (`<-ch`) that could cause subtle deadlocks if resolve is called reentrantly.

### 2. Tool-Call Parsing and Repair

**Files**: `internal/provider/provider.go`, `schema_canonicalize.go`, `schema_validate.go`, `schema_error.go`

**Schema canonicalization** (`CanonicalizeSchema`):
- Recursively stabilizes JSON Schema so identical logical schemas produce identical bytes (prompt-cache stability).
- Handles: `nil`/empty schema → `{"properties":{},"type":"object"}`, missing root `type` → injected `"object"`, non-array `required` → deleted (OpenAPI-style `{"required": true}`), sorts `required` arrays, canonicalizes nested `properties`/`patternProperties`/`$defs`/`definitions`.
- Central safety net for MCP servers that emit malformed schemas.

**Schema validation** (`ValidateToolSchema`):
- Compiles each tool's parameter schema against JSON Schema draft-07 using `jsonschema.Compile`.
- Rejects: non-object roots, roots with type != "object", invalid JSON, multiple JSON values.
- Disables the default filesystem/network loader for `$ref` resolution (MCP schemas must never reach the filesystem or network).

**Schema error annotation** (`AnnotateToolSchemaError`):
- Parses provider 400/422 error messages (e.g., "Tool 197 function has invalid 'parameters' schema") and maps the index back to the Reasonix tool name, including the MCP server identity.
- Enables actionable diagnostics: "Provider tool 197 maps to Reasonix tool `mcp__github__search_issues` (MCP server 'github', tool 'search_issues')."

**Truncated JSON repair** (`closeTruncatedJSON` in `provider.go`):
- Closes unterminated strings: appends `"`.
- Closes dangling backslash escape: trims trailing `\`.
- Closes open braces/brackets: pushes a stack during scan, appends closing characters in reverse order.
- Strips trailing commas (before close-brace), replaces trailing `:` with `:null`.
- Falls back to `{}` if the result still isn't valid JSON.
- Triggered by `needsToolCallArgRepair()` which checks `json.Valid()` on each tool-call argument.
- Applied at normalize time (before provider wire send), never mutates stored session.

**Tool-call pairing** (`NormalizeMessages` / `SanitizeToolPairing`):
- Repairs provider-visible conversation history to satisfy the tool-call contract.
- Backfills empty tool-call names from corresponding tool result messages (#4727 — old sessions).
- Pairs tool results with their tool calls (by id then by position for id-less streaming gateways).
- Inserts `[no result: the previous turn was interrupted...]` placeholder for unanswered calls.
- Drops orphan tool messages (for provider sends; preserves them for session loads).
- Fast path: well-formed history returns the input slice unchanged (zero allocation, prompt-cache key stable).

**Strengths**:
- Schema canonicalization is thorough and handles real-world MCP schema quirks.
- Truncated JSON repair uses a structural stack approach that's more robust than regex.
- Schema error annotation links provider errors back to MCP identities.
- Fast-path normalization avoids allocations for healthy sessions.

**Limitations**:
- `closeTruncatedJSON` does not attempt to recover partial object keys or predict truncated values — it only closes structural containers. If the last key had a truncated value, the result `{}` loses information.
- No scavenging — does not attempt to recover tool calls from LLM text output (e.g., markdown code blocks containing JSON). Only repairs already-structured tool calls that were truncated mid-stream.
- Schema validation rejects but doesn't auto-repair common MCP schema issues (beyond what `CanonicalizeSchema` handles), deferring repairable schemas to quarantine.

### 3. Duplicate-Call Protection / Loop Guard (Storm Breaker)

**Files**: `internal/agent/agent.go` (stormSig/stormCount, blockedTurnStreak, applyStormBreaker), `repeat_failure_guard.go`, `execute_one.go` (parseToolCall)

**Storm Breaker** (`applyStormBreaker`, threshold = 3 turns):
- **Signature detector** (`batchStormSignature`): Keys each call in a batch by `(tool_name, error_class_or_blocker)`, NOT by arguments. Since a stuck model often rewords arguments cosmetically while hitting the same host refusal, argument-agnostic matching catches the fixation. Only fires when every call in the batch errored or was blocked. Hitting the threshold arms the final-readiness loop-guard pass.
- **Streak detector** (`blockedTurnStreak`): Counts consecutive turns where every call was BLOCKED (by permission, plan mode, hook, or loop guard) — not just errored. Catches rotating between blocked tools, reordering a batch, or varying blocker text that escapes signature matching. Any success (a call that passed through) resets the streak.
- When either detector fires: the model-facing result for the first tool call gets a `[loop guard]` prefix directing the model to change approach. A notice is emitted to the user. The final-readiness loop guard is armed so the model can report the blocker on the next turn.

**Repeat-Failure Guard** (`repeatFailureBlock`, threshold = 2):
- Tracks write-like calls that keep FAILING with the same failure class.
- Different from storm breaker: successful reads do NOT blindly clear this state (re-reading a file and then resending the same stale anchor is still zero progress).
- For `edit_file`/`multi_edit`: failure classes are `old_string_not_found` and `old_string_not_unique`. When the guard fires, a Preview re-check confirms the anchor is still invalid before blocking.
- A successful mutation to overlapping paths clears the failure record.

**Repeat-Success Guard** (`repeatedSuccessBlock`, threshold = 3):
- Tracks write-like calls that keep SUCCEEDING with the same canonical arguments.
- Catches the complementary loop shape: model keeps doing the same successful write.
- Signatures for edit tools use `name + canonicalToolArgs` (JSON canonicalization). For bash, uses `normalizeShellCommand` (static field extraction, whitespace normalization).

**Stale Anchor Guard** (`staleAnchorEditBlock`):
- Specific to `delete_range`: blocks the call if the target file was already modified this turn and hasn't been re-read with `read_file` (without offset/limit). Prevents two independently resolved start/end anchors from selecting an unintended destructive span.

**Loop Guard Final-Readiness Pass** (`loopGuardArmed`):
- When any guard fires, the final-readiness loop-guard pass is armed. On the next turn, the model may ask/complete_step/todo_write without being forced to produce the receipts the guard just blocked. Reset at the start of each user turn. Guarded by a receipt-mark so real progress (new mutation evidence) revokes the pass.

**Strengths**:
- Multi-layered: signature, streak, repeat-failure, repeat-success, stale-anchor — each catches a different failure mode.
- Argument-agnostic signature detection (keys on error class, not args) catches the most common fixation pattern.
- Preview re-check for anchor-based edits before blocking prevents stale-state false positives.
- Thresholds are low enough (2-3) to catch fixations early, high enough to allow self-correction.
- Comprehensive test coverage (`storm_test.go`, `repeat_guard_test.go`, `stale_anchor_guard_test.go`).

**Limitations**:
- The repeat-failure guard only tracks write-like tools. Read-only tools that keep failing (e.g., a broken grep) are only caught by the broader storm breaker.
- `repeatSuccessSignature` hardcodes the list of tracked tools — adding a new write tool requires updating the switch statement.
- The stale-anchor guard only applies to `delete_range`. Other anchor-based operations (if any) would need their own entry in `anchorBasedEditTool`.

### 4. Parallel Execution and Deterministic Result Ordering

**Files**: `internal/agent/execute_one.go`, `parallel_tasks.go`, `scheduler.go`, `fleet.go`

**Parallel read-only dispatch**:
- The agent can dispatch a batch of tool calls in parallel when every call in the batch is `ReadOnly()`. Mixed batches stay sequential so write/read ordering is preserved.
- `executeOne` is pure with respect to the event sink — safe to invoke from parallel goroutines.
- Each call follows a 4-stage pipeline: `parseToolCall` → `resolveToolPolicy` → `prepareToolExecution` → `finishToolExecution`.
- Result ordering: parallel dispatch collects results into a slice indexed by call position, so results are returned to the model in the order calls were made — deterministic regardless of which goroutine finishes first.

**Subagent concurrency** (`SubagentScheduler`):
- Session-scoped concurrency controller shared by task, fleet, parallel_tasks, profile skills, and nested sub-agents.
- Configurable limits: `maxTotal` (total sub-agents) and `maxWriters` (concurrent writer sub-agents).
- Write-path claims: each writer declares its `WritePaths`; overlapping claims serialize writers (FIFO queue). Whole-workspace claims serialize against every other writer.
- Parent write claims: when the parent agent executes a write tool, `ReserveParentWrite` blocks overlapping subagent claims without consuming a subagent slot. Released when the write completes.
- Nested sub-agents: fail fast when capacity is exhausted (no queueing) to avoid parent/child slot deadlocks.
- Clean release: `makeRelease` is called exactly once via `sync.Once`, then `pumpWaitersLocked` activates queued workers.

**Parallel tasks** (`parallel_tasks` tool):
- Dispatches 2-64 read-only sub-agent tasks concurrently, blocks until all complete.
- Each task runs in its own read-only sub-agent.
- Results are collected in task-index order (deterministic).
- Cancellation: cancels all children on parent cancellation, propagates error.
- Enforces minimum 2 tasks (single task uses `task` instead).

**Fleet tool** (`fleet`):
- Dispatches 2-64 profile-aware sub-agent tasks in parallel.
- Each item may select profile, model, effort, tools, write_paths, or read_only.
- Multiple writers must declare non-overlapping write_paths; omitted write_paths claim the whole workspace.
- Independent failure: one failure does not cancel others.
- Background mode: returns a fleet job id collectable with `wait`.

**Strengths**:
- Deterministic result ordering (by call position, not goroutine completion).
- Write-path conflict detection prevents concurrent sub-agents from racing on the same files.
- Nested fail-fast prevents a common deadlock pattern.
- `sync.Once` release and FIFO waiter pump guarantee correctness under concurrent acquisition.

**Limitations**:
- No awareness of tool output size for scheduling — a batch of 10 read-only calls all dispatching in parallel could overwhelm context.
- `parallel_tasks` is strictly read-only. Any write task must go through `task` (sequential) or `fleet` (with write_path declarations).
- Result ordering is determined by the *call order* the model produces, which may not be the logical dependency order the user expects.

### 5. Background Processes: Job Registry, Logs, Process-Tree Termination

**Files**: `internal/jobs/jobs.go` (1722+ lines), `internal/proc/run.go`, `tracked.go`, `kill_other.go`, `tree_other.go`

**Job Registry** (`Manager`):
- Session-scoped: owned by a session, lifetime is the session (not a single turn). Jobs survive across turns.
- Two spawn methods: `Start` (legacy unscoped) and `StartForSession` (session-scoped).
- Two job kinds: `bash` and `task` (sub-agents).
- Start flow: validates `parentSession` and `kind` for path-traversal safety → allocates id (`<kind>-<seq>`) → opens artifact log path (temp dir or persistent session dir) → creates `Job` struct → emits start notice → launches goroutine with panic recovery.
- Streaming output: `jobWriter` appends to an in-memory tail buffer (bounded by `defaultTailBytes`) AND writes to an on-disk artifact file simultaneously. Incremental tail reading via read offset.
- Terminal output: for artifact-backed jobs, the full output is on disk (read via `readArtifactAllLocked`). For non-artifact jobs, output is in the tail buffer.
- Lifecycle statuses: `Running`, `Done`, `Failed`, `Killed`, `Interrupted`.

**Background tools**:
- `bash(run_in_background=true)`: Starts a bash command in background. Returns `"Started background bash job id=<bash-N>"`.
- `task(run_in_background=true)`: Starts a sub-agent task in background.
- `bash_output(job_id, filter)`: Polls new output incrementally (non-blocking), returns `[job_id] status` header + new text. Optional regex filter.
- `kill_shell(job_id)`: Synchronously flips job status to `Killed`, cancels context (which sends kill signal). Returns false if already terminal.
- `wait(job_ids, timeout_seconds)`: Blocks until specified jobs (or all running jobs) reach terminal state. Returns each job's status and final output.

**Artifact persistence**:
- Job output is written to a temp directory (`reasonix-jobs-*`) and migrated to the persistent session directory via `SetActiveSessionPath`.
- Metadata files (`.meta.json`) track job identity, status, timestamps, artifact completion, and mutation evidence (for task jobs — which write tools were used, risk classification).
- On session load (`loadSessionArtifacts`): reads metadata files, detects Running jobs owned by a live manager (deferred), detects orphaned Running jobs from a dead process (repaired to `Interrupted` if the current process owns the session lease), publishes tombstones for completed/killed/interrupted jobs.
- Recovery from interruption: `mutationEvidenceFromArtifact` reconstructs the ChildEvidenceSummary from persisted artifact metadata, preserving mutation risk level and file paths.

**Process-tree termination** (`proc`):
- `RunCommand`: supports optional process-tree tracking. When enabled, wraps the command in a platform job object (`StartTracked`) and starts a tree tracker (`TrackTree`).
- `Kill()`: calls `KillTracked` (platform job object termination) + `tree.Kill()` (walk the process tree).
- `Cancel` propagation: context cancellation → `tracked.Kill()` → waits for `cmd.Wait()` with grace period → if wait blocks past grace: logs diagnostics, retries kill at intervals, eventually returns after retry window.
- `SetCancelKillsTree`: for non-tracked commands, configures `cmd.Cancel` to call `KillTree` so context cancellation kills the entire process group.
- Platform support: Linux (`kill_other.go`, `tree_other.go` using `/proc`), Windows (`kill_windows.go`, `tree_windows.go`).

**Stalled job detection**:
- Optional per-job monitor goroutine: after `stalledWarning` duration without visible output, emits a `stalled` notice to the user.
- Stalled notice is queued as a completion note and drained into the next turn: "bash-3 may be stalled — still running after 5m0s with no visible output."

**Session teardown**:
- `BeginDestroySession`: cancels all running session jobs, returns a `SessionTeardown` handle.
- `WaitTeardown`: waits for all jobs to unwind up to `teardownGrace` (default 15s). Timed-out jobs are reported but cleanup proceeds.

**Strengths**:
- Session-scoped jobs survive across turns — enables long-running builds, servers, and sub-agents.
- Artifact persistence with metadata enables recovery after crash/restart.
- Incremental output polling via read offset avoids re-reading the entire buffer.
- Process-tree tracking ensures no orphaned child processes.
- Stalled detection warns about hung background jobs.
- Path-traversal validation on `parentSession` and `kind` prevents artifact directory escape (#6932).

**Limitations**:
- No structured output channel — output is plain text, polled incrementally.
- Wait is blocking (for the agent turn) — no callback/event-based notification.
- Only two job types (bash, task). No generic "run this tool in background" abstraction.
- Artifact migration between temp and persistent directories is complex and fragile (multi-lock pattern).

## Relevant Strengths (for Jensen adoption)

1. **LSP extension-by-config**: The `extIndex` pattern where file extensions are the sole routing key, and users can override or add languages from config without code changes, is clean and directly applicable to Jensen's TS architecture. Our LSP integration should mirror this.

2. **Stat-based dirty detection**: `ensureSynced` compares `size + modtime` rather than requiring explicit file-watch notifications. This works with any tool (bash, edit_file, etc.) and is simpler than a filesystem watcher.

3. **Schema canonicalization**: `CanonicalizeSchema` is a critical pattern for prompt-cache stability. Jensen should canonicalize tool schemas at registration time (as Reasonix does) to avoid cache misses from semantically identical but lexically different schemas.

4. **Multi-layered loop guard**: Storm breaker + repeat-failure + repeat-success + stale-anchor is comprehensive. The argument-agnostic signature (keys on error class, not args) is the key insight — it catches the most common model fixation pattern.

5. **Deterministic result ordering**: Collecting parallel results by call position (not goroutine completion) is essential for predictable model behavior.

6. **Session-scoped job registry**: Jobs that survive across turns, with artifact persistence and crash recovery, is a strong pattern for background task/sub-agent work.

7. **Truncated JSON repair**: The stack-based `closeTruncatedJSON` is simple and effective for recovering from output-token-ceiling truncations.

## Jensen-Native Design Decisions

### LSP
- Implement in TypeScript with the same extension-index pattern. Use `vscode-languageserver-protocol` types (we already have them as a devDependency in the coding-agent).
- Support definition, references, hover, diagnostics initially. Add document symbols and workspace symbols later (they are high-value for code intelligence).
- Use stat-based dirty detection (same as Reasonix) since we can't rely on file watchers across tool boundaries.
- Add rename support (broadcast `workspace/applyEdit` for the rename result) — this is a capability Reasonix deliberately omitted but is valuable for Jensen.

### Tool-Call Repair
- Implement `closeTruncatedJSON` in TypeScript. The stack-based approach is language-agnostic.
- Do NOT implement tool-call scavenging (extracting calls from LLM text). Reasonix doesn't do this either — it's fragile and the LLM should produce structured calls.
- Canonicalize schemas at tool registration time using `json-stable-stringify` or similar. This is critical for Anthropic prompt caching.

### Duplicate-Call Protection
- Implement the multi-layered guard: storm breaker (signature + streak), repeat-failure, repeat-success, stale-anchor.
- The key parameters: threshold = 3 for storm breaker, threshold = 2 for repeat-failure/3 for repeat-success.
- The argument-agnostic signature (keys on error class, not args) is the essential insight.
- For Jensen's TS architecture, maintain these as per-turn state on the Agent, reset at the start of each user turn.

### Scheduler
- Implement `SubagentScheduler` with the same FIFO waiter queue, write-path conflict detection, nested fail-fast.
- Add awareness of context budget (total tool output size) to prevent parallel dispatch from overwhelming the context window.
- Implement write-path claims at the tool level so concurrent sub-agents can't race on the same files.

### Background Jobs
- Implement a session-scoped `JobManager` with the same API surface: start, output (incremental), kill, wait.
- Use temp directories for in-progress output, migrate to persistent storage on session bind.
- Don't implement artifact metadata persistence initially (v1), but design the interface to support it.
- Add structured output channels as a v2 enhancement (Reasonix's plain-text-only output is limiting).

## Features Deliberately Rejected

1. **Tool-call scavenging from LLM text output**: Too fragile. The LLM should produce structured tool calls. If it doesn't, repair (closeTruncatedJSON) is the correct response, not scavenging.

2. **LSP rename/implementations/document symbols**: Reasonix omitted these. We will initially follow suit (definition, references, hover, diagnostics) and evaluate adding rename and symbols based on user demand. Document symbols are particularly valuable for "jump to symbol" and should be a near-term addition.

3. **AST-based symbol location**: Reasonix uses text-scan for symbol location. We should consider using treesitter for a more robust location (our coding-agent already has treesitter dependencies). This would handle whitespace variants and comments that match the symbol text.

4. **Inline interpreter execution in background**: Reasonix's delivery mode blocks `node -e`, `python -c` etc. as opaque mutations. We should adopt the same policy for auditability.

## License/Provenance Outcome

- **License**: MIT (Copyright 2026 Reasonix Contributors)
- **Provenance**: Public GitHub repository at esengine/DeepSeek-Reasonix
- **Jensen compatibility**: MIT is fully compatible with Jensen's license. Independent implementation of concepts is the correct approach (no code reuse). All mechanisms described above are patterns/architectures, not copyable code.
