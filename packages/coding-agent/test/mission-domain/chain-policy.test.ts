/**
 * Chain + parallel policy regression tests (2.3.0).
 *
 * These use the REAL MissionExecutionService / ProcessMissionExecutor
 * compatibility path (with an injected deterministic harness) to prove that a
 * legacy exit-0 child is never promoted to verified SUCCEEDED, and that the
 * execution-compatible chain policy continues past unverified-but-completed
 * children while stopping at genuine failures.
 */

import { describe, expect, it } from "vitest";
import {
	aggregateMissionResults,
	createMissionRequest,
	createMissionResult,
	MissionExecutionService,
	type MissionRequest,
	ProcessMissionExecutor,
	type ProcessMissionOutcome,
	shouldContinueMissionChain,
} from "../../src/core/mission-domain/index.js";

function executorFor(outcomes: Record<string, ProcessMissionOutcome>) {
	const launched: string[] = [];
	const executor = new ProcessMissionExecutor({
		executorId: "process",
		buildLaunch: (request) => ({ command: "node", args: [request.objective], cwd: "/tmp" }),
		harness: async (launch) => {
			const key = launch.args[0];
			launched.push(key);
			return outcomes[key] ?? { exitCode: 0, stdout: key, stderr: "" };
		},
	});
	return { executor, launched };
}

function request(objective: string): MissionRequest {
	return createMissionRequest({
		missionId: `mission_${objective}`,
		objective,
		agent: "worker",
		executionMode: "execute",
		acceptanceCriteria: [],
	});
}

const OK = (stdout: string): ProcessMissionOutcome => ({ exitCode: 0, stdout, stderr: "" });

function serviceFor(outcomes: Record<string, ProcessMissionOutcome>) {
	const { executor, launched } = executorFor(outcomes);
	const service = new MissionExecutionService();
	service.register(executor);
	return { service, launched };
}

describe("executeChain execution-compatibility policy", () => {
	it("CHAIN-1 three unverified (exit-0) legacy children all run", async () => {
		const { service, launched } = serviceFor({ A: OK("a"), B: OK("b"), C: OK("c") });
		const results = await service.executeChain([request("A"), request("B"), request("C")]);
		expect(launched).toEqual(["A", "B", "C"]);
		expect(results.map((r) => r.missionId)).toEqual(["mission_A", "mission_B", "mission_C"]);
		expect(results.map((r) => r.state)).toEqual(["PARTIAL", "PARTIAL", "PARTIAL"]);
	});

	it("CHAIN-2 a genuine FAILED child stops dependent execution", async () => {
		const { service, launched } = serviceFor({
			A: OK("a"),
			B: { exitCode: 2, stdout: "", stderr: "boom" },
			C: OK("c"),
		});
		const results = await service.executeChain([request("A"), request("B"), request("C")]);
		expect(launched).toEqual(["A", "B"]);
		expect(results.map((r) => r.state)).toEqual(["PARTIAL", "FAILED"]);
	});

	it("CHAIN-3 a CRASHED child stops dependent execution", async () => {
		const { service, launched } = serviceFor({
			A: OK("a"),
			B: { exitCode: null, launchError: "ENOENT", stdout: "", stderr: "" },
			C: OK("c"),
		});
		const results = await service.executeChain([request("A"), request("B"), request("C")]);
		expect(launched).toEqual(["A", "B"]);
		expect(results.map((r) => r.state)).toEqual(["PARTIAL", "CRASHED"]);
	});

	it("CHAIN-4 TIMED_OUT and CANCELLED children stop dependent execution", async () => {
		const timedOut = serviceFor({
			A: OK("a"),
			B: { exitCode: null, timedOut: true, stdout: "", stderr: "" },
			C: OK("c"),
		});
		const timedResults = await timedOut.service.executeChain([request("A"), request("B"), request("C")]);
		expect(timedOut.launched).toEqual(["A", "B"]);
		expect(timedResults.map((r) => r.state)).toEqual(["PARTIAL", "TIMED_OUT"]);

		const cancelled = serviceFor({
			A: OK("a"),
			B: { exitCode: null, signal: "SIGTERM", stdout: "", stderr: "" },
			C: OK("c"),
		});
		const cancelledResults = await cancelled.service.executeChain([request("A"), request("B"), request("C")]);
		expect(cancelled.launched).toEqual(["A", "B"]);
		expect(cancelledResults.map((r) => r.state)).toEqual(["PARTIAL", "CANCELLED"]);
	});

	it("CHAIN-5 no legacy exit-0 child is promoted to verified SUCCEEDED", async () => {
		const { service } = serviceFor({ A: OK("a"), B: OK("b"), C: OK("c") });
		const results = await service.executeChain([request("A"), request("B"), request("C")]);
		for (const result of results) {
			expect(result.state).toBe("PARTIAL");
			expect(result.success).toBe(false);
			expect(result.executionOutcome).toBe("COMPLETED");
			expect(result.verification.status).toBe("unverified");
		}
	});

	it("CHAIN-6 the aggregate chain result remains unverified/PARTIAL", async () => {
		const { service } = serviceFor({ A: OK("a"), B: OK("b"), C: OK("c") });
		const results = await service.executeChain([request("A"), request("B"), request("C")]);
		const agg = aggregateMissionResults(results);
		expect(agg.outcome).toBe("PARTIAL");
		expect(agg.anyHardFailure).toBe(false);
		expect(agg.allCompletedExecution).toBe(true);
		expect(agg.partial).toBe(3);
	});

	it("CHAIN-7 shouldContinueMissionChain encodes the policy explicitly", () => {
		const partial = createMissionResult({
			missionId: "p",
			depth: 0,
			state: "PARTIAL",
			executionOutcome: "COMPLETED",
			executorDiagnostics: { executorId: "t" },
			startedAtMs: 0,
			finishedAtMs: 1,
		});
		const failed = createMissionResult({
			missionId: "f",
			depth: 0,
			state: "FAILED",
			executionOutcome: "FAILED",
			executorDiagnostics: { executorId: "t" },
			startedAtMs: 0,
			finishedAtMs: 1,
		});
		expect(shouldContinueMissionChain(partial)).toBe(true);
		expect(shouldContinueMissionChain(failed)).toBe(false);
	});
});

describe("executeMany parallel policy", () => {
	it("PARALLEL-1 all exit-0/unverified children never aggregate to verified SUCCEEDED", async () => {
		const { service } = serviceFor({ A: OK("a"), B: OK("b"), C: OK("c") });
		const results = await service.executeMany([request("A"), request("B"), request("C")]);
		const agg = aggregateMissionResults(results);
		expect(agg.outcome).toBe("PARTIAL");
		expect(agg.allSucceeded).toBe(false);
		expect(agg.someSucceeded).toBe(false);
		expect(agg.anyHardFailure).toBe(false);
		expect(agg.allCompletedExecution).toBe(true);
	});

	it("PARALLEL-2 actual child failure is structurally distinguishable from unverified completion", async () => {
		const { service } = serviceFor({
			A: OK("a"),
			B: { exitCode: 3, stdout: "", stderr: "failed" },
			C: OK("c"),
		});
		const results = await service.executeMany([request("A"), request("B"), request("C")]);
		const agg = aggregateMissionResults(results);
		expect(agg.outcome).toBe("FAILED");
		expect(agg.anyHardFailure).toBe(true);
		expect(agg.failed).toBe(1);
		expect(agg.partial).toBe(2);
		expect(agg.allCompletedExecution).toBe(false);

		const states = new Set(results.map((r) => r.state));
		expect(states).toEqual(new Set(["PARTIAL", "FAILED"]));
	});
});
