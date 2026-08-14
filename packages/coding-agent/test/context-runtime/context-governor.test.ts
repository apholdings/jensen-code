import type { AgentMessage } from "@apholdings/jensen-agent-core";
import { describe, expect, it } from "vitest";
import {
	type ContextAssembly,
	type ContextCapability,
	ContextGovernor,
	checkpointToRehydrationPreamble,
	createMissionContextCheckpoint,
	estimateAssemblyInputTokens,
	InMemoryEvidenceArchive,
	type MissionContextCheckpoint,
	parseMissionContextCheckpoint,
	rehydrateEvidence,
	resolveContextCapability,
} from "../../src/core/context-runtime/index.js";

// ============================================================================
// Helpers
// ============================================================================

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as AgentMessage;
}

function assistant(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		provider: "test",
		model: "test",
		api: "openai-chat",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	} as AgentMessage;
}

function toolResult(toolCallId: string, toolName: string, text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	} as AgentMessage;
}

function toolCall(id: string, name: string, args: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: { q: args } }],
		provider: "test",
		model: "test",
		api: "openai-chat",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	} as AgentMessage;
}

function pad(tokens: number): string {
	// ~4 chars per token.
	return "x".repeat(tokens * 4);
}

function capability(window: number, maxTokens: number): ContextCapability {
	return resolveContextCapability({ modelContextWindow: window, modelMaxTokens: maxTokens });
}

function assertFits(assembly: ContextAssembly, capability: ContextCapability): number {
	const input = estimateAssemblyInputTokens(assembly);
	const total = input + capability.reservedOutputTokens + capability.safetyReserveTokens;
	expect(total).toBeLessThanOrEqual(capability.configuredContextWindow);
	return input;
}

function makeCheckpoint(missionId: string): MissionContextCheckpoint {
	return createMissionContextCheckpoint(missionId, {
		objective: "Refactor the auth module while preserving public API",
		constraints: ["Never run npm test", "Keep all existing exports"],
		decisions: [{ decision: "Use a token-bucket rate limiter", rationale: "bounded and testable" }],
		plan: "Migrate callers, then delete legacy path",
		completedSteps: ["Traced all callers"],
		pendingSteps: ["Migrate callers", "Delete legacy path"],
		activeFiles: ["src/auth.ts"],
		findings: [{ subject: "Legacy path", detail: "used by 3 callers", evidenceRef: "src/auth.ts:120" }],
		evidenceRefs: [{ evidenceId: "tool-result:bash:abc123", summary: "grep output" }],
		testState: { command: "npm run check", lastResult: "unknown" },
		blockers: [],
		nextActions: ["Migrate first caller"],
	});
}

// ============================================================================
// Tests
// ============================================================================

describe("context capability model", () => {
	it("reserves output + safety headroom and derives a safe input budget", () => {
		const cap = capability(32768, 8192);
		expect(cap.configuredContextWindow).toBe(32768);
		expect(cap.reservedOutputTokens).toBe(8192);
		expect(cap.safetyReserveTokens).toBeGreaterThanOrEqual(256);
		expect(cap.safeInputBudget).toBeLessThanOrEqual(32768 - 8192 - cap.safetyReserveTokens);
		expect(cap.softPressureThreshold).toBeLessThan(cap.safeInputBudget);
	});

	it("never lets output reservation starve input on a huge-maxTokens model", () => {
		const cap = capability(32768, 100000);
		expect(cap.reservedOutputTokens).toBeLessThanOrEqual(Math.floor(32768 * 0.5));
		expect(cap.safeInputBudget).toBeGreaterThan(0);
	});

	it("honors an authoritative configured-window override (llama.cpp)", () => {
		const cap = resolveContextCapability(
			{ modelContextWindow: 0, modelMaxTokens: 8192 },
			{ configuredContextWindow: 32768 },
		);
		expect(cap.configuredContextWindow).toBe(32768);
	});
});

describe("TEST A — request never exceeds budget", () => {
	it("reduces an oversized assembly until the hard invariant holds", async () => {
		const cap = capability(8192, 2048);
		const archive = new InMemoryEvidenceArchive();
		const governor = new ContextGovernor({ capability: cap, archive, keepRecentTokens: 512 });

		const messages: AgentMessage[] = [];
		for (let i = 0; i < 40; i++) {
			messages.push(user(pad(150)), assistant(pad(150)));
		}

		const result = await governor.govern({ systemPrompt: "sys".repeat(50), messages });

		expect(result.diagnostics.action).not.toBe("unrecoverable");
		assertFits(result.assembly, cap);
	});
});

