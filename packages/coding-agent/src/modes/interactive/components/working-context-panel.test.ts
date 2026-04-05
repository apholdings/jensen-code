import { visibleWidth } from "@apholdings/jensen-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { initTheme } from "../theme/theme.js";
import { WorkingContextPanel } from "./working-context-panel.js";

beforeAll(() => {
	initTheme("dark");
});

describe("WorkingContextPanel", () => {
	it("renders nothing when no state is available", () => {
		const panel = new WorkingContextPanel();
		expect(panel.render(80)).toEqual([]);
	});

	it("renders a compact summary at narrow widths", () => {
		const panel = new WorkingContextPanel();
		panel.update({
			memory: { itemCount: 3, staleCount: 1, keyPreview: ["branch", "repo"] },
			todo: { total: 4, completed: 1, inProgress: "Implementing panel" },
			delegatedWork: { activeCount: 1, completedCount: 2, failedCount: 0, activeAgents: ["worker"] },
		});

		const lines = panel.render(71);
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("Working Context");
		expect(lines[1]).toContain("Memory:");
		expect(lines[1]).toContain("Plan:");
		expect(lines[1]).toContain("Delegated:");
	});

	it("renders detail lines at wider widths", () => {
		const panel = new WorkingContextPanel();
		panel.update({
			memory: { itemCount: 2, staleCount: 0, keyPreview: ["branch", "goal"] },
			todo: { total: 3, completed: 1, inProgress: "Writing tests" },
			delegatedWork: {
				activeCount: 1,
				completedCount: 0,
				failedCount: 1,
				activeAgents: ["worker", "reviewer"],
				failurePreview: [
					{ agent: "reviewer", task: "Review the panel", mode: "parallel", status: "blocked", childIndex: 2 },
				],
			},
		});

		const lines = panel.render(100);
		expect(lines).toHaveLength(6);
		expect(lines[2]).toContain("Memory keys:");
		expect(lines[2]).toContain("branch, goal");
		expect(lines[3]).toContain("Current todo:");
		expect(lines[3]).toContain("Writing tests");
		expect(lines[4]).toContain("Active delegates:");
		expect(lines[4]).toContain("worker, reviewer");
		expect(lines[5]).toContain("Failed delegates:");
		expect(lines[5]).toContain("blocked child 2 reviewer");
	});

	it("shows failed delegated count honestly", () => {
		const panel = new WorkingContextPanel();
		panel.update({
			delegatedWork: { activeCount: 0, completedCount: 2, failedCount: 1 },
		});

		const [, line] = panel.render(80);
		expect(line).toContain("1 failed");
		expect(line).not.toContain("pending");
	});

	it("renders tasks in compact summary", () => {
		const panel = new WorkingContextPanel();
		panel.update({
			tasks: { total: 5, pending: 2, inProgress: 1, completed: 2 },
		});

		const lines = panel.render(71);
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("Tasks:");
		expect(lines[1]).toContain("2/5");
		expect(lines[1]).toContain("1 active");
	});

	it("renders inProgressTask at wider widths", () => {
		const panel = new WorkingContextPanel();
		panel.update({
			tasks: {
				total: 3,
				pending: 1,
				inProgress: 1,
				completed: 1,
				inProgressTask: { id: "task_1", subject: "Fix the bug", activeForm: "Fixing the bug" },
			},
		});

		const lines = panel.render(100);
		expect(lines).toHaveLength(3);
		expect(lines[2]).toContain("Current task:");
		expect(lines[2]).toContain("Fix the bug");
	});

	it("renders '(none)' when no inProgressTask", () => {
		const panel = new WorkingContextPanel();
		panel.update({
			tasks: { total: 3, pending: 3, inProgress: 0, completed: 0 },
		});

		const lines = panel.render(100);
		expect(lines).toHaveLength(3);
		expect(lines[2]).toContain("(none)");
	});

	it("keeps rendered lines within width", () => {
		const panel = new WorkingContextPanel();
		panel.update({
			memory: { itemCount: 5, staleCount: 2, keyPreview: ["one", "two", "three", "four", "five"] },
			todo: { total: 9, completed: 3, inProgress: "A very long in-progress task that should be truncated" },
			delegatedWork: {
				activeCount: 2,
				completedCount: 4,
				failedCount: 1,
				activeAgents: ["agent-one", "agent-two", "agent-three"],
				failurePreview: [
					{
						agent: "reviewer",
						task: "Review the long-running output and verify all edge cases for the panel",
						mode: "parallel",
						childIndex: 2,
						errorMessage:
							"A very long reviewer failure message that should be truncated within the line width constraints",
					},
				],
			},
		});

		for (const line of panel.render(72)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(72);
		}
	});
});
