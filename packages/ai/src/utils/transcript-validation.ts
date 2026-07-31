/**
 * Provider-specific transcript validation.
 *
 * Validates that every assistant message containing tool_calls has exactly
 * matching tool result messages, with no missing, duplicate, or orphaned IDs.
 *
 * Two separate protocols:
 * - Chat Completions: uses `tool_call_id` pairing
 * - Responses API: uses `call_id` pairing
 */

import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from "../types.js";

export interface TranscriptValidationError {
	code: "INVALID_TOOL_TRANSCRIPT";
	missingToolCallIds: string[];
	duplicateToolCallIds: string[];
	orphanToolResultIds: string[];
	duplicateCallIds: string[];
	provider: string;
	model: string;
	messageIndex: number;
	protocol: "chat-completions" | "responses";
}

export interface TranscriptValidationSuccess {
	ok: true;
}

export type TranscriptValidationResult = TranscriptValidationSuccess | TranscriptValidationError;

/**
 * Validate a transcript for Chat Completions protocol.
 * For every assistant message with tool_calls, checks:
 * - Each tool call has a non-empty unique ID
 * - Exactly one tool result message responds to each ID
 * - No duplicate tool result messages
 * - No orphan tool result messages (result without a preceding tool call)
 * - All required tool results occur before the next user or assistant message
 * - Tool calls from different assistant turns are not merged
 * - A tool result appears in the uninterrupted span following its originating assistant
 */
export function validateChatCompletionsTranscript(
	messages: Message[],
	provider: string,
	model: string,
): TranscriptValidationResult {
	const missingToolCallIds: string[] = [];
	const duplicateToolCallIds: string[] = [];
	const orphanToolResultIds: string[] = [];
	const duplicateCallIds: string[] = [];
	let errorIndex = -1;

	// Track pending tool call IDs grouped by the assistant that emitted them.
	// Each assistant's tool calls must be resolved before the next assistant or user message.
	type TurnSpan = {
		callIds: Set<string>;
		assistantIndex: number;
	};

	let currentSpan: TurnSpan | null = null;
	// Track seen tool call IDs to detect duplicates across spans
	const seenToolCallIds = new Map<string, number>();
	// Track seen tool result IDs to detect duplicate results
	const seenResultIds = new Map<string, number>();

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];

		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;

			// Skip errored/aborted assistant messages
			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				continue;
			}

			// Before starting a new assistant span, flush pending from the previous span
			if (currentSpan && currentSpan.callIds.size > 0) {
				for (const pid of currentSpan.callIds) {
					missingToolCallIds.push(pid);
					if (errorIndex < 0) errorIndex = i;
				}
			}

			const toolCalls = assistantMsg.content.filter((b) => b.type === "toolCall") as ToolCall[];

			if (toolCalls.length > 0) {
				// Start a new span for this assistant's tool calls
				currentSpan = { callIds: new Set(), assistantIndex: i };

				for (const tc of toolCalls) {
					if (!tc.id || tc.id.trim().length === 0) {
						missingToolCallIds.push("<empty>");
						if (errorIndex < 0) errorIndex = i;
						continue;
					}
					const prevIndex = seenToolCallIds.get(tc.id);
					if (prevIndex !== undefined) {
						duplicateCallIds.push(tc.id);
						if (errorIndex < 0) errorIndex = i;
					} else {
						seenToolCallIds.set(tc.id, i);
					}
					currentSpan!.callIds.add(tc.id);
				}
			} else {
				// Text-only assistant: the generic span-end handling below reports any
				// results still missing from the previous span before the next request.
			}
		} else if (msg.role === "toolResult") {
			const toolResult = msg as ToolResultMessage;
			const resultId = toolResult.toolCallId;

			if (!resultId || resultId.trim().length === 0) {
				orphanToolResultIds.push("<empty>");
				if (errorIndex < 0) errorIndex = i;
			} else if (currentSpan?.callIds.has(resultId)) {
				// Result belongs to current assistant's pending calls — valid
				currentSpan.callIds.delete(resultId);
				seenResultIds.set(resultId, i);
			} else if (seenResultIds.has(resultId)) {
				duplicateToolCallIds.push(resultId);
				if (errorIndex < 0) errorIndex = i;
			} else {
				// Not in current span and not seen before — orphaned
				orphanToolResultIds.push(resultId);
				if (errorIndex < 0) errorIndex = i;
			}
		} else if (msg.role === "user") {
			// User message interrupts flow — flush all remaining pending
			if (currentSpan && currentSpan.callIds.size > 0) {
				for (const pid of currentSpan.callIds) {
					missingToolCallIds.push(pid);
					if (errorIndex < 0) errorIndex = i;
				}
			}
			currentSpan = null;
		}
	}

	// Flush any remaining pending from the last span
	if (currentSpan && currentSpan.callIds.size > 0) {
		for (const pid of currentSpan.callIds) {
			missingToolCallIds.push(pid);
			if (errorIndex < 0) errorIndex = messages.length - 1;
		}
		currentSpan = null;
	}

	if (
		missingToolCallIds.length > 0 ||
		duplicateToolCallIds.length > 0 ||
		orphanToolResultIds.length > 0 ||
		duplicateCallIds.length > 0
	) {
		return {
			code: "INVALID_TOOL_TRANSCRIPT",
			missingToolCallIds,
			duplicateToolCallIds,
			orphanToolResultIds,
			duplicateCallIds,
			provider,
			model,
			messageIndex: errorIndex >= 0 ? errorIndex : 0,
			protocol: "chat-completions",
		};
	}

	return { ok: true };
}

