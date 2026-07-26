/**
 * Mission Contract validation tests.
 *
 * Covers contract v1 schema validation: versions, IDs, duplicates,
 * explicit/inferred provenance, workstream hierarchy, cycles,
 * requirement DAG, unknown refs, acceptance criteria, constraints,
 * forbidden actions, evidence policy, numeric validation.
 */

import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import {
	initializeRequirementLedger,
	validateMissionContract,
	validateSourceGrantCriterionIds,
} from "../../src/core/long-horizon/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "..", "..", "src", "core", "long-horizon", "fixtures");

function loadFixture(name: string): Record<string, unknown> {
	return JSON.parse(readFileSync(resolve(fixturesDir, `${name}-contract.json`), "utf-8"));
}

// =============================================================================
// M01 - Minimal valid explicit mission
// =============================================================================

describe("M01 - Minimal valid explicit mission", () => {
	it("passes validation", () => {
		const contract = loadFixture("M01");
		const result = validateMissionContract(contract);
		expect(result.valid).toBe(true);
	});
});

// =============================================================================
// M02 - Explicit and inferred requirements
// =============================================================================

describe("M02 - Explicit and inferred requirements", () => {
	it("passes validation with both EXPLCIT and INFERRED requirements", () => {
		const contract = loadFixture("M02");
		const result = validateMissionContract(contract);
		expect(result.valid).toBe(true);
	});
});

// =============================================================================
// M03 - Hierarchical workstreams
// =============================================================================

describe("M03 - Hierarchical workstreams", () => {
	it("passes validation with valid workstream hierarchy", () => {
		const contract = loadFixture("M03");
		const result = validateMissionContract(contract);
		expect(result.valid).toBe(true);
	});
});

// =============================================================================
// M04 - Duplicate requirement ID
// =============================================================================

describe("M04 - Duplicate requirement ID", () => {
	it("rejects duplicate requirement IDs", () => {
		const contract = loadFixture("M04");
		const result = validateMissionContract(contract);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("Duplicate requirement id"))).toBe(true);
	});
});

// =============================================================================
// M05 - Unknown dependency
// =============================================================================

describe("M05 - Unknown dependency", () => {
	it("rejects unknown dependency reference", () => {
		const contract = loadFixture("M05");
		const result = validateMissionContract(contract);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("references unknown requirement"))).toBe(true);
	});
});

// =============================================================================
// M06 - Dependency cycle
// =============================================================================

describe("M06 - Dependency cycle", () => {
	it("rejects dependency cycle", () => {
		const contract = loadFixture("M06");
		const result = validateMissionContract(contract);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("cycle"))).toBe(true);
	});
});

// =============================================================================
// M07 - Workstream cycle
// =============================================================================

describe("M07 - Workstream cycle", () => {
	it("rejects workstream parent cycle", () => {
		const contract = loadFixture("M07");
		const result = validateMissionContract(contract);
		expect(result.valid).toBe(false);
	});
});

// =============================================================================
// M08-M20 - Contract validation for scenario fixtures
// =============================================================================

describe("M08 - Valid ledger initialization contract", () => {
	it("passes validation", () => {
		const contract = loadFixture("M08");
		const result = validateMissionContract(contract);
		expect(result.valid).toBe(true);
	});
});

describe("M09 - Valid lifecycle contract", () => {
	it("passes validation", () => {
		const contract = loadFixture("M09");
		const result = validateMissionContract(contract);
		expect(result.valid).toBe(true);
	});
});

describe("M10 - Authoritative evidence contract", () => {
	it("passes validation", () => {
		const contract = loadFixture("M10");
		const result = validateMissionContract(contract);
		expect(result.valid).toBe(true);
	});
});

describe("M11 - Self-authorized claim contract", () => {
	it("passes validation", () => {
		const contract = loadFixture("M11");
		const result = validateMissionContract(contract);
		expect(result.valid).toBe(true);
	});
});

describe("M12 - Illegal direct SATISFIED contract", () => {
	it("passes validation", () => {
		const contract = loadFixture("M12");
		const result = validateMissionContract(contract);
		expect(result.valid).toBe(true);
	});
});

describe("M13 - Stale revision contract", () => {
	it("passes validation", () => {
		const contract = loadFixture("M13");
		const result = validateMissionContract(contract);
		expect(result.valid).toBe(true);
	});
});

describe("M14 - Digest mismatch contract", () => {
	it("passes validation", () => {
		const contract = loadFixture("M14");
		const result = validateMissionContract(contract);
		expect(result.valid).toBe(true);
	});
});

describe("M14-alt - Alternate digest mismatch contract", () => {
	it("passes validation", () => {
		const contract = loadFixture("M14-alt");
		const result = validateMissionContract(contract);
		expect(result.valid).toBe(true);
	});
});

