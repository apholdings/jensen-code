import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./system-prompt.js";
import { getToolPrompt } from "./tools/tools-prompt-data.js";

describe("prompt hardening verification", () => {
	describe("buildSystemPrompt includes Operator State Discipline section", () => {
		it("contains the Operator State Discipline section header", () => {
			const prompt = buildSystemPrompt();
			expect(prompt).toContain("Operator State Discipline:");
		});

		it("contains task_create delegation guidance", () => {
			const prompt = buildSystemPrompt();
			expect(prompt).toContain("Use task_create for multi-step work requiring explicit tracking");
		});

		it("contains todo_write usage guidance", () => {
			const prompt = buildSystemPrompt();
			expect(prompt).toContain("Use todo_write for ephemeral step-by-step progress tracking");
		});

		it("contains 'Do not delegate until you have captured what needs tracking'", () => {
			const prompt = buildSystemPrompt();
			expect(prompt).toContain("Do not delegate until you have captured what needs tracking");
		});

		it("contains 'If you have active delegated work' guidance", () => {
			const prompt = buildSystemPrompt();
			expect(prompt).toContain(
				"If you have active delegated work, there should be corresponding task or todo entries",
			);
		});
	});

	describe("getToolPrompt('task_create') contains expected hardening language", () => {
		it("contains 'Always call task_list FIRST'", () => {
			const prompt = getToolPrompt("task_create");
			expect(prompt).toBeDefined();
			expect(prompt).toContain("Always call task_list FIRST");
		});

		it("contains status transition guidance", () => {
			const prompt = getToolPrompt("task_create");
			expect(prompt).toContain("After creating, use task_update to mark the task as in_progress");
		});

		it("contains meaningful tasks guidance", () => {
			const prompt = getToolPrompt("task_create");
			expect(prompt).toContain("Meaningful tasks only");
			expect(prompt).toContain("Do NOT create a task for every trivial step");
		});
	});

	describe("getToolPrompt('todo_write') contains expected hardening language", () => {
		it("contains 'Exactly ONE task should be in_progress at any time'", () => {
			const prompt = getToolPrompt("todo_write");
			expect(prompt).toBeDefined();
			expect(prompt).toContain("Exactly ONE task should be in_progress at any time during active work");
		});

		it("contains 'When to use proactively' list", () => {
			const prompt = getToolPrompt("todo_write");
			expect(prompt).toContain("When to use proactively");
		});

		it("contains FULL LIST REPLACEMENT semantics", () => {
			const prompt = getToolPrompt("todo_write");
			expect(prompt).toContain("FULL LIST REPLACEMENT");
		});
	});

	describe("getToolPrompt('task_update') contains status transition rules", () => {
		it("contains 'pending → in_progress' transition", () => {
			const prompt = getToolPrompt("task_update");
			expect(prompt).toBeDefined();
			expect(prompt).toContain("pending → in_progress");
		});

		it("contains 'in_progress → completed' transition", () => {
			const prompt = getToolPrompt("task_update");
			expect(prompt).toContain("in_progress → completed");
		});

		it("contains 'Exactly ONE task should be in_progress'", () => {
			const prompt = getToolPrompt("task_update");
			expect(prompt).toContain("Exactly ONE task should be in_progress at any time");
		});
	});
});
