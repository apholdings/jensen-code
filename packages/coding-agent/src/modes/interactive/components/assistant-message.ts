import type { AssistantMessage } from "@apholdings/jensen-ai";
import { Container, Markdown, type MarkdownTheme, Spacer, Text } from "@apholdings/jensen-tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";

const BRIEF_ONLY_VISIBLE_TEXT =
	/(warning|error|failed|failure|denied|refused|approval|permission|security|unsafe|blocked|cannot|can't|required)/i;

function shouldShowTextInBriefOnly(text: string): boolean {
	return BRIEF_ONLY_VISIBLE_TEXT.test(text);
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private briefOnly: boolean;
	private lastMessage?: AssistantMessage;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		briefOnly = false,
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.briefOnly = briefOnly;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
	}

	setBriefOnly(briefOnly: boolean): void {
		this.briefOnly = briefOnly;
	}

	updateContent(message: AssistantMessage): void {
		this.lastMessage = message;

		// Clear content container
		this.contentContainer.clear();

		const hasVisibleContent = message.content.some((c) => {
			if (c.type === "text") {
				const trimmed = c.text.trim();
				if (!trimmed) {
					return false;
				}
				return !this.briefOnly || shouldShowTextInBriefOnly(trimmed);
			}
			if (c.type === "thinking") {
				return !this.briefOnly && c.thinking.trim().length > 0;
			}
			return false;
		});

		// No top spacer - spacing managed by parent container

		// Render content in order
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				if (this.briefOnly && !shouldShowTextInBriefOnly(content.text.trim())) {
					continue;
				}
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				this.contentContainer.addChild(new Markdown(content.text.trim(), 2, 0, this.markdownTheme));
			} else if (content.type === "thinking" && content.thinking.trim()) {
				if (this.briefOnly) {
					continue;
				}
				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				if (this.hideThinkingBlock) {
					// Show static "Thinking..." label when hidden
					this.contentContainer.addChild(new Text(theme.italic(theme.fg("thinkingText", "Thinking...")), 2, 0));
					if (hasVisibleContentAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				} else {
					// Thinking traces in thinkingText color, italic
					this.contentContainer.addChild(
						new Markdown(content.thinking.trim(), 2, 0, this.markdownTheme, {
							color: (text: string) => theme.fg("thinkingText", text),
							italic: true,
						}),
					);
					if (hasVisibleContentAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				}
			}
		}

		// Add bottom spacing when there's visible content and no tool calls
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		if (hasVisibleContent && !hasToolCalls && message.stopReason !== "aborted" && message.stopReason !== "error") {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Check if aborted - show after partial content
		// But only if there are no tool calls (tool execution components will show the error)
		if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				if (hasVisibleContent) {
					this.contentContainer.addChild(new Spacer(1));
				} else {
					this.contentContainer.addChild(new Spacer(1));
				}
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), 2, 1));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), 2, 1));
			}
		}
	}
}