describe("M15 - Blocker and reopen contract", () => {
	it("passes validation", () => {
		const contract = loadFixture("M15");
		const result = validateMissionContract(contract);
		expect(result.valid).toBe(true);
	});
});

describe("M16 - NOT_APPLICABLE contract", () => {
	it("passes validation", () => {
		const contract = loadFixture("M16");
		const result = validateMissionContract(contract);
		expect(result.valid).toBe(true);
	});
});

describe("M17 - Satisfied regression contract", () => {
	it("passes validation", () => {
		const contract = loadFixture("M17");
		const result = validateMissionContract(contract);
		expect(result.valid).toBe(true);
	});
});

describe("M18 - Duplicate evidence contract", () => {
	it("passes validation", () => {
		const contract = loadFixture("M18");
		const result = validateMissionContract(contract);
		expect(result.valid).toBe(true);
	});
});

describe("M19 - Criterion evidence incomplete contract", () => {
	it("passes validation", () => {
		const contract = loadFixture("M19");
		const result = validateMissionContract(contract);
		expect(result.valid).toBe(true);
	});
});

describe("M20 - Completion candidate contract", () => {
	it("passes validation", () => {
		const contract = loadFixture("M20");
		const result = validateMissionContract(contract);
		expect(result.valid).toBe(true);
	});
});

// =============================================================================
// Unit tests - contractVersion
// =============================================================================

describe("Contract version validation", () => {
	it("rejects contractVersion != 1", () => {
		const base = loadFixture("M01");
		const contract = { ...base, contractVersion: 2 };
		const result = validateMissionContract(contract);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("contractVersion"))).toBe(true);
	});

	it("rejects missing contractVersion", () => {
		const base = { ...loadFixture("M01") };
		delete (base as Record<string, unknown>).contractVersion;
		const result = validateMissionContract(base);
		expect(result.valid).toBe(false);
	});
});

// =============================================================================
// Unit tests - missionId
// =============================================================================

describe("Mission ID validation", () => {
	it("rejects empty missionId", () => {
		const base = loadFixture("M01");
		const contract = { ...base, missionId: "" };
		const result = validateMissionContract(contract);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("missionId"))).toBe(true);
	});

	it("rejects whitespace-only missionId", () => {
		const base = loadFixture("M01");
		const contract = { ...base, missionId: "  " };
		const result = validateMissionContract(contract);
		expect(result.valid).toBe(false);
	});

	it("rejects leading whitespace in missionId", () => {
		const base = loadFixture("M01");
		const contract = { ...base, missionId: "  abc" };
		const result = validateMissionContract(contract);
		expect(result.valid).toBe(false);
	});
});

// =============================================================================
// Unit tests - revision
// =============================================================================

describe("Revision validation", () => {
	it("rejects negative revision", () => {
		const base = loadFixture("M01");
		const contract = { ...base, revision: -1 };
		const result = validateMissionContract(contract);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("revision"))).toBe(true);
	});

	it("rejects non-integer revision", () => {
		const base = loadFixture("M01");
		const contract = { ...base, revision: 1.5 };
		const result = validateMissionContract(contract);
		expect(result.valid).toBe(false);
	});

	it("rejects NaN revision", () => {
		const base: Record<string, unknown> = { ...loadFixture("M01") };
		base.revision = NaN;
		const result = validateMissionContract(base);
		expect(result.valid).toBe(false);
	});
});

// =============================================================================
// Unit tests - INFERRED provenance
// =============================================================================

describe("Inferred requirement provenance", () => {
	it("rejects INFERRED requirement without rationale", () => {
		const base = loadFixture("M01");
		const contract = {
			...base,
			requirements: [
				{
					id: "REQ-INF",
					workstreamId: (base as Record<string, unknown>).workstreams
						? ((base as Record<string, unknown>).workstreams as Array<{ id: string }>)[0].id
						: "WS-MAIN",
					kind: "INFERRED",
					statement: "Should do this.",
					sourceRefs: [],
					dependencies: [],
					acceptanceCriteria: [],
				},
			],
		};
		const result = validateMissionContract(contract);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("INFERRED requirement must include a rationale"))).toBe(true);
	});
});

// =============================================================================
// Unit tests - self-dependency
// =============================================================================

describe("Self-dependency", () => {
	it("rejects requirement depending on itself", () => {
		const base = loadFixture("M01");
		const wsId = ((base as Record<string, unknown>).workstreams as Array<{ id: string }>)[0].id;
		const contract = {
			...base,
			requirements: [
				{
					id: "REQ-SELF",
					workstreamId: wsId,
					kind: "EXPLICIT",
					statement: "Self-dep",
					sourceRefs: [],
					dependencies: ["REQ-SELF"],
					acceptanceCriteria: [],
				},
			],
		};
		const result = validateMissionContract(contract);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("cannot reference itself"))).toBe(true);
	});
});

