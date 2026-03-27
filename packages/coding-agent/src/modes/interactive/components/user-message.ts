import { Container, Markdown, type MarkdownTheme } from "@apholdings/jensen-tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { BorderedBox } from "./bordered-box.js";

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	constructor(text: string, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super();
		const box = new BorderedBox(2, 0, (text: string) => theme.fg("border", text));
		box.addChild(
			new Markdown(text.trim(), 0, 1, markdownTheme, {
				color: (text: string) => theme.fg("userMessageText", text),
			}),
		);
		this.addChild(box);
	}
}
