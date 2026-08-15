/**
 * Token accounting for context virtualization.
 *
 * Uses the tiered token accounting module (content-class aware conservative
 * fallback, calibrated uplift when provider usage is available). The governor
 * must never under-count, so estimation is always upper-biased.
 */

import type { AgentMessage } from "@apholdings/jensen-agent-core";
import type { AssistantMessage, Tool, ToolResultMessage } from "@apholdings/jensen-ai";
import {
	analyzeText,
	type ContentClass,
	estimateTextTokens,
	MAX_CALIBRATED_MULTIPLIER,
	resolveAccountingMode,
	type TokenAccountingMode,
	type TokenAccountingOptions,
} from "./token-accounting.js";

export { analyzeText, estimateTextTokens, MAX_CALIBRATED_MULTIPLIER, resolveAccountingMode };
export type { ContentClass, TokenAccountingMode, TokenAccountingOptions };

export interface TokenAccounting {
	/** Calibrated multiplier from provider-usage observation (>= 1). */
	calibratedMultiplier?: number;
}

/** Estimate the token cost of the stable prefix (system prompt + tool schemas). */
export function estimateStablePrefixTokens(
	systemPrompt: string,
	tools: readonly Tool[] | undefined,
	accounting: TokenAccounting = {},
): number {
	let total = estimateTextTokens(systemPrompt, "system-prompt", accounting);
	for (const tool of tools ?? []) {
		total += estimateTextTokens(tool.name, "tool-schema", accounting);
		total += estimateTextTokens(tool.description, "tool-schema", accounting);
		try {
			total += estimateTextTokens(JSON.stringify(tool.parameters ?? {}), "json", accounting);
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

/** Estimate the cost of a message, choosing a content class per role/block. */
export function estimateMessageTokens(message: AgentMessage, accounting: TokenAccounting = {}): number {
	switch (message.role) {
		case "user": {
			const content = (message as { content: string | Array<{ type: string; text?: string }> }).content;
			if (typeof content === "string") return estimateTextTokens(content, "prose", accounting);
			let total = 0;
			for (const block of content) {
				if (block.type === "text" && block.text) total += estimateTextTokens(block.text, "prose", accounting);
			}
			return total;
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			let total = 0;
			for (const block of assistant.content) {
				if (block.type === "text") {
					total += estimateTextTokens(block.text, "prose", accounting);
				} else if (block.type === "thinking") {
					total += estimateTextTokens(block.thinking, "prose", accounting);
				} else if (block.type === "toolCall") {
					total += estimateTextTokens(block.name, "code", accounting);
					total += estimateTextTokens(JSON.stringify(block.arguments), "json", accounting);
				}
			}
			return total;
		}
		case "toolResult": {
			const result = message as ToolResultMessage;
			let total = 0;
			for (const block of result.content) {
				if (block.type === "text" && block.text) {
					total += estimateTextTokens(block.text, "tool-result", accounting);
				} else if (block.type === "image") {
					// Image payloads are encoded as data URLs; conservatively allow ~1200 tokens.
					total += 1200;
				}
			}
			return total;
		}
		case "bashExecution": {
			const bash = message as { command: string; output: string };
			return (
				estimateTextTokens(bash.command, "code", accounting) + estimateTextTokens(bash.output, "log", accounting)
			);
		}
		case "custom": {
			const content = (message as { content: string }).content;
			return typeof content === "string" ? estimateTextTokens(content, "prose", accounting) : 0;
		}
		case "branchSummary":
		case "compactionSummary": {
			return estimateTextTokens((message as { summary: string }).summary, "prose", accounting);
		}
		default:
			return 0;
	}
}

/**
 * Estimate the total input tokens Jensen would send for this assembly,
 * including system prompt, tool schemas, and the host-context dynamic prompt.
 */
export function estimateAssemblyInputTokens(assembly: ContextAssembly, accounting: TokenAccounting = {}): number {
	let total = estimateStablePrefixTokens(assembly.systemPrompt, assembly.tools, accounting);
	if (assembly.dynamicPrompt) {
		// dynamicPrompt is injected as a `<host-context>` user message.
		total += estimateTextTokens(`<host-context>\n${assembly.dynamicPrompt}\n</host-context>`, "prose", accounting);
	}
	for (const message of assembly.messages) {
		total += estimateMessageTokens(message, accounting);
	}
	return total;
}

/** Estimate the token cost of a list of messages. */
export function estimateMessageTokensFor(messages: AgentMessage[], accounting: TokenAccounting = {}): number {
	let total = 0;
	for (const message of messages) {
		total += estimateMessageTokens(message, accounting);
	}
	return total;
}

export interface ContextRegionCosts {
	systemPromptTokens: number;
	toolSchemaTokens: number;
	dynamicPromptTokens: number;
	messageTokens: number;
	/** systemPrompt + toolSchema + dynamicPrompt (the fixed prefix). */
	fixedPrefixTokens: number;
}

/**
 * Structured, per-region cost breakdown used for fixed-prefix diagnostics and
 * telemetry. Never used to fabricate completion authority.
 */
export function estimateContextRegionCosts(
	assembly: ContextAssembly,
	accounting: TokenAccounting = {},
): ContextRegionCosts {
	const systemPromptTokens = estimateTextTokens(assembly.systemPrompt, "system-prompt", accounting);
	const toolSchemaTokens = (() => {
		let total = 0;
		for (const tool of assembly.tools ?? []) {
			total += estimateTextTokens(tool.name, "tool-schema", accounting);
			total += estimateTextTokens(tool.description, "tool-schema", accounting);
			try {
				total += estimateTextTokens(JSON.stringify(tool.parameters ?? {}), "json", accounting);
			} catch {
				total += 64;
			}
		}
		return total;
	})();
	const dynamicPromptTokens = assembly.dynamicPrompt
		? estimateTextTokens(`<host-context>\n${assembly.dynamicPrompt}\n</host-context>`, "prose", accounting)
		: 0;
	const messageTokens = estimateMessageTokensFor(assembly.messages, accounting);
	return {
		systemPromptTokens,
		toolSchemaTokens,
		dynamicPromptTokens,
		messageTokens,
		fixedPrefixTokens: systemPromptTokens + toolSchemaTokens + dynamicPromptTokens,
	};
}
