/**
 * TEST C — MissionHandle executor independence.
 * TEST E — ProcessMissionExecutor adapter.
 */

import { describe, expect, it } from "vitest";
import {
	createMissionRequest,
	MissionExecutionService,
	type MissionExecutor,
	type MissionHandle,
	type MissionRequest,
	type MissionResult,
	ProcessMissionExecutor,
	type ProcessMissionOutcome,
} from "../../src/core/mission-domain/index.js";

// =============================================================================
// TEST C — a pure test executor proving handle independence
// =============================================================================

class TestMissionExecutor implements MissionExecutor {
	readonly executorId = "test";
	private readonly _results = new Map<string, MissionResult>();

	async launch(request: MissionRequest): Promise<MissionHandle> {
		return {
			missionId: request.missionId,
			parentMissionId: request.parentMissionId,
			depth: request.depth,
			executionId: `exec-${request.missionId}`,
			state: "RUNNING",
			createdAtMs: request.createdAtMs,
			startedAtMs: Date.now(),
			cancel: async () => undefined,
		};
	}

	async awaitResult(handle: MissionHandle): Promise<MissionResult> {
		return (
			this._results.get(handle.missionId) ?? {
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
			}
		);
	}

	async cancel(): Promise<void> {}
}

describe("MissionHandle executor independence", () => {
	it("C1 handle has no ChildProcess or process coupling", () => {
		const service = new MissionExecutionService();
		service.register(new TestMissionExecutor());

		const request = createMissionRequest({
			missionId: "mission_c1",
			objective: "test",
			agent: "worker",
			executionMode: "execute",
			acceptanceCriteria: [],
		});

		return service
			.executor("test")
			.launch(request)
			.then((handle) => {
				expect(handle.missionId).toBe("mission_c1");
				expect(handle.executionId).toContain("exec-");
				expect(handle.state).toBe("RUNNING");
				expect(handle).not.toHaveProperty("childProcess");
				expect(handle).not.toHaveProperty("process");
				expect(handle).not.toHaveProperty("pid");
				expect(typeof handle.cancel).toBe("function");
			});
	});

	it("C2 stable mission id survives launch and await", async () => {
		const executor = new TestMissionExecutor();
		const request = createMissionRequest({
			missionId: "mission_c2",
			objective: "test",
			agent: "worker",
			executionMode: "execute",
			acceptanceCriteria: [],
		});
		const handle = await executor.launch(request);
		const result = await executor.awaitResult(handle);
		expect(result.missionId).toBe("mission_c2");
		expect(result.missionId).toBe(handle.missionId);
	});
});

// =============================================================================
// TEST E — ProcessMissionExecutor with a deterministic harness
// =============================================================================

function makeExecutor(
	outcomes: Record<string, ProcessMissionOutcome>,
	options: { verified?: boolean; verifier?: boolean } = {},
): ProcessMissionExecutor {
	return new ProcessMissionExecutor({
		buildLaunch: (request) => ({
			command: "node",
			args: ["--mode", "json", "-p", "--no-session", request.objective],
			cwd: "/tmp",
		}),
		harness: async (_launch) => {
			return outcomes[_launch.args[_launch.args.length - 1]] ?? { exitCode: 0, stdout: "", stderr: "" };
		},
		verifier: options.verifier
			? async () => ({ verified: options.verified ?? true, summary: "verified" })
			: undefined,
	});
}

