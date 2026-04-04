import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readSource(relativePath: string): string {
	return readFileSync(join(__dirname, relativePath), "utf8");
}

describe("working-context consumer consolidation", () => {
	it("keeps interactive-mode on the session-level entrypoint", () => {
		const source = readSource("interactive/interactive-mode.ts");

		expect(source).not.toContain("buildWorkingContext(");
		expect(source).toContain("this.workingContextPanel.update(this.session.getWorkingContext());");
		expect(source).toContain("const workingContext = this.session.getWorkingContext();");
	});

	it("keeps rpc-mode on the session-level entrypoint", () => {
		const source = readSource("rpc/rpc-mode.ts");

		expect(source).not.toContain("buildWorkingContext(");
		expect(source).toContain('return success(id, "get_working_context", session.getWorkingContext());');
	});
});
