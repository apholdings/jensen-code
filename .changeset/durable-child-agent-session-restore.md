---
"@apholdings/jensen-code": patch
---

Durable Child AgentSession Restore.

Closes the boundary between a durable delegated child mission and a durable
child AgentSession. A delegated child no longer executes through the ephemeral
`--no-session` path: it acquires a stable `childSessionId` (stored on the
immutable MissionRequest) BEFORE external execution, persists its
conversation/todo/memory/evidence state through the standard SessionManager,
and binds that session to exactly one mission (validated on load, fail-closed).

An interrupted child remains INTERRUPTED rather than auto-rerunning, and a new
`resume-child <MISSION_ID>` command restores the SAME mission + SAME session
with a NEW attempt/execution, then continues remaining work from a bounded
operational checkpoint (objective, constraints, decisions, completed/pending
steps, active files, persisted evidence references) instead of replaying it.
Evidence references archived by the Context Governor are now persisted to the
session so a resumed child can `retrieve_evidence` for artifacts created before
interruption. The DurableMissionStore / Completion Gate remain the sole
authority for terminal results; a restored session/checkpoint can never
fabricate success.
