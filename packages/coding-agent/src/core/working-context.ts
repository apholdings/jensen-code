/**
 * Shared Working Context Contract.
 *
 * Provides a bounded, serializable surface for the operator-visible working context:
 * - Memory: persisted session state (snapshot-based, current-branch)
 * - Todo: persisted session state (current branch)
 * - Delegated work: ephemeral current-process state (explicitly not persisted)
 *
 * This contract is the single source of truth for building working-context data
 * shared between interactive panel, /session output, and RPC get_working_context.
 */

import type { DelegatedMode, DelegatedStatus, DelegatedWorkSummary } from "./delegated-work.js";
import type { MemoryItem } from "./memory.js";
import { reviewMemoryItems } from "./memory-review.js";

// ============================================================================
// Structured Summary Types
// ============================================================================

/**
 * Memory summary with explicit provenance marker.
 * Memory is persisted in session snapshots on the current branch.
 */
export interface WorkingContextMemorySummary {
	itemCount: number;
	staleCount: number;
	keyPreview: string[];
	/** Explicit marker: memory is persisted in session snapshots */
	isPersisted: true;
	/** Explicit scope: current branch session state */
	scope: "current_branch_session_state";
}

/**
 * Todo summary with explicit provenance marker.
 * Todos are persisted in session entries on the current branch.
 */
export interface WorkingContextTodoSummary {
	total: number;
	completed: number;
	inProgress?: string;
	/** Explicit marker: todos are persisted in session entries */
	isPersisted: true;
	/** Explicit scope: current branch session state */
	scope: "current_branch_session_state";
}

/**
 * Delegated work summary with explicit provenance marker.
 * Delegated work is live current-process runtime state, not persisted.
 */
export interface WorkingContextDelegatedFailurePreview {
	agent: string;
	task: string;
	mode: DelegatedMode;
	status: Extract<DelegatedStatus, "error" | "blocked">;
	childIndex?: number;
	step?: number;
	exitCode?: number;
	errorMessage?: string;
}

export interface WorkingContextDelegatedWorkSummary {
	activeCount: number;
	completedCount: number;
	failedCount: number;
	activeAgents: string[];
	failurePreview: WorkingContextDelegatedFailurePreview[];
	/** Explicit marker: delegated work is ephemeral current-process state */
	isPersisted: false;
	/** Explicit scope: current process runtime state */
	scope: "current_process_runtime_state";
	note: "live current-process state only; not persisted and resets on session switch/resume";
}

/**
 * Aggregated working context surface.
 * This is always a current-state summary, not a history surface.
 */
export interface WorkingContext {
	/** Memory summary persisted in current-branch session snapshots. */
	memory: WorkingContextMemorySummary;
	/** Todo summary persisted in current-branch session entries. */
	todo: WorkingContextTodoSummary;
	/** Delegated work summary from live current-process runtime state. */
	delegatedWork: WorkingContextDelegatedWorkSummary;
}

// ============================================================================
// Builder Functions
// ============================================================================

/**
 * Build a memory summary from memory items.
 */
export function buildWorkingContextMemorySummary(items: readonly MemoryItem[]): WorkingContextMemorySummary {
	const staleCount = reviewMemoryItems([...items]).filter((entry) => entry.reviewRecommended).length;

	return {
		itemCount: items.length,
		staleCount,
		keyPreview: items.slice(0, 4).map((item) => item.key),
		isPersisted: true,
		scope: "current_branch_session_state",
	};
}

/**
 * Build a todo summary from todo items.
 */
export function buildWorkingContextTodoSummary(
	items: ReadonlyArray<{ content: string; activeForm: string; status: string }>,
): WorkingContextTodoSummary {
	return {
		total: items.length,
		completed: items.filter((todo) => todo.status === "completed").length,
		inProgress: items.find((todo) => todo.status === "in_progress")?.activeForm,
		isPersisted: true,
		scope: "current_branch_session_state",
	};
}

function summarizeFailureMessage(message: string | undefined): string | undefined {
	if (!message) {
		return undefined;
	}

	const normalized = message.replace(/\s+/gu, " ").trim();
	if (normalized.length === 0) {
		return undefined;
	}

	return normalized.length > 160 ? `${normalized.slice(0, 160)}...` : normalized;
}

/**
 * Build a delegated work summary from the session's delegated work state.
 */
export function buildWorkingContextDelegatedWorkSummary(
	summary: DelegatedWorkSummary,
): WorkingContextDelegatedWorkSummary {
	const failurePreview = [...summary.failed]
		.sort((left, right) => right.timestamp - left.timestamp)
		.slice(0, 3)
		.map((task) => ({
			agent: task.agent,
			task: task.task,
			mode: task.mode,
			status: (task.status === "blocked" ? "blocked" : "error") as Extract<DelegatedStatus, "error" | "blocked">,
			childIndex: task.childIndex,
			step: task.step,
			exitCode: task.exitCode,
			errorMessage: summarizeFailureMessage(task.errorMessage),
		}));

	return {
		activeCount: summary.active.length,
		completedCount: summary.completed.length,
		failedCount: summary.failed.length,
		activeAgents: Array.from(new Set(summary.active.map((task) => task.agent))),
		failurePreview,
		isPersisted: false,
		scope: "current_process_runtime_state",
		note: "live current-process state only; not persisted and resets on session switch/resume",
	};
}

/**
 * Build the complete working context from session state.
 */
export function buildWorkingContext(options: {
	memoryItems: readonly MemoryItem[];
	todos: ReadonlyArray<{ content: string; activeForm: string; status: string }>;
	delegatedWorkSummary: DelegatedWorkSummary;
}): WorkingContext {
	const { memoryItems, todos, delegatedWorkSummary } = options;

	return {
		memory: buildWorkingContextMemorySummary(memoryItems),
		todo: buildWorkingContextTodoSummary(todos),
		delegatedWork: buildWorkingContextDelegatedWorkSummary(delegatedWorkSummary),
	};
}
