# Safe Autonomous Execution

Jensen can already run long-running implementation and release workflows. This
feature makes workspace mutation safer, reversible and auditable by wrapping
every deterministic mutation in a deterministic safety lifecycle:

```
tool request
→ classify effects
→ evaluate deterministic policy
→ validate workspace scope
→ acquire mutation lease
→ create pre-mutation checkpoint
→ apply transactional mutation
→ validate resulting state
→ commit transaction or roll back
→ record durable evidence
→ release mutation lease
```

The lifecycle lives in `packages/coding-agent/src/core/safety/` and is surfaced
to the agent, the CLI and the public package API.

## Tool effects

Every production tool declares a canonical `effects` descriptor (see
`ToolEffects` in `@apholdings/jensen-agent-core` and
`PRODUCTION_TOOL_EFFECTS` in the coding-agent). Effect metadata is a declared
fact about the tool; it is never derived from model output, tool results or web
content. Diagnostic tooling can show effects without exposing secrets. A test
fails when a new production tool is added without effect metadata.

## Policy engine

The policy engine is deterministic and provider-independent. Precedence is:

```text
deny > require_approval > allow > default
```

A `deny` rule can never be overridden by a lower-priority rule, model output,
web content, tool results, workspace instructions or a provider hint. The
engine reads only structured inputs, never model prose.

Baseline rules deny destructive shell patterns (`git reset --hard`,
force-push to a protected branch, policy-bypass markers), paths escaping the
workspace, and secret material. Publication is allowed only under explicit
release authorization.

### Execution modes

- `observe` — read-only tools only; any mutation is denied.
- `plan` — reads, analysis and previews; no physical mutation.
- `execute` — mutations allowed only per policy and authorization.

Mode is durable state provided by the caller; the model cannot promote itself
from `plan` to `execute` through text.

## Workspace boundary

Path-bearing mutations resolve against a canonical workspace root before
execution. Symlinks (and Windows junctions/reparse points) are resolved, `.`/
`..` are normalized, and escapes are rejected. The resolved parent is
revalidated immediately before each physical write to narrow the
time-of-check/time-of-use window. Rollback targets are also boundary-checked.

## Mutation lease

An exclusive workspace lease (atomic exclusive-create lockfile with heartbeat
and process liveness) ensures only one authoritative mutating transaction
holds the workspace. Read-only work stays concurrent. Stale leases are
recovered only after a positive liveness check; a crashed process never
permanently locks the workspace, and a live lease is never stolen. Unrelated
workspaces remain independent.

## Checkpoints

Before the first physical mutation, a content-addressed checkpoint captures
the files a transaction may change. The manifest is integrity-protected by a
SHA-256 over its own entries, and every blob is hash-verified. Checkpoints are
recovery artifacts, never execution authority, and never substitute for Git.
Rollback-required and recovery-required checkpoints are preserved; only
confirmed, expired checkpoints are garbage-collected.

## Transactions

Edit batches are represented structurally and applied in a deterministic
order with preconditions (expected content hashes). Partial application, drift
or failed validation triggers rollback. Confirmation is durable; a transaction
cannot be confirmed when validation was skipped, timed out or aborted. Rollback
is idempotent and never silently overwrites unrelated post-transaction user
changes — drift is reported as a structured `ROLLBACK_CONFLICT`.

## Crash recovery

At startup or resume, incomplete transactions are classified
(`safe_to_resume_apply`, `validation_required`, `rollback_required`,
`manual_conflict`, `already_confirmed`, `already_rolled_back`) from durable
transaction and checkpoint records plus hash verification, never from file
presence alone.

## CLI

```text
jensen workspace status
jensen workspace policy
jensen workspace lease
jensen workspace transactions
jensen workspace transaction inspect <id>
jensen workspace checkpoint inspect <id>
jensen workspace rollback <transaction-id>
jensen workspace recovery status
jensen workspace recovery inspect <transaction-id>
jensen workspace recovery resume <transaction-id>
jensen workspace recovery rollback <transaction-id>
```

Diagnostics never print checkpoint contents, secrets, hidden reasoning or
unredacted sensitive command lines.

## Limitations

- Checkpoints do not replace Git and do not authorize execution.
- Rollback may conflict with later user changes (reported, not overwritten).
- Unknown shell effects are not guaranteed fully reversible; rollback
  capability is reported as `full | partial | none | unknown` and high-risk
  autonomous execution is blocked when rollback capability is insufficient.
- `deny` cannot be overridden by lower-priority rules.
- Long-horizon execution state remains authoritative; a checkpoint alone
  cannot move execution state backward.
