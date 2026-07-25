# Benchmark Format

## Trust Boundary

The deterministic evaluator validates the semantics of a benchmark run report. It does not cryptographically authenticate JSON.

Run reports intended for authoritative benchmarking must be produced by a trusted collector that records tool, repository, test and operator evidence independently of the evaluated agent.

Agent-authored claims remain non-authoritative regardless of any boolean supplied in the run report. The run report's `authoritative` field is advisory input, not sufficient authority by itself.

## Task Manifest

A task manifest defines the benchmark assignment. It is a JSON file conforming to the `LongHorizonBenchmarkManifest` schema (schema version 1).

### Structure

```json
{
  "schemaVersion": 1,
  "benchmarkId": "example-task",
  "title": "Example Benchmark Task",
  "description": "A task demonstrating the benchmark format.",
  "category": "single-repository",
  "repositoryFixture": {
    "url": "https://github.com/example/repo",
    "sha": "abc123def",
    "localPath": "./fixtures/example-repo",
    "description": "Example repository at specific commit"
  },
  "prompt": {
    "text": "Fix the null-check bug in src/utils.ts and run all tests.",
    "attachments": ["docs/spec.md"]
  },
  "requirements": [
    {
      "id": "REQ-FIX",
      "description": "Fix the null-check bug in src/utils.ts",
      "source": "explicit-user",
      "required": true,
      "acceptanceCriteria": [
        {
          "id": "AC-001",
          "description": "Code change made",
          "passCondition": "Null check added to src/utils.ts"
        }
      ],
      "requiredEvidence": [
        {
          "type": "file-change",
          "description": "File diff showing the null check addition",
          "minimumCount": 1
        }
      ]
    },
    {
      "id": "REQ-TESTS",
      "description": "Run the full test suite",
      "source": "explicit-user",
      "required": true,
      "dependencies": ["REQ-FIX"],
      "acceptanceCriteria": [
        {
          "id": "AC-002",
          "description": "All tests pass",
          "passCondition": "npm test exits with code 0"
        }
      ],
      "requiredEvidence": [
        {
          "type": "test-result",
          "description": "Test run output",
          "minimumCount": 1
        }
      ]
    }
  ],
  "forbiddenActions": [
    {
      "id": "FORBIDDEN-PUSH",
      "description": "Do not push to remote",
      "actionCategory": "remote-mutation"
    }
  ],
  "expectedValidation": [
    {
      "id": "VAL-001",
      "description": "Full test suite",
      "validationType": "test-suite",
      "command": "npm test"
    }
  ],
  "allowedStopReasons": ["COMPLETED_AND_VERIFIED", "COMPLETED_WITH_UNVERIFIED_WORK"],
  "budgets": {
    "tokenTotal": 100000,
    "costUSD": 5.00,
    "wallClockSeconds": 1800
  }
}
```

### Categories

| Category | Description |
|----------|-------------|
| `single-repository` | Task within a single repository |
| `cross-component` | Task spanning multiple components/modules |
| `backend` | Backend-focused task |
| `frontend` | Frontend-focused task |
| `unity` | Unity engine task |
| `django` | Django web framework task |
| `integration` | Integration-focused task |
| `bug-diagnosis` | Bug diagnosis and debugging |
| `refactor` | Code refactoring |
| `release-engineering` | Release/deployment task |
| `infrastructure` | Infrastructure setup/change |
| `multi-host` | Multi-host deployment task |

### Requirement Sources

| Source | Meaning |
|--------|---------|
| `explicit-user` | Explicitly stated in the prompt |
| `inferred-necessary` | Inferred as necessary for completion |
| `repository-policy` | Required by repository conventions |
| `acceptance-criterion` | Required by an acceptance criterion |
| `safety` | Required for safety |
| `integration` | Required for integration |
| `validation` | Required for validation |

### Requirement Evaluation Statuses

| Status | Semantics |
|--------|-----------|
| `UNASSESSED` | No evaluation performed |
| `PENDING` | Work not yet started |
| `IN_PROGRESS` | Work in progress |
| `IMPLEMENTED_UNVERIFIED` | Implementation exists but not validated |
| `SATISFIED` | All criteria met with authoritative evidence |
| `BLOCKED` | Legitimately blocked with evidence |
| `NOT_APPLICABLE` | Applies only to optional requirements |
| `FAILED` | Implementation attempted but failed |

### Evidence Types and Authority

| Type | Authoritative? | Description |
|------|----------------|-------------|
| `file-change` | Yes (when pass + authoritative=true) | File was created, modified, or deleted |
| `commit` | Yes (when pass + authoritative=true) | Git commit |
| `test-result` | Yes (when pass + authoritative=true) | Test execution result |
| `build-result` | Yes (when pass + authoritative=true) | Build output |
| `command-result` | Yes (when pass + authoritative=true) | Shell command output |
| `runtime-observation` | Yes (when pass + authoritative=true) | Observed runtime behavior |
| `repository-state` | Yes (when pass + authoritative=true) | Repository state snapshot |
| `artifact` | Yes (when pass + authoritative=true) | Generated artifact |
| `external-blocker` | Yes (when pass + authoritative=true) | External blocker evidence |
| `operator-confirmation` | Yes (when pass + authoritative=true + manifest permits) | Operator confirmed |
| `claim` | **Never** | Agent's own assertion — always non-authoritative |

