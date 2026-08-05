/**
 * Durable Mission Graph — graph model, validation, hashing and critical path.
 */

import { describe, expect, it } from "vitest";
import {
	buildMissionDocument,
	computeCriticalPath,
	computeMissionGraphDigest,
	detectCycles,
	type MissionGraphDocumentV1,
	type MissionObjective,
	type MissionScope,
	topologicallyOrdered,
	validateMissionGraph,
} from "../../src/core/mission/index.js";

function objective(id: string, deps: string[] = [], extra: Partial<MissionObjective> = {}): MissionObjective {
	return {
		id,
		title: id,
		dependencies: deps,
		declaredRepositories: ["repo:A"],
		estimate: 1,
		acceptanceCriteria: [{ id: `${id}-c1`, statement: `${id} is done` }],
		requiresApproval: false,
		status: "PENDING",
		...extra,
	};
}

function scope(repos: string[] = ["repo:A"]): MissionScope {
	return { repositories: repos, requireDeclaredRepositories: true };
}

function doc(objectives: MissionObjective[], sc: MissionScope = scope()): MissionGraphDocumentV1 {
	return buildMissionDocument("m-1", sc, objectives, [], 1, "DRAFT", 1000);
}

describe("mission graph model", () => {
	it("builds a versioned document with a stable digest and monotonic revision", () => {
		const d = doc([objective("a"), objective("b", ["a"])]);
		expect(d.schemaVersion).toBe(1);
		expect(d.revision).toBe(1);
		expect(d.digest).toBe(computeMissionGraphDigest(d.scope, d.objectives, d.contracts));
		// A later revision with different metadata keeps the digest; the digest is
		// over the semantic payload only.
		const d2 = buildMissionDocument("m-1", d.scope, d.objectives, d.contracts, 2, "ACTIVE", 2000);
		expect(d2.revision).toBe(2);
		expect(d2.digest).toBe(d.digest);
	});

	it("MISSION_GRAPH_HASH_changes when semantics change", () => {
		const d1 = doc([objective("a")]);
		const d2 = doc([objective("a", [], { title: "renamed" })]);
		expect(d2.digest).not.toBe(d1.digest);
	});

	it("detects cycles", () => {
		const g = doc([objective("a", ["b"]), objective("b", ["a"])]);
		const cycles = detectCycles(g);
		expect(cycles.length).toBeGreaterThan(0);
	});

	it("CYCLE_REJECTED in validation", () => {
		const g = doc([objective("a", ["b"]), objective("b", ["a"])]);
		const v = validateMissionGraph(g);
		expect(v.valid).toBe(false);
		expect(v.cycles.length).toBeGreaterThan(0);
	});

	it("MISSING_DEPENDENCY_REJECTED in validation", () => {
		const g = doc([objective("a", ["ghost"])]);
		const v = validateMissionGraph(g);
		expect(v.valid).toBe(false);
		expect(v.missingDependencies).toContain("a->ghost");
	});

	it("rejects missing acceptance criteria", () => {
		const g = doc([objective("a", [], { acceptanceCriteria: [] })]);
		const v = validateMissionGraph(g);
		expect(v.valid).toBe(false);
	});

	it("rejects undeclared repositories", () => {
		const g = doc([objective("a", [], { declaredRepositories: ["repo:UNDECLARED"] })], scope(["repo:A"]));
		const v = validateMissionGraph(g);
		expect(v.valid).toBe(false);
		expect(v.undeclaredRepositories.some((k) => k.includes("repo:UNDECLARED"))).toBe(true);
	});

	it("rejects self-approval", () => {
		const g = doc([
			objective("a", [], {
				requiresApproval: true,
				approvalGate: { id: "gate-a", requiredPrincipals: ["a"], scope: "objective" },
			}),
		]);
		const v = validateMissionGraph(g);
		expect(v.noSelfApproval).toBe(false);
	});

	it("passes a valid multi-objective graph", () => {
		const g = doc([objective("a"), objective("b", ["a"]), objective("c", ["b"])]);
		const v = validateMissionGraph(g);
		expect(v.valid).toBe(true);
	});

	it("computes a deterministic topological order", () => {
		const g = doc([objective("b", ["a"]), objective("c", ["b"]), objective("a")]);
		expect(topologicallyOrdered(g)).toEqual(["a", "b", "c"]);
	});

	it("computes the critical path as the longest dependency chain", () => {
		const heavy = objective("long", [], { estimate: 5, declaredRepositories: ["repo:A"] });
		const g = doc([
			objective("a", [], { estimate: 1 }),
			objective("b", ["a"], { estimate: 2 }),
			heavy,
			objective("c", ["b"], { estimate: 1 }),
		]);
		// chain a->b->c = 1+2+1=4; single long =5 → critical path is [long]
		const cp = computeCriticalPath(g);
		expect(cp.path).toEqual(["long"]);
		expect(cp.weight).toBe(5);
	});

	it("computes critical path across a chain", () => {
		const g = doc([
			objective("a", [], { estimate: 1 }),
			objective("b", ["a"], { estimate: 2 }),
			objective("c", ["b"], { estimate: 3 }),
			objective("d", [], { estimate: 2 }),
		]);
		const cp = computeCriticalPath(g);
		expect(cp.path).toEqual(["a", "b", "c"]);
		expect(cp.weight).toBe(6);
	});
});