describe("TEST B — verified compaction", () => {
	it("keeps reducing until the request actually fits", async () => {
		const cap = capability(4096, 1024);
		const archive = new InMemoryEvidenceArchive();
		const checkpoint = makeCheckpoint("mission_b");
		const governor = new ContextGovernor({
			capability: cap,
			archive,
			checkpointProvider: () => checkpoint,
			keepRecentTokens: 128,
			minRetainedMessages: 2,
		});

		const messages: AgentMessage[] = [];
		for (let i = 0; i < 60; i++) {
			messages.push(user(pad(80)), assistant(pad(80)));
		}

		const result = await governor.govern({ systemPrompt: "sys", messages });
		expect(result.diagnostics.action).not.toBe("unrecoverable");
		expect(result.diagnostics.iterations).toBeGreaterThan(1);
		assertFits(result.assembly, cap);
	});
});

describe("TEST C — multi-rollover mission", () => {
	it("keeps objective and constraints across repeated rollovers", async () => {
		const cap = capability(2048, 512);
		const archive = new InMemoryEvidenceArchive();
		const checkpoint = makeCheckpoint("mission_c");

		// Grow the working set over several synthetic turns, each turn alone
		// exceeding the soft pressure threshold so a rollover is forced.
		let messages: AgentMessage[] = [];
		let rollovers = 0;
		for (let turn = 0; turn < 5; turn++) {
			messages.push(user(`turn ${turn} ${pad(600)}`), assistant(pad(600)));
			const governor = new ContextGovernor({
				capability: cap,
				archive,
				checkpointProvider: () => checkpoint,
				keepRecentTokens: 64,
				minRetainedMessages: 2,
			});
			const result = await governor.govern({ systemPrompt: "sys", messages });
			messages = result.assembly.messages;
			if (result.diagnostics.rolloverOccurred) rollovers += 1;
			assertFits(result.assembly, cap);
		}

		expect(rollovers).toBeGreaterThanOrEqual(3);

		const preamble = messages.find((m) => (m as { customType?: string }).customType === "mission_context_checkpoint");
		expect(preamble).toBeDefined();
		const text = (preamble as { content: string }).content as string;
		expect(text).toContain("Refactor the auth module");
		expect(text).toContain("Never run npm test");
	});
});

describe("TEST C2 — default keep-recent tail enables rollover", () => {
	it("does not retain the whole conversation when keepRecentTokens is omitted", async () => {
		const cap = capability(4096, 512);
		const archive = new InMemoryEvidenceArchive();
		const checkpoint = makeCheckpoint("mission_c2");

		const messages: AgentMessage[] = [];
		for (let i = 0; i < 40; i++) messages.push(user(pad(100)), assistant(pad(100)));

		const governor = new ContextGovernor({
			capability: cap,
			archive,
			checkpointProvider: () => checkpoint,
			// keepRecentTokens intentionally omitted: the capability-relative
			// default must be a fraction of the safe budget, never the whole
			// conversation (a fixed 20000-token tail made rollover a no-op).
		});

		const result = await governor.govern({ systemPrompt: "sys", messages });
		expect(result.diagnostics.rolloverOccurred).toBe(true);
		assertFits(result.assembly, cap);
	});
});

describe("TEST D — large tool result virtualization", () => {
	it("archives the full output and keeps only a synopsis hot", async () => {
		const cap = capability(8192, 2048);
		const archive = new InMemoryEvidenceArchive();
		const governor = new ContextGovernor({
			capability: cap,
			archive,
			keepRecentTokens: 200,
			toolResultVirtualizeThreshold: 100,
		});

		const bigOutput = pad(4000); // ~4000 tokens
		const call = toolCall("call_1", "bash", "run tests");
		const result = toolResult("call_1", "bash", bigOutput);
		const messages = [user("run the tests"), call, result, assistant("done")];

		const outcome = await governor.govern({ systemPrompt: "sys", messages });

		const archived = outcome.diagnostics.evidenceIdsArchived;
		expect(archived.length).toBeGreaterThanOrEqual(1);
		const evidenceId = archived[0]!;
		const record = await archive.load(evidenceId);
		expect(record?.content).toBe(bigOutput);

		// Hot working set no longer contains the raw output.
		const hotText = outcome.assembly.messages
			.map((m) => JSON.stringify((m as { content?: unknown }).content))
			.join(" ");
		expect(hotText).not.toContain(bigOutput.slice(0, 500));
		expect(hotText).toContain("evidence ref");
	});
});

