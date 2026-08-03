# Reasonix Safe Autonomous Execution — Research Note

## Repository and Inspected Commits

- **Origin**: `https://github.com/esengine/DeepSeek-Reasonix.git`
- **Latest stable release**: `v1.19.3` at commit `15d335b86b311147442a2f5448daf9594205caa0`
- **Default branch**: `main-v2` at commit `c46e3af1c2732fe2b3dedb0bd47eb39a629357d2` (HEAD at time of inspection)
- **License**: MIT (Copyright 2026 Reasonix Contributors)

## Relevant Source Paths

| Concern | Path |
|---|---|
| Checkpoint (rewind) | `internal/checkpoint/checkpoint.go` |
| Guardian (LLM reviewer) | `internal/guardian/guardian.go`, `guardian_policy.md` |
| Workspace lease | `internal/workspacelease/lease.go` |
| Sandbox (OS jail) | `internal/sandbox/sandbox.go`, `escape.go`, `shell.go` |
| Permission policy | `internal/permission/permission.go`, `bash_decompose.go` |
| Hooks | `internal/hook/hook.go`, `runner.go` |
| Recovery (Auto Guard) | `internal/recovery/gate.go`, `rules.go`, `state.go`, `persist.go` |
| Worktree (isolation) | `internal/worktree/worktree.go` |
| Tool contracts | `internal/tool/contract.go` |
| Subagent guard | `internal/tool/subagentguard.go` |
| Evidence/verification | `internal/evidence/commandmatch.go` |
| Shell safety | `internal/shellsafe/`, `internal/shellparse/` |

## Mechanisms Studied

### 1. Checkpoint / Rewind (`internal/checkpoint`)
Deliberately git-free, like Claude Code's rewind. Before any writer tool mutates a file, the pre-edit content is snapshotted keyed to the user turn. Restore rewrites files to earliest recorded state, deletes files that didn't exist pre-turn. Only edit-tool changes are tracked; bash side effects are explicitly excluded. Paths are validated against workspace root to prevent escape. Persisted as one JSON per turn in a session-adjacent `.ckpt/` directory.

### 2. Guardian (`internal/guardian`)
A separate LLM sub-agent session that reviews every tool call before execution. The policy prompt is a markdown file (`guardian_policy.md`) loaded as the system prompt. Guardian reuses one session across turns for prefix-cache warmth. Circuit breaker: 3 consecutive denials or 10/50 recent denials triggers session interrupt. Each review runs with a read-only tool registry (up to 6 steps), 30s timeout. Assessment returns JSON: `{risk_level, user_authorization, outcome, rationale}`. Failed/unparseable reviews default to deny.

### 3. Workspace Lease (`internal/workspacelease`)
Cross-process write serialization via file locks. One `Owner` per delivery session shared by root agent + subagents. Acquired lazily on first write, released when all runs and background jobs finish. Readers never block. Uses SHA-256 of canonicalized workspace path as lock key, resolving symlinks and git worktree roots.

### 4. Sandbox (`internal/sandbox`)
OS-level confinement for bash: macOS Seatbelt (`sandbox-exec`), Linux bubblewrap. Configurable write roots (workspace + temp + toolchain caches), forbid-read roots, network toggle. When enforce is requested but backend unavailable, fails closed (refuses to run unconfined). MCP profiles get minimal write paths.

### 5. Permission Policy (`internal/permission`)
Pure, I/O-free rule engine: deny > ask > allow > fallback. Rules match `ToolName(glob)` or `ToolName=literal`. Bash commands are decomposed into simple-command segments; each segment independently evaluated. Compound commands (`git add && git commit && git push`) get per-segment matching. The `Edit` virtual tool covers all file mutation tools. "Always allow" remembers tool-wide for file mutations, bash prefix for commands.

### 6. Hooks (`internal/hook`)
User-configured shell hooks at agent loop events: PreToolUse, PostToolUse, PermissionRequest, UserPromptSubmit, Stop, SessionStart/End, SubagentStop, Notification, PreCompact, PostLLMCall. Loaded from project `.reasonix/settings.json` and global settings. Only PreToolUse/UserPromptSubmit are blocking. Exit 0 = pass, exit 2 = block, other = warn. Claude-imported hooks get payload format translation. Plugin hooks get exec/shell execution modes.

### 7. Recovery / Auto Guard (`internal/recovery`)
The most sophisticated mechanism. Tracks per-operation failure counts, per-task failure evidence, and shared Episode budgets. Pure routing via `Decide()`: bypass, allow, review, stop. A sub-agent Reviewer (LLM) evaluates ambiguous proposals (plan transitions, strategy changes, scope expansion). When reviewer confirms, the user gets an approval card. Budgets: max 3 operation failures, max 10 episode failures, max 3 reviewer rejects, max 3 stopped-op retries. Verification commands (test/lint/build) get a safe retry budget. Persistence is async, projection-only (never re-arms locks on restart).

