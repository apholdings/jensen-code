/**
 * TEST 18 — architecture constraint.
 *
 * The canonical mission domain must be portable: it must not import
 * Node child_process, concrete provider clients, the CLI parser, or terminal/UI
 * components. Only ProcessMissionExecutor may depend on process-spawn machinery.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const domainDir = fileURLToPath(new URL("../../src/core/mission-domain/", import.meta.url));

const PURE_DOMAIN_FILES = [
	"mission-state.ts",
	"mission-request.ts",
	"mission-handle.ts",
	"mission-result.ts",
	"mission-executor.ts",
	"reliability-mapping.ts",
] as const;

const FORBIDDEN_IMPORTS = [
	"node:child_process",
	'from "child_process"',
	"from 'child_process'",
	"@apholdings/jensen-ai",
	"@apholdings/jensen-tui",
	"modes/interactive",
	"cli/args",
] as const;

function source(name: string): string {
	return readFileSync(`${domainDir}${name}`, "utf8");
}

describe("mission domain architecture", () => {
	it("domain files do not import process/provider/CLI/UI machinery", () => {
		for (const file of PURE_DOMAIN_FILES) {
			const text = source(file);
			for (const forbidden of FORBIDDEN_IMPORTS) {
				expect(text, `${file} must not import ${forbidden}`).not.toContain(forbidden);
			}
		}
	});

	it("only ProcessMissionExecutor imports process-spawn machinery", () => {
		expect(source("process-mission-executor.ts")).toContain("node:child_process");
	});
});
