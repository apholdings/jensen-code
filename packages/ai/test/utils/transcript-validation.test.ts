import { describe, expect, test } from "vitest";
import {
	type AssistantMessage,
	type Message,
	type ToolResultMessage,
	validateChatCompletionsTranscript,
	validateResponsesTranscript,
	validateToolSpanIntegrity,
} from "../../src/index.js";

const BASE_ASSISTANT: Partial<AssistantMessage> = {
	role: "assistant",
	api: "openai-completions",
	provider: "openai",
	model: "gpt-5.6-luna",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
	timestamp: 1000,
};

function makeAssistant(toolCalls: Array<{ id: string; name: string }>): AssistantMessage {
	return {
		...(BASE_ASSISTANT as AssistantMessage),
		content: toolCalls.map((tc) => ({
			type: "toolCall" as const,
			id: tc.id,
			name: tc.name,
			arguments: {},
		})),
	};
}

function makeAssistantText(text: string): AssistantMessage {
	return {
		...(BASE_ASSISTANT as AssistantMessage),
		stopReason: "stop",
		content: [{ type: "text" as const, text }],
	};
}

function makeToolResult(toolCallId: string, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "testTool",
		content: [{ type: "text" as const, text: "result" }],
		isError,
		timestamp: 1001,
	};
}

function makeUser(text: string): Message {
	return { role: "user", content: text, timestamp: 999 };
}

describe("validateChatCompletionsTranscript", () => {
	test("one successful tool call", () => {
		const messages: Message[] = [
			makeUser("hello"),
			makeAssistant([{ id: "call_1", name: "testTool" }]),
			makeToolResult("call_1"),
		];
		const result = validateChatCompletionsTranscript(messages, "openai", "gpt-5.6-luna");
		expect(result).toEqual({ ok: true });
	});

	test("tool call returning an error result is still valid", () => {
		const messages: Message[] = [makeAssistant([{ id: "call_1", name: "testTool" }]), makeToolResult("call_1", true)];
		const result = validateChatCompletionsTranscript(messages, "openai", "gpt-5.6-luna");
		expect(result).toEqual({ ok: true });
	});

	test("parallel tool calls all completed", () => {
		const messages: Message[] = [
			makeAssistant([
				{ id: "call_1", name: "toolA" },
				{ id: "call_2", name: "toolB" },
				{ id: "call_3", name: "toolC" },
			]),
			makeToolResult("call_1"),
			makeToolResult("call_2"),
			makeToolResult("call_3"),
		];
		const result = validateChatCompletionsTranscript(messages, "openai", "gpt-5.6-luna");
		expect(result).toEqual({ ok: true });
	});

	test("parallel calls with one tool error result", () => {
		const messages: Message[] = [
			makeAssistant([
				{ id: "call_1", name: "toolA" },
				{ id: "call_2", name: "toolB" },
			]),
			makeToolResult("call_1"),
			makeToolResult("call_2", true),
		];
		const result = validateChatCompletionsTranscript(messages, "openai", "gpt-5.6-luna");
		expect(result).toEqual({ ok: true });
	});

	test("missing result", () => {
		const messages: Message[] = [makeAssistant([{ id: "call_1", name: "testTool" }])];
		const result = validateChatCompletionsTranscript(messages, "openai", "gpt-5.6-luna");
		expect(result).not.toEqual({ ok: true });
		if ("code" in result) {
			expect(result.code).toBe("INVALID_TOOL_TRANSCRIPT");
			expect(result.missingToolCallIds).toContain("call_1");
		}
	});

	test("duplicate result", () => {
		const messages: Message[] = [
			makeAssistant([{ id: "call_1", name: "testTool" }]),
			makeToolResult("call_1"),
			makeToolResult("call_1"),
		];
		const result = validateChatCompletionsTranscript(messages, "openai", "gpt-5.6-luna");
		expect(result).not.toEqual({ ok: true });
		if ("code" in result) {
			expect(result.duplicateToolCallIds).toContain("call_1");
		}
	});

	test("orphan result (result without call)", () => {
		const messages: Message[] = [makeToolResult("orphan_1")];
		const result = validateChatCompletionsTranscript(messages, "openai", "gpt-5.6-luna");
		expect(result).not.toEqual({ ok: true });
		if ("code" in result) {
			expect(result.orphanToolResultIds).toContain("orphan_1");
		}
	});

	test("duplicate tool-call ID", () => {
		const messages: Message[] = [
			makeAssistant([{ id: "dup_1", name: "toolA" }]),
			makeToolResult("dup_1"),
			makeAssistant([{ id: "dup_1", name: "toolB" }]),
			makeToolResult("dup_1"),
		];
		const result = validateChatCompletionsTranscript(messages, "openai", "gpt-5.6-luna");
		expect(result).not.toEqual({ ok: true });
		if ("code" in result) {
			expect(result.duplicateCallIds).toContain("dup_1");
		}
	});

	test("session restore with complete span", () => {
		const messages: Message[] = [
			makeUser("start"),
			makeAssistant([{ id: "c1", name: "t1" }]),
			makeToolResult("c1"),
			makeAssistantText("done"),
		];
		const result = validateChatCompletionsTranscript(messages, "openai", "gpt-5.6-luna");
		expect(result).toEqual({ ok: true });
	});

	test("session restore with incomplete span", () => {
		const messages: Message[] = [
			makeAssistant([{ id: "c1", name: "t1" }]),
			makeToolResult("c1"),
			makeUser("next request"),
			makeAssistant([{ id: "c2", name: "t2" }]),
			// Missing tool result for c2
		];
		const result = validateChatCompletionsTranscript(messages, "openai", "gpt-5.6-luna");
		expect(result).not.toEqual({ ok: true });
		if ("code" in result) {
			expect(result.missingToolCallIds).toContain("c2");
		}
	});

	test("400 transcript error attempted once (detected not retried)", () => {
		const messages: Message[] = [
			makeAssistant([{ id: "c1", name: "t1" }]),
			// no tool result - invalid
		];
		const result = validateChatCompletionsTranscript(messages, "openrouter", "gpt-5.6-luna");
		if ("code" in result) {
			expect(result.protocol).toBe("chat-completions");
			expect(result.provider).toBe("openrouter");
			expect(result.model).toBe("gpt-5.6-luna");
			expect(result.messageIndex).toBeGreaterThanOrEqual(0);
		} else {
			expect.fail("expected validation error");
		}
	});
});

