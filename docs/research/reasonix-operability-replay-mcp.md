# Reasonix operability, replay, and MCP research

Date inspected: 2026-08-03

## Provenance

Reference repository: `https://github.com/esengine/DeepSeek-Reasonix.git`

- Stable tag inspected: `v1.19.4`, commit `b36a7e3d54a6cb88bbef8467fb5ba937f1337f34`.
- Default-branch checkout inspected: `main-v2`, commit `c46e3af1c2732fe2b3dedb0bd47eb39a629357d2d` at the start of inspection; refreshed remote `origin/main-v2` was `778a443e19e85430c3c99d76ed218e3ce9a83c2b`.
- License: repository license files were inspected; the reference is an independently licensed public project. Jensen does not copy implementation code from it. This note records concepts and paths only.

## Mechanisms studied

### Events, sessions, and replay

- `internal/store/session.go`: authoritative JSONL session/transcript paths, separate damaged-tail naming, and derived event-index sidecars.
- `internal/event/event.go`: typed wire-stable event kinds, sinks, and stable diagnostic codes.
- `internal/agent/session_events.go` and `internal/eventwire/wire.go`: session event serialization and wire handling.
- `internal/cli/branch.go` and `internal/cli/resume.go`: branch-aware transcript replay and resume projections.
- `internal/cli/rewind.go` and checkpoint metadata: explicit rewind/fork boundaries instead of silently re-running effects.

The useful design lesson is that the body of the durable transcript remains authoritative while indexes and summaries are derived and rebuildable. Tail salvage is explicit rather than silently treating a damaged file as complete.

### Doctor and diagnostic surfaces

- `internal/doctor/report.go`: structured, redacted report collection and text rendering.
- `internal/cli/doctor.go`: command routing, repair separation, and stable exit behavior.
- `internal/cli/doctor_capabilities.go` and `internal/capdiag/*`: bounded static diagnostics by default, with an explicit opt-in for live MCP probes.
- `internal/doctor/session_bundle.go`, `session_redact.go`: manifest-based bundles and sanitization before writing.

The useful lesson is to keep default diagnostics read-only and offline, distinguish static from live checks, and make support artifacts self-describing with a manifest.

### MCP

- `internal/config/mcpjson.go`, `mcp_activation.go`, and `mcp_command.go`: configuration normalization and explicit activation.
- `internal/mcpdiag/auth.go`: typed authentication diagnosis and bounded remote transport handling.
- `internal/mcplaunch/*`: process launch and platform-specific ownership/cleanup.
- `internal/plugin/*`, `internal/control/mcp.go`, and `internal/cli/mcp*.go`: MCP registration, manager/status surfaces, and lifecycle behavior.
- `internal/mcpregistry/registry.go`: explicit registry boundaries rather than implicit startup installation.

The useful lesson is that configured external capabilities need explicit lifecycle states, bounded startup/live probes, redacted diagnostics, and a clear distinction between static capability descriptions and live external effects.

## Jensen-native decisions

1. Jensen's existing session JSONL tree remains the sole durable authority. We do not introduce a second event store or destructively rewrite historical files.
2. A versioned observability envelope is derived from or attached to existing session entries, with integrity hashes and explicit corruption classifications. Projection and index data are rebuildable.
3. Render replay is a pure reader over recorded entries. It never calls models, tools, networks, or mutation APIs. Simulation and re-execution are separate, explicit modes.
4. Doctor collectors return structured status/reason/remediation data and default to read-only, bounded checks. Live MCP checks are opt-in.
5. MCP is treated as an untrusted capability boundary. Configuration, transport, handshake, capability and tool-schema validation happen before registration; unknown effects fail conservatively and every invocation still passes Jensen policy.
6. Support bundles are local-only, manifest-based, size-bounded and sanitized by construction. They are never uploaded automatically.
7. CLI, RPC, TUI, and web views consume pure projections; UI state is not authoritative.

## Deliberately rejected mechanisms

- No copied Reasonix source or non-trivial implementation.
- No broad MCP marketplace or automatic arbitrary-server installation.
- No cloud telemetry, session synchronization, distributed orchestration, or remote control plane.
- No semantic vector index.
- No implicit live MCP startup from ordinary diagnostics.
- No interpretation of replay as external re-execution and no reuse of historical approvals.

## Jensen architecture map before implementation

The canonical persisted session surface is `packages/coding-agent/src/core/session-manager.ts`: versioned JSONL headers and tree entries, append-only persistence, migrations, branch projections, and tool-span integrity checks. `packages/coding-agent/src/core/messages.ts` converts persisted agent messages to model-facing messages. Shared transcript validation lives in `packages/ai/src/utils/transcript-validation.ts`.

Existing diagnostics are split between `core/doctor.ts`, `core/execution-diagnostics.ts`, and `core/diagnostics.ts`; they are exported but the built-in doctor command currently has no complete production dispatch path. `core/event-bus.ts` is an in-process notification bus and is not durable authority. Existing LSP, jobs, storm-breaker, safety, budget, web-research, and adaptive-runtime records remain their own domain data and should be represented in projections rather than replaced.

MCP is not currently implemented in Jensen's TypeScript packages. Therefore the release implementation must add an intentionally bounded MCP boundary (configuration/capability/schema/effect/lifecycle abstractions and local fixtures) without claiming unsupported live transports where no production transport exists. The security contract is implemented before exposing a tool to the agent.
