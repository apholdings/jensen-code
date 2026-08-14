---
"@apholdings/jensen-code": patch
---

First-Class Mission domain primitives for delegated work.

Introduces canonical, executor-independent mission primitives
(`MissionRequest`, `MissionHandle`, `MissionResult`, and a `MissionState`
lifecycle machine) plus a `MissionExecutor` seam with a transitional
`ProcessMissionExecutor` adapter. The subagent execution path now derives child
mission identity structurally (explicit `parentMissionId` + depth) instead of
from PID, classifies outcomes into a structured `MissionResult` (a raw process
exit of 0 is never mission `SUCCEEDED`), and reports parallel/chain child
outcomes structurally. Reliability `MissionRuntime` / Completion Gate remain the
single source of verified success; a `MissionRequest` with deterministic
acceptance criteria maps 1:1 into a real `MissionRuntime` contract.
