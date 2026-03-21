import { TUI, ProcessTerminal } from "@apholdings/jensen-tui";
import { UserMessageComponent } from "./packages/coding-agent/src/modes/interactive/components/user-message.js";
import { getMarkdownTheme, initTheme } from "./packages/coding-agent/src/modes/interactive/theme/theme.js";

initTheme("default");
const tui = new TUI(new ProcessTerminal(), false);
const comp = new UserMessageComponent("Hello World", getMarkdownTheme());
tui.addChild(comp);
const lines = tui.render(80);
console.log("Lines length:", lines.length);
console.log("Line 0:", JSON.stringify(lines[0]));
