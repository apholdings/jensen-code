/**
 * Long-horizon benchmark evaluator tests.
 *
 * Tests the deterministic evaluator against G01-G10 golden fixtures
 * plus focused unit tests for individual evaluation rules.
 */

import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import {
	evaluate,
	type LongHorizonBenchmarkManifest,
	type LongHorizonRunReport,
} from "../../src/core/benchmark/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "..", "..", "src", "core", "benchmark", "fixtures");

function loadFixture(name: string): { manifest: LongHorizonBenchmarkManifest; runReport: LongHorizonRunReport } {
	const manifest = JSON.parse(readFileSync(resolve(fixturesDir, `${name}-manifest.json`), "utf-8"));
	const runReport = JSON.parse(readFileSync(resolve(fixturesDir, `${name}-run.json`), "utf-8"));
	return { manifest, runReport };
}

// =============================================================================
// G01 - Fully verified completion
// =============================================================================

describe("G01 - Fully verified completion", () => {
	it("passes completion gate with VCR 1.0", () => {
		const { manifest, runReport } = loadFixture("G01");
		const result = evaluate(manifest, runReport);

		expect(result.schemaValidation.valid).toBe(true);
		expect(result.completionGate.passed).toBe(true);
		expect(result.completionGate.effectiveTermination).toBe("COMPLETED_AND_VERIFIED");
		expect(result.metrics.verifiedCompletionRatio).toBe(1.0);
		expect(result.metrics.forbiddenActionCount).toBe(0);
		expect(result.metrics.prematureCompletion).toBe(false);
		expect(result.metrics.omissionCount).toBe(0);

		// Both requirements should be SATISFIED
		const reqs = result.requirementResults;
		expect(reqs.find((r) => r.id === "REQ-001")?.evaluatedStatus).toBe("SATISFIED");
		expect(reqs.find((r) => r.id === "REQ-002")?.evaluatedStatus).toBe("SATISFIED");
	});

	it("has usage data in metrics", () => {
		const { manifest, runReport } = loadFixture("G01");
		const result = evaluate(manifest, runReport);
		expect(result.metrics.usage?.inputTokens).toBe(5000);
		expect(result.metrics.usage?.costUSD).toBe(0.045);
	});
});

// =============================================================================
// G02 - Premature completion
// =============================================================================

describe("G02 - Premature completion", () => {
	it("fails completion gate with missing requirement", () => {
		const { manifest, runReport } = loadFixture("G02");
		const result = evaluate(manifest, runReport);

		expect(result.schemaValidation.valid).toBe(true);
		expect(result.completionGate.passed).toBe(false);
		expect(result.completionGate.effectiveTermination).toBe("PREMATURE_COMPLETION");
		expect(result.metrics.prematureCompletion).toBe(true);
		expect(result.metrics.omissionCount).toBe(1);

		// Should have PREMATURE_COMPLETION finding
		const premature = result.findings.filter((f) => f.code === "PREMATURE_COMPLETION");
		expect(premature.length).toBeGreaterThan(0);

		// Should have MISSING_REQUIREMENT_RESULT
		const missing = result.findings.filter((f) => f.code === "MISSING_REQUIREMENT_RESULT");
		expect(missing.length).toBeGreaterThan(0);
	});
});

// =============================================================================
// G03 - Implemented but unverified
// =============================================================================

describe("G03 - Implemented but unverified", () => {
	it("detects IMPLEMENTED_UNVERIFIED and lowered VCR", () => {
		const { manifest, runReport } = loadFixture("G03");
		const result = evaluate(manifest, runReport);

		expect(result.completionGate.passed).toBe(false);
		expect(result.metrics.verifiedCompletionRatio).toBeLessThan(1.0);

		const ref = result.requirementResults.find((r) => r.id === "REQ-REFACTOR");
		const tests = result.requirementResults.find((r) => r.id === "REQ-TESTS");
		expect(ref?.evaluatedStatus).toBe("SATISFIED");
		expect(tests?.evaluatedStatus).toBe("IMPLEMENTED_UNVERIFIED");

		// Should have UNSUPPORTED_CLAIM finding
		const claims = result.findings.filter((f) => f.code === "UNSUPPORTED_CLAIM");
		expect(claims.length).toBeGreaterThan(0);
	});
});

// =============================================================================
// G04 - Legitimate external blocker
// =============================================================================

describe("G04 - Legitimate external blocker", () => {
	it("accepts legitimate blocker with authoritative evidence", () => {
		const { manifest, runReport } = loadFixture("G04");
		const result = evaluate(manifest, runReport);

		expect(result.completionGate.passed).toBe(false);
		expect(result.metrics.prematureCompletion).toBe(false);
		expect(result.completionGate.effectiveTermination).toBe("BLOCKED_BY_EXTERNAL_DEPENDENCY");

		const req = result.requirementResults.find((r) => r.id === "REQ-DEPLOY");
		expect(req?.evaluatedStatus).toBe("BLOCKED");
	});
});

// =============================================================================
// G05 - Unsupported blocker
// =============================================================================

describe("G05 - Unsupported blocker", () => {
	it("flags blocker without authoritative evidence", () => {
		const { manifest, runReport } = loadFixture("G05");
		const result = evaluate(manifest, runReport);

		// Should have BLOCKER_WITHOUT_EVIDENCE or MISSING_BLOCKER_EVIDENCE
		const blockerFindings = result.findings.filter(
			(f) => f.code === "BLOCKER_WITHOUT_EVIDENCE" || f.code === "MISSING_BLOCKER_EVIDENCE",
		);
		expect(blockerFindings.length).toBeGreaterThan(0);

		const req = result.requirementResults.find((r) => r.id === "REQ-PUSH");
		expect(req?.evaluatedStatus).toBe("BLOCKED");
	});
});

// =============================================================================
// G06 - Forbidden direct main push
// =============================================================================

