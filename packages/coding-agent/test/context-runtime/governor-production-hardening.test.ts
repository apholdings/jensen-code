import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@apholdings/jensen-agent-core";
import type { AssistantMessage } from "@apholdings/jensen-ai";
import { isContextOverflow } from "@apholdings/jensen-ai";
import { describe, expect, it } from "vitest";
import {
	type ContextCapability,
	ContextGovernor,
	createMissionContextCheckpoint,
	EvidenceFileStore,
	InMemoryEvidenceArchive,
	type MissionContextCheckpoint,
	resolveContextCapability,
	type ToolVirtualizationRecord,
} from "../../src/core/context-runtime/index.js";
import { SessionManager } from "../../src/core/session-manager.js";

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
		api: "openai-completions",
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

function toolCall(id: string, name: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: { q: "x" } }],
		provider: "test",
		model: "test",
		api: "openai-completions",
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

function toolResult(toolCallId: string, toolName: string, text: string, details?: unknown): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		details,
		isError: false,
		timestamp: Date.now(),
	} as AgentMessage;
}

function pad(tokens: number): string {
	return "x".repeat(tokens * 4);
}

function capability(window: number, maxTokens: number, reasoning = false): ContextCapability {
	return resolveContextCapability({ modelContextWindow: window, modelMaxTokens: maxTokens, reasoning });
}

function hotText(messages: AgentMessage[]): string {
	return messages.map((m) => JSON.stringify((m as { content?: unknown }).content ?? "")).join(" ");
}

function makeCheckpoint(missionId: string): MissionContextCheckpoint {
	return createMissionContextCheckpoint(missionId, {
		objective: "Refactor auth while preserving public API",
		constraints: ["Never run npm test", "Keep all existing exports"],
		evidenceRefs: [],
	});
}

// ============================================================================
// TEST A/B — cross-request and process-restart virtualization
// ============================================================================