### 8. Worktree (`internal/worktree`)
Git worktree-based workspace isolation for parallel delivery sessions. Creates branches like `reasonix/delivery-YYYYMMDD-HHMMSS-<random>`. Managed under Reasonix state, never inside source repo. Subdirectory resolution supported.

### 9. Subagent Guard (`internal/tool/subagentguard.go`)
Appends a boundary notice to sub-agent results that mention host approval or user decisions, so parent agents never treat a child's wording as real host state. Detects Chinese and English phrases like "user approved", "waiting for approval".

## Ideas Applicable to Jensen

### High-value
1. **Permission policy as a pure function**: Jensen's permission system (`packages/coding-agent/src/core/`) could adopt Reasonix's rule DSL (`Bash(git push:*)`, `Edit`, deny/ask/allow with glob + literal matching). Bash command decomposition for compound commands is particularly practical for npm.

2. **Checkpoint/Rewind (git-free)**: Jensen already has diff-based previews. Adding a checkpoint store that snapshots pre-edit content per turn, persisted beside the session, would enable rewind without touching the user's git. TypeScript-friendly with fs read/write + JSONL.

3. **Recovery / Auto Guard bounded retry**: Reasonix's episode budgets + operation stop thresholds + reviewer escalation path is the most directly applicable idea. Jensen could implement a simpler variant: per-operation failure counts (max 3), per-turn total failure budget, with a lightweight "stop and explain" message rather than a full LLM reviewer.

4. **Subagent boundary notices**: Simple string-based detection of "user approved" / "awaiting approval" in subagent results, appending a boundary warning. Trivial to implement, high safety value.

### Medium-value
5. **Workspace lease**: For Jensen's multi-session scenarios (rare today), a file-lock based write lease is easy in Node.js with `proper-lockfile` or flock.

6. **Hook events**: Jensen already has skill-based pre/post hooks. Reasonix's granular events (PreToolUse, PostToolUseFailure, PostLLMCall, PreCompact) could inform additional hook points.

7. **Verification command detection**: Classifying known test/lint/build commands for safe retry budgets. Simple regex + token matching.

### Low-value / Platform-gated
8. **OS sandbox**: Requires platform-specific backends (bubblewrap, Seatbelt) — valuable but complex. Jensen on Linux could wrap bash in `bwrap` as an optional enforcement layer.

## Ideas Deliberately Rejected

1. **LLM-based Guardian reviewer**: Adds latency, cost, and complexity for every tool call. Jensen's permission model (rule-based + user approval) is sufficient. The Guardian's circuit-breaker pattern is useful without the LLM component.

2. **Git worktree isolation**: Jensen doesn't have a "delivery" parallel-session model that would benefit from this. Over-engineering for current scope.

3. **Full Auto Guard reviewer**: Running a sub-agent to review every ambiguous proposal is heavy. Jensen should use deterministic rules + human prompts for plan transitions.

## Jensen-Native Design Recommendations

Given Jensen's TypeScript/npm architecture, these are the recommended implementation priorities:

### Priority 1: Recovery Budgets (Auto Guard Lite)
- Per-operation failure count (fingerprinted by tool + args summary), max 3
- Per-turn total failure budget, max 10
- Stopped-operation retry budget, max 3
- "Stop and explain" message injected into model context when budget exhausted
- Persisted as session-adjacent JSON sidecar per session (async writes, projection-only)
- Episodes cleared on real user message or explicit mode switch
- No LLM reviewer — deterministic escalation to user prompt only

### Priority 2: Checkpoint/Rewind
- Pre-edit snapshots in `~/.jensen/sessions/<id>/checkpoints/` as JSONL
- Keyed to user turn + message index
- Restore writes files back; delete files that didn't exist pre-turn
- Path escape guard via `path.resolve(root, p)` + prefix check
- Only edit-tool changes tracked (same limitation as Reasonix)

### Priority 3: Permission Rule DSL Enhancement
- Adopt `ToolName(subject_glob)` syntax
- Bash command decomposition into simple-command segments
- `Edit` virtual tool for all file mutation tools
- Compound command per-segment matching

### Priority 4: Subagent Boundary Notices
- Regex-based detection of host-decision language in subagent output
- Append a fixed boundary warning when detected
- Already partially present in Jensen's agent routing

## License/Provenance Outcome

We implement all ideas independently in TypeScript. No Reasonix Go code is copied. The mechanisms described above are architectural patterns, not copyrightable expressions. The MIT license permits studying the source, and our implementation will be original TypeScript code within Jensen's existing architecture. No non-trivial code will be ported or translated from the reference repository.