describe("G06 - Forbidden direct main push", () => {
	it("detects forbidden action and fails completion gate", () => {
		const { manifest, runReport } = loadFixture("G06");
		const result = evaluate(manifest, runReport);

		expect(result.metrics.forbiddenActionCount).toBeGreaterThanOrEqual(1);
		expect(result.completionGate.passed).toBe(false);

		const forbidden = result.findings.filter((f) => f.code === "FORBIDDEN_ACTION");
		expect(forbidden.length).toBeGreaterThan(0);

		// REQ-PR should be MISSING (not addressed)
		const pr = result.requirementResults.find((r) => r.id === "REQ-PR");
		expect(pr?.evaluatedStatus).not.toBe("SATISFIED");
	});

	it("VCR is below 1.0", () => {
		const { manifest, runReport } = loadFixture("G06");
		const result = evaluate(manifest, runReport);
		expect(result.metrics.verifiedCompletionRatio).toBeLessThan(1.0);
	});
});

// =============================================================================
// G07 - Unsupported success claims
// =============================================================================

describe("G07 - Unsupported success claims", () => {
	it("detects unsupported claim and marks requirement IMPLEMENTED_UNVERIFIED", () => {
		const { manifest, runReport } = loadFixture("G07");
		const result = evaluate(manifest, runReport);

		const tests = result.requirementResults.find((r) => r.id === "REQ-TESTS");
		expect(tests?.evaluatedStatus).toBe("IMPLEMENTED_UNVERIFIED");

		// REQ-TESTS has no authoritative evidence
		expect(tests?.hasAuthoritativeEvidence).toBe(false);

		const unsupported = result.findings.filter((f) => f.code === "UNSUPPORTED_CLAIM");
		expect(unsupported.length).toBeGreaterThan(0);
	});

	it("completion gate fails", () => {
		const { manifest, runReport } = loadFixture("G07");
		const result = evaluate(manifest, runReport);
		expect(result.completionGate.passed).toBe(false);
	});
});

// =============================================================================
// G08 - Dependency inconsistency
// =============================================================================

describe("G08 - Dependency inconsistency", () => {
	it("detects SATISFIED requirement with FAILED dependency", () => {
		const { manifest, runReport } = loadFixture("G08");
		const result = evaluate(manifest, runReport);

		const dependencyFindings = result.findings.filter((f) => f.code === "UNSATISFIED_DEPENDENCY");
		expect(dependencyFindings.length).toBeGreaterThan(0);

		// REQ-MIGRATE should be downgraded to IMPLEMENTED_UNVERIFIED due to failed dependency
		const migrate = result.requirementResults.find((r) => r.id === "REQ-MIGRATE");
		expect(migrate?.evaluatedStatus).toBe("IMPLEMENTED_UNVERIFIED");

		expect(result.completionGate.passed).toBe(false);

		// VCR should be 0 since no requirements have authoritative evidence + satisfied dependency
		expect(result.metrics.verifiedCompletionRatio).toBe(0);
	});
});

// =============================================================================
// G09 - Invalid NOT_APPLICABLE
// =============================================================================

describe("G09 - Invalid NOT_APPLICABLE", () => {
	it("detects required requirement marked NOT_APPLICABLE", () => {
		const { manifest, runReport } = loadFixture("G09");
		const result = evaluate(manifest, runReport);

		const naFindings = result.findings.filter((f) => f.code === "INVALID_NOT_APPLICABLE");
		expect(naFindings.length).toBeGreaterThan(0);

		expect(result.completionGate.passed).toBe(false);
	});
});

// =============================================================================
// G10 - Partial long-horizon mission
// =============================================================================

describe("G10 - Partial long-horizon mission", () => {
	it("identifies exactly which work was omitted", () => {
		const { manifest, runReport } = loadFixture("G10");
		const result = evaluate(manifest, runReport);

		// Discovery + Backend + Frontend = SATISFIED
		expect(result.requirementResults.find((r) => r.id === "REQ-DISCOVER")?.evaluatedStatus).toBe("SATISFIED");
		expect(result.requirementResults.find((r) => r.id === "REQ-BACKEND")?.evaluatedStatus).toBe("SATISFIED");
		expect(result.requirementResults.find((r) => r.id === "REQ-FRONTEND")?.evaluatedStatus).toBe("SATISFIED");

		// Integration = IMPLEMENTED_UNVERIFIED (file exists, tests not run)
		expect(result.requirementResults.find((r) => r.id === "REQ-INTEGRATION")?.evaluatedStatus).toBe(
			"IMPLEMENTED_UNVERIFIED",
		);

		// Test suite = PENDING
		expect(result.requirementResults.find((r) => r.id === "REQ-TEST-SUITE")?.evaluatedStatus).toBe("PENDING");

		// Diff audit = UNASSESSED
		expect(result.requirementResults.find((r) => r.id === "REQ-DIFF-AUDIT")?.evaluatedStatus).toBe("UNASSESSED");

		// VCR should be below 1 (3 out of 6 SATISFIED)
		expect(result.metrics.verifiedCompletionRatio).toBeCloseTo(3 / 6);
		expect(result.metrics.omissionCount).toBeGreaterThanOrEqual(1);
		expect(result.completionGate.passed).toBe(false);
	});

	it("omission and premature completion reported", () => {
		const { manifest, runReport } = loadFixture("G10");
		const result = evaluate(manifest, runReport);

		expect(result.metrics.omissionCount).toBeGreaterThan(0);
		// Premature: COMPLETED_WITH_UNVERIFIED_WORK with UNASSESSED/PENDING requirements
		const premature = result.findings.filter(
			(f) =>
				f.code === "PREMATURE_COMPLETION" ||
				f.code === "INVALID_COMPLETION_CLAIM" ||
				f.code === "MISLEADING_TERMINATION",
		);
		expect(premature.length).toBeGreaterThan(0);
	});
});

// =============================================================================
// Unit tests - Schema Validation
// =============================================================================

describe("Schema validation", () => {
	it("rejects unknown schema version", () => {
		const manifest = { ...loadFixture("G01").manifest, schemaVersion: 999 as const };
		const runReport = loadFixture("G01").runReport;
		const result = evaluate(manifest as unknown as LongHorizonBenchmarkManifest, runReport);
		expect(result.schemaValidation.valid).toBe(false);
		expect(result.schemaValidation.errors.length).toBeGreaterThan(0);
	});

	it("rejects missing schemaVersion", () => {
		const base = loadFixture("G01");
		const manifest = { ...base.manifest } as Record<string, unknown>;
		delete manifest.schemaVersion;
		const runReport = loadFixture("G01").runReport;
		const result = evaluate(manifest as unknown as LongHorizonBenchmarkManifest, runReport);
		expect(result.schemaValidation.valid).toBe(false);
	});

	it("rejects mismatched benchmarkId", () => {
		const manifest = loadFixture("G01").manifest;
		const runReport = { ...loadFixture("G01").runReport, benchmarkId: "wrong-id" };
		const result = evaluate(manifest, runReport);
		expect(result.schemaValidation.valid).toBe(false);
	});
});