describe("ProcessMissionExecutor adapter", () => {
	it("E1 MissionRequest becomes an executor invocation and child identity is preserved", async () => {
		const launched: string[] = [];
		const executor = new ProcessMissionExecutor({
			buildLaunch: (request) => ({
				command: "node",
				args: [request.missionId],
				cwd: "/tmp",
			}),
			harness: async (launch) => {
				launched.push(launch.args[0]);
				return { exitCode: 0, stdout: "ok", stderr: "" };
			},
		});

		const request = createMissionRequest({
			missionId: "mission_e1",
			parent: { missionId: "root", depth: 0 },
			objective: "child",
			agent: "worker",
			executionMode: "execute",
			acceptanceCriteria: [],
		});
		const handle = await executor.launch(request);
		expect(handle.missionId).toBe("mission_e1");
		expect(handle.parentMissionId).toBe("root");
		expect(handle.depth).toBe(1);
		expect(handle.executionId).toMatch(/^exec_/u);

		const result = await executor.awaitResult(handle);
		expect(launched).toContain("mission_e1");
		expect(result.missionId).toBe("mission_e1");
		expect(result.parentMissionId).toBe("root");
	});

	it("E2 stdout/exit diagnostics become MissionResult fields", async () => {
		const executor = makeExecutor({ "task-a": { exitCode: 3, stdout: "partial output", stderr: "boom" } });
		const request = createMissionRequest({
			missionId: "mission_e2",
			objective: "task-a",
			agent: "worker",
			executionMode: "execute",
			acceptanceCriteria: [],
		});
		const handle = await executor.launch(request);
		const result = await executor.awaitResult(handle);
		expect(result.executorDiagnostics.processExitCode).toBe(3);
		expect(result.executorDiagnostics.stderr).toBe("boom");
		expect(result.outputText).toBe("partial output");
		expect(result.state).toBe("FAILED");
	});

	it("E3 exit 0 alone does not assert verified success", async () => {
		const executor = makeExecutor({ "task-a": { exitCode: 0, stdout: "done", stderr: "" } });
		const request = createMissionRequest({
			missionId: "mission_e3",
			objective: "task-a",
			agent: "worker",
			executionMode: "execute",
			acceptanceCriteria: [],
		});
		const handle = await executor.launch(request);
		const result = await executor.awaitResult(handle);
		expect(result.state).toBe("PARTIAL");
		expect(result.success).toBe(false);
		expect(result.verification.status).toBe("unverified");
	});

	it("E4 a verifier can promote exit-0 to SUCCEEDED", async () => {
		const executor = makeExecutor(
			{ "task-a": { exitCode: 0, stdout: "done", stderr: "" } },
			{ verifier: true, verified: true },
		);
		const request = createMissionRequest({
			missionId: "mission_e4",
			objective: "task-a",
			agent: "worker",
			executionMode: "execute",
			acceptanceCriteria: [],
		});
		const handle = await executor.launch(request);
		const result = await executor.awaitResult(handle);
		expect(result.state).toBe("SUCCEEDED");
		expect(result.success).toBe(true);
		expect(result.verification.status).toBe("verified");
		expect(result.completionDecision).toBe("accepted");
	});

	it("E5 launch failure is CRASHED and cancellation is CANCELLED", async () => {
		const crashExecutor = makeExecutor({
			"task-a": { exitCode: null, launchError: "ENOENT", stdout: "", stderr: "" },
		});
		const crashRequest = createMissionRequest({
			missionId: "mission_e5a",
			objective: "task-a",
			agent: "worker",
			executionMode: "execute",
			acceptanceCriteria: [],
		});
		const crashHandle = await crashExecutor.launch(crashRequest);
		const crashResult = await crashExecutor.awaitResult(crashHandle);
		expect(crashResult.state).toBe("CRASHED");

		const cancelExecutor = new ProcessMissionExecutor({
			buildLaunch: () => ({ command: "node", args: [], cwd: "/tmp" }),
			harness: async (_launch, signal) => {
				await new Promise<void>((resolve) => {
					signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return { exitCode: null, signal: "SIGTERM", stdout: "", stderr: "" };
			},
		});
		const cancelRequest = createMissionRequest({
			missionId: "mission_e5b",
			objective: "task-a",
			agent: "worker",
			executionMode: "execute",
			acceptanceCriteria: [],
		});
		const cancelHandle = await cancelExecutor.launch(cancelRequest);
		await cancelExecutor.cancel(cancelHandle, "stop");
		const cancelResult = await cancelExecutor.awaitResult(cancelHandle);
		expect(cancelResult.state).toBe("CANCELLED");
	});

	it("E6 invalid requests are rejected by the executor", async () => {
		const executor = makeExecutor({});
		await expect(
			executor.launch({
				missionId: "",
				depth: 0,
				objective: "x",
				agent: "worker",
				executionMode: "execute",
				acceptanceCriteria: [],
				createdAtMs: Date.now(),
			}),
		).rejects.toThrow(/Invalid MissionRequest/u);
	});
});
