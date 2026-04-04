/**
 * Delegated Work State - Pure helper for bounded subagent execution tracking.
 *
 * This module provides a minimal state machine for tracking delegated work
 * within the current session/branch. It is honest that this is ephemeral
 * session state, not provenance or cross-session tracking.
 *
 * Derived from:
 * - Subagent tool call arguments (ToolCallEvent.input for "subagent" tool)
 * - Subagent tool results (ToolResultMessage with toolName "subagent")
 * - Persisted tool result details (SubagentDetails)
 */

import type { ToolResultMessage } from "@apholdings/jensen-ai";
import type { ToolCallEvent } from "./extensions/index.js";

/**
 * Execution mode for a delegated task.
 */
export type DelegatedMode = "single" | "parallel" | "chain";

/**
 * Status of a delegated work item.
 */
export type DelegatedStatus = "active" | "completed" | "error" | "blocked";

/**
 * Minimal record of a single delegated subagent child task.
 *
 * For multi-task modes, multiple DelegatedTask records can share the same
 * parent toolCallId. `childIndex` disambiguates individual child work items
 * within one live subagent invocation.
 */
export interface DelegatedTask {
	/** Parent subagent tool call identifier. */
	toolCallId: string;
	/** 1-based child position for parallel child tasks. */
	childIndex?: number;
	/** Human-readable agent name. */
	agent: string;
	/** Source scope of the agent (user, project, both, unknown). */
	agentSource: "user" | "project" | "both" | "unknown";
	/** The task description/prompt delegated to the agent. */
	task: string;
	/** Execution mode: single, parallel, or chain. */
	mode: DelegatedMode;
	/** Current status. */
	status: DelegatedStatus;
	/** Step index for chain mode (1-based, when known). */
	step?: number;
	/** Exit code from the child process (if available). */
	exitCode?: number;
	/** Error or diagnostic message if failed. */
	errorMessage?: string;
	/** Brief output preview extracted from final assistant message. */
	outputPreview?: string;
	/** Tool call arguments as provided (for inspection). */
	rawArgs?: Record<string, unknown>;
	/** When the tool call was made. */
	timestamp: number;
}

/**
 * Aggregated summary of delegated work state.
 * Used for UI display and debugging.
 */
export interface DelegatedWorkSummary {
	/** Tasks that are currently active (no result yet). */
	active: DelegatedTask[];
	/** Tasks that completed successfully. */
	completed: DelegatedTask[];
	/** Tasks that failed or were blocked. */
	failed: DelegatedTask[];
	/** Total tasks across all categories. */
	total: number;
	/** Whether this is current-branch/session state (always true, for honesty). */
	isSessionState: true;
	/** Note clarifying this is not provenance tracking. */
	note: "ephemeral current-session state; not persisted across sessions or branches";
}

/**
 * Detailed subagent result structure from persisted tool results.
 * This matches the SubagentDetails interface from the subagent extension.
 */
