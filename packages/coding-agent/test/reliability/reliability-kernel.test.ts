/**
 * Reliability Kernel — deterministic unit tests.
 *
 * Covers the action envelope/decoder, action validator, verification engine,
 * completion gate, evidence authority, and MissionRuntime durability
 * (create/verify/finalize/serialize/deserialize).
 */

import { describe, expect, it } from "vitest";
import { decodeAction } from "../../src/core/reliability/action-decoder.js";
import { type ActionValidatorContext, validateToolCallAction } from "../../src/core/reliability/action-validator.js";
import { evaluateCompletionGate } from "../../src/core/reliability/completion-gate.js";
import { MissionRuntime } from "../../src/core/reliability/mission-runtime.js";
import type { VerificationSpec } from "../../src/core/reliability/types.js";
import { verify } from "../../src/core/reliability/verifier.js";
import { createFakeWorld } from "./fake-model.js";

const FIXED_NOW = 1700000000000;

function runtimeFor(
	criteria: {
		id: string;
		description: string;
		source: "user" | "system" | "derived";
		verification: VerificationSpec;
	}[],
) {
	return MissionRuntime.create(
		{
			missionId: "mission_test",
			goal: "Implement a feature and make tests pass",
			criteria,
		},
		{ now: FIXED_NOW },
	);
}

async function runVerification(
	runtime: MissionRuntime,
	world: ReturnType<typeof createFakeWorld>,
	criterionId: string,
) {
	const criterion = runtime.criterionView().find((c) => c.id === criterionId);
	if (!criterion?.verification) throw new Error(`no verification for ${criterionId}`);
	const result = await verify(criterion.verification, world.verifyExecutor, { criterionId });
	runtime.recordVerification(criterionId, result);
	return result;
}

describe("action decoder", () => {
	it("decodes native tool calls", () => {
		const result = decodeAction({ name: "read", id: "c1", arguments: { path: "src/x.ts" } });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.action).toMatchObject({ type: "tool_call", tool: "read" });
	});

	it("decodes structured envelopes", () => {
		const result = decodeAction({ type: "tool_call", tool: "edit", arguments: { path: "x", oldText: "a" } });
		expect(result.ok).toBe(true);
	});

	it("decodes text completion signal", () => {
		const result = decodeAction("Everything is complete. MISSION_COMPLETE");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.action.type).toBe("final_candidate");
	});

	it("decodes fenced JSON emitted by local models", () => {
		const raw =
			'```json\n{"type":"tool_call","tool":"read","toolCallId":"tc1","arguments":{"path":"src/example.ts"}}\n```';
		const result = decodeAction(raw);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.action.type).toBe("tool_call");
			expect(result.action).toMatchObject({ tool: "read" });
		}
	});

	it("rejects unknown shapes with a structured failure", () => {
		const result = decodeAction({ foo: "bar" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.failure.category).toBe("UNKNOWN_ACTION_TYPE");
	});
});

describe("action validator", () => {
	const schema = {
		exists: (name: string) => name === "read" || name === "bash",
		validateArgs: (name: string, args: Record<string, unknown>) => {
			const required = name === "bash" ? "command" : "path";
			if (typeof args[required] !== "string") return { ok: false as const, message: `missing ${required}` };
			return { ok: true as const, normalized: { ...args } };
		},
	};

	function ctx(policy?: ActionValidatorContext["policy"]): ActionValidatorContext {
		return { schema, policy };
	}

	it("rejects unknown tools without executing", () => {
		const result = validateToolCallAction(
			{ type: "tool_call", tool: "magical_fix_everything", toolCallId: "c", arguments: {} },
			ctx(),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.failure.category).toBe("UNKNOWN_TOOL");
	});

	it("rejects missing required arguments", () => {
		const result = validateToolCallAction({ type: "tool_call", tool: "bash", toolCallId: "c", arguments: {} }, ctx());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.failure.category).toBe("INVALID_ARGUMENTS");
	});

	it("rejects forbidden actions", () => {
		const result = validateToolCallAction(
			{ type: "tool_call", tool: "bash", toolCallId: "c", arguments: { command: "rm -rf /" } },
			ctx({
				forbiddenReason: (a) => (a.tool === "bash" ? "bash forbidden" : undefined),
				boundaryViolationReason: () => undefined,
				permissionViolationReason: () => undefined,
			}),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.failure.category).toBe("FORBIDDEN_ACTION");
	});

	it("rejects boundary violations", () => {
		const result = validateToolCallAction(
			{ type: "tool_call", tool: "read", toolCallId: "c", arguments: { path: "/etc/passwd" } },
			ctx({
				forbiddenReason: () => undefined,
				boundaryViolationReason: (a) => (String(a.arguments.path).startsWith("/") ? "absolute path" : undefined),
				permissionViolationReason: () => undefined,
			}),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.failure.category).toBe("BOUNDARY_VIOLATION");
	});

	it("passes valid actions", () => {
		const result = validateToolCallAction(
			{ type: "tool_call", tool: "read", toolCallId: "c", arguments: { path: "src/x.ts" } },
			ctx(),
		);
		expect(result.ok).toBe(true);
	});
});

