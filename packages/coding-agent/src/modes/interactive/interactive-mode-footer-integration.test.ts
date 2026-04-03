import { Container } from "@apholdings/jensen-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../core/agent-session.js";
import type { ReadonlyFooterDataProvider } from "../../core/footer-data-provider.js";
import type { SessionContext } from "../../core/session-manager.js";
import { BashExecutionComponent } from "./components/bash-execution.js";
import { FooterComponent } from "./components/footer.js";
import { InteractiveMode } from "./interactive-mode.js";
import { getMarkdownTheme, initTheme } from "./theme/theme.js";

beforeAll(() => {
	initTheme("dark");
});

function createFooterData(): ReadonlyFooterDataProvider {
	return {
		getGitRepoName: () => "jensen-code",
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map(),
		onBranchChange: () => () => {},
		getAvailableProviderCount: () => 0,
	};
}

describe("InteractiveMode footer cost integration", () => {
	it("renders turn and session cost from a real multi-turn session history using the current bash/user turn boundary semantics", () => {
		const messages = [
			{
				role: "user",
				content: [{ type: "text", text: "first turn" }],
			},
			{
				role: "assistant",
				provider: "openrouter",
				model: "ai21/jamba-large-1.7",
				content: [{ type: "text", text: "first answer" }],
				usage: {
					input: 1000,
					output: 500,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1500,
				},
				stopReason: "end_turn",
				timestamp: 1,
			},
			{
				role: "bashExecution",
				command: "pwd",
				output: "/home/magnus/software/jensen-code",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 2,
			},
			{
				role: "assistant",
				provider: "openrouter",
				model: "ai21/jamba-large-1.7",
				content: [{ type: "text", text: "second answer after bash" }],
				usage: {
					input: 500,
					output: 250,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 750,
				},
				stopReason: "end_turn",
				timestamp: 3,
			},
		] as AgentSession["state"]["messages"];

		const session = {
			state: {
				messages,
				model: null,
			},
			briefOnly: false,
			extensionRunner: undefined,
			settingsManager: { getShowImages: () => false },
			getContextUsage: () => ({ tokens: 1200, contextWindow: 128000, percent: 0.9375 }),
		} as unknown as AgentSession;

		const mode = Object.assign(Object.create(InteractiveMode.prototype), {
			pendingTools: new Map(),
			chatContainer: new Container(),
			footer: new FooterComponent(session, createFooterData()),
			updatePromptChrome: vi.fn(),
			ui: { requestRender: vi.fn(), terminal: { columns: 160 } },
			getRegisteredToolDefinition: () => undefined,
			toolOutputExpanded: false,
			session,
			hideThinkingBlock: false,
			getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		}) as unknown as {
			renderSessionContext: (
				context: SessionContext,
				options?: { updateFooter?: boolean; populateHistory?: boolean },
			) => void;
			chatContainer: Container;
			footer: FooterComponent;
		};

		mode.renderSessionContext(
			{
				messages: messages as SessionContext["messages"],
				thinkingLevel: "off",
				model: null,
				memoryItems: [],
				todos: [],
			},
			{ updateFooter: true },
		);

		expect(mode.chatContainer.children.some((child) => child instanceof BashExecutionComponent)).toBe(true);

		const line = stripAnsi(mode.footer.render(160)[0] ?? "");
		expect(line).toContain("cost turn $0.003000 · session $0.009000");
	});
});
