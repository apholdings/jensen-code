import { TUI, ProcessTerminal } from "@apholdings/jensen-tui";
import { UserMessageComponent } from "./packages/coding-agent/src/modes/interactive/components/user-message.js";
import { getMarkdownTheme, initTheme } from "./packages/coding-agent/src/modes/interactive/theme/theme.js";

initTheme("default");
const comp = new UserMessageComponent("Line 1\nLine 2", getMarkdownTheme());
console.log(comp.render(80));