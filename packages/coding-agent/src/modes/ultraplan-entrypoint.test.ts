import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../core/slash-commands.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readSource(relativePath: string): string {
	return readFileSync(join(__dirname, relativePath), "utf8");
}

describe("Ultraplan command entrypoint", () => {
	it("registers a built-in /ultraplan slash command with explicit revision support", () => {
		const command = BUILTIN_SLASH_COMMANDS.find((entry) => entry.name === "ultraplan");
		expect(command).toBeDefined();
		expect(command?.description).toContain("revise");
		expect(command?.description).toContain("regenerate");
	});

	it("routes interactive mode submissions through the explicit Ultraplan command handler", () => {
		const source = readSource("interactive/interactive-mode.ts");

		expect(source).toContain('if (text === "/ultraplan" || text.startsWith("/ultraplan "))');
		expect(source).toContain("await this.handleUltraplanCommand(text);");
		expect(source).toContain('args === "apply"');
		expect(source).toContain('args.startsWith("revise ") || args === "revise"');
		expect(source).toContain('args.startsWith("regenerate ") || args === "regenerate"');
	});
});