// =============================================================================
// Unit tests - unknown workstream
// =============================================================================

describe("Unknown workstream reference", () => {
	it("rejects requirement referencing unknown workstream", () => {
		const base = loadFixture("M01");
		const contract = {
			...base,
			requirements: [
				{
					id: "REQ-X",
					workstreamId: "WS-DOES-NOT-EXIST",
					kind: "EXPLICIT",
					statement: "X",
					sourceRefs: [],
					dependencies: [],
					acceptanceCriteria: [],
				},
			],
		};
		const result = validateMissionContract(contract);
		expect(result.valid).toBe(false);
	});
});

// =============================================================================
// Unit tests - empty workstreams/requirements
// =============================================================================

describe("Empty collections", () => {
	it("rejects empty workstreams", () => {
		const base = loadFixture("M01");
		const contract = { ...base, workstreams: [] };
		const result = validateMissionContract(contract);
		expect(result.valid).toBe(false);
	});

	it("rejects empty requirements", () => {
		const base = loadFixture("M01");
		const contract = { ...base, requirements: [] };
		const result = validateMissionContract(contract);
		expect(result.valid).toBe(false);
	});
});

// =============================================================================
// Unit tests - duplicate IDs
// =============================================================================

describe("Duplicate IDs", () => {
	it("rejects duplicate workstream IDs", () => {
		const result = validateMissionContract({
			contractVersion: 1,
			missionId: "test",
			revision: 1,
			title: "t",
			objective: "o",
			workstreams: [
				{ id: "WS-DUP", title: "A", order: 1 },
				{ id: "WS-DUP", title: "B", order: 2 },
			],
			requirements: [
				{
					id: "R1",
					workstreamId: "WS-DUP",
					kind: "EXPLICIT",
					statement: "S",
					sourceRefs: [],
					dependencies: [],
					acceptanceCriteria: [],
				},
			],
			constraints: [],
			forbiddenActions: [],
			evidencePolicy: { authoritativeSources: [] },
		});
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("Duplicate workstream id"))).toBe(true);
	});

	it("rejects duplicate constraint IDs", () => {
		const result = validateMissionContract({
			contractVersion: 1,
			missionId: "test",
			revision: 1,
			title: "t",
			objective: "o",
			workstreams: [{ id: "W", title: "T", order: 1 }],
			requirements: [
				{
					id: "R1",
					workstreamId: "W",
					kind: "EXPLICIT",
					statement: "S",
					sourceRefs: [],
					dependencies: [],
					acceptanceCriteria: [],
				},
			],
			constraints: [
				{ id: "C-DUP", kind: "PROCESS" as const, statement: "S", sourceRefs: [], severity: "error" as const },
				{ id: "C-DUP", kind: "SECURITY" as const, statement: "S2", sourceRefs: [], severity: "warning" as const },
			],
			forbiddenActions: [],
			evidencePolicy: { authoritativeSources: [] },
		});
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("Duplicate constraint id"))).toBe(true);
	});

	it("rejects duplicate forbidden action IDs", () => {
		const result = validateMissionContract({
			contractVersion: 1,
			missionId: "test",
			revision: 1,
			title: "t",
			objective: "o",
			workstreams: [{ id: "W", title: "T", order: 1 }],
			requirements: [
				{
					id: "R1",
					workstreamId: "W",
					kind: "EXPLICIT",
					statement: "S",
					sourceRefs: [],
					dependencies: [],
					acceptanceCriteria: [],
				},
			],
			constraints: [],
			forbiddenActions: [
				{ id: "FA-DUP", statement: "S", sourceRefs: [], severity: "error" as const },
				{ id: "FA-DUP", statement: "S2", sourceRefs: [], severity: "warning" as const },
			],
			evidencePolicy: { authoritativeSources: [] },
		});
		expect(result.valid).toBe(false);
	});

	it("rejects duplicate acceptance criterion IDs", () => {
		const result = validateMissionContract({
			contractVersion: 1,
			missionId: "test",
			revision: 1,
			title: "t",
			objective: "o",
			workstreams: [{ id: "W", title: "T", order: 1 }],
			requirements: [
				{
					id: "R1",
					workstreamId: "W",
					kind: "EXPLICIT",
					statement: "S",
					sourceRefs: [],
					dependencies: [],
					acceptanceCriteria: [
						{ id: "AC-DUP", statement: "S", requiredEvidence: [] },
						{ id: "AC-DUP", statement: "S2", requiredEvidence: [] },
					],
				},
			],
			constraints: [],
			forbiddenActions: [],
			evidencePolicy: { authoritativeSources: [] },
		});
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("Duplicate acceptance criterion id"))).toBe(true);
	});
});

