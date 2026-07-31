/**
 * Regression tests for tool-call transcript integrity.
 *
 * The release fix disables all historical todo_write folding/compaction. Every
 * assistant tool-call span and its matching tool result must be preserved in
 * chronological order so the wire payload is always provider-clean.
 */

import type { AgentMessage } from "@apholdings/jensen-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@apholdings/jensen-ai";
import {
	type Message,
	validateChatCompletionsTranscript,
	validateResponsesTranscript,
	validateToolSpanIntegrity,
} from "@apholdings/jensen-ai";
import { describe, expect, it } from "vitest";
import { convertToLlm } from "./messages.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function mkAssistant(
	content: Array<{ type: string; id?: string; name?: string; arguments?: Record<string, unknown>; text?: string }>,
	stopReason: "toolUse" | "stop" = "toolUse",
): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "openrouter",
		model: "deepseek/deepseek-v4-flash-0731",
		usage,
		stopReason,
		timestamp: 1000,
		content: content as AssistantMessage["content"],
	};
}

function makeAssistantToolCall(toolName: string, id: string, args?: Record<string, unknown>): AssistantMessage {
	return mkAssistant([{ type: "toolCall", name: toolName, id, arguments: args ?? {} }]);
}

function makeAssistantText(text: string): AssistantMessage {
	return mkAssistant([{ type: "text", text }], "stop");
}

function makeBashExec(output: string): AgentMessage {
	return {
		role: "bashExecution",
		command: "echo hello",
		output,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: Date.now(),
	} satisfies AgentMessage;
}

function makeToolResult(toolName: string, toolCallId: string, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "done" }],
		isError,
		timestamp: 2000,
	};
}

type FMsg =
	| ReturnType<typeof makeAssistantToolCall>
	| ReturnType<typeof makeBashExec>
	| ReturnType<typeof makeToolResult>
	| ReturnType<typeof makeAssistantText>;

// ---------------------------------------------------------------------------
// convertToLlm orphan detection
// ---------------------------------------------------------------------------

describe("convertToLlm: no folding, every span preserved", () => {
	it("preserves every tool result including todo_write", () => {
		const messages: FMsg[] = [
			makeAssistantToolCall("todo_write", "call_abc"),
			makeBashExec("stdout output"),
			makeToolResult("todo_write", "call_abc"),
			makeAssistantToolCall("read_file", "call_xyz"),
			makeToolResult("read_file", "call_xyz"),
		];
		const llmMessages = convertToLlm(messages);
		const toolResults = llmMessages.filter((m) => m.role === "toolResult");
		expect(toolResults).toHaveLength(2);
		expect(toolResults[0].toolCallId).toBe("call_abc");
		expect(toolResults[1].toolCallId).toBe("call_xyz");
	});

	it("keeps non-todo_write toolResults intact", () => {
		const llmMessages = convertToLlm([
			makeAssistantToolCall("read_file", "call_rf"),
			makeToolResult("read_file", "call_rf"),
		]);
		const toolResults = llmMessages.filter((m) => m.role === "toolResult");
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].toolCallId).toBe("call_rf");
	});

	it("incomplete todo_write span (no result yet) keeps both halves", () => {
		const llmMessages = convertToLlm([makeAssistantToolCall("todo_write", "call_incomplete")]);
		expect(llmMessages).toHaveLength(1);
		expect(llmMessages[0].role).toBe("assistant");
		if (llmMessages[0].role === "assistant") {
			const toolCalls = llmMessages[0].content.filter((b) => b.type === "toolCall");
			expect(toolCalls).toHaveLength(1);
			expect(toolCalls[0].id).toBe("call_incomplete");
		}
	});

	it("todo_write + bash — todo result visible", () => {
		const messages: FMsg[] = [
			makeAssistantToolCall("todo_write", "call_tw"),
			makeBashExec("ls output"),
			makeToolResult("todo_write", "call_tw"),
		];
		const llmMessages = convertToLlm(messages);
		const toolResults = llmMessages.filter((m) => m.role === "toolResult");
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].toolCallId).toBe("call_tw");
	});

	it("todo_write error result also survives", () => {
		const llmMessages = convertToLlm([
			makeAssistantToolCall("todo_write", "call_err"),
			makeBashExec("error"),
			makeToolResult("todo_write", "call_err", true),
		]);
		const toolResults = llmMessages.filter((m) => m.role === "toolResult");
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].isError).toBe(true);
	});

	it("multiple parallel tools — all results preserved", () => {
		const assistant = mkAssistant([
			{ type: "toolCall", name: "todo_write", id: "c1" },
			{ type: "toolCall", name: "bash", id: "c2" },
			{ type: "toolCall", name: "read_file", id: "c3" },
		]);
		const messages: FMsg[] = [
			assistant,
			makeBashExec("ls -la"),
			makeToolResult("todo_write", "c1"),
			makeToolResult("bash", "c2"),
			makeToolResult("read_file", "c3"),
		];
		const llmMessages = convertToLlm(messages);
		const toolResults = llmMessages.filter((m) => m.role === "toolResult");
		expect(toolResults).toHaveLength(3);
		const ids = toolResults.map((m) => m.toolCallId);
		expect(ids).toContain("c1");
		expect(ids).toContain("c2");
		expect(ids).toContain("c3");
	});

	it("sequential spans remain grouped", () => {
		const llmMessages = convertToLlm([
			makeAssistantToolCall("todo_write", "c_tw"),
			makeToolResult("todo_write", "c_tw"),
			makeAssistantToolCall("read_file", "c_rf"),
			makeToolResult("read_file", "c_rf"),
		]);
		const toolResults = llmMessages.filter((m) => m.role === "toolResult");
		expect(toolResults).toHaveLength(2);
		expect(toolResults.map((r) => r.toolCallId)).toEqual(["c_tw", "c_rf"]);
	});
});

