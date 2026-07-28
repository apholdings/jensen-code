---
"@apholdings/jensen-code": patch
---

Add deterministic Mission Contract and Requirement Ledger foundation (LH-1)

- Mission Contract v1 schema with explicit/inferred requirement provenance, hierarchical workstreams, constraints, forbidden actions, and evidence policy
- Requirement Ledger v1 with append-only transitions and evidence records, cryptographically bound to contract via SHA-256 digest
- Optimistic concurrency with stale revision rejection and atomic output
- Authoritative evidence enforcement: agent claims are never authoritative; SATISFIED requires trusted evidence
- Dependency DAG validation (Kahn's algorithm) and cycle detection for both requirements and workstream hierarchies
- Provider-isolated CLI: mission validate/digest, ledger init/validate/add-evidence/transition/inspect
- Deterministic canonical JSON serialization for stable contract digests
- Golden fixtures (M01-M20) and comprehensive unit + CLI child-process tests
- No agent-loop integration, prompt-to-contract generation, or automatic continuation (LH-2+)