describe("validateResponsesTranscript", () => {
	test("Responses call_id pairing — valid", () => {
		const messages: Message[] = [
			makeAssistant([{ id: "call_resp_1", name: "toolA" }]),
			makeToolResult("call_resp_1"),
		];
		const result = validateResponsesTranscript(messages, "openai", "gpt-5.6-luna");
		expect(result).toEqual({ ok: true });
	});

	test("Responses call_id pairing — missing output", () => {
		const messages: Message[] = [makeAssistant([{ id: "call_resp_1", name: "toolA" }])];
		const result = validateResponsesTranscript(messages, "openai", "gpt-5.6-luna");
		expect(result).not.toEqual({ ok: true });
		if ("code" in result) {
			expect(result.protocol).toBe("responses");
			expect(result.missingToolCallIds).toContain("call_resp_1");
		}
	});
});

describe("validateToolSpanIntegrity", () => {
	test("complete span is valid", () => {
		const messages: Message[] = [makeAssistant([{ id: "c1", name: "t1" }]), makeToolResult("c1")];
		expect(validateToolSpanIntegrity(messages).valid).toBe(true);
	});

	test("missing result detected", () => {
		const messages: Message[] = [makeAssistant([{ id: "c1", name: "t1" }])];
		const result = validateToolSpanIntegrity(messages);
		expect(result.valid).toBe(false);
		expect(result.missingToolCallIds).toContain("c1");
	});

	test("orphan result detected", () => {
		const messages: Message[] = [makeToolResult("orphan_1")];
		const result = validateToolSpanIntegrity(messages);
		expect(result.valid).toBe(false);
		expect(result.orphanToolResultIds).toContain("orphan_1");
	});

	test("compaction preserving complete span", () => {
		const messages: Message[] = [
			makeUser("start"),
			makeAssistant([{ id: "c1", name: "t1" }]),
			makeToolResult("c1"),
			makeAssistantText("done"),
		];
		expect(validateToolSpanIntegrity(messages).valid).toBe(true);
	});

	test("compaction refusing partial span", () => {
		const messages: Message[] = [
			makeAssistant([{ id: "c1", name: "t1" }]),
			// Missing tool result
			makeAssistantText("partial"),
		];
		expect(validateToolSpanIntegrity(messages).valid).toBe(false);
	});
});
