import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	const dir = mkdtempSync(join(tmpdir(), "jensen-protocol-status-entrypoint-"));
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

function createPrintModeSessionStub(protocolContextPath?: string) {
	const btwNotes: string[] = [];
	const agentsFiles = protocolContextPath ? [{ path: protocolContextPath, content: "protocol\n" }] : [];

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
		resourceLoader: {
			getAgentsFiles: () => ({ agentsFiles }),
		},
	};
}

describe("/protocol-status command entrypoint", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("registers a built-in /protocol-status slash command", () => {
		const command = BUILTIN_SLASH_COMMANDS.find((entry) => entry.name === "protocol-status");
		expect(command).toBeDefined();
		expect(command?.description).toContain("Protocol");
	});

	it("routes interactive mode submissions through the explicit protocol-status handler", () => {
		const source = readSource("interactive/interactive-mode.ts");

		expect(source).toContain('if (text === "/protocol-status")');
		expect(source).toContain("this.handleProtocolStatusCommand();");
	});

	it("reports the effective Protocol marker through print mode", async () => {
		const cwd = createTempDir();
		const workspaceDir = join(cwd, "workspace");
		const appDir = join(workspaceDir, "app");
		const markerPath = join(workspaceDir, ".jensen", "JENSEN_PROTOCOL.md");
		mkdirSync(dirname(markerPath), { recursive: true });
		mkdirSync(appDir, { recursive: true });
		writeFileSync(markerPath, "protocol\n", "utf8");
		writeFileSync(join(workspaceDir, "README.md"), "workspace\n", "utf8");
		const previousCwd = process.cwd();
		process.chdir(appDir);

		try {
			const output = await getPrintModeLocalCommandOutput(
				createPrintModeSessionStub(markerPath),
				"/protocol-status",
			);

			expect(output).toContain("Protocol workspace marker: detected");
			expect(output).toContain(`Effective marker file: ${markerPath}`);
			expect(output).toContain(`Workspace root: ${workspaceDir}`);
			expect(output).toContain("Protocol context in harness: available");
		} finally {
			process.chdir(previousCwd);
		}
	});

	it("reports non-Protocol workspaces honestly through print mode", async () => {
		const cwd = createTempDir();
		const appDir = join(cwd, "app");
		mkdirSync(appDir, { recursive: true });
		const previousCwd = process.cwd();
		writeFileSync(join(cwd, "README.md"), "workspace\n", "utf8");
		process.chdir(appDir);

		try {
			const output = await getPrintModeLocalCommandOutput(createPrintModeSessionStub(), "/protocol-status");

			expect(output).toContain("Protocol workspace marker: not detected");
			expect(output).toContain("Effective marker file: none");
			expect(output).toContain("Protocol context in harness: unavailable");
		} finally {
			process.chdir(previousCwd);
		}
	});
});
