/**
 * Token accounting for context virtualization.
 *
 * Conservative (over-estimating) char-based estimation, consistent with the
 * existing compaction estimator. Exact tokenizer counts are a provider
 * capability; the governor must never under-count, so it reuses the same
 * chars/4 heuristic the rest of Jensen already trusts.
 */

import type { AgentMessage } from "@apholdings/jensen-agent-core";
import type { Tool } from "@apholdings/jensen-ai";
import { estimateTokens as estimateMessageTokens } from "../compaction/index.js";

export function estimateTextTokens(text: string): number {
	if (!text) return 0;
	return Math.ceil(text.length / 4);
}

/** Estimate the token cost of the stable prefix (system prompt + tool schemas). */
export function estimateStablePrefixTokens(systemPrompt: string, tools: readonly Tool[] | undefined): number {
	let total = estimateTextTokens(systemPrompt);
	for (const tool of tools ?? []) {
		total += estimateTextTokens(tool.name);
		total += estimateTextTokens(tool.description);
		try {
			total += estimateTextTokens(JSON.stringify(tool.parameters ?? {}));
		} catch {
			// Non-serializable schema: fall back to a small fixed allowance.
			total += 64;
		}
	}
	return total;
}

export interface ContextAssembly {
	systemPrompt: string;
	dynamicPrompt?: string;
	messages: AgentMessage[];
	tools?: Tool[];
}

/**
 * Estimate the total input tokens Jensen would send for this assembly,
 * including system prompt, tool schemas, and the host-context dynamic prompt.
 */
export function estimateAssemblyInputTokens(assembly: ContextAssembly): number {
	let total = estimateStablePrefixTokens(assembly.systemPrompt, assembly.tools);
	if (assembly.dynamicPrompt) {
		// dynamicPrompt is injected as a `<host-context>` user message.
		total += estimateTextTokens(`<host-context>\n${assembly.dynamicPrompt}\n</host-context>`);
	}
	for (const message of assembly.messages) {
		total += estimateMessageTokens(message);
	}
	return total;
}

/** Estimate the token cost of a single message (re-exported for convenience). */
export function estimateMessageTokensFor(messages: AgentMessage[]): number {
	let total = 0;
	for (const message of messages) {
		total += estimateMessageTokens(message);
	}
	return total;
}