interface SubagentResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: unknown[];
	stderr: string;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens: number;
		turns: number;
	};
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	failureStage?: string;
	diagnosticMessage?: string;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: string;
	projectAgentsDir: string | null;
	discoveryErrors: unknown[];
	results: SubagentResult[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function createDelegatedTask(options: {
	toolCallId: string;
	agent: string;
	task: string;
	mode: DelegatedMode;
	childIndex?: number;
	step?: number;
	rawArgs: Record<string, unknown>;
	timestamp: number;
}): DelegatedTask {
	return {
		toolCallId: options.toolCallId,
		childIndex: options.childIndex,
		agent: options.agent,
		agentSource: "unknown",
		task: options.task,
		mode: options.mode,
		status: "active",
		step: options.step,
		rawArgs: options.rawArgs,
		timestamp: options.timestamp,
	};
}

/**
 * Extract delegated work items from a subagent tool call event.
 *
 * Honesty boundary:
 * - single mode -> one active child entry
 * - parallel mode -> one active child entry per requested child task
 * - chain mode -> only the first step is active at tool-call start
 */
export function extractDelegatedTasks(event: ToolCallEvent): DelegatedTask[] {
	if (event.toolName !== "subagent") {
		return [];
	}

	const input = event.input;
	if (!isRecord(input)) {
		return [];
	}

	const params = input;
	const timestamp = Date.now();

	if (Array.isArray(params.tasks) && params.tasks.length > 0) {
		return params.tasks.flatMap((item, index) => {
			if (!isRecord(item)) {
				return [];
			}
			const agent = typeof item.agent === "string" ? item.agent : undefined;
			const task = typeof item.task === "string" ? item.task : undefined;
			if (!agent || !task) {
				return [];
			}
			return [
				createDelegatedTask({
					toolCallId: event.toolCallId,
					agent,
					task,
					mode: "parallel",
					childIndex: index + 1,
					rawArgs: params,
					timestamp,
				}),
			];
		});
	}

	if (Array.isArray(params.chain) && params.chain.length > 0) {
		const first = params.chain[0];
		if (!isRecord(first)) {
			return [];
		}
		const agent = typeof first.agent === "string" ? first.agent : undefined;
		const task = typeof first.task === "string" ? first.task : undefined;
		if (!agent || !task) {
			return [];
		}
		return [
			createDelegatedTask({
				toolCallId: event.toolCallId,
				agent,
				task,
				mode: "chain",
				step: 1,
				rawArgs: params,
				timestamp,
			}),
		];
	}

	const agent = typeof params.agent === "string" ? params.agent : undefined;
	const task = typeof params.task === "string" ? params.task : undefined;
	if (!agent || !task) {
		return [];
	}

	return [
		createDelegatedTask({
			toolCallId: event.toolCallId,
			agent,
			task,
			mode: "single",
			rawArgs: params,
			timestamp,
		}),
	];
}

/**
 * Backwards-compatible singular helper.
 *
 * Returns the first extracted delegated task, which preserves prior single-task
 * helper behavior for callers that only need a representative entry.
 */
export function extractDelegatedTask(event: ToolCallEvent): DelegatedTask | undefined {
	return extractDelegatedTasks(event)[0];
}

/**
 * Extract output preview from subagent messages.
 * Looks for the final assistant text content.
 */
function extractOutputPreview(messages: unknown[]): string | undefined {
	if (!Array.isArray(messages) || messages.length === 0) {
		return undefined;
	}

	// Find last assistant message with text
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as Record<string, unknown>;
		if (msg.role !== "assistant") continue;

		const content = msg.content;
		if (!Array.isArray(content)) continue;

		for (let j = content.length - 1; j >= 0; j--) {
			const part = content[j] as Record<string, unknown>;
			if (part.type === "text" && typeof part.text === "string") {
				const text = part.text.trim();
				if (text.length > 0) {
					// Return first 200 chars for preview
					return text.length > 200 ? `${text.slice(0, 200)}...` : text;
				}
			}
		}
	}

	return undefined;
}

function getTaskIdentity(task: DelegatedTask): string {
	return `${task.toolCallId}:${task.mode}:${task.childIndex ?? "single"}:${task.step ?? "-"}`;
}

function getMatchingResult(task: DelegatedTask, results: SubagentResult[]): SubagentResult | undefined {
	if (task.mode === "single") {
		return results[0];
	}

	if (task.mode === "parallel") {
		return task.childIndex ? results[task.childIndex - 1] : undefined;
	}

	if (task.step !== undefined) {
		return results.find((result) => result.step === task.step) ?? results[task.step - 1];
	}

	return results.find((result) => result.agent === task.agent && result.task === task.task);
}

function getToolResultText(toolResult: ToolResultMessage): string | undefined {
	const textContent = toolResult.content.find((content) => content.type === "text");
	if (!textContent || textContent.type !== "text") {
		return undefined;
	}
	const text = textContent.text.trim();
	return text.length > 0 ? text.slice(0, 200) : undefined;
}

function isBlockedSubagentResult(result: SubagentResult): boolean {
	return result.stopReason === "aborted";
}

function isBlockedToolResultWithoutChildResults(toolResult: ToolResultMessage, details: SubagentDetails): boolean {
	if (details.results.length > 0) {
		return false;
	}

	const text = getToolResultText(toolResult);
	if (!text) {
		return false;
	}

	return /(cancel(?:ed|led)|blocked|denied|refused|not approved|approval required|permission required)/iu.test(text);
}

