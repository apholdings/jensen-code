---
"@apholdings/jensen-agent-core": minor
"@apholdings/jensen-ai": minor
"@apholdings/jensen-code": minor
"@apholdings/jensen-mom": minor
"@apholdings/jensen-pods": minor
"@apholdings/jensen-tui": minor
"@apholdings/jensen-web-ui": minor
---

Jensen 2.1.0 — Reliable Agent Runtime.

Introduces the Reliability Kernel, which moves execution authority from the model
into Jensen. The model proposes actions and completion; Jensen owns state,
execution, evidence, validation, and completion.

- Mission Ledger: durable, machine-readable, session-associated mission state
  (goal, constraints, acceptance criteria, evidence, blockers) that survives
  process exit, `jensen resume <SESSION_ID>`, and context compaction.
- Structured agent actions: model output is normalized into a finite, Jensen-owned
  action union (`tool_call`, `request_context`, `mission_update`,
  `final_candidate`, `blocked`, `no_op`).
- Action validation: every executable action is validated before execution
  (tool exists, schema, required arguments, boundary, permission, forbidden
  actions); invalid actions are rejected with structured failures and never run.
- Evidence Store: records what Jensen actually observed, never model claims;
  deterministic verification evidence is authoritative.
- Verification Engine: deterministic build/test/file/search/git-diff verifiers.
- Acceptance criteria: user-required and system-derived criteria with
  evidence-gated status; a model assertion can never mark a criterion passed.
- Completion Gate: `FINAL_CANDIDATE` is a proposal, not completion; Jensen rejects
  premature completion with `FINALIZATION_REJECTED`.
- Reliability Suite: deterministic adversarial scenarios (R01–R15) prove the
  trusted runtime stays safe when the model misbehaves.

2.1.0 introduces the Reliability Kernel; advanced autonomous retry/recovery
policy remains future work (2.1.1).
