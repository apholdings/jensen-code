/**
 * TEST D — structured MissionResult.
 * TEST G — parallel/chain structural aggregation.
 */

import { describe, expect, it } from "vitest";
import {
	aggregateMissionResults,
	createMissionResult,
	type MissionResult,
	type MissionState,
} from "../../src/core/mission-domain/index.js";

function result(state: MissionState, missionId: string, overrides: Partial<MissionResult> = {}): MissionResult {
	const executionOutcome: MissionResult["executionOutcome"] =
		state === "SUCCEEDED" || state === "PARTIAL"
			? "COMPLETED"
			: state === "CANCELLED"
				? "CANCELLED"
				: state === "TIMED_OUT"
					? "TIMED_OUT"
					: state === "CRASHED"
						? "CRASHED"
						: "FAILED";
	return createMissionResult({
		missionId,
		depth: 1,
		parentMissionId: "root",
		state,
		executionOutcome,
		executorDiagnostics: { executorId: "test", processExitCode: state === "SUCCEEDED" ? 0 : 1 },
		startedAtMs: 1,
		finishedAtMs: 2,
		...overrides,
	});
}

describe("MissionResult", () => {
	it("D1 success is derived from state, never from prose", () => {
		expect(result("SUCCEEDED", "m1").success).toBe(true);
		for (const state of ["PARTIAL", "FAILED", "CANCELLED", "TIMED_OUT", "CRASHED"] as MissionState[]) {
			const r = result(state, "m2", { outputText: "everything looks fine" });
			expect(r.success).toBe(false);
			expect(r.state).toBe(state);
		}
	});

	it("D2 each terminal state is distinguishable without parsing text", () => {
		const states: MissionState[] = ["SUCCEEDED", "PARTIAL", "FAILED", "CANCELLED", "TIMED_OUT", "CRASHED"];
		const seen = new Set(states.map((s, i) => result(s, `m${i}`).state));
		expect(seen.size).toBe(states.length);
	});

	it("D3 executor diagnostics are separate from domain outcome", () => {
		const r = result("FAILED", "m3", {
			executorDiagnostics: { executorId: "process", processExitCode: 7, stderr: "boom" },
			outputText: "no failure mentioned",
		});
		expect(r.state).toBe("FAILED");
		expect(r.executorDiagnostics.processExitCode).toBe(7);
		expect(r.outputText).toBe("no failure mentioned");
	});

	it("D4 executionOutcome is a typed executor-level fact, not mission success", () => {
		expect(result("PARTIAL", "m4").executionOutcome).toBe("COMPLETED");
		expect(result("FAILED", "m5").executionOutcome).toBe("FAILED");
		// Verification failure is a mission failure even though execution completed.
		const verificationFailed = result("FAILED", "m6", {
			executionOutcome: "COMPLETED",
			verification: { status: "failed", summary: "criteria not met" },
		});
		expect(verificationFailed.state).toBe("FAILED");
		expect(verificationFailed.executionOutcome).toBe("COMPLETED");
	});

	it("R1 success is a pure derivation of state and can never diverge", () => {
		const states: MissionState[] = [
			"CREATED",
			"QUEUED",
			"RUNNING",
			"WAITING",
			"BLOCKED",
			"RETRYING",
			"SUCCEEDED",
			"PARTIAL",
			"FAILED",
			"CANCELLED",
			"TIMED_OUT",
			"CRASHED",
		];
		for (const state of states) {
			const r = result(state, `r_${state}`);
			expect(r.success).toBe(r.state === "SUCCEEDED");
		}
	});
});

describe("aggregateMissionResults (parallel/chain)", () => {
	it("G1 all-success aggregate is SUCCEEDED", () => {
		const agg = aggregateMissionResults([result("SUCCEEDED", "a"), result("SUCCEEDED", "b")]);
		expect(agg.outcome).toBe("SUCCEEDED");
		expect(agg.allSucceeded).toBe(true);
		expect(agg.allFailed).toBe(false);
		expect(agg.anyHardFailure).toBe(false);
		expect(agg.allCompletedExecution).toBe(true);
	});

	it("G2 a set with a genuine failure is FAILED, never clean success", () => {
		const agg = aggregateMissionResults([result("SUCCEEDED", "a"), result("FAILED", "b"), result("CRASHED", "c")]);
		expect(agg.outcome).toBe("FAILED");
		expect(agg.allSucceeded).toBe(false);
		expect(agg.someSucceeded).toBe(true);
		expect(agg.succeeded).toBe(1);
		expect(agg.failed).toBe(1);
		expect(agg.crashed).toBe(1);
		expect(agg.anyHardFailure).toBe(true);
		expect(agg.allCompletedExecution).toBe(false);
	});

	it("G3 all-failure aggregate is FAILED", () => {
		const agg = aggregateMissionResults([result("FAILED", "a"), result("CANCELLED", "b")]);
		expect(agg.outcome).toBe("FAILED");
		expect(agg.allFailed).toBe(true);
		expect(agg.anyHardFailure).toBe(true);
	});

	it("G4 each child retains a structured MissionResult", () => {
		const children = [result("SUCCEEDED", "a"), result("FAILED", "b"), result("CRASHED", "c")];
		const agg = aggregateMissionResults(children);
		expect(agg.results.map((r) => r.state)).toEqual(["SUCCEEDED", "FAILED", "CRASHED"]);
		expect(agg.results.map((r) => r.missionId)).toEqual(["a", "b", "c"]);
	});

	it("G5 a never-finished (non-terminal) child cannot look like success", () => {
		const agg = aggregateMissionResults([result("SUCCEEDED", "a"), result("RUNNING", "b")]);
		expect(agg.outcome).toBe("FAILED");
		expect(agg.allSucceeded).toBe(false);
		expect(agg.anyHardFailure).toBe(true);
	});

	it("G6 all-unverified (PARTIAL) children are PARTIAL, not FAILED and not SUCCEEDED", () => {
		const agg = aggregateMissionResults([result("PARTIAL", "a"), result("PARTIAL", "b"), result("PARTIAL", "c")]);
		expect(agg.outcome).toBe("PARTIAL");
		expect(agg.partial).toBe(3);
		expect(agg.succeeded).toBe(0);
		expect(agg.failed).toBe(0);
		expect(agg.anyHardFailure).toBe(false);
		expect(agg.allCompletedExecution).toBe(true);
		expect(agg.allSucceeded).toBe(false);
	});

	it("G7 mixed verified + unverified (no hard failure) is PARTIAL", () => {
		const agg = aggregateMissionResults([result("SUCCEEDED", "a"), result("PARTIAL", "b")]);
		expect(agg.outcome).toBe("PARTIAL");
		expect(agg.anyHardFailure).toBe(false);
		expect(agg.allCompletedExecution).toBe(true);
	});
});
