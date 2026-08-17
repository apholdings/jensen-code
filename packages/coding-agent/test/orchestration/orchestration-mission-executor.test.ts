import { describe, expect, it } from "vitest";
import type { DurableMissionStore } from "../../src/core/mission-domain/durable-store.js";
import { createMissionRequest } from "../../src/core/mission-domain/mission-request.js";
import type { OrchestrationLifecycleExecutor } from "../../src/core/orchestration/lifecycle-executor.js";
import { createOrchestrationMissionExecutor } from "../../src/core/orchestration/orchestration-mission-executor.js";
import type { OrchestratorService } from "../../src/core/orchestration/orchestrator.js";
import type {
	OrchestrationChildExecutionStatus,
	OrchestrationPlan,
	OrchestrationStore,
} from "../../src/core/orchestration/types.js";

function plan(requirement: "REQUIRED" | "OPTIONAL" = "REQUIRED"): OrchestrationPlan {
	return {
		schemaVersion: 1,
		orchestrationId: "orch_parent",
		parentMissionId: "mission_parent",
		decision: "FANOUT",
		rationale: "test",
		nodes: [
			{
				nodeId: "required",
				role: "tester",
				nodeKind: "CHILD",
				objective: "required",
				agent: "worker",
				executionMode: "execute",
				requirement,
				workspaceAccess: "READ_ONLY",
				acceptanceCriteria: [],
				dependencyCriticality: 0,
				status: "MATERIALIZED",
				childMissionId: "mission_child",
				childSessionId: "child_session",
			},
		],
		edges: [],
		revision: 1,
		state: "ACTIVE",
		maxDepth: 2,
		maxChildrenPerNode: 4,
		maxTotalLogicalAgents: 4,
		maxReplans: 1,
		replanCount: 0,
		createdAtMs: 1,
		updatedAtMs: 1,
	};
}

function status(overrides: Partial<OrchestrationChildExecutionStatus> = {}): OrchestrationChildExecutionStatus {
	return {
		orchestrationId: "orch_parent",
		nodeId: "required",
		childMissionId: "mission_child",
		childSessionId: "child_session",
		missionState: "SUCCEEDED",
		terminal: true,
		success: true,
		verificationStatus: "verified",
		completionDecision: "accepted",
		workers: [],
		...overrides,
	};
}

function harness(childStatus: OrchestrationChildExecutionStatus, requirement: "REQUIRED" | "OPTIONAL" = "REQUIRED") {
	const parent = createMissionRequest({
		missionId: "mission_parent",
		objective: "parent",
		agent: "worker",
		executionMode: "execute",
		acceptanceCriteria: [],
		orchestrationExecution: { orchestrationId: "orch_parent", childExecutionAuthority: "authority" },
		now: 1,
	});
	const missions = {
		load: async () => ({ status: "ok", record: { request: parent } as never }),
	} as unknown as DurableMissionStore;
	const store = {
		load: async () => ({ status: "ok", document: { schemaVersion: 1, plan: plan(requirement), revisions: [] } }),
	} as unknown as OrchestrationStore;
	const lifecycle = {
		launchChildren: async () => ({}) as never,
		childStatus: async () => childStatus,
	} as unknown as OrchestrationLifecycleExecutor;
	const orchestrator = {
		reconcile: async () => ({}) as never,
		cancel: async () => ({}),
	} as unknown as OrchestratorService;
	const executor = createOrchestrationMissionExecutor({
		missions,
		store,
		lifecycle,
		orchestrator,
		pollMs: 1,
		maxWallTimeMs: 20,
	});
	return { executor, parent };
}

describe("OrchestrationMissionExecutor", () => {
	it("maps verified required child success to parent success", async () => {
		const { executor, parent } = harness(status());
		const handle = await executor.launch(parent);
		const result = await executor.awaitResult(handle);
		expect(result.state).toBe("SUCCEEDED");
		expect(result.completionDecision).toBe("accepted");
		expect((executor as unknown as { _active: Map<string, unknown> })._active.has(parent.missionId)).toBe(false);
	});

	it("rejects a required child failure without fabricating recovery", async () => {
		const { executor, parent } = harness(
			status({
				missionState: "FAILED",
				terminal: true,
				success: false,
				verificationStatus: "failed",
				completionDecision: "rejected",
			}),
		);
		const handle = await executor.launch(parent);
		const result = await executor.awaitResult(handle);
		expect(result.state).toBe("FAILED");
		expect(result.success).toBe(false);
	});

	it("preserves a terminal required PARTIAL child as parent PARTIAL", async () => {
		const { executor, parent } = harness(
			status({
				missionState: "PARTIAL",
				terminal: true,
				success: false,
				verificationStatus: "unverified",
				completionDecision: "unavailable",
			}),
		);
		const handle = await executor.launch(parent);
		const result = await executor.awaitResult(handle);
		expect(result.state).toBe("PARTIAL");
		expect(result.executionOutcome).toBe("COMPLETED");
		expect(result.completionDecision).toBe("rejected");
	});

	it("completes when all optional children reach terminal state", async () => {
		const { executor, parent } = harness(
			status({
				missionState: "FAILED",
				terminal: true,
				success: false,
				verificationStatus: "failed",
				completionDecision: "rejected",
			}),
			"OPTIONAL",
		);
		const handle = await executor.launch(parent);
		const result = await executor.awaitResult(handle);
		expect(result.state).toBe("PARTIAL");
	});

	it("times out when a required child never reaches terminal state", async () => {
		const { executor, parent } = harness(
			status({
				missionState: "RUNNING",
				terminal: false,
				success: false,
				verificationStatus: "unverified",
				completionDecision: "unavailable",
			}),
		);
		const handle = await executor.launch(parent);
		const result = await executor.awaitResult(handle);
		expect(result.state).toBe("TIMED_OUT");
	});
});