/**
 * Validate a transcript for Responses API protocol.
 * Uses function_call.call_id and function_call_output.call_id pairing.
 * Validates independently from Chat Completions - no protocol mixing.
 *
 * Each assistant's function calls form a span that must be resolved before
 * the next assistant or user message begins a new span.
 */
export function validateResponsesTranscript(
	messages: Message[],
	provider: string,
	model: string,
): TranscriptValidationResult {
	const missingCallIds: string[] = [];
	const duplicateCallIds: string[] = [];
	const orphanOutputIds: string[] = [];
	const duplicateCallIdValues: string[] = [];
	let errorIndex = -1;

	type TurnSpan = {
		callIds: Set<string>;
		assistantIndex: number;
	};

	let currentSpan: TurnSpan | null = null;
	// Track seen call IDs to detect duplicates across spans
	const seenCallIds = new Map<string, number>();
	// Track seen output IDs to detect duplicate results
	const seenOutputIds = new Map<string, number>();

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];

		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;

			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				continue;
			}

			// Before starting a new assistant span, flush pending from previous
			if (currentSpan && currentSpan.callIds.size > 0) {
				for (const pid of currentSpan.callIds) {
					missingCallIds.push(pid);
					if (errorIndex < 0) errorIndex = i;
				}
			}

			const toolCalls = assistantMsg.content.filter((b) => b.type === "toolCall") as ToolCall[];

			if (toolCalls.length > 0) {
				currentSpan = { callIds: new Set(), assistantIndex: i };

				for (const tc of toolCalls) {
					if (!tc.id || tc.id.trim().length === 0) {
						missingCallIds.push("<empty>");
						if (errorIndex < 0) errorIndex = i;
						continue;
					}
					const prevIndex = seenCallIds.get(tc.id);
					if (prevIndex !== undefined) {
						duplicateCallIdValues.push(tc.id);
						if (errorIndex < 0) errorIndex = i;
					} else {
						seenCallIds.set(tc.id, i);
					}
					currentSpan!.callIds.add(tc.id);
				}
			} else {
				// Text-only assistant: the generic span-end handling below reports any
				// results still missing from the previous span before the next request.
			}
		} else if (msg.role === "toolResult") {
			const toolResult = msg as ToolResultMessage;
			const callId = toolResult.toolCallId;

			if (!callId || callId.trim().length === 0) {
				orphanOutputIds.push("<empty>");
				if (errorIndex < 0) errorIndex = i;
			} else if (currentSpan?.callIds.has(callId)) {
				currentSpan.callIds.delete(callId);
				seenOutputIds.set(callId, i);
			} else if (seenOutputIds.has(callId)) {
				duplicateCallIds.push(callId);
				if (errorIndex < 0) errorIndex = i;
			} else {
				orphanOutputIds.push(callId);
				if (errorIndex < 0) errorIndex = i;
			}
		} else if (msg.role === "user") {
			if (currentSpan && currentSpan.callIds.size > 0) {
				for (const pid of currentSpan.callIds) {
					missingCallIds.push(pid);
					if (errorIndex < 0) errorIndex = i;
				}
			}
			currentSpan = null;
		}
	}

	if (currentSpan && currentSpan.callIds.size > 0) {
		for (const pid of currentSpan.callIds) {
			missingCallIds.push(pid);
			if (errorIndex < 0) errorIndex = messages.length - 1;
		}
		currentSpan = null;
	}

	if (
		missingCallIds.length > 0 ||
		duplicateCallIds.length > 0 ||
		orphanOutputIds.length > 0 ||
		duplicateCallIdValues.length > 0
	) {
		return {
			code: "INVALID_TOOL_TRANSCRIPT",
			missingToolCallIds: missingCallIds,
			duplicateToolCallIds: duplicateCallIds,
			orphanToolResultIds: orphanOutputIds,
			duplicateCallIds: duplicateCallIdValues,
			provider,
			model,
			messageIndex: errorIndex >= 0 ? errorIndex : 0,
			protocol: "responses",
		};
	}

	return { ok: true };
}

