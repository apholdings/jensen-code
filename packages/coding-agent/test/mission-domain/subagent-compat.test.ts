/**
 * TEST I — existing subagent compatibility.
 * TEST J — legacy output generated FROM MissionResult (not inferred from prose).
 */

import { describe, expect, it } from "vitest";
import { createMissionResult, type MissionResult } from "../../src/core/mission-domain/index.js";
import { getCanonicalSubagentRegistry } from "../../src/core/subagent-registry.js";
import { createSubagentContextPacket, resolveSubagentInvocation } from "../../src/core/subagent-runtime.js";

describe("subagent compatibility adapter", () => {
	it("I1 existing subagent resolution still works with mission identity", () => {
		const invocation = resolveSubagentInvocation({
			requestedAgent: "worker",
			parentRunId: "mission_root",
			childRunId: "mission_child",
		});
		expect(invocation.canonicalAgentName).toBe("worker");
		expect(invocation.parentRunId).toBe("mission_root");
		expect(invocation.childRunId).toBe("mission_child");
		expect(invocation.effectiveAllowedTools).toContain("write");
	});

	it("I2 context packet still serializes the resolved contract", () => {
		const invocation = resolveSubagentInvocation({
			requestedAgent: "scout",
			parentRunId: "mission_root",
			childRunId: "mission_child",
		});
		const packet = createSubagentContextPacket({
			invocation,
			objective: "find symbols",
			acceptanceCriteria: ["locate the symbol"],
		});
		expect(packet.objective).toBe("find symbols");
		expect(packet.childRunId).toBe("mission_child");
		expect(packet.parentRunId).toBe("mission_root");
	});

	it("I3 canonical registry still resolves built-in agents", () => {
		const result = getCanonicalSubagentRegistry().resolve("cavecrew-builder");
		expect("code" in result).toBe(false);
	});
});

/** Presentation is derived from structured MissionResult state, not prose. */
function presentMissionResult(result: MissionResult): string {
	switch (result.state) {
		case "SUCCEEDED":
			return `[succeeded] ${result.outputText ?? ""}`;
		case "PARTIAL":
			return `[partial/unverified] ${result.outputText ?? ""}`;
		case "CANCELLED":
			return "[cancelled]";
		case "TIMED_OUT":
			return "[timed_out]";
		case "CRASHED":
			return "[crashed]";
		default:
			return `[failed] ${result.outputText ?? ""}`;
	}
}

describe("legacy output generation", () => {
	it("J1 text is generated from MissionResult, never the reverse", () => {
		const failed = createMissionResult({
			missionId: "m",
			depth: 0,
			state: "FAILED",
			executionOutcome: "FAILED",
			outputText: "All tests passed (model prose)",
			executorDiagnostics: { executorId: "test", processExitCode: 1 },
			startedAtMs: 0,
			finishedAtMs: 1,
		});
		// Even though outputText looks positive, the state is authoritative.
		expect(failed.success).toBe(false);
		expect(presentMissionResult(failed)).toContain("[failed]");

		const succeeded = createMissionResult({
			missionId: "m",
			depth: 0,
			state: "SUCCEEDED",
			executionOutcome: "COMPLETED",
			outputText: "done",
			executorDiagnostics: { executorId: "test", processExitCode: 0 },
			startedAtMs: 0,
			finishedAtMs: 1,
		});
		expect(presentMissionResult(succeeded)).toContain("[succeeded]");
	});
});
