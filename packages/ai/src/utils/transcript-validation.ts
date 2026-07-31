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

function throwValidationError(result: TranscriptValidationResult, field: string): void {
	if (!("code" in result)) return;
	throw new Error(
		`INVALID_TOOL_TRANSCRIPT: protocol=${result.protocol}, ` +
			`missingToolCallIds=[${result.missingToolCallIds.join(", ")}], ` +
			`duplicateToolCallIds=[${result.duplicateToolCallIds.join(", ")}], ` +
			`orphanToolResultIds=[${result.orphanToolResultIds.join(", ")}], ` +
			`duplicateCallIds=[${result.duplicateCallIds.join(", ")}], ` +
			`provider=${result.provider}, model=${result.model}, messageIndex=${result.messageIndex}, field=${field}`,
	);
}

export function assertValidChatCompletionsPayload(payload: unknown, provider: string, model: string): void {
	const messages = isRecord(payload) ? payload.messages : undefined;
	if (!Array.isArray(messages)) {
		throw new Error(`INVALID_TOOL_TRANSCRIPT: protocol=chat-completions, missing messages`);
	}
	throwValidationError(validateChatCompletionsTranscript(messages, provider, model), "messages");
}

export function assertValidResponsesPayload(payload: unknown, provider: string, model: string): void {
	const input = isRecord(payload) ? payload.input : undefined;
	if (!Array.isArray(input)) {
		throw new Error(`INVALID_TOOL_TRANSCRIPT: protocol=responses, missing input`);
	}
	throwValidationError(validateResponsesTranscript(input, provider, model), "input");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function asToolCall(id: unknown, name: unknown): ToolCall {
	return {
		type: "toolCall",
		id: typeof id === "string" ? id : "",
		name: typeof name === "string" ? name : "",
		arguments: {},
	};
}

function asAssistantMessage(content: ToolCall[]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "unknown",
		model: "unknown",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function asToolResult(toolCallId: unknown): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: typeof toolCallId === "string" ? toolCallId : "",
		toolName: "",
		content: [],
		isError: false,
		timestamp: 0,
	};
}

function normalizeChatCompletionsMessages(messages: readonly unknown[]): Message[] {
	const normalized: Message[] = [];
	for (const raw of messages) {
		if (!isRecord(raw)) continue;
		if (raw.role === "assistant") {
			const toolCalls = Array.isArray(raw.tool_calls)
				? raw.tool_calls.map((call) => {
						if (!isRecord(call)) return asToolCall(undefined, undefined);
						const functionData = isRecord(call.function) ? call.function : undefined;
						return asToolCall(call.id, functionData?.name);
					})
				: [];
			normalized.push(asAssistantMessage(toolCalls));
		} else if (raw.role === "tool") {
			normalized.push(asToolResult(raw.tool_call_id));
		} else if (raw.role === "user") {
			normalized.push({ role: "user", content: "", timestamp: 0 });
		}
	}
	return normalized;
}

function normalizeResponsesMessages(messages: readonly unknown[]): Message[] {
	const normalized: Message[] = [];
	let pendingCalls: ToolCall[] = [];
	const flushCalls = () => {
		if (pendingCalls.length > 0) {
			normalized.push(asAssistantMessage(pendingCalls));
			pendingCalls = [];
		}
	};

	for (const raw of messages) {
		if (!isRecord(raw)) continue;
		if (raw.type === "function_call") {
			pendingCalls.push(asToolCall(raw.call_id, raw.name));
		} else {
			flushCalls();
			if (raw.type === "function_call_output") {
				normalized.push(asToolResult(raw.call_id));
			} else if (raw.role === "user") {
				normalized.push({ role: "user", content: "", timestamp: 0 });
			}
		}
	}
	flushCalls();
	return normalized;
}

function normalizeMessages(messages: readonly unknown[], protocol: "chat-completions" | "responses"): Message[] {
	if (messages.some((message) => isRecord(message) && message.role === "toolResult")) {
		return messages as Message[];
	}
	if (
		messages.some(
			(message) =>
				isRecord(message) &&
				message.role === "assistant" &&
				Array.isArray(message.content) &&
				message.content.some((block) => isRecord(block) && block.type === "toolCall"),
		)
	) {
		return messages as Message[];
	}
	if (messages.some((message) => isRecord(message) && message.role === "assistant" && !("api" in message))) {
		return normalizeChatCompletionsMessages(messages);
	}
	if (
		messages.some(
			(message) =>
				isRecord(message) && (message.type === "function_call" || message.type === "function_call_output"),
		)
	) {
		return normalizeResponsesMessages(messages);
	}
	if (
		messages.some(
			(message) =>
				isRecord(message) &&
				(message.role === "tool" || Array.isArray(message.tool_calls) || message.role === "toolResult"),
		)
	) {
		return normalizeChatCompletionsMessages(messages);
	}
	if (protocol === "responses") return normalizeResponsesMessages(messages);
	return messages as Message[];
}

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
	messages: readonly unknown[],
	provider: string,
	model: string,
): TranscriptValidationResult {
	const normalizedMessages = normalizeMessages(messages, "chat-completions");
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

	for (let i = 0; i < normalizedMessages.length; i++) {
		const msg = normalizedMessages[i];

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
			if (errorIndex < 0) errorIndex = normalizedMessages.length - 1;
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
	messages: readonly unknown[],
	provider: string,
	model: string,
): TranscriptValidationResult {
	const normalizedMessages = normalizeMessages(messages, "responses");
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

	for (let i = 0; i < normalizedMessages.length; i++) {
		const msg = normalizedMessages[i];

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
			if (errorIndex < 0) errorIndex = normalizedMessages.length - 1;
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
