# Jensen operability architecture

Jensen 1.6 adds read-only operability over the existing session JSONL authority.

```text
session JSONL
  -> bounded validated reader
  -> canonical observability envelopes
  -> pure projections (timeline, replay state, evidence, diagnostics, diff)
  -> CLI / RPC / TUI / web consumers
```

The session file remains authoritative. Indexes, snapshots, diagnostics and UI state are derived and rebuildable. A malformed canonical record is surfaced with its line number and is never silently treated as a complete replay.

## Replay boundaries

- **Render replay** reconstructs recorded user-visible transcript activity only. It never calls a model, executes a tool, accesses the network, starts a process, or mutates a workspace.
- **Projection replay** rebuilds a deterministic state projection and reports corruption, unknown entries and divergence.
- **Simulation replay** is a test/developer boundary that uses recorded tool results and labels them as simulated; it does not assert current external state.
- **Re-execution**, if added by a caller, is a new run requiring current policy, budget, workspace and approval evaluation. Historical approvals and mutations are evidence, not commands.

## Canonical envelope

`JensenEventEnvelope` carries stable event identity, run/session identity, ordering, schema version, causation/correlation, source, payload and a SHA-256 payload digest. Persisted envelopes verify that digest on read; legacy session entries are wrapped with a deterministic digest for projection compatibility and are structurally validated. Unknown event types are preserved as diagnostics. The envelope is an observability representation and does not serialize hidden reasoning or secrets.

## Diagnostics and support

Doctor collectors are bounded and read-only by default. Each result has a stable check ID, component, status, reason code and optional remediation. Support bundles are explicit local writes with a manifest, hashes, size limit and redaction report; there is no automatic upload.

## MCP boundary

MCP servers are external capabilities. Configuration is validated without resolving secrets into durable state. Supported transport identifiers are `stdio`, `sse`, and `streamable_http`. Capability snapshots are evidence, not permanent authority. Tool schemas are bounded and canonicalized before registration. Unknown effect metadata is high-risk, serial and approval-required. MCP output remains untrusted data and cannot change Jensen policy or tool-effect metadata.