// =============================================================================
// Unit tests - invalid constraint kind
// =============================================================================

describe("Invalid constraint kind", () => {
	it("rejects unknown constraint kind", () => {
		const result = validateMissionContract({
			contractVersion: 1,
			missionId: "test",
			revision: 1,
			title: "t",
			objective: "o",
			workstreams: [{ id: "W", title: "T", order: 1 }],
			requirements: [
				{
					id: "R1",
					workstreamId: "W",
					kind: "EXPLICIT",
					statement: "S",
					sourceRefs: [],
					dependencies: [],
					acceptanceCriteria: [],
				},
			],
			constraints: [{ id: "C1", kind: "INVALID_KIND", statement: "S", sourceRefs: [], severity: "error" }],
			forbiddenActions: [],
			evidencePolicy: { authoritativeSources: [] },
		});
		expect(result.valid).toBe(false);
	});
});

// =============================================================================
// Unit tests - invalid severity
// =============================================================================

describe("Invalid severity", () => {
	it("rejects unknown constraint severity", () => {
		const result = validateMissionContract({
			contractVersion: 1,
			missionId: "test",
			revision: 1,
			title: "t",
			objective: "o",
			workstreams: [{ id: "W", title: "T", order: 1 }],
			requirements: [
				{
					id: "R1",
					workstreamId: "W",
					kind: "EXPLICIT",
					statement: "S",
					sourceRefs: [],
					dependencies: [],
					acceptanceCriteria: [],
				},
			],
			constraints: [{ id: "C1", kind: "PROCESS", statement: "S", sourceRefs: [], severity: "critical" }],
			forbiddenActions: [],
			evidencePolicy: { authoritativeSources: [] },
		});
		expect(result.valid).toBe(false);
	});
});

// =============================================================================
// Unit tests - self-parent workstream
// =============================================================================

describe("Self-parent workstream", () => {
	it("rejects workstream with self-parent", () => {
		const result = validateMissionContract({
			contractVersion: 1,
			missionId: "test",
			revision: 1,
			title: "t",
			objective: "o",
			workstreams: [{ id: "WS-SELF", title: "Self", parentId: "WS-SELF", order: 1 }],
			requirements: [
				{
					id: "R1",
					workstreamId: "WS-SELF",
					kind: "EXPLICIT",
					statement: "S",
					sourceRefs: [],
					dependencies: [],
					acceptanceCriteria: [],
				},
			],
			constraints: [],
			forbiddenActions: [],
			evidencePolicy: { authoritativeSources: [] },
		});
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("cannot reference itself"))).toBe(true);
	});
});

// =============================================================================
// Unit tests - NOT_APPLICABLE without rationale
// =============================================================================

describe("NOT_APPLICABLE without rationale", () => {
	it("rejects NOT_APPLICABLE initial applicability without rationale", () => {
		const result = validateMissionContract({
			contractVersion: 1,
			missionId: "test",
			revision: 1,
			title: "t",
			objective: "o",
			workstreams: [{ id: "W", title: "T", order: 1 }],
			requirements: [
				{
					id: "R1",
					workstreamId: "W",
					kind: "EXPLICIT",
					statement: "S",
					sourceRefs: [],
					dependencies: [],
					acceptanceCriteria: [],
					initialApplicability: "NOT_APPLICABLE",
				},
			],
			constraints: [],
			forbiddenActions: [],
			evidencePolicy: { authoritativeSources: [] },
		});
		expect(result.valid).toBe(false);
	});
});

// =============================================================================
// Unit tests - NULL, non-object input
// =============================================================================

describe("Non-object input", () => {
	it("rejects null", () => {
		const result = validateMissionContract(null);
		expect(result.valid).toBe(false);
	});

	it("rejects undefined", () => {
		const result = validateMissionContract(undefined);
		expect(result.valid).toBe(false);
	});

	it("rejects string", () => {
		const result = validateMissionContract("not an object");
		expect(result.valid).toBe(false);
	});

	it("rejects number", () => {
		const result = validateMissionContract(42);
		expect(result.valid).toBe(false);
	});
});

// =============================================================================
// Unit tests - valid kinds
// =============================================================================

describe("Valid requirement kind values", () => {
	it("rejects unknown kind", () => {
		const result = validateMissionContract({
			contractVersion: 1,
			missionId: "test",
			revision: 1,
			title: "t",
			objective: "o",
			workstreams: [{ id: "W", title: "T", order: 1 }],
			requirements: [
				{
					id: "R1",
					workstreamId: "W",
					kind: "IMPLIED",
					statement: "S",
					sourceRefs: [],
					dependencies: [],
					acceptanceCriteria: [],
				},
			],
			constraints: [],
			forbiddenActions: [],
			evidencePolicy: { authoritativeSources: [] },
		});
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("kind"))).toBe(true);
	});
});

