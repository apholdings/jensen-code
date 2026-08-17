import { describe, expect, it } from "vitest";
import { validateOrchestrationPlan } from "../../src/core/orchestration/index.js";
import type { OrchestrationNode, OrchestrationPlan } from "../../src/core/orchestration/types.js";

function node(id: string): OrchestrationNode {
	return {
		nodeId: id,
		role: "research",
		nodeKind: "CHILD",
		objective: `Inspect ${id}`,
		agent: "librarian",
		executionMode: "observe",
		requirement: "REQUIRED",
		workspaceAccess: "READ_ONLY",
		independenceReason: "independent_recon",
		acceptanceCriteria: [],
		dependencyCriticality: 0,
		status: "PROPOSED",
	};
}
function plan(count: number): OrchestrationPlan {
	return {
		schemaVersion: 1,
		orchestrationId: `bench_${count}`,
		parentMissionId: "mission_parent",
		decision: count === 1 ? "DIRECT" : "FANOUT",
		rationale: "controlled fan-out benchmark",
		nodes: count === 1 ? [] : Array.from({ length: count }, (_, index) => node(`node_${index}`)),
		edges: [],
		revision: 1,
		state: "DRAFT",
		maxDepth: 2,
		maxChildrenPerNode: 20,
		maxTotalLogicalAgents: 20,
		maxReplans: 2,
		replanCount: 0,
		createdAtMs: 1,
		updatedAtMs: 1,
	};
}
describe("orchestration fan-out benchmark harness", () => {
	it.each([1, 2, 4, 8, 12])("validates controlled profile %s without coupling to inference capacity", (count) => {
		const started = performance.now();
		const result = validateOrchestrationPlan(plan(count));
		const elapsedMs = performance.now() - started;
		expect(result.valid).toBe(count <= 12);
		expect(count).toBeGreaterThanOrEqual(1);
		expect(elapsedMs).toBeGreaterThanOrEqual(0);
	});
});
