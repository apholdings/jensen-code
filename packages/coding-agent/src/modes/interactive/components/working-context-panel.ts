import { type Component, truncateToWidth } from "@apholdings/jensen-tui";
import type {
	WorkingContext,
	WorkingContextDelegatedWorkSummary,
	WorkingContextMemorySummary,
	WorkingContextTaskSummary,
	WorkingContextTodoSummary,
} from "../../../core/working-context.js";
import { theme } from "../theme/theme.js";

/**
 * Panel-local memory summary type.
 * Omits isPersisted for panel rendering (backward compatible).
 */
interface PanelMemorySummary {
	itemCount: number;
	staleCount: number;
	keyPreview?: string[];
}

/**
 * Panel-local todo summary type.
 * Omits isPersisted for panel rendering (backward compatible).
 */
interface PanelTodoSummary {
	total: number;
	completed: number;
	inProgress?: string;
}

/**
 * Panel-local task summary type.
 * Omits isPersisted for panel rendering (backward compatible).
 */
interface PanelTaskSummary {
	total: number;
	pending: number;
	inProgress: number;
	completed: number;
	inProgressTask?: { id: string; subject: string; activeForm?: string };
}

/**
 * Panel-local delegated work summary type.
 * Omits isPersisted and note for panel rendering (backward compatible).
 */
interface PanelDelegatedWorkFailurePreview {
	agent: string;
	task: string;
	mode: "single" | "parallel" | "chain";
	status?: "error" | "blocked";
	childIndex?: number;
	step?: number;
	exitCode?: number;
	errorMessage?: string;
}

interface PanelDelegatedWorkSummary {
	activeCount: number;
	completedCount: number;
	failedCount: number;
	activeAgents?: string[];
	failurePreview?: PanelDelegatedWorkFailurePreview[];
}

/**
 * Panel-local working context data type for backward compatibility.
 * Also accepts the full WorkingContext type from the shared contract.
 */
export type WorkingContextData =
	| WorkingContext
	| {
			memory?: PanelMemorySummary;
			todo?: PanelTodoSummary;
			tasks?: PanelTaskSummary;
			delegatedWork?: PanelDelegatedWorkSummary;
	  };

/** Aliases for backwards compatibility */
export type MemorySummary = WorkingContextMemorySummary;
export type TodoSummary = WorkingContextTodoSummary;
export type TaskSummary = WorkingContextTaskSummary;
export type DelegatedWorkSummary = WorkingContextDelegatedWorkSummary;

const DETAIL_THRESHOLD = 72;

function formatFailurePreviewItem(item: PanelDelegatedWorkFailurePreview): string {
	const identity =
		item.mode === "chain"
			? `step ${item.step ?? "?"}`
			: item.mode === "parallel"
				? `child ${item.childIndex ?? "?"}`
				: "single";
	const statusPrefix = item.status === "blocked" ? "blocked " : "";
	const exitText = item.exitCode !== undefined ? ` exit ${item.exitCode}` : "";
	const detail = item.errorMessage ?? item.task;
	return `${statusPrefix}${identity} ${item.agent}${exitText}: ${detail}`;
}

export class WorkingContextPanel implements Component {
	private data: WorkingContextData = {};

	update(data: WorkingContextData): void {
		this.data = data;
	}

	render(width: number): string[] {
		if (width < 24) {
			return [];
		}

		const memory = this.data.memory;
		const todo = this.data.todo;
		const tasks = this.data.tasks;
		const delegatedWork = this.data.delegatedWork;
		const isSharedContract = memory !== undefined && todo !== undefined && delegatedWork !== undefined;
		const hasVisibleState =
			(memory?.itemCount ?? 0) > 0 ||
			(todo?.total ?? 0) > 0 ||
			(tasks?.total ?? 0) > 0 ||
			(delegatedWork?.activeCount ?? 0) > 0 ||
			(delegatedWork?.completedCount ?? 0) > 0 ||
			(delegatedWork?.failedCount ?? 0) > 0;
		if ((!memory && !todo && !tasks && !delegatedWork) || (isSharedContract && !hasVisibleState)) {
			return [];
		}

		const summaryParts: string[] = [theme.bold(theme.fg("accent", "Working Context"))];
		if (memory) {
			const staleText = memory.staleCount > 0 ? `, ${memory.staleCount} stale` : "";
			summaryParts.push(
				theme.fg("muted", "Memory:"),
				`${memory.itemCount} item${memory.itemCount === 1 ? "" : "s"}${staleText}`,
			);
		}
		if (todo) {
			summaryParts.push(theme.fg("muted", "Plan:"), `${todo.completed}/${todo.total} done`);
		}
		if (tasks) {
			summaryParts.push(
				theme.fg("muted", "Tasks:"),
				`${tasks.completed}/${tasks.total}`,
				`${tasks.inProgress} active`,
			);
		}
		if (delegatedWork) {
			summaryParts.push(
				theme.fg("muted", "Delegated:"),
				`${delegatedWork.activeCount} active`,
				`${delegatedWork.completedCount} done`,
				`${delegatedWork.failedCount} failed`,
			);
		}

		const lines = [truncateToWidth(summaryParts.join(" "), width)];
		if (width < DETAIL_THRESHOLD) {
			return ["", ...lines];
		}

		if (memory) {
			const keyPreview = memory.keyPreview && memory.keyPreview.length > 0 ? memory.keyPreview.join(", ") : "(none)";
			lines.push(truncateToWidth(`  ${theme.fg("muted", "Memory keys:")} ${keyPreview}`, width));
		}

		if (todo) {
			const activeText = todo.inProgress ?? "(none)";
			lines.push(truncateToWidth(`  ${theme.fg("muted", "Current todo:")} ${activeText}`, width));
		}

		if (tasks) {
			const taskLabel = tasks.inProgressTask ? tasks.inProgressTask.subject : "(none)";
			lines.push(truncateToWidth(`  ${theme.fg("muted", "Current task:")} ${taskLabel}`, width));
		}

		if (delegatedWork) {
			const agents =
				delegatedWork.activeAgents && delegatedWork.activeAgents.length > 0
					? delegatedWork.activeAgents.join(", ")
					: "(none active)";
			lines.push(truncateToWidth(`  ${theme.fg("muted", "Active delegates:")} ${agents}`, width));

			if (delegatedWork.failurePreview && delegatedWork.failurePreview.length > 0) {
				const preview = delegatedWork.failurePreview.map(formatFailurePreviewItem).join("; ");
				lines.push(truncateToWidth(`  ${theme.fg("muted", "Failed delegates:")} ${preview}`, width));
			}
		}

		return ["", ...lines];
	}

	invalidate(): void {
		// No cached render state.
	}
}

export default WorkingContextPanel;
