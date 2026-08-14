import type { AgentContext, AgentLoopConfig, AgentMessage } from "@apholdings/jensen-agent-core";
import { agentLoop } from "@apholdings/jensen-agent-core";
import type { AssistantMessage, AssistantMessageEvent, Context, Message, Model } from "@apholdings/jensen-ai";
import { EventStream } from "@apholdings/jensen-ai";
import { describe, expect, it } from "vitest";
import {
	ContextGovernor,
	estimateAssemblyInputTokens,
	InMemoryEvidenceArchive,
	resolveContextCapability,
} from "../../src/core/context-runtime/index.js";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createModel(): Model<"openai-completions"> {
	return {
		id: "small-local",
		name: "small-local",
		api: "openai-completions",
		provider: "llamacpp",
		baseUrl: "http://localhost:8080/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "openai-completions",
		provider: "llamacpp",
		model: "small-local",
		usage: createUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as AgentMessage;
}

function assistant(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "llamacpp",
		model: "small-local",
		usage: createUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	} as AgentMessage;
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function pad(tokens: number): string {
	return "x".repeat(tokens * 4);
}

describe("governor at the provider boundary (TEST A end-to-end)", () => {
	it("never sends an oversized request through the real agent loop", async () => {
		const capability = resolveContextCapability({ modelContextWindow: 8192, modelMaxTokens: 2048 });
		const archive = new InMemoryEvidenceArchive();
		const governor = new ContextGovernor({ capability, archive, keepRecentTokens: 512 });

		const messages: AgentMessage[] = [];
		for (let i = 0; i < 60; i++) {
			messages.push(user(pad(120)), assistant(pad(120)));
		}

		const context: AgentContext = {
			systemPrompt: "system prompt for the small local model",
			messages,
			tools: [],
		};

		const receivedContexts: Context[] = [];
		const streamFn = (_model: Model<any>, providerContext: Context) => {
			receivedContexts.push(providerContext);
			const s = new MockAssistantStream();
			queueMicrotask(() => {
				s.push({ type: "done", reason: "stop", message: createAssistantMessage() });
			});
			return s;
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			transformContext: async (msgs) => {
				const result = await governor.govern({
					systemPrompt: context.systemPrompt,
					messages: msgs,
					tools: context.tools,
				});
				return result.assembly.messages;
			},
		};

		const stream = agentLoop([user("go")], context, config, undefined, streamFn);
		for await (const _event of stream) {
			// consume
		}

		expect(receivedContexts.length).toBeGreaterThan(0);
		for (const received of receivedContexts) {
			const inputTokens = estimateAssemblyInputTokens({
				systemPrompt: received.systemPrompt ?? "",
				messages: received.messages as AgentMessage[],
				tools: received.tools,
			});
			const total = inputTokens + capability.reservedOutputTokens + capability.safetyReserveTokens;
			expect(total).toBeLessThanOrEqual(capability.configuredContextWindow);
		}
	});
});
