import type { AssistantMessage } from "@apholdings/jensen-ai";
import { Container } from "@apholdings/jensen-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionContext } from "../../core/session-manager.js";
import { ToolExecutionComponent } from "./components/tool-execution.js";
import { InteractiveMode } from "./interactive-mode.js";
import { getMarkdownTheme, initTheme } from "./theme/theme.js";

beforeAll(() => {
	initTheme("dark");
});

describe("InteractiveMode brief-only honesty", () => {
	it("toggles brief-only mode through the /brief command surface", () => {
		const mode = Object.assign(Object.create(InteractiveMode.prototype), {
			chatContainer: new Container(),
			showWarning: vi.fn(),
			ui: { requestRender: vi.fn() },
			session: {
				briefOnly: false,
				setBriefOnly(enabled: boolean) {
					this.briefOnly = enabled;
				},
			},
		}) as unknown as {
			handleBriefCommand: (text: string) => void;
			chatContainer: Container;
			session: { briefOnly: boolean };
		};

		mode.handleBriefCommand("/brief status");
		expect(mode.chatContainer.children.at(-1)).toMatchObject({
			text: expect.stringContaining("Brief-only mode is disabled for this session only (runtime-only)."),
		});
		mode.handleBriefCommand("/brief on");
		expect(mode.session.briefOnly).toBe(true);
		expect(mode.chatContainer.children.at(-1)).toMatchObject({
			text: expect.stringContaining("Enabled brief-only mode for this session only (runtime-only)."),
		});
		mode.handleBriefCommand("/brief off");
		expect(mode.session.briefOnly).toBe(false);
		expect(mode.chatContainer.children.at(-1)).toMatchObject({
			text: expect.stringContaining("Disabled brief-only mode for this session only (runtime-only)."),
		});
	});

	it("queues /btw guidance through the interactive command surface", () => {
		const mode = Object.assign(Object.create(InteractiveMode.prototype), {
			chatContainer: new Container(),
			showWarning: vi.fn(),
			ui: { requestRender: vi.fn() },
			session: {
				pendingBtwNotes: [] as string[],
				queueByTheWay(note: string) {
					this.pendingBtwNotes.push(note);
				},
				getPendingByTheWayNotes() {
					return this.pendingBtwNotes;
				},
			},
		}) as unknown as {
			handleBtwCommand: (text: string) => void;
			chatContainer: Container;
			session: { pendingBtwNotes: string[] };
		};

		mode.handleBtwCommand("/btw keep the next step narrow");
		expect(mode.session.pendingBtwNotes).toEqual(["keep the next step narrow"]);
		expect(mode.chatContainer.children.at(-1)).toMatchObject({
			text: expect.stringContaining("Queued by-the-way guidance for the next turn only (runtime-only)."),
		});

		mode.handleBtwCommand("/btw mention the pending blocker");
		expect(mode.session.pendingBtwNotes).toEqual(["keep the next step narrow", "mention the pending blocker"]);
		expect(mode.chatContainer.children.at(-1)).toMatchObject({
			text: expect.stringContaining("Pending BTW notes: 2."),
		});
	});

	it("keeps tool activity visible when assistant prose is suppressed", () => {
		const mode = Object.assign(Object.create(InteractiveMode.prototype), {
			pendingTools: new Map(),
			chatContainer: new Container(),
			footer: { invalidate: vi.fn() },
			updatePromptChrome: vi.fn(),
			ui: { requestRender: vi.fn() },
			getRegisteredToolDefinition: () => undefined,
			toolOutputExpanded: false,
			session: {
				briefOnly: true,
				retryAttempt: 0,
				settingsManager: { getShowImages: () => false },
				extensionRunner: undefined,
			},
			hideThinkingBlock: false,
			getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		}) as unknown as {
			renderSessionContext: (
				context: SessionContext,
				options?: { updateFooter?: boolean; populateHistory?: boolean },
			) => void;
			chatContainer: Container;
		};

		const assistantMessage = {
			role: "assistant",
			provider: "test-provider",
			model: "test-model",
			stopReason: "end_turn",
			errorMessage: undefined,
			content: [
				{ type: "text", text: "suppressed prose" },
				{ type: "toolCall", id: "call_1", name: "bash", arguments: '{"command":"pwd"}' },
			],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0 },
			},
			timestamp: Date.now(),
		} as unknown as AssistantMessage;

		mode.renderSessionContext({
			messages: [assistantMessage],
			thinkingLevel: "off",
			model: null,
			memoryItems: [],
			todos: [],
		});

		expect(mode.chatContainer.children.some((child) => child instanceof ToolExecutionComponent)).toBe(true);
	});
});