// =============================================================================
// Unit tests - evidence policy rules
// =============================================================================

describe("Evidence policy rules", () => {
	it("rejects duplicate evidence policy rule IDs", () => {
		const result = validateMissionContract({
			contractVersion: 1,
			missionId: "test",
			revision: 1,
			title: "t",
			objective: "o",
			workstreams: [{ id: "W", title: "T", order: 1 }],
			requirements: [
				{
					id: "R1",
					workstreamId: "W",
					kind: "EXPLICIT",
					statement: "S",
					sourceRefs: [],
					dependencies: [],
					acceptanceCriteria: [],
				},
			],
			constraints: [],
			forbiddenActions: [],
			evidencePolicy: {
				authoritativeSources: [],
				rules: [
					{ id: "R-DUP", description: "A" },
					{ id: "R-DUP", description: "B" },
				],
			},
		});
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("Duplicate evidence policy rule id"))).toBe(true);
	});
});

// =============================================================================
// CID-01 through CID-06: Global acceptance-criterion ID uniqueness
// =============================================================================

describe("CID-01 - Duplicate criterion ID in same requirement", () => {
	it("rejects duplicate criterion ID within the same requirement", () => {
		const result = validateMissionContract({
			contractVersion: 1,
			missionId: "CID-01",
			revision: 1,
			title: "CID-01",
			objective: "Test global criterion uniqueness",
			workstreams: [{ id: "W", title: "T", order: 1 }],
			requirements: [
				{
					id: "REQ-1",
					workstreamId: "W",
					kind: "EXPLICIT" as const,
					statement: "Requirement 1",
					sourceRefs: [],
					dependencies: [],
					acceptanceCriteria: [
						{ id: "AC-DUP", statement: "First", requiredEvidence: [] },
						{ id: "AC-DUP", statement: "Duplicate in same requirement", requiredEvidence: [] },
					],
				},
			],
			constraints: [],
			forbiddenActions: [],
			evidencePolicy: { authoritativeSources: [] },
		});
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("Duplicate acceptance criterion id: AC-DUP"))).toBe(true);
	});
});

describe("CID-02 - Duplicate criterion ID in different requirements", () => {
	it("rejects duplicate criterion ID across different requirements", () => {
		const result = validateMissionContract({
			contractVersion: 1,
			missionId: "CID-02",
			revision: 1,
			title: "CID-02",
			objective: "Test cross-requirement criterion uniqueness",
			workstreams: [{ id: "W", title: "T", order: 1 }],
			requirements: [
				{
					id: "REQ-1",
					workstreamId: "W",
					kind: "EXPLICIT" as const,
					statement: "First requirement",
					sourceRefs: [],
					dependencies: [],
					acceptanceCriteria: [{ id: "AC-SHARED", statement: "Criterion in REQ-1", requiredEvidence: [] }],
				},
				{
					id: "REQ-2",
					workstreamId: "W",
					kind: "EXPLICIT" as const,
					statement: "Second requirement",
					sourceRefs: [],
					dependencies: [],
					acceptanceCriteria: [{ id: "AC-SHARED", statement: "Criterion in REQ-2", requiredEvidence: [] }],
				},
			],
			constraints: [],
			forbiddenActions: [],
			evidencePolicy: { authoritativeSources: [] },
		});
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("Duplicate acceptance criterion id: AC-SHARED"))).toBe(true);
	});
});

describe("CID-03 - Same textual ID with different case", () => {
	it("treats different-case criterion IDs as distinct (case-sensitive)", () => {
		const result = validateMissionContract({
			contractVersion: 1,
			missionId: "CID-03",
			revision: 1,
			title: "CID-03",
			objective: "Test case-sensitive criterion IDs",
			workstreams: [{ id: "W", title: "T", order: 1 }],
			requirements: [
				{
					id: "REQ-1",
					workstreamId: "W",
					kind: "EXPLICIT" as const,
					statement: "First requirement",
					sourceRefs: [],
					dependencies: [],
					acceptanceCriteria: [{ id: "ac-test", statement: "Lowercase", requiredEvidence: [] }],
				},
				{
					id: "REQ-2",
					workstreamId: "W",
					kind: "EXPLICIT" as const,
					statement: "Second requirement",
					sourceRefs: [],
					dependencies: [],
					acceptanceCriteria: [{ id: "AC-TEST", statement: "Uppercase", requiredEvidence: [] }],
				},
			],
			constraints: [],
			forbiddenActions: [],
			evidencePolicy: { authoritativeSources: [] },
		});
		expect(result.valid).toBe(true);
	});
});