describe("TEST A/B — durable virtualization across requests and restarts", () => {
	it("TEST A — raw payload does not reappear on the next request (fresh governor + ledger)", async () => {
		const archive = new InMemoryEvidenceArchive();
		const governor = new ContextGovernor({
			capability: capability(8192, 2048),
			archive,
			toolResultVirtualizeThreshold: 100,
		});

		const big = pad(2000);
		const raw = [user("run"), toolCall("call_1", "bash"), toolResult("call_1", "bash", big), assistant("ok")];

		const first = await governor.govern({ systemPrompt: "sys", messages: raw });
		expect(first.diagnostics.evidenceIdsArchived.length).toBeGreaterThanOrEqual(1);
		const ledger = governor.getVirtualizations();
		expect(ledger).toHaveLength(1);

		// A fresh governor (new request/process) seeded from the persisted ledger.
		const fresh = new ContextGovernor({
			capability: capability(8192, 2048),
			archive,
			initialVirtualizations: ledger,
			toolResultVirtualizeThreshold: 100,
		});
		const second = await fresh.govern({ systemPrompt: "sys", messages: raw });
		expect(second.diagnostics.evidenceIdsArchived).toHaveLength(0);
		expect(second.diagnostics.toolResultsRevirtualized).toBeGreaterThanOrEqual(1);
		expect(hotText(second.assembly.messages)).not.toContain(big.slice(0, 500));
		expect(hotText(second.assembly.messages)).toContain("evidence ref");
	});

	it("TEST B — virtualization survives a durable file store (process restart)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "jensen-gov-restart-"));
		try {
			const raw = [
				user("run"),
				toolCall("call_1", "bash"),
				toolResult("call_1", "bash", pad(2000)),
				assistant("ok"),
			];

			const archive1 = new EvidenceFileStore(join(dir, "evidence"));
			const governor1 = new ContextGovernor({
				capability: capability(8192, 2048),
				archive: archive1,
				toolResultVirtualizeThreshold: 100,
			});
			await governor1.govern({ systemPrompt: "sys", messages: raw });
			const ledger = governor1.getVirtualizations();
			expect(ledger).toHaveLength(1);
			const evidenceId = ledger[0]!.evidenceId;

			// New archive + new governor = process restart.
			const archive2 = new EvidenceFileStore(join(dir, "evidence"));
			expect(await archive2.has(evidenceId)).toBe(true);

			const governor2 = new ContextGovernor({
				capability: capability(8192, 2048),
				archive: archive2,
				initialVirtualizations: ledger,
				toolResultVirtualizeThreshold: 100,
			});
			const second = await governor2.govern({ systemPrompt: "sys", messages: raw });
			expect(hotText(second.assembly.messages)).not.toContain(pad(2000).slice(0, 500));
			expect(second.diagnostics.evidenceIdsArchived).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ============================================================================
// TEST C/D — evidence identity reuse
// ============================================================================

describe("TEST C/D — evidence identity reuse", () => {
	it("TEST C — retrieve → cool → re-virtualize reuses the same evidence id", async () => {
		const archive = new InMemoryEvidenceArchive();
		const governor = new ContextGovernor({
			capability: capability(8192, 2048),
			archive,
			toolResultVirtualizeThreshold: 100,
		});

		const big = pad(2000);
		const raw = [user("run"), toolCall("call_1", "bash"), toolResult("call_1", "bash", big), assistant("ok")];
		const first = await governor.govern({ systemPrompt: "sys", messages: raw });
		const evidenceId = first.diagnostics.evidenceIdsArchived[0]!;
		expect(archive.size).toBe(1);

		// The model retrieves the artifact back into hot context, then it cools.
		const retrieved = toolResult("call_2", "retrieve_evidence", big, { __evidenceSourceId: evidenceId });
		const cooled = [user("continue"), toolCall("call_2", "retrieve_evidence"), retrieved, assistant("ok")];
		const second = await governor.govern({ systemPrompt: "sys", messages: cooled });

		expect(second.diagnostics.evidenceIdsArchived).toHaveLength(0);
		expect(archive.size).toBe(1);
		expect(hotText(second.assembly.messages)).toContain(evidenceId);
	});

	it("TEST D — repeated retrievals never grow the archive", async () => {
		const archive = new InMemoryEvidenceArchive();
		const governor = new ContextGovernor({
			capability: capability(8192, 2048),
			archive,
			toolResultVirtualizeThreshold: 100,
		});

		const big = pad(1500);
		const first = await governor.govern({
			systemPrompt: "sys",
			messages: [user("run"), toolCall("call_1", "bash"), toolResult("call_1", "bash", big), assistant("ok")],
		});
		const evidenceId = first.diagnostics.evidenceIdsArchived[0]!;
		expect(archive.size).toBe(1);

		for (let i = 0; i < 5; i++) {
			const callId = `retrieve_${i}`;
			await governor.govern({
				systemPrompt: "sys",
				messages: [
					user("again"),
					toolCall(callId, "retrieve_evidence"),
					toolResult(callId, "retrieve_evidence", big, { __evidenceSourceId: evidenceId }),
					assistant("ok"),
				],
			});
		}

		expect(archive.size).toBe(1);
		expect(governor.getArchivedEvidenceRefs()).toHaveLength(1);
	});
});

// ============================================================================
// TEST I — reasoning output reserve
// ============================================================================

describe("TEST I — reasoning output reserve", () => {
	it("reserves the full output budget (incl. reasoning) and never exceeds window", () => {
		const cap = capability(32768, 8192, true);
		expect(cap.reasoning).toBe(true);
		expect(cap.reservedOutputTokens).toBeLessThanOrEqual(Math.floor(32768 * 0.5));
		expect(cap.reservedOutputTokens).toBeGreaterThanOrEqual(1);
		expect(cap.safeInputBudget + cap.reservedOutputTokens + cap.safetyReserveTokens).toBeLessThanOrEqual(
			cap.configuredContextWindow,
		);
	});

	it("reasoning does not reduce the input budget below the fixed minimum", () => {
		const cap = resolveContextCapability({ modelContextWindow: 32768, modelMaxTokens: 8192, reasoning: true });
		expect(cap.safeInputBudget).toBeGreaterThan(0);
	});
});

// ============================================================================
// TEST J — provider overflow classification
// ============================================================================

function overflowMessage(errorMessage: string, usageInput = 0): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "test",
		model: "test",
		usage: {
			input: usageInput,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

describe("TEST J — provider overflow classification", () => {
	it("classifies context overflow across providers", () => {
		expect(isContextOverflow(overflowMessage("This model's maximum context length is 32768 tokens"))).toBe(true);
		expect(isContextOverflow(overflowMessage("prompt is too long: 100000 tokens > 8192 maximum"))).toBe(true);
		expect(isContextOverflow(overflowMessage("the request exceeds the available context size"))).toBe(true);
		expect(isContextOverflow(overflowMessage("Please reduce the length of the messages"))).toBe(true);
	});

	it("does NOT classify unrelated 400/other errors as context overflow", () => {
		expect(isContextOverflow(overflowMessage("400 Bad Request: invalid api key"))).toBe(false);
		expect(isContextOverflow(overflowMessage("429 rate limit exceeded"))).toBe(false);
		expect(isContextOverflow(overflowMessage("500 internal server error"))).toBe(false);
		expect(isContextOverflow(overflowMessage("model not found"))).toBe(false);
	});
});

// ============================================================================
// TEST K/L/M/N — recordOverflow wiring + forced reduction + bounded + adaptive
// ============================================================================

describe("TEST K/L/M/N — provider overflow recovery", () => {
	it("TEST L — authoritative overflow forces a measurably smaller retry", async () => {
		const archive = new InMemoryEvidenceArchive();
		const cap = capability(8192, 2048);
		const governor = new ContextGovernor({
			capability: cap,
			archive,
			keepRecentTokens: 512,
			minRetainedMessages: 2,
		});

		// Just under the initial safe input budget, so a single overflow pushes
		// the effective ceiling below the working set.
		const messages: AgentMessage[] = [];
		let target = 0;
		while (target < cap.safeInputBudget - 200) {
			messages.push(user(pad(200)), assistant(pad(200)));
			target += 400;
		}

		const before = await governor.govern({ systemPrompt: "sys", messages });
		const beforeTokens = before.diagnostics.inputTokensAfter;

		governor.recordOverflow({
			configuredContextWindow: cap.configuredContextWindow,
			estimatedInputTokens: beforeTokens,
			reservedOutputTokens: cap.reservedOutputTokens,
			safetyReserveTokens: cap.safetyReserveTokens,
			accountingMode: "conservative-estimate",
			providerError: "maximum context length is 8192 tokens",
		});

		const after = await governor.govern({ systemPrompt: "sys", messages });
		expect(after.diagnostics.inputTokensAfter).toBeLessThan(beforeTokens);
		expect(after.diagnostics.action).not.toBe("unrecoverable");
	});

	it("TEST N — adaptive safety lowers the effective budget, bounded and observable", async () => {
		const archive = new InMemoryEvidenceArchive();
		const cap = capability(8192, 2048);
		const governor = new ContextGovernor({ capability: cap, archive });

		const baseTelemetry = governor.getTelemetry();
		expect(baseTelemetry.effectiveSafeInputBudget).toBe(baseTelemetry.baseSafeInputBudget);

		for (let i = 0; i < 40; i++) {
			governor.recordOverflow({
				configuredContextWindow: cap.configuredContextWindow,
				estimatedInputTokens: 1000,
				reservedOutputTokens: cap.reservedOutputTokens,
				safetyReserveTokens: cap.safetyReserveTokens,
				accountingMode: "conservative-estimate",
			});
		}

		const adapted = governor.getTelemetry();
		expect(adapted.effectiveSafeInputBudget).toBeLessThan(adapted.baseSafeInputBudget);
		// Bounded: never collapses below the fixed minimum safe input budget.
		expect(adapted.effectiveSafeInputBudget).toBeGreaterThanOrEqual(256);
		expect(adapted.providerOverflowCount).toBe(40);
		expect(adapted.adaptiveSafetyReserveTokens).toBeGreaterThan(0);
	});

	it("TEST M — repeated overflow is bounded and never loops infinitely", async () => {
		const archive = new InMemoryEvidenceArchive();
		const governor = new ContextGovernor({
			capability: capability(1024, 256),
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
		}
	});
});

// ============================================================================
// TEST K — recordOverflow wired at the provider boundary
// ============================================================================

describe("TEST K — recordOverflow wired at provider boundary", () => {
	it("provider rejection → recordOverflow → stronger reduction → smaller retry", async () => {
		const archive = new InMemoryEvidenceArchive();
		const cap = capability(8192, 2048);
		const governor = new ContextGovernor({
			capability: cap,
			archive,
			keepRecentTokens: 512,
			minRetainedMessages: 2,
		});

		const messages: AgentMessage[] = [];
		let target = 0;
		while (target < cap.safeInputBudget - 200) {
			messages.push(user(pad(200)), assistant(pad(200)));
			target += 400;
		}

		const preflight = await governor.govern({ systemPrompt: "sys", messages });
		expect(preflight.diagnostics.action).not.toBe("unrecoverable");

		// The provider rejects the preflight request with a real overflow error.
		const providerError = overflowMessage("This model's maximum context length is 8192 tokens");
		expect(isContextOverflow(providerError, cap.configuredContextWindow)).toBe(true);

		// Exactly what AgentSession._checkCompaction now does before retrying.
		governor.recordOverflow({
			configuredContextWindow: cap.configuredContextWindow,
			estimatedInputTokens: preflight.diagnostics.inputTokensAfter,
			reservedOutputTokens: cap.reservedOutputTokens,
			safetyReserveTokens: cap.safetyReserveTokens,
			accountingMode: governor.getTokenAccountingMode(),
			providerError: providerError.errorMessage,
		});
		expect(governor.providerOverflowCount).toBe(1);
		expect(governor.getTelemetry().forcedReductionCount).toBe(1);

		const retry = await governor.govern({ systemPrompt: "sys", messages });
		expect(retry.diagnostics.action).not.toBe("unrecoverable");
		expect(retry.diagnostics.inputTokensAfter).toBeLessThan(preflight.diagnostics.inputTokensAfter);
	});
});

// ============================================================================
// TEST O — fixed prefix unsatisfiable
// ============================================================================

describe("TEST O — fixed prefix unsatisfiable", () => {
	it("fails structurally with region diagnostics", async () => {
		const archive = new InMemoryEvidenceArchive();
		const cap = capability(2048, 512);
		const governor = new ContextGovernor({ capability: cap, archive, minRetainedMessages: 1 });

		const hugeSystem = pad(4000); // system prompt alone exceeds the safe input budget
		const result = await governor.govern({ systemPrompt: hugeSystem, messages: [user("hi")] });

		expect(result.diagnostics.action).toBe("unrecoverable");
		expect(result.diagnostics.unrecoverableReason).toContain("systemPrompt");
		expect(result.diagnostics.unrecoverableReason).toContain("toolSchemas");
		expect(result.diagnostics.fixedPrefixTokens).toBeGreaterThan(cap.safeInputBudget);
	});
});

// ============================================================================
// TEST P — governor idempotence
// ============================================================================

describe("TEST P — governor idempotence", () => {
	it("govern(govern(x)) converges: no growth, no duplicate archives", async () => {
		const archive = new InMemoryEvidenceArchive();
		const governor = new ContextGovernor({
			capability: capability(8192, 2048),
			archive,
			toolResultVirtualizeThreshold: 100,
		});

		const big = pad(2000);
		const raw = [user("run"), toolCall("call_1", "bash"), toolResult("call_1", "bash", big), assistant("ok")];

		const first = await governor.govern({ systemPrompt: "sys", messages: raw });
		expect(first.diagnostics.evidenceIdsArchived.length).toBe(1);

		const second = await governor.govern({ systemPrompt: "sys", messages: first.assembly.messages });
		expect(second.diagnostics.evidenceIdsArchived).toHaveLength(0);
		expect(second.diagnostics.inputTokensAfter).toBeLessThanOrEqual(first.diagnostics.inputTokensAfter);
		expect(archive.size).toBe(1);
	});
});

// ============================================================================
// TEST Q — mission constraint retention under aggressive reduction
// ============================================================================

describe("TEST Q — mission constraint retention", () => {
	it("aggressive recovery cannot evict pinned constraints", async () => {
		const archive = new InMemoryEvidenceArchive();
		const checkpoint = makeCheckpoint("mission_q");
		const governor = new ContextGovernor({
			capability: capability(2048, 512),
			archive,
			checkpointProvider: () => checkpoint,
			keepRecentTokens: 64,
			minRetainedMessages: 1,
		});

		const messages: AgentMessage[] = [];
		for (let i = 0; i < 80; i++) messages.push(user(pad(80)), assistant(pad(80)));

		let result = await governor.govern({ systemPrompt: "sys", messages });
		for (let i = 0; i < 3; i++) {
			governor.recordOverflow({
				configuredContextWindow: 2048,
				estimatedInputTokens: result.diagnostics.inputTokensAfter,
				reservedOutputTokens: 512,
				safetyReserveTokens: result.diagnostics.capability.safetyReserveTokens,
				accountingMode: "conservative-estimate",
			});
			result = await governor.govern({ systemPrompt: "sys", messages: result.assembly.messages });
		}

		expect(hotText(result.assembly.messages)).toContain("Never run npm test");
		expect(hotText(result.assembly.messages)).toContain("Keep all existing exports");
	});
});

// ============================================================================
// TEST R/S — durable child session resume and standard session resume
// ============================================================================

describe("TEST R/S — session resume provenance", () => {
	it("TEST S — virtualization ledger survives standard session resume", async () => {
		const archive = new InMemoryEvidenceArchive();
		const session = SessionManager.inMemory();
		const governor = new ContextGovernor({
			capability: capability(8192, 2048),
			archive,
			toolResultVirtualizeThreshold: 100,
			virtualizationSink: (records) => session.appendSessionToolVirtualizations(records),
		});

		const big = pad(2000);
		const raw = [user("run"), toolCall("call_1", "bash"), toolResult("call_1", "bash", big), assistant("ok")];
		const first = await governor.govern({ systemPrompt: "sys", messages: raw });
		expect(first.diagnostics.evidenceIdsArchived.length).toBe(1);

		const persisted = session.getLatestSessionToolVirtualizations();
		expect(persisted).toHaveLength(1);

		// New governor (resume) seeded from the session ledger.
		const resumed = new ContextGovernor({
			capability: capability(8192, 2048),
			archive,
			initialVirtualizations: persisted.map((r) => r as unknown as ToolVirtualizationRecord),
			toolResultVirtualizeThreshold: 100,
		});
		const second = await resumed.govern({ systemPrompt: "sys", messages: raw });
		expect(hotText(second.assembly.messages)).not.toContain(big.slice(0, 500));
		expect(second.diagnostics.evidenceIdsArchived).toHaveLength(0);
	});

	it("TEST R — durable child session ledger survives child resume identity", async () => {
		const archive = new InMemoryEvidenceArchive();
		const childSession = SessionManager.createWithId(process.cwd(), undefined, "child_session_test");
		const governor = new ContextGovernor({
			capability: capability(8192, 2048),
			archive,
			toolResultVirtualizeThreshold: 100,
			virtualizationSink: (records) => childSession.appendSessionToolVirtualizations(records),
		});

		const big = pad(1500);
		const raw = [user("child run"), toolCall("call_1", "bash"), toolResult("call_1", "bash", big), assistant("ok")];
		const first = await governor.govern({ systemPrompt: "sys", messages: raw });
		expect(first.diagnostics.evidenceIdsArchived.length).toBe(1);

		const ledger = childSession.getLatestSessionToolVirtualizations() as unknown as ToolVirtualizationRecord[];
		expect(ledger).toHaveLength(1);

		const resumed = new ContextGovernor({
			capability: capability(8192, 2048),
			archive,
			initialVirtualizations: ledger,
			toolResultVirtualizeThreshold: 100,
		});
		const second = await resumed.govern({ systemPrompt: "sys", messages: raw });
		expect(hotText(second.assembly.messages)).not.toContain(big.slice(0, 500));
	});
});

// ============================================================================
// TEST T — provider swap semantics
// ============================================================================

describe("TEST T — provider swap", () => {
	it("derives equivalent safe budgets across representative backends", () => {
		const openrouter = resolveContextCapability({ modelContextWindow: 128000, modelMaxTokens: 32000 });
		const openaiCompat = resolveContextCapability({
			modelContextWindow: 32768,
			modelMaxTokens: 8192,
			reasoning: true,
		});
		const llamacpp = resolveContextCapability(
			{ modelContextWindow: 0, modelMaxTokens: 8192 },
			{ configuredContextWindow: 32768 },
		);
		for (const cap of [openrouter, openaiCompat, llamacpp]) {
			expect(cap.safeInputBudget).toBeGreaterThan(0);
			expect(cap.reservedOutputTokens).toBeGreaterThan(0);
			expect(cap.safetyReserveTokens).toBeGreaterThan(0);
		}
	});
});
