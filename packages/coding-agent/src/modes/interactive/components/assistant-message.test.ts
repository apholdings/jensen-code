import type { AssistantMessage } from "@apholdings/jensen-ai";
import { Markdown, Text } from "@apholdings/jensen-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { initTheme } from "../theme/theme.js";
import { AssistantMessageComponent } from "./assistant-message.js";

function getContentChildren(component: AssistantMessageComponent) {
	const container = component as unknown as {
		contentContainer: { children: unknown[] };
	};
	return container.contentContainer.children;
}

function makeAssistantMessage(overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		provider: "test-provider",
		model: "test-model",
		stopReason: "end_turn",
		errorMessage: undefined,
		content: [{ type: "text", text: "Detailed assistant prose" }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { total: 0 },
		},
		timestamp: Date.now(),
		...overrides,
	} as AssistantMessage;
}

beforeAll(() => {
	initTheme("dark");
});

describe("AssistantMessageComponent brief-only rendering", () => {
	it("renders ordinary assistant prose when brief-only is disabled", () => {
		const component = new AssistantMessageComponent(
			makeAssistantMessage({
				content: [
					{ type: "text", text: "Detailed assistant prose" },
					{ type: "thinking", thinking: "internal reasoning" },
				],
			}),
			false,
			undefined,
			false,
		);

		const children = getContentChildren(component);
		expect(children.some((child) => child instanceof Markdown)).toBe(true);
	});

	it("suppresses ordinary assistant prose when brief-only is enabled", () => {
		const component = new AssistantMessageComponent(
			makeAssistantMessage({
				content: [
					{ type: "text", text: "Detailed assistant prose" },
					{ type: "thinking", thinking: "internal reasoning" },
				],
			}),
			false,
			undefined,
			true,
		);

		const children = getContentChildren(component);
		expect(children.some((child) => child instanceof Markdown)).toBe(false);
		expect(children.some((child) => child instanceof Text)).toBe(false);
	});

	it("still shows security-relevant warning prose when brief-only is enabled", () => {
		const component = new AssistantMessageComponent(
			makeAssistantMessage({
				content: [{ type: "text", text: "Warning: approval required before deleting credentials." }],
			}),
			false,
			undefined,
			true,
		);

		const children = getContentChildren(component);
		expect(children.some((child) => child instanceof Markdown)).toBe(true);
	});

	it("still shows honest error output when brief-only is enabled", () => {
		const component = new AssistantMessageComponent(
			makeAssistantMessage({
				stopReason: "error",
				errorMessage: "Permission denied",
				content: [{ type: "text", text: "Hidden prose" }],
			}),
			false,
			undefined,
			true,
		);

		const children = getContentChildren(component);
		const errorText = children.find((child) => child instanceof Text) as (Text & { text?: string }) | undefined;
		expect(errorText).toBeDefined();
		expect(errorText?.text).toContain("Error: Permission denied");
	});
});