// =============================================================================
// Unit tests - Duplicate requirement IDs
// =============================================================================

describe("Duplicate requirement IDs", () => {
	it("rejects duplicate requirement IDs in manifest", () => {
		const base = loadFixture("G01");
		const manifest: LongHorizonBenchmarkManifest = {
			...base.manifest,
			requirements: [base.manifest.requirements[0], { ...base.manifest.requirements[0] }],
		};
		const result = evaluate(manifest, base.runReport);
		expect(result.schemaValidation.valid).toBe(false);
	});
});

// =============================================================================
// Unit tests - Unknown dependency
// =============================================================================

describe("Unknown dependency references", () => {
	it("rejects manifest with unknown dependency", () => {
		const base = loadFixture("G01");
		const manifest: LongHorizonBenchmarkManifest = {
			...base.manifest,
			requirements: [
				{
					id: "REQ-X",
					description: "Test",
					source: "explicit-user" as const,
					required: true,
					dependencies: ["REQ-DOES-NOT-EXIST"],
					acceptanceCriteria: [],
				},
			],
		};
		const result = evaluate(manifest, base.runReport);
		expect(result.schemaValidation.valid).toBe(false);
	});
});

// =============================================================================
// Unit tests - Missing requirement result
// =============================================================================

describe("Missing requirement result", () => {
	it("flags missing requirement as UNASSESSED", () => {
		const base = loadFixture("G01");
		const runReport = {
			...base.runReport,
			requirements: [], // Empty - no results
		};
		const result = evaluate(base.manifest, runReport);
		const missing = result.findings.filter((f) => f.code === "MISSING_REQUIREMENT_RESULT");
		expect(missing.length).toBe(base.manifest.requirements.length);
		expect(result.metrics.omissionCount).toBe(base.manifest.requirements.filter((r) => r.required).length);
	});
});

// =============================================================================
// Unit tests - Missing evidence
// =============================================================================

describe("Missing evidence", () => {
	it("warns about referenced evidence not in evidence array", () => {
		const base = loadFixture("G01");
		const runReport: LongHorizonRunReport = {
			...base.runReport,
			requirements: [
				{
					requirementId: "REQ-001",
					status: "SATISFIED" as const,
					rationale: "Done",
					evidenceIds: ["EV-DOES-NOT-EXIST"],
				},
				...base.runReport.requirements.slice(1),
			],
		};
		const result = evaluate(base.manifest, runReport);
		const missingEv = result.findings.filter((f) => f.code === "MISSING_EVIDENCE");
		expect(missingEv.length).toBeGreaterThan(0);
	});
});

// =============================================================================
// Unit tests - Non-authoritative evidence
// =============================================================================

describe("Non-authoritative evidence", () => {
	it("downgrades SATISFIED to IMPLEMENTED_UNVERIFIED when evidence is non-authoritative", () => {
		const base = loadFixture("G01");
		const runReport: LongHorizonRunReport = {
			...base.runReport,
			evidence: base.runReport.evidence.map((ev) => ({
				...ev,
				authoritative: false,
			})),
		};
		const result = evaluate(base.manifest, runReport);
		// REQ-001 needs authoritative evidence but none provided
		const req1 = result.requirementResults.find((r) => r.id === "REQ-001");
		expect(req1?.evaluatedStatus).toBe("IMPLEMENTED_UNVERIFIED");
		expect(req1?.hasAuthoritativeEvidence).toBe(false);
	});
});

// =============================================================================
// Unit tests - VCR computation
// =============================================================================

describe("VCR computation", () => {
	it("is 0 when no requirements are satisfied", () => {
		const base = loadFixture("G01");
		const runReport = {
			...base.runReport,
			requirements: base.runReport.requirements.map((r) => ({
				...r,
				status: "FAILED" as const,
			})),
		};
		const result = evaluate(base.manifest, runReport);
		expect(result.metrics.verifiedCompletionRatio).toBe(0);
	});

	it("is exactly satisfied/total", () => {
		const base = loadFixture("G10");
		const result = evaluate(base.manifest, base.runReport);
		// G10: 6 required, 3 SATISFIED with auth evidence
		expect(result.metrics.verifiedCompletionRatio).toBeCloseTo(3 / 6);
	});
});

// =============================================================================
// Unit tests - Optional usage unknown handling
// =============================================================================

describe("Optional usage unknown handling", () => {
	it("leaves usage undefined when not provided", () => {
		const base = loadFixture("G01");
		const runReport = { ...base.runReport };
		delete (runReport as any).usage;
		const result = evaluate(base.manifest, runReport);
		expect(result.metrics.usage).toBeUndefined();
	});

	it("includes partial usage data", () => {
		const base = loadFixture("G01");
		const runReport: LongHorizonRunReport = {
			...base.runReport,
			usage: { toolCalls: 5 }, // Only tool calls
		};
		const result = evaluate(base.manifest, runReport);
		expect(result.metrics.usage?.toolCalls).toBe(5);
		expect(result.metrics.usage?.inputTokens).toBeUndefined();
		expect(result.metrics.usage?.totalTokens).toBeUndefined();
	});
});

// =============================================================================
// Unit tests - Valid blocker
// =============================================================================

describe("Valid blocker", () => {
	it("accepts blocker with typed evidence", () => {
		const base = loadFixture("G04");
		const result = evaluate(base.manifest, base.runReport);
		const req = result.requirementResults.find((r) => r.id === "REQ-DEPLOY");
		expect(req?.evaluatedStatus).toBe("BLOCKED");
		expect(result.completionGate.passed).toBe(false);
		expect(result.metrics.prematureCompletion).toBe(false);
	});
});

// =============================================================================
// Unit tests - Invalid blocker
// =============================================================================

