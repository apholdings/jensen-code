---
"@apholdings/jensen-code": minor
"@apholdings/jensen-agent-core": minor
---

Code intelligence & tool reliability (1.4.0):

- Add native Language Server Protocol (LSP) subsystem with nine read-only,
  parallel-safe tools (`lsp_definition`, `lsp_references`, `lsp_implementations`,
  `lsp_hover`, `lsp_diagnostics`, `lsp_document_symbols`, `lsp_workspace_symbols`,
  `lsp_rename_preview`, `lsp_status`), zero-mutation rename preview, and
  transactional rename apply through the existing checkpoint/transaction manager
  with `failOnNewLspErrors` validation gates.
- Add provider-independent tool-call normalization pipeline (schema flattening,
  conservative argument repair that never invents semantic values, truncated-JSON
  recovery, tightly-bounded tool-call scavenging).
- Add Tool Storm Breaker with call fingerprints, staged duplicate/no-progress
  thresholds, typed errors, and bounded read-only cache reuse.
- Add parallel-safe deterministic scheduler: only explicitly `parallelSafe`
  read-only tools run concurrently, mutations are serial barriers, with
  dependency analysis, bounded concurrency, deterministic result ordering and
  cancellation propagation.
- Add durable background-job registry (`job_start|status|list|logs|stop|restart|adopt`)
  with authoritative process-tree ownership, PID-reuse protection, bounded
  sanitized logs, and long-horizon completion gates.
- Add `collectExecutionDiagnostics` for `jensen doctor lsp|tools|scheduler|jobs`.