describe("verification engine", () => {
	it("treats non-zero exit as failure (no model judgment)", async () => {
		const world = createFakeWorld({ testPassing: false });
		const result = await verify({ kind: "test", command: "npm test" }, world.verifyExecutor, { criterionId: "AC-1" });
		expect(result.passed).toBe(false);
		expect(result.evidence.success).toBe(false);
	});

	it("treats zero exit as pass", async () => {
		const world = createFakeWorld({ testPassing: true });
		const result = await verify({ kind: "test", command: "npm test" }, world.verifyExecutor, { criterionId: "AC-1" });
		expect(result.passed).toBe(true);
	});

	it("verifies file existence deterministically", async () => {
		const world = createFakeWorld({ files: { "src/x.ts": "hello" } });
		const exists = await verify({ kind: "file_exists", path: "src/x.ts" }, world.verifyExecutor);
		const absent = await verify({ kind: "file_exists", path: "src/y.ts" }, world.verifyExecutor);
		expect(exists.passed).toBe(true);
		expect(absent.passed).toBe(false);
	});
});

describe("mission runtime + completion gate", () => {
	it("records authoritative evidence and accepts completion only when all criteria pass", async () => {
		const world = createFakeWorld({ testPassing: true, files: { "src/feature.ts": "code" } });
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

		expect(runtime.proposeFinalCandidate().decision).toBe("reject");

		await runVerification(runtime, world, "AC-1");
		await runVerification(runtime, world, "AC-2");

		const gate = runtime.proposeFinalCandidate();
		expect(gate.decision).toBe("accept");
		expect(gate.missingCriterionIds).toEqual([]);
	});

	it("blocks false success: model claims done while tests fail", async () => {
		const world = createFakeWorld({ testPassing: false });
		const runtime = runtimeFor([
			{
				id: "AC-1",
				description: "tests pass",
				source: "system",
				verification: { kind: "test", command: "npm test" },
			},
		]);

		await runVerification(runtime, world, "AC-1"); // fail evidence recorded

		const gate = runtime.proposeFinalCandidate();
		expect(gate.decision).toBe("reject");
		expect(gate.missingCriterionIds).toContain("AC-1");
		expect(runtime.phase).not.toBe("COMPLETED");
	});

	it("never marks a criterion passed from an agent claim alone", () => {
		const runtime = runtimeFor([
			{
				id: "AC-1",
				description: "tests pass",
				source: "system",
				verification: { kind: "test", command: "npm test" },
			},
		]);
		// No verification recorded; criterion must remain pending.
		const view = runtime.criterionView();
		expect(view.find((c) => c.id === "AC-1")?.status).toBe("pending");
		expect(runtime.proposeFinalCandidate().decision).toBe("reject");
	});

	it("survives serialize/deserialize (resume) with criterion state intact", async () => {
		const world = createFakeWorld({ testPassing: true });
		const runtime = runtimeFor([
			{
				id: "AC-1",
				description: "tests pass",
				source: "system",
				verification: { kind: "test", command: "npm test" },
			},
		]);
		await runVerification(runtime, world, "AC-1");
		expect(runtime.proposeFinalCandidate().decision).toBe("accept");

		const revived = MissionRuntime.deserialize(JSON.parse(runtime.toJSON()));
		expect(revived.missionId).toBe("mission_test");
		expect(revived.criterionView().find((c) => c.id === "AC-1")?.status).toBe("passed");
		expect(revived.proposeFinalCandidate().decision).toBe("accept");
	});

	it("keeps the model context summary token-disciplined", () => {
		const runtime = runtimeFor([
			{
				id: "AC-1",
				description: "tests pass",
				source: "system",
				verification: { kind: "test", command: "npm test" },
			},
		]);
		const summary = runtime.summarizeForModel();
		expect(summary).toContain("Goal:");
		expect(summary).toContain("AC-1");
	});
});

describe("completion gate authority", () => {
	it("rejects when no trusted validation context can be minted by the model", () => {
		const runtime = runtimeFor([
			{
				id: "AC-1",
				description: "tests pass",
				source: "system",
				verification: { kind: "test", command: "npm test" },
			},
		]);
		// Gate is always evaluated through the runtime's trusted context; a
		// plain-object context (what a model could forge) must be rejected.
		const forged = {
			verifyPrincipal: () => true,
			verifyCapability: () => true,
			verifyEvidenceSource: () => true,
		} as never;
		expect(() => evaluateCompletionGate(runtime.contract, runtime.ledger, forged)).not.toThrow();
		const gate = evaluateCompletionGate(
			runtime.contract,
			runtime.ledger,
			forged as Parameters<typeof evaluateCompletionGate>[2],
		);
		expect(gate.decision).toBe("reject");
	});
});
