/**
 * Unity MCP Vertical Slice — scheduler designation proof tests (2.13.0).
 *
 * Proves Mission → Scheduling Intent → Scheduler → blackpearl-unity-lotg
 * executor → Durable Assignment, and STOPS there. No assignment acceptance or
 * execution; the Worker daemon is out of scope.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runUnitySchedulerProof } from "../../src/core/unity-mcp/unity-scheduler-proof.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
	const root = mkdtempSync(path.join(tmpdir(), "unity-scheduler-proof-"));
	roots.push(root);
	return root;
}

describe("Unity scheduler designation proof", () => {
	it("designates blackpearl-unity-lotg and produces a durable assignment", async () => {
		const result = await runUnitySchedulerProof({ root: makeRoot(), missionId: "mission_unity_proof" });

		expect(result.missionId).toBe("mission_unity_proof");
		expect(result.intentId).toBe("intent_mission_unity_proof");
		expect(result.executorId).toBe("blackpearl-unity-lotg");
		expect(result.decision).toBe("ASSIGN");
		expect(result.assignmentId).toBeTruthy();
		expect(result.reason).toBeUndefined();
	});

	it("is deterministic across independent store roots", async () => {
		const first = await runUnitySchedulerProof({ root: makeRoot(), missionId: "mission_unity_proof" });
		const second = await runUnitySchedulerProof({ root: makeRoot(), missionId: "mission_unity_proof" });

		expect(first.decision).toBe(second.decision);
		expect(first.executorId).toBe(second.executorId);
		expect(first.intentId).toBe(second.intentId);
	});
});