function getDelegatedStatus(result: SubagentResult): DelegatedStatus {
	if (isBlockedSubagentResult(result)) {
		return "blocked";
	}
	if (result.exitCode === -1 && !result.failureStage) {
		return "active";
	}
	if (result.stopReason === "error" || result.exitCode !== 0 || result.failureStage) {
		return "error";
	}
	return "completed";
}

function getDelegatedErrorMessage(result: SubagentResult, toolResult: ToolResultMessage): string | undefined {
	if (result.diagnosticMessage) {
		return result.diagnosticMessage;
	}
	if (result.errorMessage) {
		return result.errorMessage;
	}
	if (result.stderr?.trim()) {
		return result.stderr.trim();
	}
	if (toolResult.isError || isBlockedSubagentResult(result)) {
		return getToolResultText(toolResult);
	}
	return undefined;
}

function createDelegatedTaskFromResult(options: {
	toolCallId: string;
	mode: DelegatedMode;
	result: SubagentResult;
	toolResult: ToolResultMessage;
	rawArgs?: Record<string, unknown>;
	timestamp: number;
	childIndex?: number;
	step?: number;
}): DelegatedTask {
	return {
		toolCallId: options.toolCallId,
		childIndex: options.childIndex,
		agent: options.result.agent,
		agentSource: options.result.agentSource,
		task: options.result.task,
		mode: options.mode,
		status: getDelegatedStatus(options.result),
		step: options.step,
		exitCode: options.result.exitCode,
		errorMessage: getDelegatedErrorMessage(options.result, options.toolResult),
		outputPreview: extractOutputPreview(options.result.messages),
		rawArgs: options.rawArgs,
		timestamp: options.timestamp,
	};
}

function extractChainTaskInput(
	rawArgs: Record<string, unknown> | undefined,
	step: number,
): Record<string, unknown> | undefined {
	const chain = rawArgs?.chain;
	if (!Array.isArray(chain)) {
		return undefined;
	}
	const item = chain[step - 1];
	return isRecord(item) ? item : undefined;
}

export function reconcileDelegatedResult(tasks: DelegatedTask[], result: ToolResultMessage): DelegatedTask[] {
	if (result.toolName !== "subagent") {
		return tasks;
	}

	const details = result.details as SubagentDetails | undefined;
	if (!details || !Array.isArray(details.results)) {
		return tasks;
	}

	let nextTasks = [...tasks];
	const matchingTasks = nextTasks.filter((task) => task.toolCallId === result.toolCallId);
	const parentTask = matchingTasks[0];
	const timestamp = parentTask?.timestamp ?? Date.now();
	const rawArgs = parentTask?.rawArgs;

	if (isBlockedToolResultWithoutChildResults(result, details)) {
		const errorMessage = getToolResultText(result);
		for (const task of matchingTasks) {
			if (task.status !== "active") {
				continue;
			}
			nextTasks = mergeDelegatedTask(nextTasks, {
				...task,
				status: "blocked",
				errorMessage,
			});
		}
		return nextTasks;
	}

	if (details.mode === "chain") {
		for (let index = 0; index < details.results.length; index++) {
			const childResult = details.results[index];
			const step = childResult.step ?? index + 1;
			const existingTask = matchingTasks.find((task) => task.mode === "chain" && task.step === step);
			const taskInput = extractChainTaskInput(rawArgs, step);
			const task =
				existingTask ??
				createDelegatedTask({
					toolCallId: result.toolCallId,
					agent: typeof taskInput?.agent === "string" ? taskInput.agent : childResult.agent,
					task: typeof taskInput?.task === "string" ? taskInput.task : childResult.task,
					mode: "chain",
					step,
					rawArgs: rawArgs ?? {},
					timestamp,
				});
			nextTasks = mergeDelegatedTask(
				nextTasks,
				createDelegatedTaskFromResult({
					toolCallId: result.toolCallId,
					mode: "chain",
					result: childResult,
					toolResult: result,
					rawArgs: task.rawArgs,
					timestamp: task.timestamp,
					step,
				}),
			);
		}
		return nextTasks;
	}

	for (const currentTask of matchingTasks) {
		const updatedTask = applyDelegatedResult(currentTask, result);
		if (updatedTask) {
			nextTasks = mergeDelegatedTask(nextTasks, updatedTask);
		}
	}

	return nextTasks;
}

