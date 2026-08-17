import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMissionRequest } from "../../src/core/mission-domain/mission-request.js";
import { createFileDurableMissionStore } from "../../src/core/mission-durable/index.js";
import {
	createFileOrchestrationStore,
	OrchestratorService,
	validateOrchestrationPlan,
} from "../../src/core/orchestration/index.js";
import type { OrchestrationNode, OrchestrationPlan } from "../../src/core/orchestration/types.js";

const roots: string[] = [];
function root(): string {
	const value = mkdtempSync(path.join(tmpdir(), "jensen-orch-test-"));
	roots.push(value);
	return value;
}
afterEach(() => {
	for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

function node(overrides: Partial<OrchestrationNode> = {}): OrchestrationNode {
	return {
		nodeId: overrides.nodeId ?? "recon",
		role: overrides.role ?? "research",
		nodeKind: overrides.nodeKind ?? "CHILD",
		objective: overrides.objective ?? "Inspect the source",
		agent: overrides.agent ?? "librarian",
		executionMode: overrides.executionMode ?? "observe",
		requirement: overrides.requirement ?? "REQUIRED",
		workspaceAccess: overrides.workspaceAccess ?? "READ_ONLY",
		independenceReason: overrides.independenceReason ?? "independent_recon",
		acceptanceCriteria: [],
		dependencyCriticality: 0,
		status: overrides.status ?? "PROPOSED",
		...overrides,
	};
}

function plan(overrides: Partial<OrchestrationPlan> = {}): OrchestrationPlan {
	return {
		schemaVersion: 1,
		orchestrationId: "orch_test",
		parentMissionId: "mission_parent",
		decision: "FANOUT",
		rationale: "independent concerns",
		nodes: [node()],
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
		...overrides,
	};
}

async function parentFixture(base: string) {
	const missions = createFileDurableMissionStore(path.join(base, "missions"));
	const parent = createMissionRequest({
		missionId: "mission_parent",
		objective: "Parent objective",
		agent: "worker",
		executionMode: "execute",
		acceptanceCriteria: [],
		workspaceScope: { cwd: base },
		childSessionId: "parent_session",
	});
	await missions.create({
		schemaVersion: 1,
		missionId: parent.missionId,
		parentMissionId: undefined,
		depth: 0,
		request: parent,
		state: "CREATED",
		createdAtMs: 1,
		updatedAtMs: 1,
		transitions: [],
		attempts: [],
		fencingToken: 0,
		revision: 1,
	});
	return missions;
}

describe("orchestration plan validation", () => {
	it("keeps a trivial direct plan child-free", () => {
		const result = validateOrchestrationPlan(plan({ decision: "DIRECT", nodes: [] }));
		expect(result.valid).toBe(true);
	});
	it("rejects cycles, missing dependencies, duplicate work, and unsafe writers", () => {
		const result = validateOrchestrationPlan(
			plan({
				nodes: [
					node(),
					node({ nodeId: "duplicate", workspaceAccess: "WRITE", workspaceKey: "repo" }),
					node({ nodeId: "writer", workspaceAccess: "WRITE", workspaceKey: "repo" }),
				],
				edges: [
					{ from: "recon", to: "missing", kind: "REQUIRED" },
					{ from: "writer", to: "duplicate", kind: "REQUIRED" },
					{ from: "duplicate", to: "writer", kind: "REQUIRED" },
				],
			}),
		);
		expect(result.valid).toBe(false);
		expect(result.issues.map((issue) => issue.code)).toEqual(
			expect.arrayContaining([
				"ORCHESTRATION_CYCLE",
				"ORCHESTRATION_MISSING_DEPENDENCY",
				"ORCHESTRATION_DUPLICATE_WORK",
			]),
		);
	});
	it("accepts explicitly independent review duplication", () => {
		const result = validateOrchestrationPlan(
			plan({
				nodes: [node(), node({ nodeId: "review", nodeKind: "REVIEW", independenceReason: "independent_review" })],
			}),
		);
		expect(result.valid).toBe(true);
	});
});

describe("durable orchestrator materialization", () => {
	it("materializes child missions idempotently and keeps blocked dependencies blocked", async () => {
		const base = root();
		const missions = await parentFixture(base);
		const store = createFileOrchestrationStore(path.join(base, "orchestrations"));
		const orchestrator = new OrchestratorService({
			store,
			missions,
			sessionDir: path.join(base, "sessions"),
			orchestrationIdFactory: () => "orch_test",
		});
		const created = await orchestrator.create({
			parentMissionId: "mission_parent",
			proposal: {
				decision: "FANOUT",
				rationale: "parallel recon",
				nodes: [
					node({ nodeId: "a" }),
					node({ nodeId: "b", objective: "Inspect tests" }),
					node({
						nodeId: "synthesis",
						nodeKind: "SYNTHESIS",
						role: "planning",
						agent: "planner",
						executionMode: "plan",
						independenceReason: "synthesis_required",
						status: "PROPOSED",
					}),
				],
				edges: [
					{ from: "a", to: "synthesis", kind: "REQUIRED" },
					{ from: "b", to: "synthesis", kind: "REQUIRED" },
				],
			},
		});
		const first = await orchestrator.materializeReady(created.orchestrationId);
		expect(first.materializedMissionIds).toHaveLength(2);
		const second = await orchestrator.materializeReady(created.orchestrationId);
		expect(second.materializedMissionIds).toHaveLength(0);
		const status = await orchestrator.status(created.orchestrationId);
		expect(status.childrenMaterialized).toBe(2);
		expect(status.childrenBlocked).toBe(1);
		expect(status.childrenMaterialized).toBe(status.localChildren + status.remoteChildren);
		const children = await missions.listChildren("mission_parent");
		expect(children).toHaveLength(2);
	});
	it("preview creates no durable children", async () => {
		const base = root();
		const missions = await parentFixture(base);
		const store = createFileOrchestrationStore(path.join(base, "orchestrations"));
		const orchestrator = new OrchestratorService({
			store,
			missions,
			sessionDir: path.join(base, "sessions"),
			orchestrationIdFactory: () => "orch_preview",
		});
		const preview = await orchestrator.preview({
			parentMissionId: "mission_parent",
			proposal: { decision: "FANOUT", rationale: "recon", nodes: [node()], edges: [] },
		});
		expect(preview.validation.valid).toBe(true);
		expect(await missions.listChildren("mission_parent")).toHaveLength(0);
	});
	it("joins required and optional child outcomes honestly", async () => {
		const base = root();
		const missions = await parentFixture(base);
		const store = createFileOrchestrationStore(path.join(base, "orchestrations"));
		const orchestrator = new OrchestratorService({
			store,
			missions,
			sessionDir: path.join(base, "sessions"),
			orchestrationIdFactory: () => "orch_join",
		});
		const created = await orchestrator.create({
			parentMissionId: "mission_parent",
			proposal: {
				decision: "FANOUT",
				rationale: "recon",
				nodes: [
					node({ nodeId: "required" }),
					node({ nodeId: "optional", requirement: "OPTIONAL", objective: "Optional check" }),
				],
				edges: [],
			},
		});
		await orchestrator.materializeReady(created.orchestrationId);
		const joined = await orchestrator.join(created.orchestrationId);
		expect(joined.terminal).toBe(false);
		expect(joined.pendingNodeIds).toHaveLength(2);
	});
});
