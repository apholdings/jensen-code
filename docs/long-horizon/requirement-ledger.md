# Requirement Ledger v1

The Requirement Ledger is a versioned, auditable, append-only record of requirement state transitions and evidence records, cryptographically bound to a specific Mission Contract revision.

## Schema

```typescript
interface RequirementLedgerV1 {
  ledgerVersion: 1;
  missionId: string;
  contractVersion: 1;
  contractRevision: number;
  contractDigest: string;      // SHA-256 of the bound contract

  revision: number;            // Monotonic, incremented on every mutation
  requirements: RequirementLedgerEntry[];
  evidence: LedgerEvidenceRecord[];
  transitions: RequirementTransition[];
}
```

## Ledger Entries

One entry per contract requirement:

```typescript
interface RequirementLedgerEntry {
  requirementId: string;
  status: RequirementEvaluationStatus;  // From LH-0 canonical states
  workstreamId: string;
  initialNotApplicable: boolean;
  notApplicableRationale?: string;
}
```

## Initialization

Initializing a ledger from a valid contract produces:
- Ledger revision 0
- Applicable requirements set to UNASSESSED
- Contract-declared not-applicable requirements set to NOT_APPLICABLE

No completion is inferred during initialization.

## Contract Binding

Every ledger stores the SHA-256 digest of its bound contract. A ledger whose digest does not match the supplied contract is rejected.

## Evidence Records

Evidence is append-only:

```typescript
interface LedgerEvidenceRecord {
  id: string;
  type: string;
  requirementIds: string[];
  criterionIds: string[];
  collectorType: EvidenceCollectorType;
  reportedAuthority: boolean;
  effectiveAuthority: EvidenceAuthorityClassification;
  status: "pass" | "fail" | "unknown";
  source: string;
  summary: string;
  digest?: string;
  claimText?: string;
  metadata?: Record<string, unknown>;
}
```

### Authority Computation

`reportedAuthority` is the caller-supplied boolean (advisory). `effectiveAuthority` is computed as follows:

- Evidence of type `claim` → always `agent-claim` (non-authoritative)
- Evidence from `trusted-collector` → `trusted-collector`
- Evidence from `operator` → `operator-confirmation`
- Evidence from `test-runner` → `test-result`
- All other cases → `agent-claim` (unless from a known authoritative type)

A caller-provided `reportedAuthority: true` cannot override this classification.

## Transitions

Transitions are append-only and never deleted:

```typescript
interface RequirementTransition {
  id: string;
  ledgerRevisionBefore: number;
  ledgerRevisionAfter: number;
  requirementId: string;
  fromStatus: RequirementEvaluationStatus;
  toStatus: RequirementEvaluationStatus;
  actorType: ActorType;
  actorId?: string;
  reason: string;
  evidenceIds: string[];
  blockerReference?: string;
  metadata?: Record<string, unknown>;
}
```

## Transition Matrix

| From | Allowed To |
|------|-----------|
| UNASSESSED | PENDING, IN_PROGRESS, IMPLEMENTED_UNVERIFIED, NOT_APPLICABLE |
| PENDING | IN_PROGRESS, IMPLEMENTED_UNVERIFIED, BLOCKED, NOT_APPLICABLE |
| IN_PROGRESS | IMPLEMENTED_UNVERIFIED, BLOCKED, FAILED |
| IMPLEMENTED_UNVERIFIED | SATISFIED, IN_PROGRESS, FAILED, BLOCKED |
| SATISFIED | IMPLEMENTED_UNVERIFIED, IN_PROGRESS, FAILED |
| BLOCKED | IN_PROGRESS, PENDING, FAILED, NOT_APPLICABLE |
| NOT_APPLICABLE | PENDING, UNASSESSED |
| FAILED | IN_PROGRESS, PENDING, BLOCKED |

### Completion Boundary

The only normal entry into SATISFIED is from IMPLEMENTED_UNVERIFIED. These paths are forbidden:
- UNASSESSED → SATISFIED
- PENDING → SATISFIED
- IN_PROGRESS → SATISFIED
- BLOCKED → SATISFIED
- FAILED → SATISFIED

### Authority Boundary

SATISFIED requires:
- All acceptance criteria satisfied
- Authoritative evidence for every required criterion
- No evidence-trust violation
- Actor authorized to confirm satisfaction (cannot be agent)

### Regression and Reopening

A satisfied requirement may regress via:
- SATISFIED → IMPLEMENTED_UNVERIFIED
- SATISFIED → IN_PROGRESS
- SATISFIED → FAILED

Each regression requires a structured reason and a new transition record. Prior satisfaction history is never deleted.

### Blocked

BLOCKED requires a structured blocker reason. A blocker does not erase executable work elsewhere.

### Failed

FAILED is distinguishable from BLOCKED, PENDING, and IMPLEMENTED_UNVERIFIED. Requires a structured failure reason.

## Optimistic Concurrency

Every mutation requires `expectedRevision`. When `expectedRevision != current ledger revision`, the operation is rejected with a typed stale-revision error. A rejected mutation:
- Does not increment revision
- Does not append a transition
- Does not append evidence
- Does not partially update any requirement

## Revision Model

Ledger revision is the canonical sequence identifier. Each accepted mutation increments revision by exactly 1. Transitions record `ledgerRevisionBefore` and `ledgerRevisionAfter`. Wall-clock time is not used for ordering.

## Ledger Summary

```typescript
interface LedgerSummary {
  missionId: string;
  contractRevision: number;
  contractDigest: string;
  ledgerRevision: number;
  totalRequirements: number;
  applicableRequirements: number;
  stateCounts: Partial<Record<RequirementEvaluationStatus, number>>;
  explicitCount: number;
  inferredCount: number;
  workstreamSummaries: WorkstreamSummary[];
  blockedRequirements: string[];
  failedRequirements: string[];
  requirementsLackingAuthoritativeEvidence: string[];
  completionCandidate: boolean;
}
```

### completionCandidate

`completionCandidate` is true only when:
- Every applicable requirement is SATISFIED
- No requirement is blocked, failed, pending, unassessed, in-progress, or implemented-unverified
- Contract and ledger validation pass

This is NOT the final LH-5 Completion Gate — it is a candidate for review, not a verdict of mission completion.