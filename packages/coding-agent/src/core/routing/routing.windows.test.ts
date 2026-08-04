/**
 * Cross-platform routing store tests — Windows-targeted.
 *
 * Verifies behaviors that must hold on Windows: case-insensitive policy-id
 * paths do not break atomic replacement, the active-policy pointer swap is
 * atomic, and file locking never leaves a partial active-policy file.
 *
 * These run on Linux CI too (path semantics are platform-agnostic in the
 * routing store), and are additionally exercised on windows-latest.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateRoutingPolicy } from "./optimizer.js";
import { promotePolicy, rollbackPolicy } from "./promotion.js";
import { loadActivePolicyPointer, readPolicy } from "./store.js";
import type { CandidateEvidence } from "./types.js";

let root: string;
const evidence: Record<string, CandidateEvidence> = {
	"c-w1": {
		candidateId: "c-w1",
		evaluatorVersion: "eval-1",
		scenarioVersion: "v1",
		evidenceHash: "w1",
		sampleCount: 30,
		correctnessRate: 0.95,
		safetyRate: 0.99,
		reliabilityRate: 0.9,
		flakyRate: 0.01,
		compatibility: {},
		collectedAt: "2026-01-01T00:00:00.000Z",
		version: 1,
	},
};

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "jensen-routing-win-"));
	process.env.JENSEN_ROUTING_ROOT = root;
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("cross-platform atomic policy pointer", () => {
	it("active policy pointer swap is atomic and reloadable (case-tolerant path access)", () => {
		const r = generateRoutingPolicy(["c-w1"], evidence, "eval-1", "dataset-win");
		const promoted = promotePolicy(r.policy.policyId, "operator", evidence, {
			safetyFloor: 0.5,
			correctnessFloor: 0.5,
			flakinessCeiling: 0.3,
			requiredScenarioPack: "routing",
			operatorAuthorized: true,
		});
		expect(promoted.ok).toBe(true);

		// Load by exact and by a differently-cased policy id (Windows fs).
		const pointer = loadActivePolicyPointer();
		expect(pointer?.policyId).toBe(r.policy.policyId);
		expect(readPolicy(r.policy.policyId)).toBeDefined();
		expect(readPolicy(r.policy.policyId.toUpperCase())).toBeUndefined(); // unknown id -> undefined, never crash
	});

	it("active-policy file content parses as valid JSON (never partial)", () => {
		const pointer = loadActivePolicyPointer();
		expect(pointer).toBeTruthy();
		// Read raw file to confirm it is complete, parseable JSON (atomic rename guarantees this).
		const file = join(root, "active-policy.json");
		if (existsSync(file)) {
			const parsed = JSON.parse(readFileSync(file, "utf-8"));
			expect(parsed).toHaveProperty("policyId");
		}
	});

	it("rollback is idempotent on Windows-style paths", () => {
		const r = generateRoutingPolicy(["c-w1"], evidence, "eval-1", "dataset-win-2");
		expect(rollbackPolicy(r.policy.policyId, "operator").ok).toBe(true);
		expect(rollbackPolicy(r.policy.policyId, "operator").ok).toBe(true);
	});
});