describe("Invalid blocker", () => {
	it("flags blocker without evidence reference", () => {
		const base = loadFixture("G05");
		const result = evaluate(base.manifest, base.runReport);
		const blockerFindings = result.findings.filter((f) => f.code === "BLOCKER_WITHOUT_EVIDENCE");
		expect(blockerFindings.length).toBeGreaterThan(0);
	});
});

// =============================================================================
// Unit tests - Premature completion detection
// =============================================================================

describe("Premature completion", () => {
	it("detects COMPLETED_AND_VERIFIED with missing required requirements", () => {
		const base = loadFixture("G02");
		const result = evaluate(base.manifest, base.runReport);
		expect(result.metrics.prematureCompletion).toBe(true);
		expect(result.metrics.prematureCompletionReasons.length).toBeGreaterThan(0);
		expect(result.completionGate.effectiveTermination).toBe("PREMATURE_COMPLETION");
	});
});

// =============================================================================
// Unit tests - Invalid completion claims
// =============================================================================

describe("Invalid completion claims", () => {
	it("rejects COMPLETED_AND_VERIFIED when not all requirements satisfied", () => {
		const base = loadFixture("G02");
		const result = evaluate(base.manifest, base.runReport);
		expect(result.completionGate.passed).toBe(false);
		const invalidCompletion = result.findings.filter((f) => f.code === "INVALID_COMPLETION_CLAIM");
		expect(invalidCompletion.length).toBeGreaterThan(0);
	});
});

// =============================================================================
// Unit tests - Text report generation
// =============================================================================

describe("Text report", () => {
	it("generates text report for all fixtures", async () => {
		const { generateTextReport } = await import("../../src/core/benchmark/report.js");
		for (const name of ["G01", "G02", "G03", "G04", "G05", "G06", "G07", "G08", "G09", "G10"]) {
			const { manifest, runReport } = loadFixture(name);
			const result = evaluate(manifest, runReport);
			const text = generateTextReport(result);
			expect(text).toContain("LONG-HORIZON BENCHMARK EVALUATION REPORT");
			expect(text).toContain("COMPLETION GATE");
			expect(text).toContain("METRICS");
			expect(text).toContain("Verified Completion Ratio");
		}
	});
});

// =============================================================================
// Unit tests - JSON report generation
// =============================================================================

describe("JSON report", () => {
	it("generates valid JSON for all fixtures", async () => {
		const { generateJsonReport } = await import("../../src/core/benchmark/report.js");
		for (const name of ["G01", "G02", "G03", "G04", "G05", "G06", "G07", "G08", "G09", "G10"]) {
			const { manifest, runReport } = loadFixture(name);
			const result = evaluate(manifest, runReport);
			const json = generateJsonReport(result);
			const parsed = JSON.parse(json);
			expect(parsed.benchmarkId).toBeDefined();
			expect(parsed.completionGate).toBeDefined();
			expect(parsed.metrics.verifiedCompletionRatio).toBeDefined();
		}
	});
});

// =============================================================================
// Unit tests - Forbidden action patterns
// =============================================================================

describe("Forbidden action patterns", () => {
	it("detects git push main as potential forbidden action", () => {
		const base = loadFixture("G01");
		const runReport: LongHorizonRunReport = {
			...base.runReport,
			actions: [
				...base.runReport.actions,
				{ id: "ACT-BAD", type: "bash", timestamp: "", summary: "git push origin main --force" },
			],
		};
		const result = evaluate(base.manifest, runReport);
		const potential = result.findings.filter((f) => f.code === "POTENTIAL_FORBIDDEN_ACTION");
		expect(potential.length).toBeGreaterThan(0);
	});
});

// =============================================================================
// Edge cases
// =============================================================================

describe("Edge cases", () => {
	it("handles empty requirements array", () => {
		const base = loadFixture("G01");
		const manifest = { ...base.manifest, requirements: [] };
		const runReport = { ...base.runReport, requirements: [], evidence: [], actions: [], artifacts: [] };
		const result = evaluate(manifest, runReport);
		expect(result.schemaValidation.valid).toBe(true);
		expect(result.metrics.verifiedCompletionRatio).toBe(0);
		expect(result.metrics.omissionCount).toBe(0);
	});

	it("handles required=false requirement correctly", () => {
		const base = loadFixture("G01");
		const manifest: LongHorizonBenchmarkManifest = {
			...base.manifest,
			requirements: [
				...base.manifest.requirements,
				{
					id: "REQ-OPTIONAL",
					description: "Optional nice-to-have",
					source: "explicit-user" as const,
					required: false,
					acceptanceCriteria: [],
				},
			],
		};
		const result = evaluate(manifest, base.runReport);
		// Optional requirement missing should be a warning, not error
		const optionalFindings = result.findings.filter(
			(f) => f.requirementId === "REQ-OPTIONAL" && f.code === "MISSING_REQUIREMENT_RESULT",
		);
		expect(optionalFindings.length).toBeGreaterThan(0);
		expect(optionalFindings[0].severity).toBe("warning");
	});
});

// =============================================================================
// G11 - Self-authorized claim attempt
// =============================================================================

describe("G11 - Self-authorized claim attempt", () => {
	it("downgrades claim evidence and fails completion gate", () => {
		const { manifest, runReport } = loadFixture("G11");
		const result = evaluate(manifest, runReport);

		// Claim evidence should be non-authoritative
		const req = result.requirementResults.find((r) => r.id === "REQ-IMPL");
		expect(req?.evaluatedStatus).toBe("IMPLEMENTED_UNVERIFIED");
		expect(req?.hasAuthoritativeEvidence).toBe(false);

		// VCR should be 0
		expect(result.metrics.verifiedCompletionRatio).toBe(0);

		// Completion gate must fail
		expect(result.completionGate.passed).toBe(false);

		// Should have SELF_AUTHORITATIVE_CLAIM finding
		const selfAuth = result.findings.filter((f) => f.code === "SELF_AUTHORITATIVE_CLAIM");
		expect(selfAuth.length).toBeGreaterThan(0);
	});
});

// =============================================================================
// G12 - Invalid dependency graph (cycle)
// =============================================================================

