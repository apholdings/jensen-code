/**
 * TEST B — MissionState machine.
 *
 * Asserts legal and illegal transitions, terminal states, and that SUCCEEDED
 * cannot be produced from a raw process exit alone (via the pure classifier).
 */

import { describe, expect, it } from "vitest";
import {
	assertMissionTransition,
	canTransitionMissionState,
	classifyExecutorOutcome,
	isMissionSuccessState,
	isTerminalMissionState,
	MISSION_SUCCESS_STATES,
	MISSION_TERMINAL_STATES,
	type MissionState,
	MissionStateTracker,
} from "../../src/core/mission-domain/index.js";

const TERMINAL: MissionState[] = ["SUCCEEDED", "PARTIAL", "FAILED", "CANCELLED", "TIMED_OUT", "CRASHED"];

describe("MissionState machine", () => {
	it("B1 legal transitions are accepted", () => {
		expect(canTransitionMissionState("CREATED", "QUEUED")).toBe(true);
		expect(canTransitionMissionState("QUEUED", "RUNNING")).toBe(true);
		expect(canTransitionMissionState("RUNNING", "WAITING")).toBe(true);
		expect(canTransitionMissionState("RUNNING", "BLOCKED")).toBe(true);
		expect(canTransitionMissionState("RUNNING", "RETRYING")).toBe(true);
		expect(canTransitionMissionState("RUNNING", "SUCCEEDED")).toBe(true);
		expect(canTransitionMissionState("RUNNING", "PARTIAL")).toBe(true);
		expect(canTransitionMissionState("RUNNING", "FAILED")).toBe(true);
		expect(canTransitionMissionState("RUNNING", "CANCELLED")).toBe(true);
		expect(canTransitionMissionState("RUNNING", "TIMED_OUT")).toBe(true);
		expect(canTransitionMissionState("RUNNING", "CRASHED")).toBe(true);
		expect(canTransitionMissionState("WAITING", "RUNNING")).toBe(true);
		expect(canTransitionMissionState("BLOCKED", "RETRYING")).toBe(true);
	});

	it("B2 illegal transitions are rejected", () => {
		expect(canTransitionMissionState("CREATED", "RUNNING")).toBe(false);
		expect(canTransitionMissionState("CREATED", "SUCCEEDED")).toBe(false);
		expect(canTransitionMissionState("WAITING", "SUCCEEDED")).toBe(false);
		expect(canTransitionMissionState("BLOCKED", "SUCCEEDED")).toBe(false);
		expect(canTransitionMissionState("SUCCEEDED", "FAILED")).toBe(false);
		expect(assertMissionTransition("SUCCEEDED", "FAILED").ok).toBe(false);
		expect(assertMissionTransition("RUNNING", "RUNNING").ok).toBe(false);
	});

	it("B3 terminal states admit no outgoing transitions", () => {
		for (const state of TERMINAL) {
			expect(isTerminalMissionState(state)).toBe(true);
			expect(canTransitionMissionState(state, "FAILED")).toBe(false);
			expect(canTransitionMissionState(state, "SUCCEEDED")).toBe(false);
		}
	});

	it("B4 SUCCEEDED is the only clean success state", () => {
		expect(isMissionSuccessState("SUCCEEDED")).toBe(true);
		expect(MISSION_SUCCESS_STATES.has("PARTIAL")).toBe(false);
		for (const state of TERMINAL) {
			if (state === "SUCCEEDED") continue;
			expect(isMissionSuccessState(state)).toBe(false);
		}
	});

	it("B5 tracker enforces the canonical API", () => {
		const tracker = new MissionStateTracker("CREATED");
		expect(tracker.transition("QUEUED").ok).toBe(true);
		expect(tracker.transition("RUNNING").ok).toBe(true);
		expect(tracker.state).toBe("RUNNING");
		expect(tracker.transition("CREATED").ok).toBe(false);
		expect(tracker.state).toBe("RUNNING");
	});

	it("B6 SUCCEEDED cannot be produced from a raw process exit alone", () => {
		// exit 0 without verification is PARTIAL, never SUCCEEDED.
		expect(classifyExecutorOutcome({ exitCode: 0 }).state).toBe("PARTIAL");
		// exit 0 with verification is SUCCEEDED.
		expect(classifyExecutorOutcome({ exitCode: 0 }, { verified: true }).state).toBe("SUCCEEDED");
		// non-zero exit is FAILED.
		expect(classifyExecutorOutcome({ exitCode: 2 }).state).toBe("FAILED");
		// crash / cancel / timeout map to their own states.
		expect(classifyExecutorOutcome({ exitCode: null, launchError: "spawn ENOENT" }).state).toBe("CRASHED");
		expect(classifyExecutorOutcome({ exitCode: null, signal: "SIGTERM" }).state).toBe("CANCELLED");
		expect(classifyExecutorOutcome({ exitCode: null, timedOut: true }).state).toBe("TIMED_OUT");
	});
});

describe("terminal state set", () => {
	it("contains exactly the six terminal states", () => {
		expect([...MISSION_TERMINAL_STATES].sort()).toEqual([...TERMINAL].sort());
	});
});