describe("CID-04 - Unique criterion IDs accepted", () => {
	it("accepts globally unique criterion IDs across requirements", () => {
		const result = validateMissionContract({
			contractVersion: 1,
			missionId: "CID-04",
			revision: 1,
			title: "CID-04",
			objective: "Test globally unique criterion IDs",
			workstreams: [{ id: "W", title: "T", order: 1 }],
			requirements: [
				{
					id: "REQ-1",
					workstreamId: "W",
					kind: "EXPLICIT" as const,
					statement: "First requirement",
					sourceRefs: [],
					dependencies: [],
					acceptanceCriteria: [{ id: "AC-1", statement: "Criterion 1", requiredEvidence: [] }],
				},
				{
					id: "REQ-2",
					workstreamId: "W",
					kind: "EXPLICIT" as const,
					statement: "Second requirement",
					sourceRefs: [],
					dependencies: [],
					acceptanceCriteria: [{ id: "AC-2", statement: "Criterion 2", requiredEvidence: [] }],
				},
			],
			constraints: [],
			forbiddenActions: [],
			evidencePolicy: { authoritativeSources: [] },
		});
		expect(result.valid).toBe(true);
	});
});

describe("CID-05 - Duplicate criterion IDs prevent authoritative digest", () => {
	it("invalid contract with duplicate criterion IDs cannot produce valid digest flow", () => {
		const contract = {
			contractVersion: 1,
			missionId: "CID-05",
			revision: 1,
			title: "CID-05",
			objective: "Test digest precondition",
			workstreams: [{ id: "W", title: "T", order: 1 }],
			requirements: [
				{
					id: "REQ-1",
					workstreamId: "W",
					kind: "EXPLICIT" as const,
					statement: "Req 1",
					sourceRefs: [],
					dependencies: [],
					acceptanceCriteria: [{ id: "AC-X", statement: "X", requiredEvidence: [] }],
				},
				{
					id: "REQ-2",
					workstreamId: "W",
					kind: "EXPLICIT" as const,
					statement: "Req 2",
					sourceRefs: [],
					dependencies: [],
					acceptanceCriteria: [{ id: "AC-X", statement: "X duplicate", requiredEvidence: [] }],
				},
			],
			constraints: [],
			forbiddenActions: [],
			evidencePolicy: { authoritativeSources: [] },
		};
		const result = validateMissionContract(contract);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("Duplicate acceptance criterion id: AC-X"))).toBe(true);
	});
});

describe("CID-06 - Empty criterion IDs rejected", () => {
	it("empty criterion IDs are rejected by the schema", () => {
		// Empty criterion IDs are now rejected (allowEmpty removed).
		const result = validateMissionContract({
			contractVersion: 1,
			missionId: "CID-06",
			revision: 1,
			title: "CID-06",
			objective: "Test empty criterion ID rejection",
			workstreams: [{ id: "W", title: "T", order: 1 }],
			requirements: [
				{
					id: "REQ-1",
					workstreamId: "W",
					kind: "EXPLICIT" as const,
					statement: "Req 1",
					sourceRefs: [],
					dependencies: [],
					acceptanceCriteria: [{ id: "", statement: "Empty 1", requiredEvidence: [] }],
				},
			],
			constraints: [],
			forbiddenActions: [],
			evidencePolicy: { authoritativeSources: [] },
		});
		expect(result.valid).toBe(false);
	});
});

// =============================================================================
// CID-07 through CID-13: Additional criterion-ID boundary tests
// =============================================================================

describe("CID-07 - Empty criterion ID rejected", () => {
	it("rejects a contract with an empty-string criterion ID", () => {
		const result = validateMissionContract({
			contractVersion: 1,
			missionId: "CID-07",
			revision: 1,
			title: "CID-07",
			objective: "Test empty criterion ID (separate from CID-06)",
			workstreams: [{ id: "W", title: "T", order: 1 }],
			requirements: [
				{
					id: "REQ-C7",
					workstreamId: "W",
					kind: "EXPLICIT" as const,
					statement: "Req with empty criterion",
					sourceRefs: [],
					dependencies: [],
					acceptanceCriteria: [{ id: "", statement: "Empty criterion", requiredEvidence: [] }],
				},
			],
			constraints: [],
			forbiddenActions: [],
			evidencePolicy: { authoritativeSources: [] },
		});
		expect(result.valid).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});
});

