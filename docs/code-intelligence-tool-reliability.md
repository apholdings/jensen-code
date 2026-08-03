# Code Intelligence & Tool Reliability (Jensen 1.4.0)

Jensen 1.4.0 adds four capabilities that make autonomous execution safer and
more reliable: a native Language Server Protocol (LSP) subsystem, a
provider-independent tool-call normalization pipeline, a parallel-safe
deterministic scheduler, and a durable background-job registry. Each integrates
with the Jensen 1.3.0 safety model (effects, workspace boundary, leases,
checkpoints, transactions).

## 1. Native LSP subsystem

Location: `packages/coding-agent/src/core/lsp/`

A self-contained LSP client (no external `vscode-languageserver*` dependency -
the client speaks the JSON-RPC/Content-Length framing directly).

| Module | Responsibility |
| --- | --- |
| `jsonrpc.ts` | `JsonRpcClient`: Content-Length framing, request/response correlation, cancellation, bounded buffers, notification handler. |
| `position.ts` | UTF-16 offset <-> LSP position conversion (JS string offsets are UTF-16 units). |
| `discovery.ts` | Language detection + deterministic ordered server candidates for TS/JS, Python, C#, Java, Go, Rust. |
| `client.ts` | `LspClient`: initialize, full-document sync, semantic requests, rename. |
| `manager.ts` | `LspServerManager`: per `(workspace, language, executable)` reuse, timeouts, crash detection + bounded restart, graceful shutdown. |
| `diagnostics.ts` | Summaries + `failOnNewLspErrors` gate. |
| `rename.ts` | Zero-mutation rename preview + apply edits later-to-earlier with BOM/CRLF preservation; transactional `WorkspaceEdit`. |
| `runtime.ts` | `LspRuntime`: boundary enforcement + effect gating. |
| `tools.ts` | Nine tools: `lsp_definition`, `lsp_references`, `lsp_implementations`, `lsp_hover`, `lsp_diagnostics`, `lsp_document_symbols`, `lsp_workspace_symbols`, `lsp_rename_preview`, `lsp_status`. |

All LSP tools are read-only and `parallelSafe`; rename preview performs zero
mutation. Applying a rename goes through the 1.3.0 checkpoint/transaction
manager so conflicting edits roll back atomically.

Server candidates (must be installed - discovery reports `unavailable` if
missing, it never errors):

- TypeScript / JavaScript: `typescript-language-server` (`tsserver`)
- Python: `basedpyright-langserver`, `pyright-langserver`
- C#: `OmniSharp`, `csharp-ls`
- Java: `jdtls`
- Go: `gopls`
- Rust: `rust-analyzer`

## 2. Tool-call normalization pipeline

Location: `packages/coding-agent/src/core/tool-call/`

Provider-independent normalization of raw model tool calls before dispatch:

- `schema-flatten.ts` - flatten provider schema variants (object/array/primitive
  wrappers) into a canonical `JSON Schema`.
- `repair.ts` - conservative argument repair that **never invents semantic
  values**; it only coerces transparent types (string `"true"` -> boolean),
  drops unknown keys, and annotates what it changed.
- `truncated-json.ts` - deterministic truncated-JSON recovery that closes
  unfinished literals without guessing content (`TOOL_CALL_TRUNCATED_UNRECOVERABLE`
  when it cannot be closed safely).
- `scavenge.ts` - tightly-bounded tool-call scavenging from malformed output.
- `canonicalize.ts` - stable stringify + sha256 + schema validation.
- `pipeline.ts` - `runToolCallPipeline` orchestrates flatten -> validate ->
  repair -> recover -> reject.

## 3. Tool storm breaker

Location: `packages/coding-agent/src/core/storm/`

Call fingerprints + staged thresholds to stop a model from flailing:

- `fresh` -> `duplicate_annotate` -> `no_progress_reflect` ->
  `storm_blocked` -> `strategy_pivot_required`.
- Typed errors: `TOOL_CALL_STORM_BLOCKED`, `TOOL_STRATEGY_PIVOT_REQUIRED`,
  `TOOL_CALL_DUPLICATE_NO_PROGRESS`.
- State-change progress resets the counters; read-only results are reused from
  a bounded cache instead of re-executed.

## 4. Parallel-safe deterministic scheduler

Location: `packages/agent/src/scheduler.ts`

`DeterministicParallelScheduler`:

- Wave partitioning: only explicitly `parallelSafe` read-only tools run
  concurrently; every mutation is a serial barrier.
- Dependency edges via `ToolEffects.consumes`.
- Resource/server conflicts (host, server) handled.
- Bounded concurrency: global/per-tool/per-host/per-server limits.
- Deterministic presentation order + cancellation propagation.

It preserves the existing `isConcurrencySafe` tool contract while replacing the
old partitioning in `agent-loop.ts`.

## 5. Durable background-job registry

Location: `packages/coding-agent/src/core/jobs/`

`BackgroundJobRegistry`:

- Durable JSON storage; jobs start/status/list/logs/stop/restart/adopt.
- Authoritative process-tree ownership: `process-identity.ts` captures
  pid + start-time + command line.
- PID-reuse protection (identity is more than a pid).
- Bounded sanitized logs (untreated as untrusted content).
- Long-horizon completion gates via `gateStepCompletion`.
- Idempotent stop, restart lineage, conservative adopt/refuse.

`createJobTools(registry)` exposes the seven job tools (`job_start`,
`job_status`, `job_list`, `job_logs`, `job_stop`, `job_restart`, `job_adopt`).

## Diagnostics

`collectExecutionDiagnostics` aggregates LSP server discovery/active state,
storm counts, scheduler limits, and job/orphan state for `jensen doctor
lsp|tools|scheduler|jobs`. It never exposes secrets, tokens, full files, or raw
sensitive arguments.
