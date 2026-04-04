import { type Component, truncateToWidth } from "@apholdings/jensen-tui";
import { theme } from "../theme/theme.js";

/**
 * Todo item as emitted in the todo_update event.
 */
export interface TodoUpdateItem {
	content: string;
	activeForm: string;
	status: string;
}

/**
 * Compact threshold for showing expandable details vs just the status line.
 */
const EXPAND_THRESHOLD = 80;

/**
 * Component that renders the todo list as a compact status bar.
 * Shows a summary line and optional expandable task details.
 */
export class TodoListComponent implements Component {
	private todos: TodoUpdateItem[] = [];

	update(todos: TodoUpdateItem[]): void {
		this.todos = todos;
	}

	render(width: number): string[] {
		if (this.todos.length === 0) {
			return [];
		}

		const completed = this.todos.filter((t) => t.status === "completed").length;
		const inProgress = this.todos.find((t) => t.status === "in_progress");
		const total = this.todos.length;

		// Build the status line
		const statusParts: string[] = [];
		statusParts.push(theme.fg("muted", "Tasks:"));
		statusParts.push(`${completed}/${total}`);
		statusParts.push(theme.fg("success", "done"));

		if (inProgress) {
			statusParts.push(theme.fg("muted", "|"));
			statusParts.push(theme.fg("muted", "Working:"));
			statusParts.push(theme.fg("warning", truncateToWidth(inProgress.activeForm, 40)));
		}

		const statusLine = statusParts.join(" ");

		// If narrow width, just show the status line
		if (width < EXPAND_THRESHOLD) {
			return [truncateToWidth(statusLine, width)];
		}

		// Show status line plus one line per task
		const lines: string[] = [statusLine];

		// Render each task
		for (const todo of this.todos) {
			let icon: string;
			let text: string;
			let colorFn: (text: string) => string;

			switch (todo.status) {
				case "completed":
					icon = theme.fg("success", "✓");
					text = todo.content;
					colorFn = (t) => theme.fg("dim", t);
					break;
				case "in_progress":
					icon = theme.fg("warning", "◉");
					text = todo.activeForm;
					colorFn = (t) => theme.fg("warning", theme.bold(t));
					break;
				default:
					icon = theme.fg("muted", "○");
					text = todo.content;
					colorFn = (t) => theme.fg("text", t);
					break;
			}

			const taskLine = `  ${icon} ${colorFn(text)}`;
			lines.push(truncateToWidth(taskLine, width));
		}

		return lines;
	}

	invalidate(): void {
		// No-op: we don't cache anything
	}
}

export default TodoListComponent;