Claims are never authoritative regardless of the `authoritative` boolean. An agent cannot make its own assertion authoritative.

For a requirement without explicit `requiredEvidence` to become SATISFIED, it must have at least one passing non-claim authoritative evidence record correctly linked to that requirement. A plain status of SATISFIED in the run result is insufficient.

### Dependency Graph

The dependency graph must be acyclic. Self-dependencies and cycles of any length are rejected at schema validation.

A requirement cannot be SATISFIED when any of its mandatory dependencies is not SATISFIED. Dependency-inconsistent requirements are downgraded to IMPLEMENTED_UNVERIFIED and excluded from VCR.

### Scoring

Scoring is unweighted in schema v1. Each required requirement contributes equally to VCR. The schema does not include a `weight` field.

## Run Report

A run report describes what an agent did. It is a JSON file conforming to the `LongHorizonRunReport` schema (schema version 1).

### Structure

```json
{
  "schemaVersion": 1,
  "runId": "run-001",
  "benchmarkId": "example-task",
  "agent": "Jensen",
  "model": "claude-sonnet-4-20250514",
  "startedAt": "2026-07-25T10:00:00Z",
  "completedAt": "2026-07-25T10:15:00Z",
  "termination": {
    "claimedTermination": "COMPLETED_AND_VERIFIED",
    "reason": "All requirements satisfied and all tests pass"
  },
  "requirements": [
    {
      "requirementId": "REQ-FIX",
      "status": "SATISFIED",
      "rationale": "Added null check to src/utils.ts line 42",
      "evidenceIds": ["ev-001"],
      "implementationSummary": "Fixed null dereference bug"
    }
  ],
  "evidence": [
    {
      "id": "ev-001",
      "type": "file-change",
      "requirementIds": ["REQ-FIX"],
      "source": "src/utils.ts",
      "summary": "Added null guard before property access",
      "authoritative": true,
      "status": "pass",
      "details": {
        "linesAdded": 3,
        "linesRemoved": 0
      }
    }
  ],
  "actions": [
    {
      "id": "act-001",
      "type": "edit",
      "timestamp": "2026-07-25T10:01:00Z",
      "summary": "Edited src/utils.ts",
      "isForbidden": false
    }
  ],
  "tests": [
    {
      "id": "tst-001",
      "name": "Full Suite",
      "status": "passed",
      "output": "42 passed, 0 failed",
      "durationMs": 3500
    }
  ],
  "artifacts": [
    {
      "id": "art-001",
      "artifactType": "file",
      "path": "src/utils.ts",
      "status": "modified",
      "summary": "Null check added"
    }
  ],
  "claims": [
    {
      "id": "clm-001",
      "claim": "All tests pass successfully",
      "evidenceId": "ev-002",
      "authoritative": false
    }
  ],
  "usage": {
    "inputTokens": 25000,
    "outputTokens": 8000,
    "totalTokens": 33000,
    "toolCalls": 12,
    "durationMs": 900000
  },
  "cost": {
    "totalUSD": 0.12,
    "inputUSD": 0.08,
    "outputUSD": 0.04
  }
}
```

Note: the `claim`'s `authoritative` field is set to `false` because claims are never authoritative. An evaluator will ignore any `true` value.

### Termination Reasons

| Reason | Meaning |
|--------|---------|
| `COMPLETED_AND_VERIFIED` | All work done and verified |
| `COMPLETED_WITH_UNVERIFIED_WORK` | Some work unverified |
| `BLOCKED_BY_EXTERNAL_DEPENDENCY` | External service unavailable |
| `BLOCKED_BY_CREDENTIALS` | Missing authentication |
| `BLOCKED_BY_ENVIRONMENT` | Environment issue |
| `USER_VALIDATION_REQUIRED` | Needs human review |
| `SAFETY_RESTRICTION` | Safety policy blocked action |
| `PREMATURE_COMPLETION` | Stopped before finishing |
| `AGENT_FAILURE` | Internal agent error |
| `BUDGET_EXHAUSTED` | Token/cost budget exceeded |
| `TIMEOUT` | Wall-clock timeout |
| `UNKNOWN` | Unknown reason |

### Duplicate Identity Rejection

Duplicate IDs are rejected at schema validation:

- Duplicate manifest requirement IDs
- Duplicate evidence IDs
- Duplicate run requirement result IDs
- Duplicate action IDs
- Duplicate claim IDs

No last-wins or first-wins behavior — duplicates produce a hard schema error.

### Numeric Validation

All numeric fields (tokens, costs, budgets, durations, tool-call counts) must be finite. Non-finite values (NaN, Infinity) are rejected. Negative values are rejected where fields represent counts or non-negative quantities.

Missing optional numeric fields remain absent, not zero.