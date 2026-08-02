import type { AssistantMessage, ToolResultMessage } from "@apholdings/jensen-ai";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../session-manager.js";
import { createDeterministicCompactionDetails, prepareCompaction } from "./compaction.js";

describe("deterministic compaction checkpoints", () => {
	it("keeps hashed tool evidence addressable in the durable session log", () => {
		const session = SessionManager.inMemory("/tmp/cache-stable-compaction");
		session.appendMessage({ role: "user", content: "inspect", timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			api: "openai-completions",
			provider: "test",
			model: "test",
			content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "large.txt" } }],
			usage: {
				input: 10,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 12,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		} satisfies AssistantMessage);
		const evidenceMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "complete durable evidence" }],
			isError: false,
			timestamp: 3,
		} satisfies ToolResultMessage;
		session.appendMessage(evidenceMessage);
		session.appendMessage({ role: "user", content: "keep this recent turn", timestamp: 4 });

		const preparation = prepareCompaction(session.getBranch(), {
			enabled: true,
			reserveTokens: 100,
			keepRecentTokens: 1,
		});
		expect(preparation).toBeDefined();
		if (!preparation) return;

		const first = createDeterministicCompactionDetails(preparation, {
			readFiles: ["z.txt", "a.txt", "z.txt"],
			modifiedFiles: [],
		});
		const second = createDeterministicCompactionDetails(preparation, {
			modifiedFiles: [],
			readFiles: ["a.txt", "z.txt"],
		});
		expect(first).toEqual(second);
		expect(first.readFiles).toEqual(["a.txt", "z.txt"]);
		expect(first.checkpoint.toolEvidence).toHaveLength(1);
		expect(first.checkpoint.toolEvidence[0]).toMatchObject({
			toolCallId: "call-1",
			toolName: "read",
			contentBytes: expect.any(Number),
			contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
			excerpt: "complete durable evidence",
		});

		const durableEvidence = session
			.getEntries()
			.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolCallId === first.checkpoint.toolEvidence[0]?.toolCallId,
			);
		expect(durableEvidence?.type === "message" ? durableEvidence.message : undefined).toEqual(evidenceMessage);
	});
});