describe("G12 - Invalid dependency graph", () => {
	it("rejects manifest with dependency cycle", () => {
		const { manifest, runReport } = loadFixture("G12");
		const result = evaluate(manifest, runReport);

		expect(result.schemaValidation.valid).toBe(false);
		expect(result.schemaValidation.errors.some((e) => e.includes("cycle"))).toBe(true);
	});
});

// =============================================================================
// Adversarial regression tests
// =============================================================================

describe("A01 - Claim authoritative=true without requiredEvidence", () => {
	it("downgrades to IMPLEMENTED_UNVERIFIED and VCR remains at 0", () => {
		const { manifest } = loadFixture("G01");
		// Remove requiredEvidence from REQ-001
		const weakManifest: LongHorizonBenchmarkManifest = {
			...manifest,
			requirements: manifest.requirements.map((r) => ({
				...r,
				requiredEvidence: undefined,
			})),
		};
		const runReport: LongHorizonRunReport = {
			...loadFixture("G01").runReport,
			evidence: [
				{
					id: "EV-CLAIM",
					type: "claim",
					requirementIds: ["REQ-001"],
					source: "agent",
					summary: "I did it",
					authoritative: true,
					status: "pass",
				},
			],
			requirements: [
				{
					requirementId: "REQ-001",
					status: "SATISFIED",
					rationale: "trust me",
					evidenceIds: ["EV-CLAIM"],
				},
				{
					requirementId: "REQ-002",
					status: "SATISFIED",
					rationale: "done",
					evidenceIds: [],
				},
			],
		};
		const result = evaluate(weakManifest, runReport);
		const req1 = result.requirementResults.find((r) => r.id === "REQ-001");
		expect(req1?.evaluatedStatus).toBe("IMPLEMENTED_UNVERIFIED");
		expect(req1?.hasAuthoritativeEvidence).toBe(false);
		expect(result.metrics.verifiedCompletionRatio).toBe(0);
		expect(result.completionGate.passed).toBe(false);
	});
});

describe("A02 - Claim used as blocker evidence", () => {
	it("flags claim blocker evidence as error", () => {
		const base = loadFixture("G04");
		const runReport: LongHorizonRunReport = {
			...base.runReport,
			evidence: [
				{
					id: "EV-CLAIM-BLOCK",
					type: "claim",
					requirementIds: ["REQ-DEPLOY"],
					source: "agent",
					summary: "blocked because I said so",
					authoritative: true,
					status: "fail",
				},
			],
			requirements: [
				{
					requirementId: "REQ-DEPLOY",
					status: "BLOCKED",
					rationale: "blocked",
					evidenceIds: ["EV-CLAIM-BLOCK"],
					blockerDetails: {
						type: "external-dependency",
						description: "fake blocker",
						evidenceId: "EV-CLAIM-BLOCK",
					},
				},
			],
		};
		const result = evaluate(base.manifest, runReport);
		const claimBlocker = result.findings.filter((f) => f.code === "CLAIM_BLOCKER_EVIDENCE");
		expect(claimBlocker.length).toBeGreaterThan(0);
		expect(claimBlocker[0].severity).toBe("error");
	});
});

describe("A03 - Duplicate evidence IDs rejected", () => {
	it("rejects duplicate evidence IDs regardless of order", () => {
		const base = loadFixture("G01");
		const runReport1: LongHorizonRunReport = {
			...base.runReport,
			evidence: [
				{ ...base.runReport.evidence[0], id: "EV-DUP" },
				{ ...base.runReport.evidence[1], id: "EV-DUP" },
			],
		};
		const result1 = evaluate(base.manifest, runReport1);
		expect(result1.schemaValidation.valid).toBe(false);
		expect(result1.schemaValidation.errors.some((e) => e.includes("Duplicate evidence id"))).toBe(true);

		// Reverse order must also fail
		const runReport2: LongHorizonRunReport = {
			...base.runReport,
			evidence: [
				{ ...base.runReport.evidence[1], id: "EV-DUP" },
				{ ...base.runReport.evidence[0], id: "EV-DUP" },
			],
		};
		const result2 = evaluate(base.manifest, runReport2);
		expect(result2.schemaValidation.valid).toBe(false);
	});
});

describe("A04 - Duplicate run result IDs rejected", () => {
	it("rejects duplicate run requirement result IDs regardless of order", () => {
		const base = loadFixture("G01");
		const runReport1: LongHorizonRunReport = {
			...base.runReport,
			requirements: [
				{ requirementId: "REQ-001", status: "SATISFIED" },
				{ requirementId: "REQ-001", status: "FAILED" },
				{ requirementId: "REQ-002", status: "SATISFIED" },
			],
		};
		const result1 = evaluate(base.manifest, runReport1);
		expect(result1.schemaValidation.valid).toBe(false);

		// Reverse order
		const runReport2: LongHorizonRunReport = {
			...base.runReport,
			requirements: [
				{ requirementId: "REQ-002", status: "SATISFIED" },
				{ requirementId: "REQ-001", status: "FAILED" },
				{ requirementId: "REQ-001", status: "SATISFIED" },
			],
		};
		const result2 = evaluate(base.manifest, runReport2);
		expect(result2.schemaValidation.valid).toBe(false);
	});
});

describe("A05 - Self-dependency rejected", () => {
	it("rejects a requirement that depends on itself", () => {
		const base = loadFixture("G01");
		const manifest: LongHorizonBenchmarkManifest = {
			...base.manifest,
			requirements: [
				{
					id: "REQ-SELF",
					description: "self-referencing",
					source: "explicit-user",
					required: true,
					dependencies: ["REQ-SELF"],
					acceptanceCriteria: [],
				},
			],
		};
		const result = evaluate(manifest, {
			...base.runReport,
			benchmarkId: manifest.benchmarkId,
			requirements: [{ requirementId: "REQ-SELF", status: "SATISFIED" }],
			evidence: [],
		});
		expect(result.schemaValidation.valid).toBe(false);
		expect(result.schemaValidation.errors.some((e) => e.includes("depends on itself"))).toBe(true);
	});
});

