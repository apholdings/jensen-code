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
	isMissionState,
	isMissionSuccessState,
	isResumableMissionState,
	isTerminalMissionState,
	MISSION_STATES,
	MISSION_SUCCESS_STATES,
	MISSION_TERMINAL_STATES,
	type MissionState,
	MissionStateTracker,
} from "../../src/core/mission-domain/index.js";

const TERMINAL: MissionState[] = ["SUCCEEDED", "PARTIAL", "FAILED", "CANCELLED", "TIMED_OUT", "CRASHED"];

describe("MissionState machine", () => {
	it("B1 legal transitions are accepted", () => {
		expect(canTransitionMissionState("CREATED", "QUEUED")).toBe(true);
		expect(canTransitionMissionState("QUEUED", "LAUNCHING")).toBe(true);
		expect(canTransitionMissionState("LAUNCHING", "RUNNING")).toBe(true);
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

describe("INTERRUPTED state machine (2.4.0)", () => {
	it("is a non-terminal, recoverable state, never success or terminal", () => {
		expect(isTerminalMissionState("INTERRUPTED")).toBe(false);
		expect(isMissionSuccessState("INTERRUPTED")).toBe(false);
		expect(canTransitionMissionState("INTERRUPTED", "QUEUED")).toBe(true);
	});

	it("active non-terminal states may be reconciled to INTERRUPTED", () => {
		expect(canTransitionMissionState("QUEUED", "INTERRUPTED")).toBe(true);
		expect(canTransitionMissionState("RUNNING", "INTERRUPTED")).toBe(true);
		expect(canTransitionMissionState("WAITING", "INTERRUPTED")).toBe(true);
		expect(canTransitionMissionState("BLOCKED", "INTERRUPTED")).toBe(true);
		expect(canTransitionMissionState("RETRYING", "INTERRUPTED")).toBe(true);
	});

	it("CREATED never becomes INTERRUPTED (no attempt was ever owned)", () => {
		expect(canTransitionMissionState("CREATED", "INTERRUPTED")).toBe(false);
	});

	it("recovery exits INTERRUPTED only to QUEUED/CANCELLED/FAILED", () => {
		expect(canTransitionMissionState("INTERRUPTED", "QUEUED")).toBe(true);
		expect(canTransitionMissionState("INTERRUPTED", "CANCELLED")).toBe(true);
		expect(canTransitionMissionState("INTERRUPTED", "FAILED")).toBe(true);
		expect(canTransitionMissionState("INTERRUPTED", "SUCCEEDED")).toBe(false);
		expect(canTransitionMissionState("INTERRUPTED", "RUNNING")).toBe(false);
	});

	it("INTERRUPTED is resumable and never self-transitions", () => {
		expect(isResumableMissionState("INTERRUPTED")).toBe(true);
		expect(assertMissionTransition("INTERRUPTED", "INTERRUPTED").ok).toBe(false);
	});

	it("INTERRUPTED is in MISSION_STATES and validated by the type guard", () => {
		expect(MISSION_STATES.has("INTERRUPTED")).toBe(true);
		expect(isMissionState("INTERRUPTED")).toBe(true);
		expect(isMissionState("NOT_A_STATE")).toBe(false);
	});
});

describe("LAUNCHING state machine (2.4.0)", () => {
	it("is a non-terminal, non-success, resumable bridge state", () => {
		expect(isTerminalMissionState("LAUNCHING")).toBe(false);
		expect(isMissionSuccessState("LAUNCHING")).toBe(false);
		expect(isResumableMissionState("LAUNCHING")).toBe(true);
	});

	it("is entered only from QUEUED", () => {
		expect(canTransitionMissionState("QUEUED", "LAUNCHING")).toBe(true);
		expect(canTransitionMissionState("CREATED", "LAUNCHING")).toBe(false);
		expect(canTransitionMissionState("RUNNING", "LAUNCHING")).toBe(false);
		expect(canTransitionMissionState("INTERRUPTED", "LAUNCHING")).toBe(false);
	});

	it("exits to RUNNING (ownership confirmed), FAILED (launch rejected), or INTERRUPTED (recovery)", () => {
		expect(canTransitionMissionState("LAUNCHING", "RUNNING")).toBe(true);
		expect(canTransitionMissionState("LAUNCHING", "FAILED")).toBe(true);
		expect(canTransitionMissionState("LAUNCHING", "INTERRUPTED")).toBe(true);
		expect(canTransitionMissionState("LAUNCHING", "SUCCEEDED")).toBe(false);
		expect(canTransitionMissionState("LAUNCHING", "PARTIAL")).toBe(false);
	});

	it("never self-transitions and is validated by the type guard", () => {
		expect(assertMissionTransition("LAUNCHING", "LAUNCHING").ok).toBe(false);
		expect(MISSION_STATES.has("LAUNCHING")).toBe(true);
		expect(isMissionState("LAUNCHING")).toBe(true);
	});

	it("recovery sees LAUNCHING as an active nonterminal state", () => {
		expect(canTransitionMissionState("LAUNCHING", "INTERRUPTED")).toBe(true);
	});
});
