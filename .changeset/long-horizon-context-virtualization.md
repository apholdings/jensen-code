---
"@apholdings/jensen-code": patch
---

Long-Horizon Context Virtualization.

Decouples mission horizon from the physical model context window: a
provider-independent context capability model (physical/configured window,
reserved output, safety reserve, safe input budget), a preflight Context
Governor that enforces the hard input budget before every inference, verified
iterative compaction that recounts until the request actually fits, and a
three-tier memory model (hot working set, warm mission checkpoint, cold
evidence archive) with tool-result virtualization and deterministic
checkpoint rollover/rehydration. Provider overflow recovery is now bounded and
forces progressively stronger reduction instead of a single compact-and-retry.
MissionRuntime / Completion Gate remain the sole completion authority; a
checkpoint can never fabricate success.
