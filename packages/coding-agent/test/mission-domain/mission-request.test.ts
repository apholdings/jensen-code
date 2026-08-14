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