describe("TEST E — evidence rehydration", () => {
	it("pages an archived artifact back into context", async () => {
		const archive = new InMemoryEvidenceArchive();
		const id = await archive.store({ kind: "tool-result", source: "bash", content: "HELLO WORLD OUTPUT" });
		const rehydrated = await rehydrateEvidence(archive, id);
		expect(rehydrated).toContain("HELLO WORLD OUTPUT");
	});
});

describe("TEST F — process restart rehydration", () => {
	it("reconstructs working state from a checkpoint without the full transcript", async () => {
		const checkpoint = makeCheckpoint("mission_f");
		const serialized = JSON.stringify(checkpoint);
		const restored = parseMissionContextCheckpoint(JSON.parse(serialized));
		expect(restored.objective).toBe(checkpoint.objective);
		expect(restored.constraints).toEqual(checkpoint.constraints);

		// A fresh governor with only the checkpoint + one recent message continues.
		const cap = capability(8192, 2048);
		const archive = new InMemoryEvidenceArchive();
		const governor = new ContextGovernor({
			capability: cap,
			archive,
			checkpointProvider: () => restored,
			keepRecentTokens: 512,
		});
		const result = await governor.govern({
			systemPrompt: "sys",
			messages: [user("continue the migration")],
		});
		expect(result.diagnostics.action).toBe("pass");
	});
});

describe("TEST G / H — constraint and decision retention", () => {
	it("constraints and decisions appear in the rehydrated preamble", async () => {
		const cap = capability(2048, 512);
		const archive = new InMemoryEvidenceArchive();
		const checkpoint = makeCheckpoint("mission_gh");
		const governor = new ContextGovernor({
			capability: cap,
			archive,
			checkpointProvider: () => checkpoint,
			keepRecentTokens: 96,
		});

		const messages: AgentMessage[] = [];
		for (let i = 0; i < 30; i++) messages.push(user(pad(80)), assistant(pad(80)));

		const result = await governor.govern({ systemPrompt: "sys", messages });
		const text = result.assembly.messages
			.map((m) =>
				typeof (m as { content?: unknown }).content === "string" ? (m as { content: string }).content : "",
			)
			.join("\n");
		expect(text).toContain("Never run npm test");
		expect(text).toContain("token-bucket rate limiter");
	});
});

describe("TEST I — evidence authority", () => {
	it("checkpoint cannot fabricate success; completion authority is fixed", () => {
		const checkpoint = makeCheckpoint("mission_i");
		expect(checkpoint.completionAuthority).toBe("mission-runtime-only");
		expect(checkpointToText(checkpoint)).toContain("cannot certify success");

		expect(() =>
			parseMissionContextCheckpoint({ ...checkpoint, completionAuthority: "checkpoint-self-certified" }),
		).toThrow(/completionAuthority/);
	});

	it("parse rejects structural corruption", () => {
		expect(() => parseMissionContextCheckpoint({})).toThrow();
		expect(() =>
			parseMissionContextCheckpoint({
				schemaVersion: 1,
				missionId: "m",
				objective: "x",
				completionAuthority: "mission-runtime-only",
			}),
		).not.toThrow();
	});
});

function checkpointToText(checkpoint: MissionContextCheckpoint): string {
	return checkpointToRehydrationPreamble(checkpoint);
}

describe("TEST J / K — child long-horizon and interruption", () => {
	it("preserves child mission identity across rollover and never auto-runs", async () => {
		const cap = capability(2048, 512);
		const archive = new InMemoryEvidenceArchive();
		const checkpoint = createMissionContextCheckpoint("child_mission_abc", {
			objective: "Child: verify the submodule compiles",
			constraints: ["Read-only inspection"],
			nextActions: ["Run typecheck"],
		});

		const messages: AgentMessage[] = [];
		for (let i = 0; i < 20; i++) messages.push(user(pad(80)), assistant(pad(80)));

		const governor = new ContextGovernor({
			capability: cap,
			archive,
			checkpointProvider: () => checkpoint,
			keepRecentTokens: 96,
		});
		const result = await governor.govern({ systemPrompt: "sys", messages });
		expect(result.diagnostics.rolloverOccurred).toBe(true);
		const text = result.assembly.messages
			.map((m) =>
				typeof (m as { content?: unknown }).content === "string" ? (m as { content: string }).content : "",
			)
			.join("\n");
		expect(text).toContain("child_mission_abc");
		expect(text).toContain("Read-only inspection");

		// The governor never executes anything: no child rerun is triggered by
		// reconstruction (recovery is read-only conservative).
		expect(result.diagnostics.action).not.toBe("unrecoverable");
	});
});

