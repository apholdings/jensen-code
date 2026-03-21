import { UserMessageComponent } from "./packages/coding-agent/src/modes/interactive/components/user-message.js";
import { getMarkdownTheme, initTheme } from "./packages/coding-agent/src/modes/interactive/theme/theme.js";

initTheme("default");
const comp1 = new UserMessageComponent("Hello\n", getMarkdownTheme());
console.log(comp1.render(80));