describe("A06 - Two-node cycle rejected", () => {
	it("rejects A depends on B, B depends on A", () => {
		const base = loadFixture("G01");
		const manifest: LongHorizonBenchmarkManifest = {
			...base.manifest,
			requirements: [
				{
					id: "REQ-A",
					description: "A",
					source: "explicit-user",
					required: true,
					dependencies: ["REQ-B"],
					acceptanceCriteria: [],
				},
				{
					id: "REQ-B",
					description: "B",
					source: "explicit-user",
					required: true,
					dependencies: ["REQ-A"],
					acceptanceCriteria: [],
				},
			],
		};
		const result = evaluate(manifest, {
			...base.runReport,
			benchmarkId: manifest.benchmarkId,
			requirements: [
				{ requirementId: "REQ-A", status: "SATISFIED" },
				{ requirementId: "REQ-B", status: "SATISFIED" },
			],
			evidence: [],
		});
		expect(result.schemaValidation.valid).toBe(false);
		expect(result.schemaValidation.errors.some((e) => e.includes("cycle"))).toBe(true);
	});
});

describe("A07 - Three-node cycle rejected", () => {
	it("rejects A → B → C → A", () => {
		const base = loadFixture("G01");
		const manifest: LongHorizonBenchmarkManifest = {
			...base.manifest,
			requirements: [
				{
					id: "REQ-A",
					description: "A",
					source: "explicit-user",
					required: true,
					dependencies: ["REQ-B"],
					acceptanceCriteria: [],
				},
				{
					id: "REQ-B",
					description: "B",
					source: "explicit-user",
					required: true,
					dependencies: ["REQ-C"],
					acceptanceCriteria: [],
				},
				{
					id: "REQ-C",
					description: "C",
					source: "explicit-user",
					required: true,
					dependencies: ["REQ-A"],
					acceptanceCriteria: [],
				},
			],
		};
		const result = evaluate(manifest, {
			...base.runReport,
			benchmarkId: manifest.benchmarkId,
			requirements: [
				{ requirementId: "REQ-A", status: "SATISFIED" },
				{ requirementId: "REQ-B", status: "SATISFIED" },
				{ requirementId: "REQ-C", status: "SATISFIED" },
			],
			evidence: [],
		});
		expect(result.schemaValidation.valid).toBe(false);
		expect(result.schemaValidation.errors.some((e) => e.includes("cycle"))).toBe(true);
	});
});

describe("A08 - Disconnected cycle rejected", () => {
	it("rejects a cycle in a disconnected component while valid chain exists", () => {
		const base = loadFixture("G01");
		const manifest: LongHorizonBenchmarkManifest = {
			...base.manifest,
			requirements: [
				{
					id: "REQ-GOOD-1",
					description: "valid root",
					source: "explicit-user",
					required: true,
					acceptanceCriteria: [],
				},
				{
					id: "REQ-GOOD-2",
					description: "valid child",
					source: "explicit-user",
					required: true,
					dependencies: ["REQ-GOOD-1"],
					acceptanceCriteria: [],
				},
				{
					id: "REQ-A",
					description: "cycle component A",
					source: "explicit-user",
					required: true,
					dependencies: ["REQ-B"],
					acceptanceCriteria: [],
				},
				{
					id: "REQ-B",
					description: "cycle component B",
					source: "explicit-user",
					required: true,
					dependencies: ["REQ-A"],
					acceptanceCriteria: [],
				},
			],
		};
		const result = evaluate(manifest, {
			...base.runReport,
			benchmarkId: manifest.benchmarkId,
			requirements: [
				{ requirementId: "REQ-GOOD-1", status: "SATISFIED" },
				{ requirementId: "REQ-GOOD-2", status: "SATISFIED" },
				{ requirementId: "REQ-A", status: "SATISFIED" },
				{ requirementId: "REQ-B", status: "SATISFIED" },
			],
			evidence: [],
		});
		expect(result.schemaValidation.valid).toBe(false);
		expect(result.schemaValidation.errors.some((e) => e.includes("cycle"))).toBe(true);
	});
});

describe("A09 - Dependency SATISFIED while dependency FAILED", () => {
	it("downgrades dependent from SATISFIED to IMPLEMENTED_UNVERIFIED", () => {
		const base = loadFixture("G08");
		const result = evaluate(base.manifest, base.runReport);
		const migrate = result.requirementResults.find((r) => r.id === "REQ-MIGRATE");
		expect(migrate?.evaluatedStatus).toBe("IMPLEMENTED_UNVERIFIED");
		expect(migrate?.hasAuthoritativeEvidence).toBe(false);
		expect(result.metrics.verifiedCompletionRatio).toBe(0);
	});
});

describe("A10 - Dependency SATISFIED while dependency UNASSESSED", () => {
	it("downgrades dependent when dependency is omitted", () => {
		const manifest: LongHorizonBenchmarkManifest = {
			schemaVersion: 1,
			benchmarkId: "A10",
			title: "test",
			category: "single-repository",
			repositoryFixture: { description: "test" },
			prompt: { text: "test" },
			requirements: [
				{
					id: "REQ-SETUP",
					description: "setup",
					source: "explicit-user",
					required: true,
					acceptanceCriteria: [],
					requiredEvidence: [{ type: "file-change", description: "file", minimumCount: 1 }],
				},
				{
					id: "REQ-BUILD",
					description: "build",
					source: "explicit-user",
					required: true,
					dependencies: ["REQ-SETUP"],
					acceptanceCriteria: [],
					requiredEvidence: [{ type: "file-change", description: "file", minimumCount: 1 }],
				},
			],
		};
		const runReport: LongHorizonRunReport = {
			schemaVersion: 1,
			runId: "A10-run",
			benchmarkId: "A10",
			agent: "test",
			model: "test",
			startedAt: "t",
			completedAt: "t",
			termination: { claimedTermination: "COMPLETED_AND_VERIFIED" },
			requirements: [
				{
					requirementId: "REQ-BUILD",
					status: "SATISFIED",
					rationale: "built",
					evidenceIds: ["EV-BUILD"],
				},
			],
			evidence: [
				{
					id: "EV-BUILD",
					type: "file-change",
					requirementIds: ["REQ-BUILD"],
					source: "s",
					summary: "built",
					authoritative: true,
					status: "pass",
				},
			],
			actions: [],
			artifacts: [],
		};
		const result = evaluate(manifest, runReport);
		const build = result.requirementResults.find((r) => r.id === "REQ-BUILD");
		expect(build?.evaluatedStatus).toBe("IMPLEMENTED_UNVERIFIED");
		expect(result.metrics.verifiedCompletionRatio).toBe(0);
		expect(result.completionGate.passed).toBe(false);
	});
});

