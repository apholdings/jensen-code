import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_GOVERNANCE_POLICY, FileGovernanceStore, GovernanceService } from "../../src/core/governance/index.js";
import { createMissionRequest } from "../../src/core/mission-domain/mission-request.js";
import { createFileDurableMissionStore } from "../../src/core/mission-durable/index.js";
import { createFileOrchestrationStore, OrchestratorService } from "../../src/core/orchestration/index.js";
import type { OrchestrationNode } from "../../src/core/orchestration/types.js";

const roots: string[] = [];
const node = (nodeId: string): OrchestrationNode => ({
	nodeId,
	role: "research",
	nodeKind: "CHILD",
	objective: nodeId,
	agent: "librarian",
	executionMode: "observe",
	requirement: "REQUIRED",
	workspaceAccess: "READ_ONLY",
	independenceReason: "independent_recon",
	acceptanceCriteria: [],
	dependencyCriticality: 0,
	status: "PROPOSED",
});
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("materializes children exactly once and records correlated fan-out/depth accounting", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "jensen-orch-governance-"));
	roots.push(root);
	const missions = createFileDurableMissionStore(path.join(root, "missions"));
	await missions.create({
		schemaVersion: 1,
		missionId: "mission_parent",
		depth: 0,
		request: createMissionRequest({
			missionId: "mission_parent",
			objective: "parent",
			agent: "worker",
			executionMode: "execute",
			acceptanceCriteria: [],
		}),
		state: "CREATED",
		createdAtMs: 1,
		updatedAtMs: 1,
		transitions: [],
		attempts: [],
		fencingToken: 0,
		revision: 1,
	});
	const governance = new GovernanceService({
		store: new FileGovernanceStore({ root: path.join(root, "governance") }),
		policy: { ...DEFAULT_GOVERNANCE_POLICY, operator: { maxChildren: 1 } },
	});
	const orchestrator = new OrchestratorService({
		store: createFileOrchestrationStore(path.join(root, "orchestrations")),
		missions,
		governance,
		sessionDir: path.join(root, "sessions"),
		orchestrationIdFactory: () => "orch_governed",
	});
	const plan = await orchestrator.create({
		parentMissionId: "mission_parent",
		proposal: { decision: "FANOUT", rationale: "test", nodes: [node("a"), node("b")], edges: [] },
	});
	const result = await orchestrator.materializeReady(plan.orchestrationId);
	expect(result.materializedMissionIds).toHaveLength(1);
	const ledger = await governance.store.load("mission_parent");
	expect(ledger.status).toBe("ok");
	if (ledger.status !== "ok") return;
	expect(ledger.ledger.usage.children).toBe(1);
	expect(ledger.ledger.events.map((event) => event.correlation?.nodeId)).toContain("a");
	expect(ledger.ledger.events.map((event) => event.correlation?.orchestrationId)).toContain("orch_governed");
	const second = await orchestrator.materializeReady(plan.orchestrationId);
	expect(second.materializedMissionIds).toHaveLength(0);
});

describe("planner repair and orchestration replan events", () => {
	it("records separate durable retry classes with structured correlation", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "jensen-planner-governance-"));
		roots.push(root);
		const governance = new GovernanceService({
			store: new FileGovernanceStore({ root }),
			policy: DEFAULT_GOVERNANCE_POLICY,
		});
		await governance.ensureMission("mission_parent");
		await governance.recordRetry("mission_parent", "planner-repair", "planner", 1, {
			orchestrationId: "orch",
			phase: "planner_repair",
		});
		await governance.recordRetry("mission_parent", "orchestration-replan", "replan", 2, {
			orchestrationId: "orch",
			phase: "orchestration_replan",
		});
		const ledger = await governance.store.load("mission_parent");
		expect(ledger.status).toBe("ok");
		if (ledger.status !== "ok") return;
		expect(ledger.ledger.retries).toMatchObject({ planner: 1, replan: 1 });
		expect(ledger.ledger.events.map((event) => event.correlation?.phase)).toEqual([
			"planner_repair",
			"orchestration_replan",
		]);
	});
});
