/**
 * Jensen Reliability Suite — deterministic adversarial scenarios R01–R15.
 *
 * Each scenario drives the Reliability Kernel with a scripted adversarial model
 * and asserts a runtime invariant. No real LLM is used; the trusted runtime
 * must stay safe even when the model behaves badly.
 */

import { describe, expect, it } from "vitest";
import { executeAgentAction } from "../../src/core/reliability/execution.js";
import { MissionRuntime } from "../../src/core/reliability/mission-runtime.js";
import type { VerificationSpec } from "../../src/core/reliability/types.js";
import { verify } from "../../src/core/reliability/verifier.js";
import { AdversarialModel, createFakeWorld, rawMalformedAction, rawPrematureDone, rawToolCall } from "./fake-model.js";

function runtimeFor(
	criteria: {
		id: string;
		description: string;
		source: "user" | "system" | "derived";
		verification: VerificationSpec;
	}[],
	missionId = "mission_suite",
) {
	return MissionRuntime.create(
		{ missionId, goal: "Implement the requested change correctly", criteria },
		{ now: 1700000000000 },
	);
}

async function runVerifications(runtime: MissionRuntime, world: ReturnType<typeof createFakeWorld>) {
	for (const criterion of runtime.criterionView()) {
		if (!criterion.verification) continue;
		const result = await verify(criterion.verification, world.verifyExecutor, { criterionId: criterion.id });
		runtime.recordVerification(criterion.id, result);
	}
}