// ---------------------------------------------------------------------------
// Provider-level transcript validation catches orphans
// ---------------------------------------------------------------------------

describe("transcript validation catches orphan results pre-transport", () => {
	it("detects orphan toolResult in chat completions flow", () => {
		const assistant = makeAssistantToolCall("read_file", "call_ok");
		const orphanTw = {
			role: "toolResult",
			toolCallId: "orphan_tw",
			toolName: "todo_write",
			content: [{ type: "text", text: "done" }],
			timestamp: 3000,
		} as unknown as Message;
		const result = validateChatCompletionsTranscript([assistant, orphanTw], "openrouter", "gpt-5.6-luna");
		expect("code" in result).toBe(true);
		if ("code" in result) {
			expect(result.code).toBe("INVALID_TOOL_TRANSCRIPT");
			expect(result.orphanToolResultIds).toContain("orphan_tw");
		}
	});

	it("valid complete span passes chat completions validator", () => {
		const assistant = makeAssistantToolCall("read_file", "call_ok");
		const result = makeToolResult("read_file", "call_ok");
		expect(validateChatCompletionsTranscript([assistant, result], "openrouter", "gpt-5.6-luna")).toEqual({
			ok: true,
		});
	});

	it("valid complete span passes responses validator", () => {
		const assistant = makeAssistantToolCall("read_file", "call_resp");
		const result = makeToolResult("read_file", "call_resp");
		expect(validateResponsesTranscript([assistant, result], "opencode-go", "gpt-5.6-luna")).toEqual({ ok: true });
	});

	it("duplicate tool results detected by chat completions validator", () => {
		const assistant = makeAssistantToolCall("read_file", "call_dup");
		const r1 = makeToolResult("read_file", "call_dup");
		const r2 = makeToolResult("read_file", "call_dup");
		const result = validateChatCompletionsTranscript([assistant, r1, r2], "openrouter", "gpt-5.6-luna");
		expect("code" in result).toBe(true);
	});

	it("span checker detects orphan tool results", () => {
		const assistant = makeAssistantToolCall("read_file", "call_ok");
		const orphanTw = {
			role: "toolResult",
			toolCallId: "orphan_tw",
			toolName: "todo_write",
			content: [{ type: "text", text: "done" }],
			timestamp: 3000,
		} as unknown as Message;
		const spanCheck = validateToolSpanIntegrity([assistant, orphanTw]);
		expect(spanCheck.valid).toBe(false);
		expect(spanCheck.orphanToolResultIds).toContain("orphan_tw");
	});
});

