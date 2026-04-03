import { describe, expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "./slash-commands.js";

describe("built-in slash commands", () => {
	it("uses Jensen branding for quit and exit descriptions", () => {
		const quitCommand = BUILTIN_SLASH_COMMANDS.find((entry) => entry.name === "quit");
		const exitCommand = BUILTIN_SLASH_COMMANDS.find((entry) => entry.name === "exit");

		expect(quitCommand?.description).toBe("Quit Jensen");
		expect(exitCommand?.description).toBe("Exit Jensen");
	});
});