describe("CID-08 - Whitespace-only criterion ID rejected", () => {
	it("rejects a contract with a whitespace-only criterion ID", () => {
		const result = validateMissionContract({
			contractVersion: 1,
			missionId: "CID-08",
			revision: 1,
			title: "CID-08",
			objective: "Test whitespace-only criterion ID rejection",
			workstreams: [{ id: "W", title: "T", order: 1 }],
			requirements: [
				{
					id: "REQ-C8",
					workstreamId: "W",
					kind: "EXPLICIT" as const,
					statement: "Req with whitespace criterion",
					sourceRefs: [],
					dependencies: [],
					acceptanceCriteria: [{ id: "   ", statement: "Whitespace criterion", requiredEvidence: [] }],
				},
			],
			constraints: [],
			forbiddenActions: [],
			evidencePolicy: { authoritativeSources: [] },
		});
		expect(result.valid).toBe(false);
	});
});

describe("CID-09 - Leading whitespace rejected", () => {
	it("rejects a criterion ID with leading whitespace", () => {
		const result = validateMissionContract({
			contractVersion: 1,
			missionId: "CID-09",
			revision: 1,
			title: "CID-09",
			objective: "Test leading whitespace rejection",
			workstreams: [{ id: "W", title: "T", order: 1 }],
			requirements: [
				{
					id: "REQ-C9",
					workstreamId: "W",
					kind: "EXPLICIT" as const,
					statement: "Req with leading-ws criterion",
					sourceRefs: [],
					dependencies: [],
					acceptanceCriteria: [{ id: "  AC-BAD", statement: "Leading whitespace", requiredEvidence: [] }],
				},
			],
			constraints: [],
			forbiddenActions: [],
			evidencePolicy: { authoritativeSources: [] },
		});
		expect(result.valid).toBe(false);
	});
});

describe("CID-10 - Trailing whitespace rejected", () => {
	it("rejects a criterion ID with trailing whitespace", () => {
		const result = validateMissionContract({
			contractVersion: 1,
			missionId: "CID-10",
			revision: 1,
			title: "CID-10",
			objective: "Test trailing whitespace rejection",
			workstreams: [{ id: "W", title: "T", order: 1 }],
			requirements: [
				{
					id: "REQ-C10",
					workstreamId: "W",
					kind: "EXPLICIT" as const,
					statement: "Req with trailing-ws criterion",
					sourceRefs: [],
					dependencies: [],
					acceptanceCriteria: [{ id: "AC-BAD  ", statement: "Trailing whitespace", requiredEvidence: [] }],
				},
			],
			constraints: [],
			forbiddenActions: [],
			evidencePolicy: { authoritativeSources: [] },
		});
		expect(result.valid).toBe(false);
	});
});

describe("CID-11 - Multiple blank IDs produce deterministic errors", () => {
	it("reports errors for each blank criterion ID deterministically", () => {
		const result = validateMissionContract({
			contractVersion: 1,
			missionId: "CID-11",
			revision: 1,
			title: "CID-11",
			objective: "Test multiple blank criterion IDs",
			workstreams: [{ id: "W", title: "T", order: 1 }],
			requirements: [
				{
					id: "REQ-C11",
					workstreamId: "W",
					kind: "EXPLICIT" as const,
					statement: "Req with multiple blank criteria",
					sourceRefs: [],
					dependencies: [],
					acceptanceCriteria: [
						{ id: "", statement: "Blank 1", requiredEvidence: [] },
						{ id: "", statement: "Blank 2", requiredEvidence: [] },
					],
				},
			],
			constraints: [],
			forbiddenActions: [],
			evidencePolicy: { authoritativeSources: [] },
		});
		expect(result.valid).toBe(false);
		expect(result.errors.length).toBeGreaterThanOrEqual(2);
	});
});

describe("CID-12 - Ledger initialization rejects invalid-criterion contract", () => {
	it("cannot initialize a ledger from a contract with invalid criterion IDs", () => {
		const contract = {
			contractVersion: 1,
			missionId: "CID-12",
			revision: 1,
			title: "CID-12",
			objective: "Test ledger rejection",
			workstreams: [{ id: "W", title: "T", order: 1 }],
			requirements: [
				{
					id: "REQ-C12",
					workstreamId: "W",
					kind: "EXPLICIT" as const,
					statement: "Req with invalid criterion",
					sourceRefs: [],
					dependencies: [],
					acceptanceCriteria: [{ id: "", statement: "Invalid criterion", requiredEvidence: [] }],
				},
			],
			constraints: [],
			forbiddenActions: [],
			evidencePolicy: { authoritativeSources: [] },
		};
		const result = initializeRequirementLedger(contract as any);
		expect(result.ok).toBe(false);
	});
});

// CID-13 through CID-18: Source grant criterion ID reference validation
// These tests validate TrustedEvidenceSourceGrant.allowedCriterionIds
// against the Mission Contract's global criterion registry.
// The contract-level validateCriterionReferences for v1 is wired but
// a no-op (the contract has no criterion-reference fields).
// =============================================================================

