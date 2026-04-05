import { Container } from "@apholdings/jensen-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../core/agent-session.js";
import type { WorkingContext } from "../../core/working-context.js";
import { InteractiveMode } from "./interactive-mode.js";
import { initTheme } from "./theme/theme.js";

type SessionCommandHarness = {
	handleSessionCommand: () => void;
	chatContainer: Container;
};

beforeAll(() => {
	initTheme("dark");
});

function createMockSession(workingContext: Partial<WorkingContext>): AgentSession {
	return {
		getSessionStats: () => ({
			sessionFile: undefined,
			sessionId: "test-session-id",
			userMessages: 1,
			assistantMessages: 1,
			toolCalls: 0,
			toolResults: 0,
			totalMessages: 2,
			tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
			cost: 0,
		}),
		getWorkingContext: () =>
			({
				memory: {
					itemCount: 0,
					staleCount: 0,
					keyPreview: [],
					isPersisted: true,
					scope: "current_branch_session_state",
				},
				todo: { total: 0, completed: 0, isPersisted: true, scope: "current_branch_session_state" },
				tasks: workingContext.tasks ?? {
					total: 0,
					pending: 0,
					inProgress: 0,
					completed: 0,
					isPersisted: true,
					scope: "current_branch_session_state",
				},
				delegatedWork: {
					activeCount: 0,
					completedCount: 0,
					failedCount: 0,
					activeAgents: [],
					failurePreview: [],
					isPersisted: false,
					scope: "current_process_runtime_state",
					note: "live current-process state only; not persisted and resets on session switch/resume",
				},
			}) as WorkingContext,
		getRecentDelegatedTasks: () => [],
		sessionManager: { getSessionName: () => undefined },
	} as unknown as AgentSession;
}

function createModeInstance(session: AgentSession): SessionCommandHarness {
	return Object.assign(Object.create(InteractiveMode.prototype), {
		pendingTools: new Map(),
		chatContainer: new Container(),
		ui: { requestRender: vi.fn(), terminal: { columns: 160 } },
		editor: { setText: vi.fn() },
		session,
	}) as unknown as SessionCommandHarness;
}

describe("handleSessionCommand task visibility", () => {
	it("renders task summary when tasks exist", () => {
		const session = createMockSession({
			tasks: {
				total: 3,
				pending: 1,
				inProgress: 1,
				completed: 1,
				inProgressTask: { id: "task_2", subject: "Test task 2", activeForm: "Testing" },
				isPersisted: true,
				scope: "current_branch_session_state",
			},
		});
		const mode = createModeInstance(session);

		mode.handleSessionCommand();

		const textChild = mode.chatContainer.children.find(
			(c) => "text" in c && typeof c.text === "string" && c.text.includes("Tasks:"),
		);
		expect(textChild).toBeDefined();
		const output = stripAnsi((textChild as unknown as { text: string }).text);
		expect(output).toContain("Tasks:");
		expect(output).toContain("1/3 completed");
		expect(output).toContain("1 in progress");
	});

	it("renders empty task state correctly", () => {
		const session = createMockSession({
			tasks: {
				total: 0,
				pending: 0,
				inProgress: 0,
				completed: 0,
				isPersisted: true,
				scope: "current_branch_session_state",
			},
		});
		const mode = createModeInstance(session);

		mode.handleSessionCommand();

		const textChild = mode.chatContainer.children.find(
			(c) => "text" in c && typeof c.text === "string" && c.text.includes("Tasks:"),
		);
		expect(textChild).toBeDefined();
		const output = stripAnsi((textChild as unknown as { text: string }).text);
		expect(output).toContain("0/0 completed");
	});

	it("surfaces in-progress task subject", () => {
		const session = createMockSession({
			tasks: {
				total: 2,
				pending: 1,
				inProgress: 1,
				completed: 0,
				inProgressTask: { id: "task_1", subject: "Implement feature X", activeForm: "Implementing feature X" },
				isPersisted: true,
				scope: "current_branch_session_state",
			},
		});
		const mode = createModeInstance(session);

		mode.handleSessionCommand();

		const textChild = mode.chatContainer.children.find(
			(c) => "text" in c && typeof c.text === "string" && c.text.includes("Tasks:"),
		);
		expect(textChild).toBeDefined();
		const output = stripAnsi((textChild as unknown as { text: string }).text);
		expect(output).toContain("Implement feature X");
	});

	it("does not regress existing session sections", () => {
		const session = createMockSession({});
		const mode = createModeInstance(session);

		mode.handleSessionCommand();

		const textChild = mode.chatContainer.children.find((c) => "text" in c && typeof c.text === "string");
		expect(textChild).toBeDefined();
		const output = stripAnsi((textChild as unknown as { text: string }).text);
		expect(output).toContain("Session Info");
		expect(output).toContain("Memory:");
		expect(output).toContain("Plan:");
		expect(output).toContain("Delegated:");
		expect(output).toContain("Tokens");
	});
});
