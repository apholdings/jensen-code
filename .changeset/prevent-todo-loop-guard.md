---
"@apholdings/jensen-code": patch
---

Prevent planning loops with a Todo-family loop guard. Separate todo state into read (todo_read), write (todo_write), and partial progress update (todo_update) operations with stable IDs and revision tracking. Make compacted todo_write snapshots non-replayable as tool calls. Report failed Todo operations truthfully.
