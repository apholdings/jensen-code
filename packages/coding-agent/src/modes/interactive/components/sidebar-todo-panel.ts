/**
 * Sidebar Todo Panel
 *
 * Compact todo panel optimized for sidebar display.
 * Real-data-friendly interface that InteractiveMode can wire later.
 */

import { type Component, truncateToWidth, visibleWidth } from "@apholdings/jensen-tui";
import { theme } from "../theme/theme.js";

// ============================================================================
// Types & Interfaces
// ============================================================================

/** Status of a todo item */
export type TodoStatus = "pending" | "in_progress" | "completed";

/** A single todo item */
export interface TodoItem {
	/** Unique identifier */
	id: string;
	/** Todo content/description */
	content: string;
	/** Active form description (what's currently being done) */
	activeForm?: string;
	/** Current status */
	status: TodoStatus;
	/** Priority level (optional, higher = more important) */
	priority?: number;
	/** Whether this item is persisted */
	isPersisted?: boolean;
}

/** Todo data for the panel */
export interface SidebarTodoData {
	/** All todo items */
	items: TodoItem[];
	/** Current in-progress item (optional, for quick access) */
	current?: TodoItem;
	/** Total count of items */
	totalCount: number;
	/** Count of completed items */
	completedCount: number;
	/** Whether todo list is persisted */
	isPersisted?: boolean;
}

/** Configuration for the panel */
export interface SidebarTodoPanelConfig {
	/** Header label shown in the panel (default: "Todos") */
	title: string;
	/** Minimum width for showing active form (default: 22) */
	activeThreshold: number;
	/** Minimum width for showing all items (default: 26) */
	itemsThreshold: number;
	/** Maximum items to show (default: 8) */
	maxItems: number;
	/** Show priority indicators (default: false) */
	showPriority: boolean;
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_CONFIG: SidebarTodoPanelConfig = {
	title: "Todos",
	// Show active form at narrower widths (18 instead of 22) for better visibility
	activeThreshold: 18,
	// Show items at narrower widths (22 instead of 26) now that tools panel is removed
	itemsThreshold: 22,
	// Keep maxItems at 8 for compact sidebar display
	maxItems: 8,
	showPriority: false,
};

/**
 * Build SidebarTodoData from the session's raw todo list shape
 * (`{ content, activeForm, status }`). Returns `undefined` when the list
 * is empty so callers can clear the panel instead of rendering it.
 */
export function buildSidebarTodoData(
	todos: ReadonlyArray<{ content: string; activeForm: string; status: string }>,
): SidebarTodoData | undefined {
	if (todos.length === 0) return undefined;
	const items: TodoItem[] = todos.map((todo, index) => ({
		id: `todo-${index}`,
		content: todo.content,
		activeForm: todo.activeForm,
		status: todo.status as TodoStatus,
	}));
	return {
		items,
		totalCount: items.length,
		completedCount: items.filter((item) => item.status === "completed").length,
		current: items.find((item) => item.status === "in_progress"),
	};
}

/**
 * Build SidebarTodoData from the session's structured Task list shape
 * (`{ id, subject, activeForm?, status }`). Tasks are distinct from todos:
 * they are persistent, model-visible work items with an explicit id and
 * subject. This mapper reuses the shared panel rendering so the Task panel
 * renders with the same visual treatment as the Todo panel.
 */
export function buildSidebarTaskData(
	tasks: ReadonlyArray<{ id: string; subject: string; activeForm?: string; status: string }>,
): SidebarTodoData | undefined {
	if (tasks.length === 0) return undefined;
	const items: TodoItem[] = tasks.map((task) => ({
		id: task.id,
		content: task.subject,
		activeForm: task.activeForm,
		status: task.status as TodoStatus,
	}));
	return {
		items,
		totalCount: items.length,
		completedCount: items.filter((item) => item.status === "completed").length,
		current: items.find((item) => item.status === "in_progress"),
	};
}

// ============================================================================
// Status Icons & Colors
// ============================================================================

/** Get icon for todo status - scannable checkbox format */
function getStatusIcon(status: TodoStatus): string {
	switch (status) {
		case "pending":
			return theme.fg("muted", "[ ]");
		case "in_progress":
			return theme.fg("warning", "[-]");
		case "completed":
			return theme.fg("success", "[x]");
	}
}

/** Get color for todo status */
function getStatusColorFn(status: TodoStatus): (text: string) => string {
	switch (status) {
		case "pending":
			return (text: string) => theme.fg("text", text);
		case "in_progress":
			return (text: string) => theme.fg("warning", theme.bold(text));
		case "completed":
			return (text: string) => theme.fg("dim", text);
	}
}

/** Get priority indicator */
function getPriorityIndicator(priority?: number): string {
	if (!priority || priority <= 0) return "";
	if (priority >= 3) return theme.fg("error", "!");
	if (priority >= 2) return theme.fg("warning", "~");
	return theme.fg("muted", "·");
}

// ============================================================================
// Panel Component
// ============================================================================

/**
 * Compact sidebar panel for todo status.
 *
 * Features:
 * - Shows todo progress and current task
 * - Width-aware rendering (compact at narrow widths)
 * - Real-data-friendly interface that InteractiveMode can wire later
 *
 * Usage:
 * ```typescript
 * const panel = new SidebarTodoPanel();
 *
 * // Update with data from InteractiveMode
 * panel.update({
 *   items: [
 *     { id: "1", content: "Implement feature X", status: "completed" },
 *     { id: "2", content: "Write tests", activeForm: "Writing test cases", status: "in_progress" },
 *     { id: "3", content: "Review code", status: "pending" },
 *   ],
 *   current: { id: "2", content: "Write tests", status: "in_progress" },
 *   totalCount: 3,
 *   completedCount: 1,
 * });
 *
 * // Render
 * const lines = panel.render(35);
 * ```
 */
export class SidebarTodoPanel implements Component {
	private data: SidebarTodoData | undefined;
	private config: SidebarTodoPanelConfig;
	private cachedLines: Map<number, string[]> = new Map();