const CID_13_18_CONTRACT = {
	contractVersion: 1,
	missionId: "CID-1318",
	revision: 1,
	title: "CID Criterion Reference Tests",
	objective: "Base contract for criterion reference validation",
	workstreams: [{ id: "W", title: "W", order: 1 }],
	requirements: [
		{
			id: "REQ-A",
			workstreamId: "W",
			kind: "EXPLICIT" as const,
			statement: "First req",
			sourceRefs: [],
			dependencies: [],
			acceptanceCriteria: [
				{ id: "AC-A1", statement: "A1", requiredEvidence: [] },
				{ id: "AC-A2", statement: "A2", requiredEvidence: [] },
			],
		},
		{
			id: "REQ-B",
			workstreamId: "W",
			kind: "EXPLICIT" as const,
			statement: "Second req",
			sourceRefs: [],
			dependencies: [],
			acceptanceCriteria: [{ id: "AC-B1", statement: "B1", requiredEvidence: [] }],
		},
	],
	constraints: [],
	forbiddenActions: [],
	evidencePolicy: { authoritativeSources: [] },
};

describe("CID-13 - Unknown criterion ID in source grant rejected", () => {
	it("rejects a source grant referencing a nonexistent criterion ID", () => {
		const result = validateMissionContract(CID_13_18_CONTRACT);
		expect(result.valid).toBe(true);

		const errors = validateSourceGrantCriterionIds(
			[{ sourceId: "src-x", allowedCriterionIds: ["INVALID-CID"] }],
			new Set(["AC-A1", "AC-A2", "AC-B1"]),
		);
		expect(errors.length).toBe(1);
		expect(errors[0]).toContain("Unknown acceptance criterion id reference");
		expect(errors[0]).toContain("INVALID-CID");
	});
});

describe("CID-14 - Known criterion reference accepted", () => {
	it("accepts source grants with valid criterion IDs from the contract", () => {
		const result = validateMissionContract(CID_13_18_CONTRACT);
		expect(result.valid).toBe(true);

		const errors = validateSourceGrantCriterionIds(
			[{ sourceId: "src-x", allowedCriterionIds: ["AC-A1"] }],
			new Set(["AC-A1", "AC-A2", "AC-B1"]),
		);
		expect(errors.length).toBe(0);
	});
});

describe("CID-15 - Cross-requirement criterion reference accepted", () => {
	it("accepts valid criterion IDs from a different requirement (global uniqueness)", () => {
		const result = validateMissionContract(CID_13_18_CONTRACT);
		expect(result.valid).toBe(true);

		// "AC-B1" belongs to requirement REQ-B. Accepting it from a grant
		// scoped to a different requirement is valid because IDs are globally unique.
		const errors = validateSourceGrantCriterionIds(
			[{ sourceId: "src-x", allowedCriterionIds: ["AC-A1", "AC-B1"] }],
			new Set(["AC-A1", "AC-A2", "AC-B1"]),
		);
		expect(errors.length).toBe(0);
	});
});

describe("CID-16 - Empty criterion reference rejected", () => {
	it("rejects empty-string criterion IDs in source grants", () => {
		const result = validateMissionContract(CID_13_18_CONTRACT);
		expect(result.valid).toBe(true);

		const errors = validateSourceGrantCriterionIds(
			[{ sourceId: "src-x", allowedCriterionIds: [""] }],
			new Set(["AC-A1", "AC-A2", "AC-B1"]),
		);
		expect(errors.length).toBe(1);
		expect(errors[0]).toContain("empty criterion ID");
	});
});

describe("CID-17 - Whitespace criterion reference rejected", () => {
	it("rejects whitespace-only criterion IDs in source grants", () => {
		const result = validateMissionContract(CID_13_18_CONTRACT);
		expect(result.valid).toBe(true);

		const errors = validateSourceGrantCriterionIds(
			[{ sourceId: "src-x", allowedCriterionIds: ["   "] }],
			new Set(["AC-A1", "AC-A2", "AC-B1"]),
		);
		expect(errors.length).toBe(1);
		expect(errors[0]).toContain("whitespace-only");
	});
});

describe("CID-18 - Duplicate criterion references rejected", () => {
	it("rejects duplicate criterion IDs deterministically", () => {
		const result = validateMissionContract(CID_13_18_CONTRACT);
		expect(result.valid).toBe(true);

		const errors = validateSourceGrantCriterionIds(
			[{ sourceId: "src-x", allowedCriterionIds: ["AC-A1", "AC-B1", "AC-A1"] }],
			new Set(["AC-A1", "AC-A2", "AC-B1"]),
		);
		expect(errors.length).toBe(1);
		expect(errors[0]).toContain("duplicate criterion ID");
		expect(errors[0]).toContain("AC-A1");
	});
});