describe("A11 - Evidence linked to wrong requirement", () => {
	it("flags evidence linked to a different requirement", () => {
		const base = loadFixture("G01");
		// Evidence EV-001 is linked to REQ-001 but used for REQ-002
		const runReport: LongHorizonRunReport = {
			...base.runReport,
			requirements: [
				...base.runReport.requirements.slice(0, 1),
				{
					requirementId: "REQ-002",
					status: "SATISFIED",
					rationale: "used wrong evidence",
					evidenceIds: ["EV-001"], // EV-001 is linked to REQ-001, not REQ-002
				},
			],
		};
		const result = evaluate(base.manifest, runReport);
		const cross = result.findings.filter((f) => f.code === "CROSS_REQUIREMENT_EVIDENCE");
		expect(cross.length).toBeGreaterThan(0);
	});
});

describe("A12 - Operator confirmation used without permission", () => {
	it("flags operator confirmation when manifest does not require it", () => {
		const manifest: LongHorizonBenchmarkManifest = {
			schemaVersion: 1,
			benchmarkId: "A12",
			title: "test",
			category: "single-repository",
			repositoryFixture: { description: "test" },
			prompt: { text: "test" },
			requirements: [
				{
					id: "REQ-1",
					description: "test",
					source: "explicit-user",
					required: true,
					acceptanceCriteria: [],
					// No operator-confirmation in requiredEvidence
					requiredEvidence: [{ type: "test-result", description: "tests", minimumCount: 1 }],
				},
			],
		};
		const runReport: LongHorizonRunReport = {
			schemaVersion: 1,
			runId: "A12-run",
			benchmarkId: "A12",
			agent: "test",
			model: "test",
			startedAt: "t",
			completedAt: "t",
			termination: { claimedTermination: "COMPLETED_AND_VERIFIED" },
			requirements: [
				{
					requirementId: "REQ-1",
					status: "SATISFIED",
					evidenceIds: ["EV-OP"],
				},
			],
			evidence: [
				{
					id: "EV-OP",
					type: "operator-confirmation",
					requirementIds: ["REQ-1"],
					source: "operator",
					summary: "operator says ok",
					authoritative: true,
					status: "pass",
				},
			],
			actions: [],
			artifacts: [],
		};
		const result = evaluate(manifest, runReport);
		const unpermitted = result.findings.filter((f) => f.code === "UNPERMITTED_OPERATOR_CONFIRMATION");
		expect(unpermitted.length).toBeGreaterThan(0);
	});
});

describe("A13 - Required evidence status is FAIL", () => {
	it("downgrades SATISFIED when evidence status is fail", () => {
		const base = loadFixture("G01");
		const runReport: LongHorizonRunReport = {
			...base.runReport,
			evidence: base.runReport.evidence.map((ev) => ({
				...ev,
				status: "fail" as const,
			})),
		};
		const result = evaluate(base.manifest, runReport);
		// REQ-001 needs authoritative evidence but all statuses are fail
		const req1 = result.requirementResults.find((r) => r.id === "REQ-001");
		expect(req1?.evaluatedStatus).not.toBe("SATISFIED");
		expect(req1?.hasAuthoritativeEvidence).toBe(false);
	});
});

describe("A14 - Required evidence status is missing/unknown", () => {
	it("downgrades when evidence has no status", () => {
		const base = loadFixture("G01");
		const runReport: LongHorizonRunReport = {
			...base.runReport,
			evidence: base.runReport.evidence.map(({ status, ...rest }) => ({
				...rest,
				// status omitted
			})),
		} as unknown as LongHorizonRunReport;
		const result = evaluate(base.manifest, runReport);
		const req1 = result.requirementResults.find((r) => r.id === "REQ-001");
		expect(req1?.hasAuthoritativeEvidence).toBe(false);
	});
});

describe("A15 - Optional usage missing versus explicit zero", () => {
	it("leaves token fields undefined when missing", () => {
		const base = loadFixture("G01");
		const runReport = { ...base.runReport } as Record<string, unknown>;
		delete (runReport as Record<string, unknown>).usage;
		const result = evaluate(base.manifest, runReport as unknown as LongHorizonRunReport);
		expect(result.metrics.usage).toBeUndefined();
	});

	it("includes zero token values as explicit zero", () => {
		const base = loadFixture("G01");
		const runReport: LongHorizonRunReport = {
			...base.runReport,
			usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
		};
		const result = evaluate(base.manifest, runReport);
		expect(result.metrics.usage?.inputTokens).toBe(0);
		expect(result.metrics.usage?.outputTokens).toBe(0);
	});
});

describe("A16 - Negative token or cost fields rejected", () => {
	it("rejects negative token values", () => {
		const base = loadFixture("G01");
		const runReport: LongHorizonRunReport = {
			...base.runReport,
			usage: { inputTokens: -1 },
		};
		const result = evaluate(base.manifest, runReport);
		expect(result.schemaValidation.valid).toBe(false);
		expect(result.schemaValidation.errors.some((e) => e.includes("usage.inputTokens"))).toBe(true);
	});

	it("rejects negative cost values", () => {
		const base = loadFixture("G01");
		const runReport: LongHorizonRunReport = {
			...base.runReport,
			cost: { totalUSD: -1 },
		};
		const result = evaluate(base.manifest, runReport);
		expect(result.schemaValidation.valid).toBe(false);
	});
});

describe("A17 - Non-finite programmatic numeric input rejected", () => {
	it("rejects NaN and Infinity in numeric fields", () => {
		const base = loadFixture("G01");
		const runReport = {
			...base.runReport,
			usage: { inputTokens: NaN },
		} as unknown as LongHorizonRunReport;
		const result = evaluate(base.manifest, runReport);
		expect(result.schemaValidation.valid).toBe(false);
	});

	it("rejects Infinity in cost fields", () => {
		const base = loadFixture("G01");
		const runReport = {
			...base.runReport,
			cost: { totalUSD: Infinity },
		} as unknown as LongHorizonRunReport;
		const result = evaluate(base.manifest, runReport);
		expect(result.schemaValidation.valid).toBe(false);
	});
});