	constructor(config: Partial<SidebarTodoPanelConfig> = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * Update the panel with new data
	 */
	update(data: SidebarTodoData): void {
		this.data = data;
		this.invalidateCache();
	}

	/**
	 * Clear the panel data
	 */
	clear(): void {
		this.data = undefined;
		this.invalidateCache();
	}

	/**
	 * Update configuration
	 */
	configure(config: Partial<SidebarTodoPanelConfig>): void {
		const changed =
			config.activeThreshold !== this.config.activeThreshold ||
			config.itemsThreshold !== this.config.itemsThreshold ||
			config.maxItems !== this.config.maxItems ||
			config.showPriority !== this.config.showPriority;

		this.config = { ...this.config, ...config };

		if (changed) {
			this.invalidateCache();
		}
	}

	invalidate(): void {
		this.invalidateCache();
	}

	private invalidateCache(): void {
		this.cachedLines.clear();
	}

	/**
	 * Render a single todo item line
	 */
	private renderTodoLine(item: TodoItem, width: number, showActiveForm: boolean): string {
		const icon = getStatusIcon(item.status);
		const colorFn = getStatusColorFn(item.status);
		const priority = this.config.showPriority ? getPriorityIndicator(item.priority) : "";

		// Build the content text
		let contentText: string;
		if (item.status === "in_progress" && item.activeForm && showActiveForm) {
			contentText = item.activeForm;
		} else {
			contentText = item.content;
		}

		// Truncate to available width (account for 4-char icon + spaces)
		const availableWidth = width - 6;
		const truncated = truncateToWidth(contentText, availableWidth);

		// Build line
		const parts: string[] = [icon, colorFn(truncated)];
		if (priority) {
			parts.push(priority);
		}

		return `  ${parts.join(" ")}`;
	}

	render(width: number): string[] {
		// Minimum width check
		if (width < 16) {
			return [];
		}

		// Check cache
		const cached = this.cachedLines.get(width);
		if (cached) {
			return cached;
		}

		const lines: string[] = [];

		// No data
		if (!this.data || this.data.items.length === 0) {
			return [];
		}

		const { items, totalCount, completedCount } = this.data;
		const showActiveForm = width >= this.config.activeThreshold;
		const showItems = width >= this.config.itemsThreshold;

		// Header with progress
		const progress = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
		const progressBar = this.renderProgressBar(progress, 6);
		const headerParts: string[] = [
			theme.bold(theme.fg("accent", this.config.title)),
			theme.fg("muted", progressBar),
			theme.fg("muted", `${completedCount}/${totalCount}`),
		];

		lines.push(truncateToWidth(headerParts.join(" "), width));

		// Show items if width permits
		if (showItems) {
			// Sort: in_progress first, then pending, then completed
			const sortedItems = [...items].sort((a, b) => {
				const statusOrder: Record<TodoStatus, number> = {
					in_progress: 0,
					pending: 1,
					completed: 2,
				};
				const statusDiff = statusOrder[a.status] - statusOrder[b.status];
				if (statusDiff !== 0) return statusDiff;

				// Within same status, sort by priority (higher first)
				if (this.config.showPriority) {
					return (b.priority ?? 0) - (a.priority ?? 0);
				}

				return 0;
			});

			const visibleItems = sortedItems.slice(0, this.config.maxItems);
			for (const item of visibleItems) {
				const line = this.renderTodoLine(item, width, showActiveForm);
				lines.push(truncateToWidth(line, width));
			}

			// Overflow indicator
			if (items.length > this.config.maxItems) {
				const remaining = items.length - this.config.maxItems;
				lines.push(truncateToWidth(theme.fg("muted", `  +${remaining} more...`), width));
			}
		} else {
			// Compact mode: just show current task if any
			const currentItem = items.find((item) => item.status === "in_progress");
			if (currentItem) {
				const line = this.renderTodoLine(currentItem, width, false);
				lines.push(truncateToWidth(line, width));
			}
		}

		// Verify width constraints
		const result = lines.map((line) => {
			const lineWidth = visibleWidth(line);
			if (lineWidth > width) {
				return truncateToWidth(line, width, "", false);
			}
			return line;
		});

		const spacedResult = result.length > 0 ? ["", ...result] : result;

		// Cache result
		if (spacedResult.length > 0) {
			this.cachedLines.set(width, spacedResult);
		}

		return spacedResult;
	}

	/**
	 * Render a simple progress bar
	 */
	private renderProgressBar(percent: number, barWidth: number): string {
		const filled = Math.round((percent / 100) * barWidth);
		const empty = barWidth - filled;

		if (filled === barWidth) {
			return theme.fg("success", "█".repeat(barWidth));
		}

		if (filled === 0) {
			return theme.fg("dim", "░".repeat(barWidth));
		}

		return theme.fg("success", "█".repeat(filled)) + theme.fg("dim", "░".repeat(empty));
	}
}

export default SidebarTodoPanel;
