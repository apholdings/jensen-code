# Mission Contract Schema v1

The Mission Contract is a versioned JSON document that defines what a mission requires, which requirements were explicit, which were inferred, what constraints apply, what actions are forbidden, and what evidence each requirement needs.

## Schema

```typescript
interface MissionContractV1 {
  contractVersion: 1;
  missionId: string;
  revision: number;
  title: string;
  objective: string;

  workstreams: MissionWorkstream[];
  requirements: MissionRequirement[];
  constraints: MissionConstraint[];
  forbiddenActions: ForbiddenAction[];
  evidencePolicy: MissionEvidencePolicy;

  metadata?: Record<string, unknown>;
}
```

## Requirements

Each requirement is either EXPLICIT (traceable to user input) or INFERRED (necessary for completion, with rationale).

```typescript
type RequirementKind = "EXPLICIT" | "INFERRED";

interface MissionRequirement {
  id: string;
  workstreamId: string;
  kind: RequirementKind;
  statement: string;
  rationale?: string;          // Required for INFERRED
  sourceRefs: string[];        // Traceability references
  dependencies: string[];      // Must form a DAG
  acceptanceCriteria: AcceptanceCriterion[];
  initialApplicability?: "APPLICABLE" | "NOT_APPLICABLE";
}
```

### Identity Rules

All IDs must be explicit, nonempty, case-sensitive, stable, unique within their namespace, bounded in length, and free of leading/trailing whitespace. IDs are never auto-renumbered by validation.

Duplicates are rejected at validation time.

### Explicit vs Inferred

- **EXPLICIT**: Derived directly from user-supplied mission input. Must preserve traceability to the source.
- **INFERRED**: Inferred as necessary to complete or verify the mission. Must include a concrete rationale explaining why it is needed.

An INFERRED requirement with no rationale is invalid.

### Dependencies

Requirements may declare dependencies on other requirements. The dependency graph must be acyclic. Self-dependencies and cycles of any length are rejected.

### Acceptance Criteria

Each requirement must have at least one acceptance criterion:

```typescript
interface AcceptanceCriterion {
  id: string;
  statement: string;
  requiredEvidence: EvidenceRequirement[];
}
```

An `EvidenceRequirement` specifies what kind of evidence can satisfy the criterion:

```typescript
interface EvidenceRequirement {
  allowedTypes?: string[];           // e.g., ["test-result", "file-change"]
  minAuthority?: EvidenceAuthorityClassification;
  requiredCollectorClass?: string;
  minPassingStatus?: "pass";
}
```

A criterion with no required evidence is valid only when classified as operator judgment.

## Workstreams

Workstreams support hierarchical organization:

```typescript
interface MissionWorkstream {
  id: string;
  title: string;
  description?: string;
  parentId?: string;   // References another workstream
  order?: number;
}
```

Hierarchy must be acyclic. Self-parenting and unknown parent references are rejected.

## Constraints

Constraints represent structured mission limitations:

```typescript
type ConstraintKind = "REQUIRED" | "LIMIT" | "ENVIRONMENT"
                    | "PROCESS" | "SECURITY" | "COMPATIBILITY";

interface MissionConstraint {
  id: string;
  kind: ConstraintKind;
  statement: string;
  sourceRefs: string[];
  severity: "error" | "warning";
}
```

## Forbidden Actions

Forbidden actions describe what execution must never do:

```typescript
interface ForbiddenAction {
  id: string;
  statement: string;
  sourceRefs: string[];
  severity: "error" | "warning";
  matchHint?: string;   // Machine-match metadata for future phases
}
```

## Evidence Policy

The evidence policy defines what evidence is authoritative:

```typescript
interface MissionEvidencePolicy {
  authoritativeSources: EvidenceAuthorityClassification[];
  rules?: EvidencePolicyRule[];
}
```

### Trust Boundary

Agent claims are never authoritative. The evidence policy distinguishes:

| Classification | Authoritative? |
|---------------|----------------|
| agent-claim | Never |
| repository-observation | Yes (when from trusted collector) |
| command-result | Yes (when from trusted collector) |
| test-result | Yes (when from trusted collector) |
| runtime-observation | Yes (when from trusted collector) |
| operator-confirmation | Yes (from operator) |
| trusted-collector | Yes (always) |

## Deterministic Digest

Contracts have a SHA-256 digest computed from all semantically relevant fields (excluding metadata). The digest is stable across platforms and encodes:

- contractVersion, missionId, revision, title, objective
- All workstreams (sorted IDs)
- All requirements (with sorted source refs and dependencies)
- All constraints (sorted)
- All forbidden actions (sorted)
- Evidence policy

Metadata is excluded from the digest.