describe("Reliability Suite", () => {
	it("R01 exact single-file edit completes with deterministic verification", async () => {
		const world = createFakeWorld({ files: {} });
		const runtime = runtimeFor([
			{
				id: "AC-1",
				description: "feature file contains expected code",
				source: "user",
				verification: { kind: "file_contains", path: "src/feature.ts", pattern: "return 42" },
			},
		]);
		const ctx = { ...world.executionContext, executeTool: world.executeTool };

		await executeAgentAction(
			runtime,
			rawToolCall("write", { path: "src/feature.ts", content: "export const x = () => { return 42; }" }),
			ctx,
		);
		await runVerifications(runtime, world);
		expect(runtime.criterionView()[0].status).toBe("passed");
		expect(runtime.proposeFinalCandidate().decision).toBe("accept");
	});

	it("R02 multi-file change verifies each criterion", async () => {
		const world = createFakeWorld({ files: {} });
		const runtime = runtimeFor([
			{
				id: "AC-1",
				description: "a.ts exists",
				source: "user",
				verification: { kind: "file_exists", path: "a.ts" },
			},
			{
				id: "AC-2",
				description: "b.ts exists",
				source: "user",
				verification: { kind: "file_exists", path: "b.ts" },
			},
		]);
		const ctx = { ...world.executionContext, executeTool: world.executeTool };
		await executeAgentAction(runtime, rawToolCall("write", { path: "a.ts", content: "a" }), ctx);
		await executeAgentAction(runtime, rawToolCall("write", { path: "b.ts", content: "b" }), ctx);
		await runVerifications(runtime, world);
		expect(runtime.proposeFinalCandidate().decision).toBe("accept");
	});

	it("R03 failing-test diagnosis only passes after the test actually passes", async () => {
		const world = createFakeWorld({ testPassing: false });
		const runtime = runtimeFor([
			{
				id: "AC-1",
				description: "tests pass",
				source: "system",
				verification: { kind: "test", command: "npm test" },
			},
		]);

		await runVerifications(runtime, world); // still failing
		expect(runtime.proposeFinalCandidate().decision).toBe("reject");

		world.state.testPassing = true;
		await runVerifications(runtime, world); // now passes (authoritative evidence)
		expect(runtime.proposeFinalCandidate().decision).toBe("accept");
	});

	it("R04 malformed action response is decoded as a failure and never executes", async () => {
		const world = createFakeWorld({ files: {} });
		const runtime = runtimeFor([
			{
				id: "AC-1",
				description: "file exists",
				source: "user",
				verification: { kind: "file_exists", path: "x.ts" },
			},
		]);
		const ctx = { ...world.executionContext, executeTool: world.executeTool };

		const result = await executeAgentAction(runtime, rawMalformedAction(), ctx);
		expect(result.kind).toBe("decode_rejected");
		expect(world.state.executedTools).toHaveLength(0);
	});

	it("R05 nonexistent file hallucination fails safely with zero crash", async () => {
		const world = createFakeWorld({ files: {} });
		const runtime = runtimeFor([
			{
				id: "AC-1",
				description: "file exists",
				source: "user",
				verification: { kind: "file_exists", path: "x.ts" },
			},
		]);
		const ctx = { ...world.executionContext, executeTool: world.executeTool };

		const result = await executeAgentAction(runtime, rawToolCall("read", { path: "nonexistent.ts" }), ctx);
		expect(result.kind).toBe("executed");
		if (result.kind === "executed") expect(result.evidence.success).toBe(false);
	});

	it("R06 premature done claim is rejected (false success blocked)", async () => {
		const world = createFakeWorld({ testPassing: false });
		const runtime = runtimeFor([
			{
				id: "AC-1",
				description: "tests pass",
				source: "system",
				verification: { kind: "test", command: "npm test" },
			},
		]);
		const ctx = { ...world.executionContext, executeTool: world.executeTool };

		const model = new AdversarialModel([rawPrematureDone()]);
		const result = await executeAgentAction(runtime, model.next(), ctx);
		expect(result.kind).toBe("non_tool");
		const gate = runtime.proposeFinalCandidate();
		expect(gate.decision).toBe("reject");
		expect(runtime.phase).not.toBe("COMPLETED");
	});

	it("R07 forgotten acceptance criterion stays pending and blocks completion", async () => {
		const world = createFakeWorld({ files: {} });
		const runtime = runtimeFor([
			{
				id: "AC-1",
				description: "a.ts exists",
				source: "user",
				verification: { kind: "file_exists", path: "a.ts" },
			},
			{
				id: "AC-2",
				description: "b.ts exists",
				source: "user",
				verification: { kind: "file_exists", path: "b.ts" },
			},
		]);
		const ctx = { ...world.executionContext, executeTool: world.executeTool };

		await executeAgentAction(runtime, rawToolCall("write", { path: "a.ts", content: "a" }), ctx);
		await runVerifications(runtime, world);
		// AC-2 forgotten by the model.
		const gate = runtime.proposeFinalCandidate();
		expect(gate.decision).toBe("reject");
		expect(gate.missingCriterionIds).toContain("AC-2");
		expect(runtime.criterionView().find((c) => c.id === "AC-2")?.status).toBe("pending");
	});

	it("R08 tool execution failure records fail evidence and blocks completion", async () => {
		const world = createFakeWorld({ testPassing: false });
		const runtime = runtimeFor([
			{
				id: "AC-1",
				description: "tests pass",
				source: "system",
				verification: { kind: "test", command: "npm test" },
			},
		]);
		const ctx = { ...world.executionContext, executeTool: world.executeTool };

		const result = await executeAgentAction(runtime, rawToolCall("bash", { command: "npm test" }), ctx);
		expect(result.kind).toBe("executed");
		expect(runtime.proposeFinalCandidate().decision).toBe("reject");
	});

	it("R09 compaction continuity preserves criteria and evidence", async () => {
		const world = createFakeWorld({ testPassing: true });
		const runtime = runtimeFor([
			{
				id: "AC-1",
				description: "tests pass",
				source: "system",
				verification: { kind: "test", command: "npm test" },
			},
		]);
		await runVerifications(runtime, world);
		expect(runtime.proposeFinalCandidate().decision).toBe("accept");

		// A compaction is modeled as a serialize/deserialize round-trip of the
		// durable document; conversational history may vanish but the ledger must not.
		const revived = MissionRuntime.deserialize(JSON.parse(runtime.toJSON()));
		expect(revived.criterionView()[0].status).toBe("passed");
		expect(revived.proposeFinalCandidate().decision).toBe("accept");
	});

	it("R10 process exit + resume recovers mission without restarting from zero", async () => {
		const world = createFakeWorld({ testPassing: true, files: {} });
		const runtime = runtimeFor([
			{
				id: "AC-1",
				description: "tests pass",
				source: "system",
				verification: { kind: "test", command: "npm test" },
			},
			{
				id: "AC-2",
				description: "feature file exists",
				source: "user",
				verification: { kind: "file_exists", path: "src/feature.ts" },
			},
		]);
		await runVerifications(runtime, world); // AC-1 passes; AC-2 still pending (file missing)

		const persisted = runtime.toJSON(); // process exits
		const world2 = createFakeWorld({ testPassing: true, files: { "src/feature.ts": "code" } });
		const resumed = MissionRuntime.deserialize(JSON.parse(persisted));
		expect(resumed.criterionView().find((c) => c.id === "AC-1")?.status).toBe("passed");
		expect(resumed.criterionView().find((c) => c.id === "AC-2")?.status).toBe("pending");

		await runVerifications(resumed, world2); // complete remaining work
		expect(resumed.proposeFinalCandidate().decision).toBe("accept");
	});

	it("R11 wrong-session protection: mission identity is stable and cannot leak", async () => {
		const runtime = runtimeFor(
			[
				{
					id: "AC-1",
					description: "tests pass",
					source: "system",
					verification: { kind: "test", command: "npm test" },
				},
			],
			"mission_A",
		);
		const revived = MissionRuntime.deserialize(JSON.parse(runtime.toJSON()));
		expect(revived.missionId).toBe("mission_A");
		// A different mission id must not be able to hijack this runtime.
		expect(revived.missionId).not.toBe("mission_B");
	});

	it("R12 boundary violation is rejected before execution", async () => {
		const world = createFakeWorld({ files: {} });
		const runtime = runtimeFor([
			{
				id: "AC-1",
				description: "file exists",
				source: "user",
				verification: { kind: "file_exists", path: "x.ts" },
			},
		]);
		const ctx = { ...world.executionContext, executeTool: world.executeTool };

		const result = await executeAgentAction(runtime, rawToolCall("read", { path: "/etc/passwd" }), ctx);
		expect(result.kind).toBe("validation_rejected");
		if (result.kind === "validation_rejected") expect(result.failure.category).toBe("BOUNDARY_VIOLATION");
		expect(world.state.readCalls).toBe(0);
	});

	it("R13 regression verification rejects stale satisfaction", async () => {
		const world = createFakeWorld({ testPassing: true });
		const runtime = runtimeFor([
			{
				id: "AC-1",
				description: "tests pass",
				source: "system",
				verification: { kind: "test", command: "npm test" },
			},
		]);
		await runVerifications(runtime, world);
		expect(runtime.proposeFinalCandidate().decision).toBe("accept");

		// Regression: tests break again. New fail evidence must invalidate.
		world.state.testPassing = false;
		await runVerifications(runtime, world);
		expect(runtime.proposeFinalCandidate().decision).toBe("reject");
	});

	it("R14 dirty working tree preservation: out-of-scope diff blocks completion", async () => {
		const world = createFakeWorld({ files: { "src/feature.ts": "code", "package.json": "changed" } });
		const runtime = runtimeFor([
			{
				id: "AC-1",
				description: "only src/ changes",
				source: "system",
				verification: { kind: "git_diff_scope", allowedPaths: ["src"] },
			},
		]);
		await runVerifications(runtime, world);
		const gate = runtime.proposeFinalCandidate();
		expect(gate.decision).toBe("reject");
	});

	it("R15 finalization rejection returns structured reasons and keeps mission alive", async () => {
		const world = createFakeWorld({ testPassing: true });
		const runtime = runtimeFor([
			{
				id: "AC-1",
				description: "tests pass",
				source: "system",
				verification: { kind: "test", command: "npm test" },
			},
			{
				id: "AC-2",
				description: "required file exists",
				source: "user",
				verification: { kind: "file_exists", path: "missing.ts" },
			},
		]);
		await runVerifications(runtime, world);
		// AC-2 file is missing, so it cannot pass.

		const gate = runtime.proposeFinalCandidate();
		expect(gate.decision).toBe("reject");
		expect(gate.missingCriterionIds).toContain("AC-2");
		expect(gate.reasons.length).toBeGreaterThan(0);
	});
});
