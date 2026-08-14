---
"@apholdings/jensen-agent-core": patch
"@apholdings/jensen-code": patch
---

Reliability Kernel activation in normal interactive sessions.

The Reliability Kernel is now authoritative in the real interactive agent path:
real tool calls flow through `beforeToolCall`/`afterToolCall` reliability hooks,
real tool outcomes become authoritative evidence, the Completion Gate controls
live completion (a model "done" is rejected until all acceptance criteria are
verified), and mission state persists with the session and restores on
`jensen resume <SESSION_ID>`. Adds an `onTurnEnd` agent-loop lifecycle hook.