/**
 * Validate tool call/result span integrity in a raw agent message array.
 * Checks that every assistant message with tool_calls has all matching
 * tool result messages before the next non-tool-result message.
 *
 * This operates on the raw AgentMessage[] level (which includes toolResult
 * and non-LLM messages) before convertToLlm.
 */
export function validateToolSpanIntegrity(messages: Message[]): {
	valid: boolean;
	missingToolCallIds: string[];
	orphanToolResultIds: string[];
} {
	const missingToolCallIds: string[] = [];
	const orphanToolResultIds: string[] = [];
	let pendingToolCallIds = new Set<string>();

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];

		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				continue;
			}

			// Before processing new assistant, check if there are still pending
			for (const pid of pendingToolCallIds) {
				missingToolCallIds.push(pid);
			}

			const toolCalls = assistantMsg.content.filter((b) => b.type === "toolCall") as ToolCall[];
			pendingToolCallIds = new Set(toolCalls.map((tc) => tc.id).filter((id) => id.trim().length > 0));
		} else if (msg.role === "toolResult") {
			const toolResult = msg as ToolResultMessage;
			if (pendingToolCallIds.has(toolResult.toolCallId)) {
				pendingToolCallIds.delete(toolResult.toolCallId);
			} else {
				orphanToolResultIds.push(toolResult.toolCallId);
			}
		} else if (msg.role === "user") {
			for (const pid of pendingToolCallIds) {
				missingToolCallIds.push(pid);
			}
			pendingToolCallIds = new Set();
		}
	}

	for (const pid of pendingToolCallIds) {
		missingToolCallIds.push(pid);
	}

	return {
		valid: missingToolCallIds.length === 0 && orphanToolResultIds.length === 0,
		missingToolCallIds,
		orphanToolResultIds,
	};
}

/**
 * Classify an unresolved tool call after an interrupt or resume.
 */
export type UnresolvedToolCallClassification =
	| "DURABLE_RESULT_AVAILABLE"
	| "DEFINITELY_NOT_EXECUTED"
	| "EXECUTION_OUTCOME_UNKNOWN";

/**
 * Classify the status of an unresolved tool call based on available state.
 *
 * @param toolCallId - The tool call ID to classify
 * @param pendingToolCalls - Set of tool call IDs still pending execution
 * @param persistedResults - Map of tool call IDs to their persisted result messages
 * @param executionLog - Optional set of tool call IDs confirmed to have started execution
 */
export function classifyUnresolvedToolCall(
	toolCallId: string,
	pendingToolCalls: Set<string>,
	persistedResults: Map<string, ToolResultMessage>,
	executionLog?: Set<string>,
): UnresolvedToolCallClassification {
	// If we have a persisted result, it's durable
	if (persistedResults.has(toolCallId)) {
		return "DURABLE_RESULT_AVAILABLE";
	}

	// If the tool call was never started (not in pending or execution log), not executed
	if (!pendingToolCalls.has(toolCallId) && (!executionLog || !executionLog.has(toolCallId))) {
		return "DEFINITELY_NOT_EXECUTED";
	}

	// Otherwise, outcome is unknown (was started but result not persisted)
	return "EXECUTION_OUTCOME_UNKNOWN";
}
