---
"@apholdings/jensen-code": patch
---

Prevent planning loops with a Todo-family loop guard. Separate todo state into read (todo_read), write (todo_write), and partial progress update (todo_update) operations with stable IDs and revision tracking. Make compacted todo_write snapshots non-replayable as tool calls. Report failed Todo operations truthfully. Migrate legacy persisted tool allowlists to expose todo_read and todo_update in actual runtime. Preserve Todo tool identities through provider, dispatcher, events, and TUI.
