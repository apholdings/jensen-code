/**
 * TEST F — parent/child mission relationship.
 */

import { describe, expect, it } from "vitest";
import {
	createMissionRequest,
	MissionExecutionService,
	type MissionExecutor,
	type MissionHandle,
	type MissionRequest,
	type MissionResult,
} from "../../src/core/mission-domain/index.js";

class EchoExecutor implements MissionExecutor {
	readonly executorId = "echo";
	readonly launched: MissionRequest[] = [];

	async launch(request: MissionRequest): Promise<MissionHandle> {
		this.launched.push(request);
		return {
			missionId: request.missionId,
			parentMissionId: request.parentMissionId,
			depth: request.depth,
			executionId: `exec:${request.missionId}`,
			state: "RUNNING",
			createdAtMs: request.createdAtMs,
			startedAtMs: Date.now(),
			cancel: async () => undefined,
		};
	}

	async awaitResult(handle: MissionHandle): Promise<MissionResult> {
		return {
			missionId: handle.missionId,
			parentMissionId: handle.parentMissionId,
			depth: handle.depth,
			state: "SUCCEEDED",
			executionOutcome: "COMPLETED",
			success: true,
			evidenceRefs: [],
			verification: { status: "verified" },
			completionDecision: "accepted",
			failures: [],
			executorDiagnostics: { executorId: this.executorId },
			startedAtMs: handle.startedAtMs ?? 0,
			finishedAtMs: Date.now(),
		};
	}

	async cancel(): Promise<void> {}
}

describe("parent/child mission relationship", () => {
	it("F1 child.parentMissionId equals parent.missionId", async () => {
		const parent = createMissionRequest({
			missionId: "mission_parent",
			objective: "parent",
			agent: "worker",
			executionMode: "execute",
			acceptanceCriteria: [],
		});
		const child = createMissionRequest({
			parent: { missionId: parent.missionId, depth: parent.depth },
			objective: "child",
			agent: "worker",
			executionMode: "execute",
			acceptanceCriteria: [],
		});
		expect(child.parentMissionId).toBe(parent.missionId);
	});

	it("F2 child result preserves the relationship", async () => {
		const executor = new EchoExecutor();
		const service = new MissionExecutionService();
		service.register(executor);
		service.setDefaultExecutorId("echo");

		const child = createMissionRequest({
			parent: { missionId: "mission_parent", depth: 0 },
			objective: "child",
			agent: "worker",
			executionMode: "execute",
			acceptanceCriteria: [],
		});
		const result = await service.execute(child);
		expect(result.missionId).toBe(child.missionId);
		expect(result.parentMissionId).toBe("mission_parent");
		expect(result.depth).toBe(1);
	});

	it("F3 grandchild identity and depth are structurally representable", () => {
		const root = createMissionRequest({
			missionId: "mission_root",
			objective: "root",
			agent: "worker",
			executionMode: "execute",
			acceptanceCriteria: [],
		});
		const child = createMissionRequest({
			parent: { missionId: root.missionId, depth: root.depth },
			objective: "child",
			agent: "worker",
			executionMode: "execute",
			acceptanceCriteria: [],
		});
		const grandchild = createMissionRequest({
			parent: { missionId: child.missionId, depth: child.depth },
			objective: "grandchild",
			agent: "scout",
			executionMode: "observe",
			acceptanceCriteria: [],
		});
		expect(grandchild.depth).toBe(2);
		expect(grandchild.parentMissionId).toBe(child.missionId);
		expect(grandchild.missionId).not.toBe(root.missionId);
		expect(grandchild.missionId).not.toBe(child.missionId);
	});

	it("F4 no PID-derived identity anywhere in the chain", () => {
		const root = createMissionRequest({
			missionId: "mission_root_pid",
			objective: "root",
			agent: "worker",
			executionMode: "execute",
			acceptanceCriteria: [],
		});
		const child = createMissionRequest({
			parent: { missionId: root.missionId, depth: root.depth },
			objective: "child",
			agent: "worker",
			executionMode: "execute",
			acceptanceCriteria: [],
		});
		for (const request of [root, child]) {
			expect(request.missionId).not.toContain(String(process.pid));
			expect(request.parentMissionId ?? "").not.toContain(String(process.pid));
		}
	});
});
