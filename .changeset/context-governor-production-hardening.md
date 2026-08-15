---
"@apholdings/jensen-code": patch
---

Context Governor production hardening.

Makes the Context Governor safe against the failure modes that a purely
`chars / 4` budget exposed on real long-horizon runs:

- Tiered, content-class-aware token accounting (CJK/emoji/dense-punctuation/
  code are never under-counted), with a bounded conservative uplift calibrated
  from authoritative provider usage that only ever raises estimates.
- Durable tool-result virtualization ledger: already-archived results are
  restored to their virtualized representation across requests, session resume,
  and process restart instead of reappearing full-sized.
- Content-addressed evidence identity reuse: retrieve -> cool -> retrieve
  cycles collapse back to the original evidence id and never duplicate archive
  records.
- Tool schemas are included in the input estimate; fixed-prefix overflow now
  fails diagnostically with per-region costs.
- `recordOverflow()` is wired into the real provider-boundary recovery path:
  a provider context overflow tightens an adaptive safety reserve and forces a
  genuinely smaller, bounded retry.
- Reasoning/thinking content is reserved out of the output budget.
- Aggressive reduction preserves pinned mission-constraint/checkpoint state.
- Opt-in telemetry (`JENSEN_CONTEXT_TELEMETRY`) exposes governor diagnostics,
  accounting mode, calibration, and overflow/recovery counters.