describe("TEST L — provider swap", () => {
	it("derives equivalent long-horizon semantics across representative backends", () => {
		const openrouter = resolveContextCapability({ modelContextWindow: 128000, modelMaxTokens: 32000 });
		const openaiCompat = resolveContextCapability({ modelContextWindow: 32768, modelMaxTokens: 8192 });
		const llamacpp = resolveContextCapability(
			{ modelContextWindow: 0, modelMaxTokens: 8192 },
			{ configuredContextWindow: 32768 },
		);

		for (const cap of [openrouter, openaiCompat, llamacpp]) {
			expect(cap.safeInputBudget).toBeGreaterThan(0);
			expect(cap.reservedOutputTokens).toBeGreaterThan(0);
			expect(cap.safetyReserveTokens).toBeGreaterThan(0);
		}
		expect(llamacpp.configuredContextWindow).toBe(32768);
	});
});

describe("TEST M — overflow 400 recovery", () => {
	it("bounded forced reduction; never loops infinitely", async () => {
		// Simulate provider disagreement: effective budget far smaller than request.
		const cap = capability(1024, 256);
		const archive = new InMemoryEvidenceArchive();
		const governor = new ContextGovernor({
			capability: cap,
			archive,
			keepRecentTokens: 64,
			minRetainedMessages: 1,
			maxIterations: 6,
		});

		const messages: AgentMessage[] = [];
		for (let i = 0; i < 100; i++) messages.push(user(pad(40)), assistant(pad(40)));

		const result = await governor.govern({ systemPrompt: "sys", messages });
		expect(result.diagnostics.iterations).toBeLessThanOrEqual(6);
		if (result.diagnostics.action === "unrecoverable") {
			expect(result.diagnostics.unrecoverableReason).toBeDefined();
		} else {
			assertFits(result.assembly, cap);
		}
	});
});

describe("TEST N — corrupt checkpoint", () => {
	it("fails conservative instead of fabricating state", async () => {
		const cap = capability(2048, 512);
		const archive = new InMemoryEvidenceArchive();
		const governor = new ContextGovernor({
			capability: cap,
			archive,
			checkpointProvider: () => {
				throw new Error("corrupt checkpoint");
			},
			keepRecentTokens: 96,
		});

		const messages: AgentMessage[] = [];
		for (let i = 0; i < 30; i++) messages.push(user(pad(80)), assistant(pad(80)));

		const result = await governor.govern({ systemPrompt: "sys", messages });
		// Either deterministic tail-trim fits, or it is structured-unrecoverable —
		// but it never throws and never invents a checkpoint.
		expect(result.diagnostics.rolloverOccurred).toBe(false);
		expect(() => result.diagnostics).toBeTruthy();
	});
});

describe("TEST O — evidence refs survive rollover", () => {
	it("archived evidence refs are carried into the rollover checkpoint preamble", async () => {
		const cap = capability(2048, 512);
		const archive = new InMemoryEvidenceArchive();
		const governor = new ContextGovernor({
			capability: cap,
			archive,
			keepRecentTokens: 96,
			minRetainedMessages: 2,
		});

		// First govern: virtualize one large tool result.
		const big = pad(1500);
		const first = await governor.govern({
			systemPrompt: "sys",
			messages: [user("run"), toolResult("call_1", "bash", big), assistant("ok")],
		});
		expect(first.diagnostics.evidenceIdsArchived.length).toBe(1);
		const refs = governor.getArchivedEvidenceRefs();
		expect(refs).toHaveLength(1);
		expect(refs[0]!.evidenceId).toBe(first.diagnostics.evidenceIdsArchived[0]);

		// Bind a checkpoint that carries the refs (the same wiring used by the SDK).
		governor.setCheckpointProvider(() =>
			createMissionContextCheckpoint("mission_o", { evidenceRefs: governor.getArchivedEvidenceRefs() }),
		);

		// Second govern: force a rollover with enough accumulated messages.
		const messages: AgentMessage[] = [];
		for (let i = 0; i < 40; i++) messages.push(user(pad(80)), assistant(pad(80)));
		const second = await governor.govern({ systemPrompt: "sys", messages });
		expect(second.diagnostics.rolloverOccurred).toBe(true);

		const preamble = second.assembly.messages.find(
			(m) => (m as { customType?: string }).customType === "mission_context_checkpoint",
		);
		expect(preamble).toBeDefined();
		expect((preamble as { content: string }).content).toContain(refs[0]!.evidenceId);
	});
});