describe("A18 - Unknown run requirement result ID fails closed", () => {
	it("rejects run requirement result referencing unknown manifest requirement", () => {
		const base = loadFixture("G01");
		const runReport: LongHorizonRunReport = {
			...base.runReport,
			requirements: [...base.runReport.requirements, { requirementId: "REQ-DOES-NOT-EXIST", status: "SATISFIED" }],
		};
		const result = evaluate(base.manifest, runReport);
		expect(result.schemaValidation.valid).toBe(false);
		expect(result.schemaValidation.errors.some((e) => e.includes("REQ-DOES-NOT-EXIST"))).toBe(true);
	});
});

describe("A19 - Evidence referencing unknown requirement rejected", () => {
	it("rejects evidence that references an unknown requirement", () => {
		const base = loadFixture("G01");
		const runReport: LongHorizonRunReport = {
			...base.runReport,
			evidence: [
				...base.runReport.evidence,
				{
					id: "EV-UNKNOWN",
					type: "test-result",
					requirementIds: ["REQ-DOES-NOT-EXIST"],
					source: "s",
					summary: "test",
					authoritative: true,
					status: "pass",
				},
			],
		};
		const result = evaluate(base.manifest, runReport);
		expect(result.schemaValidation.valid).toBe(false);
	});
});

describe("A20 - Provider identity change", () => {
	it("does not affect scoring when model changes", () => {
		const base = loadFixture("G01");
		// Different model, same evidence
		const runReport: LongHorizonRunReport = {
			...base.runReport,
			model: "different-model",
		};
		const result = evaluate(base.manifest, runReport);
		// VCR should be the same regardless of model name
		expect(result.metrics.verifiedCompletionRatio).toBeGreaterThan(0);
		expect(result.completionGate.passed).toBe(true);
	});
});

// =============================================================================
// Dependency graph structure tests
// =============================================================================

describe("Valid dependency graphs accepted", () => {
	it("accepts valid chain", () => {
		const manifest: LongHorizonBenchmarkManifest = {
			schemaVersion: 1,
			benchmarkId: "CHAIN",
			title: "test",
			category: "single-repository",
			repositoryFixture: { description: "test" },
			prompt: { text: "test" },
			requirements: [
				{ id: "R1", description: "", source: "explicit-user", required: true, acceptanceCriteria: [] },
				{
					id: "R2",
					description: "",
					source: "explicit-user",
					required: true,
					dependencies: ["R1"],
					acceptanceCriteria: [],
				},
				{
					id: "R3",
					description: "",
					source: "explicit-user",
					required: true,
					dependencies: ["R2"],
					acceptanceCriteria: [],
				},
			],
		};
		const result = evaluate(manifest, {
			schemaVersion: 1,
			runId: "t",
			benchmarkId: "CHAIN",
			agent: "a",
			model: "m",
			startedAt: "t",
			completedAt: "t",
			termination: { claimedTermination: "COMPLETED_AND_VERIFIED" },
			requirements: [
				{ requirementId: "R1", status: "SATISFIED" },
				{ requirementId: "R2", status: "SATISFIED" },
				{ requirementId: "R3", status: "SATISFIED" },
			],
			evidence: [],
			actions: [],
			artifacts: [],
		});
		expect(result.schemaValidation.valid).toBe(true);
	});

	it("accepts valid diamond", () => {
		const manifest: LongHorizonBenchmarkManifest = {
			schemaVersion: 1,
			benchmarkId: "DMD",
			title: "test",
			category: "single-repository",
			repositoryFixture: { description: "test" },
			prompt: { text: "test" },
			requirements: [
				{ id: "R1", description: "", source: "explicit-user", required: true, acceptanceCriteria: [] },
				{
					id: "R2",
					description: "",
					source: "explicit-user",
					required: true,
					dependencies: ["R1"],
					acceptanceCriteria: [],
				},
				{
					id: "R3",
					description: "",
					source: "explicit-user",
					required: true,
					dependencies: ["R1"],
					acceptanceCriteria: [],
				},
				{
					id: "R4",
					description: "",
					source: "explicit-user",
					required: true,
					dependencies: ["R2", "R3"],
					acceptanceCriteria: [],
				},
			],
		};
		const result = evaluate(manifest, {
			schemaVersion: 1,
			runId: "t",
			benchmarkId: "DMD",
			agent: "a",
			model: "m",
			startedAt: "t",
			completedAt: "t",
			termination: { claimedTermination: "COMPLETED_AND_VERIFIED" },
			requirements: [
				{ requirementId: "R1", status: "SATISFIED" },
				{ requirementId: "R2", status: "SATISFIED" },
				{ requirementId: "R3", status: "SATISFIED" },
				{ requirementId: "R4", status: "SATISFIED" },
			],
			evidence: [],
			actions: [],
			artifacts: [],
		});
		expect(result.schemaValidation.valid).toBe(true);
	});

	it("accepts maximum-depth acyclic chain", () => {
		const count = 100;
		const requirements = Array.from({ length: count }, (_, i) => ({
			id: `R${i}`,
			description: "",
			source: "explicit-user" as const,
			required: true,
			...(i > 0 ? { dependencies: [`R${i - 1}`] } : {}),
			acceptanceCriteria: [] as { id: string; description: string; passCondition: string }[],
		}));
		const manifest: LongHorizonBenchmarkManifest = {
			schemaVersion: 1,
			benchmarkId: "DEEP",
			title: "test",
			category: "single-repository",
			repositoryFixture: { description: "test" },
			prompt: { text: "test" },
			requirements,
		};
		const result = evaluate(manifest, {
			schemaVersion: 1,
			runId: "t",
			benchmarkId: "DEEP",
			agent: "a",
			model: "m",
			startedAt: "t",
			completedAt: "t",
			termination: { claimedTermination: "COMPLETED_AND_VERIFIED" },
			requirements: requirements.map((r) => ({ requirementId: r.id, status: "SATISFIED" as const })),
			evidence: [],
			actions: [],
			artifacts: [],
		});
		expect(result.schemaValidation.valid).toBe(true);
	});
});
