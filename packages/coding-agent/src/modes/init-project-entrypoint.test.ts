import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../core/slash-commands.js";
import type { UltraplanArtifact, UltraplanRunResult } from "../core/ultraplan.js";
import { getPrintModeLocalCommandOutput } from "./print-mode.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "jensen-init-project-entrypoint-"));
	tempDirs.push(dir);
	return dir;
}

function readSource(relativePath: string): string {
	return readFileSync(join(__dirname, relativePath), "utf8");
}

function makeUltraplanArtifact(): UltraplanArtifact {
	return {
		version: 1,
		plannerMode: "local_subagent",
		plannerAgent: "planner",
		executionState: "plan_only",
		objective: "unused",
		assumptions: [],
		constraints: [],
		phases: [],
		risks: [],
		recommendedExecutionOrder: [],
		actionableNextSteps: [],
		createdAt: "2026-04-03T00:00:00.000Z",
	};
}

function makeUltraplanRunResult(): UltraplanRunResult {
	return {
		artifact: makeUltraplanArtifact(),
		displayText: "unused",
		rawPlannerOutput: "",
	};
}

function createPrintModeSessionStub() {
	const btwNotes: string[] = [];

	return {
		briefOnly: false,
		setBriefOnly: () => {},
		queueByTheWay: (note: string) => {
			btwNotes.push(note);
		},
		getPendingByTheWayNotes: () => btwNotes,
		getMemoryHistory: () => [],
		resolveMemorySnapshotSelector: () => ({
			snapshot: undefined,
			matchedInput: "",
			resolvedId: undefined,
			error: "empty" as const,
			candidates: [],
		}),
		getLatestUltraplanPlan: () => undefined,
		runUltraplan: async () => makeUltraplanRunResult(),
		runUltraplanRevise: async () => makeUltraplanRunResult(),
		applyUltraplan: () => ({ applied: [], displayText: "unused" }),
	};
}

describe("/init-project command entrypoint", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("registers a built-in /init-project slash command", () => {
		const command = BUILTIN_SLASH_COMMANDS.find((entry) => entry.name === "init-project");
		expect(command).toBeDefined();
		expect(command?.description).toContain("project-local Jensen harness");
	});

	it("routes interactive mode submissions through the explicit init-project handler", () => {
		const source = readSource("interactive/interactive-mode.ts");

		expect(source).toContain('if (text === "/init-project" || text.startsWith("/init-project "))');
		expect(source).toContain("await this.handleInitProjectCommand();");
		expect(source).toContain('this.showWarning("Usage: /init-project");');
	});

	it("invokes /init-project through print mode and creates scaffold files", async () => {
		const cwd = createTempDir();
		const previousCwd = process.cwd();
		process.chdir(cwd);

		try {
			const output = await getPrintModeLocalCommandOutput(createPrintModeSessionStub(), "/init-project");

			expect(output).toContain("/init-project completed.");
			expect(output).toContain(".jensen/settings.json");
			expect(readFileSync(join(cwd, ".jensen", "settings.json"), "utf-8")).toContain('"./extensions/subagent"');
		} finally {
			process.chdir(previousCwd);
		}
	});
});
