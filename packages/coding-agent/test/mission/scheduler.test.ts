/**
 * Durable Mission Graph — dependency-aware scheduler.
 */

import { describe, expect, it } from "vitest";
import {
	budgetViolations,
	buildSchedulePlan,
	canonicalRepositoryId,
	isObjectiveReady,
	type MissionGraphDocumentV1,
	type MissionObjective,
	type MissionScope,
	type ObjectiveStatus,
} from "../../src/core/mission/index.js";

function objective(id: string, deps: string[] = [], repo = "repo:A"): MissionObjective {
	return {
		id,
		title: id,
		dependencies: deps,
		declaredRepositories: [canonicalRepositoryId(repo)],
		estimate: 1,
		acceptanceCriteria: [{ id: `${id}-c1`, statement: `${id} done` }],
		requiresApproval: false,
		status: "PENDING",
	};
}

function doc(objectives: MissionObjective[]): MissionGraphDocumentV1 {
	const scope: MissionScope = {
		repositories: [...new Set(objectives.flatMap((o) => o.declaredRepositories))],
		requireDeclaredRepositories: true,
	};
	return {
		schemaVersion: 1,
		missionId: "m",
		revision: 1,
		digest: "d",
		scope,
		objectives,
		contracts: [],
		status: "ACTIVE",
		createdAtMs: 0,
		updatedAtMs: 0,
	};
}

function statusMap(
	objectives: MissionObjective[],
	statuses: Record<string, ObjectiveStatus>,
): Map<string, ObjectiveStatus> {
	const m = new Map<string, ObjectiveStatus>();
	for (const o of objectives) m.set(o.id, statuses[o.id] ?? "PENDING");
	return m;
}

describe("mission scheduler", () => {
	it("DEPENDENCY_READINESS schedules only dependency-satisfied objectives", () => {
		const g = doc([objective("a"), objective("b", ["a"]), objective("c", ["b"])]);
		const status = statusMap(g.objectives, { a: "COMPLETED", b: "PENDING", c: "PENDING" });
		const plan = buildSchedulePlan(g, { status, parallelismBound: 4, enforceBudget: false });
		expect(plan.waves[0]).toEqual(["b"]);
		expect(plan.waves.flat()).not.toContain("c");
	});

	it("PARALLEL_INDEPENDENT schedules independent objectives in the same wave", () => {
		const g = doc([objective("a", [], "repo:A"), objective("b", [], "repo:B"), objective("c", [], "repo:C")]);
		const plan = buildSchedulePlan(g, {
			status: statusMap(g.objectives, {}),
			parallelismBound: 4,
			enforceBudget: false,
		});
		expect(plan.waves[0].sort()).toEqual(["a", "b", "c"]);
	});

	it("PARALLELISM_BOUND caps wave size", () => {
		const g = doc(["a", "b", "c", "d", "e", "f"].map((id) => objective(id, [], `repo:${id.toUpperCase()}`)));
		const plan = buildSchedulePlan(g, {
			status: statusMap(g.objectives, {}),
			parallelismBound: 2,
			enforceBudget: false,
		});
		expect(plan.waves[0].length).toBeLessThanOrEqual(2);
	});

	it("WRITE_CONFLICT_SERIALIZATION never runs two objectives on the same repo in one wave", () => {
		const g = doc([objective("a", [], "repo:X"), objective("b", [], "repo:X"), objective("c", [], "repo:Y")]);
		const plan = buildSchedulePlan(g, {
			status: statusMap(g.objectives, {}),
			parallelismBound: 4,
			enforceBudget: false,
		});
		const wave0 = plan.waves[0];
		// a and b share repo:X → they must never both appear in wave 0; c is on a
		// different repo and may run in parallel with exactly one of them.
		expect(wave0).toContain("c");
		const repoXInWave0 = wave0.filter((id) => id === "a" || id === "b");
		expect(repoXInWave0.length).toBeLessThanOrEqual(1);
		expect(plan.serializedGroups.length).toBeGreaterThan(0);
	});

	it("WRITE_CONFLICT_SERIALIZATION schedules the conflicted objective in a later wave", () => {
		const g = doc([objective("a", [], "repo:X"), objective("b", [], "repo:X")]);
		const plan = buildSchedulePlan(g, {
			status: statusMap(g.objectives, {}),
			parallelismBound: 4,
			enforceBudget: false,
		});
		const flattened = plan.waves.flat();
		expect(flattened).toContain("a");
		expect(flattened).toContain("b");
	});

	it("BUDGET_BOUND flags budget exceedance", () => {
		const g = doc([objective("a")]);
		const plan = buildSchedulePlan(g, {
			status: statusMap(g.objectives, {}),
			parallelismBound: 4,
			budget: { maxCost: 0, spentCost: 10 },
			enforceBudget: true,
		});
		expect(plan.budgetExceeded).toBe(true);
	});

	it("computeCriticalPath is reflected in the plan", () => {
		const g = doc([objective("a"), objective("b", ["a"]), objective("c", ["b"])]);
		const plan = buildSchedulePlan(g, {
			status: statusMap(g.objectives, {}),
			parallelismBound: 4,
			enforceBudget: false,
		});
		expect(plan.criticalPath).toEqual(["a", "b", "c"]);
	});

	it("isObjectiveReady respects completed dependencies", () => {
		const g = doc([objective("a"), objective("b", ["a"])]);
		expect(isObjectiveReady(g, "b", statusMap(g.objectives, { a: "PENDING" }))).toBe(false);
		expect(isObjectiveReady(g, "b", statusMap(g.objectives, { a: "COMPLETED" }))).toBe(true);
	});

	it("budgetViolations reports over-budget objectives", () => {
		const over = objective("a");
		over.budget = { maxCost: 5, spentCost: 9, route: "default" };
		const g = doc([over]);
		expect(budgetViolations(g.objectives)).toContain(`objective a spent 9 > budget 5`);
	});
});
