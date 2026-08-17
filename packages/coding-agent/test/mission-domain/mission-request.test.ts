/**
 * TEST A — MissionRequest contract.
 */

import { describe, expect, it } from "vitest";
import {
	createMissionRequest,
	type MissionRequest,
	newMissionId,
	validateMissionRequest,
} from "../../src/core/mission-domain/index.js";

describe("MissionRequest contract", () => {
	it("A1 root request has stable non-PID identity and depth 0", () => {
		const request = createMissionRequest({
			objective: "do work",
			agent: "worker",
			executionMode: "execute",
			acceptanceCriteria: [],
		});
		expect(request.missionId).toMatch(/^mission_[0-9a-f-]{36}$/u);
		expect(request.missionId).not.toContain(String(process.pid));
		expect(request.parentMissionId).toBeUndefined();
		expect(request.depth).toBe(0);
	});

	it("A2 child request has explicit parent identity and derived depth", () => {
		const parent = { missionId: "mission_root", depth: 0 };
		const child = createMissionRequest({
			parent,
			objective: "child work",
			agent: "worker",
			executionMode: "plan",
			acceptanceCriteria: [],
		});
		expect(child.parentMissionId).toBe("mission_root");
		expect(child.depth).toBe(1);

		const grandchild = createMissionRequest({
			parent: { missionId: child.missionId, depth: child.depth },
			objective: "grandchild",
			agent: "scout",
			executionMode: "observe",
			acceptanceCriteria: [],
		});
		expect(grandchild.parentMissionId).toBe(child.missionId);
		expect(grandchild.depth).toBe(2);
	});

	it("A3 idempotency key is independent of mission identity", () => {
		const a = createMissionRequest({
			idempotencyKey: "dedup-1",
			objective: "x",
			agent: "worker",
			executionMode: "execute",
			acceptanceCriteria: [],
		});
		const b = createMissionRequest({
			idempotencyKey: "dedup-1",
			objective: "x",
			agent: "worker",
			executionMode: "execute",
			acceptanceCriteria: [],
		});
		expect(a.idempotencyKey).toBe("dedup-1");
		expect(a.missionId).not.toBe(b.missionId);
	});

	it("A4 malformed requests are rejected", () => {
		const base: MissionRequest = createMissionRequest({
			objective: "x",
			agent: "worker",
			executionMode: "execute",
			acceptanceCriteria: [],
		});

		const missingId = validateMissionRequest({ ...base, missionId: "" });
		expect(missingId.valid).toBe(false);
		if (!missingId.valid) expect(missingId.errors).toContain("MISSING_MISSION_ID");

		const parentWithoutDepth = validateMissionRequest({
			...base,
			missionId: newMissionId(),
			parentMissionId: "parent-1",
			depth: 0,
		});
		expect(parentWithoutDepth.valid).toBe(false);
		if (!parentWithoutDepth.valid) expect(parentWithoutDepth.errors).toContain("PARENT_WITHOUT_DEPTH");

		const rootDepthMismatch = validateMissionRequest({
			...base,
			missionId: newMissionId(),
			depth: 3,
		});
		expect(rootDepthMismatch.valid).toBe(false);
		if (!rootDepthMismatch.valid) expect(rootDepthMismatch.errors).toContain("ROOT_DEPTH_MISMATCH");
	});

	it("A5 duplicate criterion ids are rejected", () => {
		const request = createMissionRequest({
			objective: "x",
			agent: "worker",
			executionMode: "execute",
			acceptanceCriteria: [
				{ id: "AC-1", description: "a" },
				{ id: "AC-1", description: "b" },
			],
		});
		const result = validateMissionRequest(request);
		expect(result.valid).toBe(false);
		if (!result.valid) expect(result.errors).toContain("DUPLICATE_CRITERION_ID");
	});
});

/**
 * MissionRequest.orchestrationExecution — typed parent orchestration
 * execution contract (presence, cloning, validation).
 */

describe("MissionRequest.orchestrationExecution contract", () => {
	it("E1 a parent request carries the typed orchestration execution contract", () => {
		const request = createMissionRequest({
			objective: "drive the orchestration",
			agent: "worker",
			executionMode: "execute",
			acceptanceCriteria: [],
			orchestrationExecution: {
				orchestrationId: "orch_parent_1",
				childExecutionAuthority: "scheduler_authority",
			},
		});
		expect(request.orchestrationExecution).toEqual({
			orchestrationId: "orch_parent_1",
			childExecutionAuthority: "scheduler_authority",
		});
		expect(validateMissionRequest(request).valid).toBe(true);
	});

	it("E2 absent by default and independent of child orchestration metadata", () => {
		const request = createMissionRequest({
			objective: "child work",
			agent: "worker",
			executionMode: "plan",
			acceptanceCriteria: [],
			parent: { missionId: "mission_parent", depth: 0 },
			orchestration: {
				orchestrationId: "orch_parent_1",
				planRevision: 1,
				nodeId: "n1",
				role: "recon",
				nodeKind: "CHILD",
				requirement: "REQUIRED",
				workspaceAccess: "READ_ONLY",
			},
		});
		expect(request.orchestration).toBeDefined();
		expect(request.orchestrationExecution).toBeUndefined();
		expect(validateMissionRequest(request).valid).toBe(true);
	});

	it("E3 cloning freezes the contract and isolates it from the input object", () => {
		const input = { orchestrationId: "orch_clone", childExecutionAuthority: "auth_1" };
		const request = createMissionRequest({
			objective: "x",
			agent: "worker",
			executionMode: "execute",
			acceptanceCriteria: [],
			orchestrationExecution: input,
		});
		expect(Object.isFrozen(request.orchestrationExecution)).toBe(true);
		input.orchestrationId = "orch_tampered";
		input.childExecutionAuthority = "auth_2";
		expect(request.orchestrationExecution?.orchestrationId).toBe("orch_clone");
		expect(request.orchestrationExecution?.childExecutionAuthority).toBe("auth_1");
	});

	it("E4 malformed execution contracts are rejected with INVALID_ORCHESTRATION_EXECUTION", () => {
		const base: MissionRequest = createMissionRequest({
			objective: "x",
			agent: "worker",
			executionMode: "execute",
			acceptanceCriteria: [],
		});
		const cases: Array<{ label: string; value: unknown }> = [
			{ label: "missing orchestrationId", value: { childExecutionAuthority: "auth_1" } },
			{ label: "blank orchestrationId", value: { orchestrationId: "   ", childExecutionAuthority: "auth_1" } },
			{ label: "non-string orchestrationId", value: { orchestrationId: 7, childExecutionAuthority: "auth_1" } },
			{ label: "missing childExecutionAuthority", value: { orchestrationId: "orch_1" } },
			{
				label: "blank childExecutionAuthority",
				value: { orchestrationId: "orch_1", childExecutionAuthority: "  " },
			},
			{
				label: "non-string childExecutionAuthority",
				value: { orchestrationId: "orch_1", childExecutionAuthority: null },
			},
			{ label: "non-object contract", value: null },
		];
		for (const { label, value } of cases) {
			const result = validateMissionRequest({
				...base,
				orchestrationExecution: value as MissionRequest["orchestrationExecution"],
			});
			expect(result.valid, label).toBe(false);
			if (!result.valid) expect(result.errors, label).toContain("INVALID_ORCHESTRATION_EXECUTION");
		}
	});
});
