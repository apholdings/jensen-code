import { visibleWidth } from "@apholdings/jensen-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { initTheme } from "../theme/theme.js";
import { TodoListComponent } from "./todo-list.js";

beforeAll(() => {
	initTheme("dark");
});

describe("TodoListComponent", () => {
	describe("conditional rendering", () => {
		it("renders nothing when no todos exist", () => {
			const panel = new TodoListComponent();
			panel.update([]);
			expect(panel.render(80)).toEqual([]);
		});

		it("renders status line when todos exist", () => {
			const panel = new TodoListComponent();
			panel.update([
				{ content: "First task", activeForm: "First task", status: "in_progress" },
				{ content: "Second task", activeForm: "Second task", status: "pending" },
			]);
			const lines = panel.render(80);
			expect(lines.length).toBeGreaterThan(0);
			expect(lines[0]).toContain("Tasks:");
			expect(lines[0]).toContain("done");
		});

		it("shows correct completion count", () => {
			const panel = new TodoListComponent();
			panel.update([
				{ content: "Task one", activeForm: "Task one", status: "completed" },
				{ content: "Task two", activeForm: "Task two", status: "in_progress" },
				{ content: "Task three", activeForm: "Task three", status: "pending" },
				{ content: "Task four", activeForm: "Task four", status: "completed" },
			]);
			const lines = panel.render(80);
			expect(lines[0]).toContain("2/4");
		});

		it("shows in-progress task in expanded mode", () => {
			const panel = new TodoListComponent();
			panel.update([
				{ content: "Working on feature", activeForm: "Implementing the feature", status: "in_progress" },
				{ content: "Done task", activeForm: "Done task", status: "completed" },
			]);
			const lines = panel.render(80);
			// Status line + one line per task = 3 lines
			expect(lines.length).toBe(3);
			expect(lines[0]).toContain("Working:");
			expect(lines[0]).toContain("Implementing the feature");
		});

		it("renders compact at narrow widths", () => {
			const panel = new TodoListComponent();
			panel.update([
				{ content: "Task one", activeForm: "Task one", status: "pending" },
				{ content: "Task two", activeForm: "Task two", status: "pending" },
			]);
			// At narrow width, should only show status line
			const lines = panel.render(40);
			expect(lines.length).toBe(1);
			expect(lines[0]).toContain("Tasks:");
		});

		it("keeps rendered lines within width", () => {
			const panel = new TodoListComponent();
			panel.update([
				{
					content: "A very long task description that should be truncated at narrow widths",
					activeForm: "A very long active form description",
					status: "in_progress",
				},
				{
					content: "Another long task that needs truncation when the terminal is narrow",
					activeForm: "Another long active form text",
					status: "pending",
				},
			]);
			for (const line of panel.render(60)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(60);
			}
		});

		it("handles all todo statuses correctly", () => {
			const panel = new TodoListComponent();
			panel.update([
				{ content: "Pending task", activeForm: "Pending task", status: "pending" },
				{ content: "In progress task", activeForm: "Working on it", status: "in_progress" },
				{ content: "Completed task", activeForm: "Completed task", status: "completed" },
			]);
			const lines = panel.render(80);
			// Status line + 3 task lines
			expect(lines.length).toBe(4);
		});

		it("empty todos returns empty array at any width", () => {
			const panel = new TodoListComponent();
			panel.update([]);
			// Both narrow and wide should return empty
			expect(panel.render(30)).toEqual([]);
			expect(panel.render(100)).toEqual([]);
		});
	});
});
