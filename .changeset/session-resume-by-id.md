---
"@apholdings/jensen-ai": patch
"@apholdings/jensen-agent-core": patch
"@apholdings/jensen-code": patch
"@apholdings/jensen-mom": patch
"@apholdings/jensen-pods": patch
"@apholdings/jensen-tui": patch
"@apholdings/jensen-web-ui": patch
---

Add explicit session resume by ID.

`jensen resume <SESSION_ID>` resolves a persisted session by exact ID, restores
its conversation history, model/thinking configuration, memory/todos/tasks, and
working directory, and continues writing under the same session ID rather than
creating a new one.

- Exact session resolution (never prefix matching, never fall back to the
  latest session).
- Same-session continuation across repeated resume cycles.
- Safe failure for unknown IDs (`Session not found: <id>`), corrupted session
  files (persisted bytes are never overwritten), and path-like input (never
  treated as a filesystem path).
- Backward compatible with sessions persisted by 2.0.1 and earlier versions.
- New regression coverage for ID lookup, file validation, continuation,
  compaction continuity, and end-to-end hydration through `createAgentSession`.