// ---------------------------------------------------------------------------
// Full pipeline: convertToLlm → validate (simulates wire payload)
// ---------------------------------------------------------------------------

describe("full pipeline: produces provider-clean payload end-to-end", () => {
	it("chat completions: todo_write → read_file → clean wire payload", () => {
		const messages: FMsg[] = [
			makeAssistantToolCall("todo_write", "call_tw_001"),
			makeToolResult("todo_write", "call_tw_001"),
			makeAssistantToolCall("read_file", "call_rf_001"),
			makeToolResult("read_file", "call_rf_001"),
		];
		const llmMessages = convertToLlm(messages);
		expect(llmMessages.filter((m) => m.role === "toolResult")).toHaveLength(2);
		const spanCheck = validateToolSpanIntegrity(llmMessages);
		expect(spanCheck.valid).toBe(true);
		const validation = validateChatCompletionsTranscript(
			llmMessages,
			"openrouter",
			"deepseek/deepseek-v4-flash-0731",
		);
		expect(validation).toEqual({ ok: true });
	});

	it("responses API: GPT-5.6 Luna — canonical function_call/output ordering", () => {
		const messages: FMsg[] = [
			makeAssistantToolCall("todo_write", "call_tw_luna"),
			makeToolResult("todo_write", "call_tw_luna"),
			makeAssistantText("Analysis complete."),
		];
		const llmMessages = convertToLlm(messages);
		expect(llmMessages.filter((m) => m.role === "toolResult")).toHaveLength(1);
		const validation = validateResponsesTranscript(llmMessages, "openrouter", "openai/gpt-5.6-luna");
		expect(validation).toEqual({ ok: true });
	});

	it("historical text placeholder span does not break validation", () => {
		const sessionMessages: FMsg[] = [
			mkAssistant(
				[
					{
						type: "text",
						text: "A previous summary.",
					},
				],
				"stop",
			) as FMsg,
			makeAssistantToolCall("read_file", "call_new"),
			makeToolResult("read_file", "call_new"),
		];
		const llmMessages = convertToLlm(sessionMessages);
		const spanCheck = validateToolSpanIntegrity(llmMessages);
		expect(spanCheck.valid).toBe(true);
		const validation = validateChatCompletionsTranscript(
			llmMessages,
			"openrouter",
			"deepseek/deepseek-v4-flash-0731",
		);
		expect(validation).toEqual({ ok: true });
	});

	it("todo_write followed by multiple sequential tools — canonical spans", () => {
		const messages: FMsg[] = [
			makeAssistantToolCall("todo_write", "tw_01"),
			makeToolResult("todo_write", "tw_01"),
			makeAssistantToolCall("read_file", "rf_01"),
			makeToolResult("read_file", "rf_01"),
			makeAssistantText("Complete."),
		];
		const llmMessages = convertToLlm(messages);
		expect(llmMessages.filter((m) => m.role === "assistant")).toHaveLength(3);
		expect(llmMessages.filter((m) => m.role === "toolResult")).toHaveLength(2);
		const validation = validateChatCompletionsTranscript(
			llmMessages,
			"openrouter",
			"deepseek/deepseek-v4-flash-0731",
		);
		expect(validation).toEqual({ ok: true });
	});

	it("todo_write followed by parallel tools remains valid", () => {
		const llmMessages = convertToLlm([
			makeAssistantToolCall("todo_write", "tw_par"),
			makeAssistantToolCall("read_file", "rf_p1"),
			makeToolResult("todo_write", "tw_par"),
			makeToolResult("read_file", "rf_p1"),
		]);
		expect(llmMessages.filter((m) => m.role === "toolResult")).toHaveLength(2);
	});

	it("todo_write stale-revision error remains paired (non-todo-write result preserved)", () => {
		const llmMessages = convertToLlm([
			makeAssistantToolCall("todo_update", "tu_stale"),
			makeToolResult("todo_update", "tu_stale", true),
		]);
		const toolResults = llmMessages.filter((m) => m.role === "toolResult");
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].toolCallId).toBe("tu_stale");
	});
});