/**
 * Update a delegated task with result data from a persisted ToolResultMessage.
 * Returns the updated task or undefined if this result doesn't match.
 */
export function applyDelegatedResult(task: DelegatedTask, result: ToolResultMessage): DelegatedTask | undefined {
	// Only process subagent results
	if (result.toolName !== "subagent") {
		return undefined;
	}

	// Verify this result is for our tool call
	if (result.toolCallId !== task.toolCallId) {
		return undefined;
	}

	const details = result.details as SubagentDetails | undefined;
	if (!details || !Array.isArray(details.results)) {
		// Result exists but no details yet (still running)
		return task;
	}

	const matchingResult = getMatchingResult(task, details.results);
	if (!matchingResult) {
		// Still waiting for our result
		return task;
	}

	return {
		...task,
		agent: matchingResult.agent,
		task: matchingResult.task,
		agentSource: matchingResult.agentSource,
		exitCode: matchingResult.exitCode,
		status: getDelegatedStatus(matchingResult),
		errorMessage: getDelegatedErrorMessage(matchingResult, result),
		outputPreview: extractOutputPreview(matchingResult.messages),
		step: task.mode === "chain" ? (matchingResult.step ?? task.step) : task.step,
	};
}

/**
 * Build a summary of delegated work state.
 */
export function buildDelegatedWorkSummary(tasks: DelegatedTask[]): DelegatedWorkSummary {
	const active: DelegatedTask[] = [];
	const completed: DelegatedTask[] = [];
	const failed: DelegatedTask[] = [];

	for (const task of tasks) {
		if (task.status === "active") {
			active.push(task);
		} else if (task.status === "completed") {
			completed.push(task);
		} else {
			failed.push(task);
		}
	}

	return {
		active,
		completed,
		failed,
		total: tasks.length,
		isSessionState: true,
		note: "ephemeral current-session state; not persisted across sessions or branches",
	};
}

/**
 * Get the most recent tasks, optionally filtered by status.
 */
export function getRecentDelegatedTasks(
	tasks: DelegatedTask[],
	options?: {
		status?: DelegatedStatus;
		limit?: number;
	},
): DelegatedTask[] {
	let filtered = tasks;

	if (options?.status) {
		filtered = tasks.filter((t) => t.status === options.status);
	}

	// Sort by timestamp descending (most recent first)
	const sorted = [...filtered].sort((a, b) => b.timestamp - a.timestamp);

	if (options?.limit !== undefined && options.limit > 0) {
		return sorted.slice(0, options.limit);
	}

	return sorted;
}

/**
 * Merge a new task into the existing task list.
 * If a task with the same logical identity exists, it is replaced.
 */
export function mergeDelegatedTask(tasks: DelegatedTask[], newTask: DelegatedTask): DelegatedTask[] {
	const newIdentity = getTaskIdentity(newTask);
	const existing = tasks.findIndex((task) => getTaskIdentity(task) === newIdentity);
	if (existing >= 0) {
		const updated = [...tasks];
		updated[existing] = newTask;
		return updated;
	}
	return [...tasks, newTask];
}

/**
 * Synchronize task states with persisted tool results.
 * This is the main reconciliation function that:
 * 1. Activates tasks from tool call events
 * 2. Updates tasks with result data
 *
 * Returns the updated task list.
 */
export function syncDelegatedWork(
	tasks: DelegatedTask[],
	toolCallEvents: ToolCallEvent[],
	toolResultMessages: ToolResultMessage[],
): DelegatedTask[] {
	let result = [...tasks];

	// Process tool calls to activate tasks
	for (const event of toolCallEvents) {
		for (const task of extractDelegatedTasks(event)) {
			result = mergeDelegatedTask(result, task);
		}
	}

	// Process results to update task states
	for (const resultMsg of toolResultMessages) {
		result = reconcileDelegatedResult(result, resultMsg);
	}

	return result;
}
