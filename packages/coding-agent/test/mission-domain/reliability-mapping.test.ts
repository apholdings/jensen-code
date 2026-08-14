/**
 * TEST H — reliability compatibility.
 *
 * A MissionRequest maps to the real Reliability Kernel MissionRuntime without
 * introducing a duplicate completion architecture.
 */

import { describe, expect, it } from "vitest";
import {
	createMissionRequest,
	createMissionRuntimeFromRequest,
	toMissionRuntimeDefinition,
} from "../../src/core/mission-domain/index.js";

describe("MissionRequest → MissionRuntime mapping", () => {
	it("H1 maps objective and criteria 1:1 into the real contract", () => {
		const request = createMissionRequest({
			missionId: "mission_h1",
			objective: "create a.txt",
			agent: "worker",
			executionMode: "execute",
			acceptanceCriteria: [
				{ id: "AC-1", description: "a.txt exists", verification: { kind: "file_exists", path: "a.txt" } },
			],
		});

		const definition = toMissionRuntimeDefinition(request);
		expect(definition.missionId).toBe("mission_h1");
		expect(definition.goal).toBe("create a.txt");
		expect(definition.criteria).toHaveLength(1);
		expect(definition.criteria[0].id).toBe("AC-1");
	});

	it("H2 a request with an unverifiable criterion is rejected, never fabricated", () => {
		const request = createMissionRequest({
			missionId: "mission_h2",
			objective: "describe something",
			agent: "scout",
			executionMode: "observe",
			acceptanceCriteria: [{ id: "AC-1", description: "descriptive only" }],
		});
		expect(() => toMissionRuntimeDefinition(request)).toThrow(/no deterministic verification/u);
	});

	it("H3 MissionRuntime is the single completion authority", () => {
		const request = createMissionRequest({
			missionId: "mission_h3",
			objective: "create a.txt",
			agent: "worker",
			executionMode: "execute",
			acceptanceCriteria: [
				{ id: "AC-1", description: "a.txt exists", verification: { kind: "file_exists", path: "a.txt" } },
			],
		});
		const runtime = createMissionRuntimeFromRequest(request);
		expect(runtime.missionId).toBe("mission_h3");
		expect(runtime.goal).toBe("create a.txt");

		// Unverified completion is rejected by the Completion Gate.
		expect(runtime.proposeFinalCandidate().decision).toBe("reject");

		// Authoritative evidence advances the criterion and the gate accepts.
		runtime.recordVerification("AC-1", {
			passed: true,
			kind: "file_exists",
			evidence: {
				id: "ev-1",
				type: "file_state",
				source: "runtime:repository-observation",
				summary: "a.txt exists",
				timestamp: new Date().toISOString(),
			},
		});
		expect(runtime.criterionView()[0].status).toBe("passed");
		expect(runtime.proposeFinalCandidate().decision).toBe("accept");
		// Advance the execution state machine to the completion-review boundary,
		// exactly as the live session does before approving completion.
		runtime.transition("START_EXECUTION");
		runtime.transition("REQUEST_VERIFICATION");
		runtime.transition("REQUEST_COMPLETION_REVIEW");
		expect(runtime.approveCompletion().ok).toBe(true);
		expect(runtime.phase).toBe("COMPLETED");
	});
});
