import { describe, expect, it } from "vitest";
import { SessionManager } from "./session-manager.js";

describe("SessionManager compaction invariants", () => {
	it("keeps a retained assistant tool-call segment paired with its tool result after compaction", () => {
		const session = SessionManager.inMemory("/tmp/project");

		session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Old request" }],
			timestamp: 1,
		});
		const keptAssistantId = session.appendMessage({
			role: "assistant",
			provider: "test-provider",
			model: "test-model",
			content: [
				{
					type: "toolCall",
					id: "tool-1",
					name: "read",
					arguments: { path: "README.md" },
				},
			],
			stopReason: "tool_use",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { total: 0 },
			},
			timestamp: 2,
		} as any);
		session.appendMessage({
			role: "toolResult",
			toolCallId: "tool-1",
			toolName: "read",
			content: [{ type: "text", text: "README contents" }],
			isError: false,
			timestamp: 3,
		} as any);
		session.appendCompaction("Compacted history", keptAssistantId, 200);

		const context = session.buildSessionContext();

		expect(context.messages.map((message) => message.role)).toEqual(["compactionSummary", "assistant", "toolResult"]);

		const keptAssistant = context.messages[1];
		const keptToolResult = context.messages[2];
		expect(keptAssistant?.role).toBe("assistant");
		expect(keptToolResult?.role).toBe("toolResult");
		if (keptAssistant?.role === "assistant") {
			expect(keptAssistant.content[0]).toMatchObject({
				type: "toolCall",
				id: "tool-1",
				name: "read",
			});
		}
		if (keptToolResult?.role === "toolResult") {
			expect(keptToolResult.toolCallId).toBe("tool-1");
		}
	});
});
