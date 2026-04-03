import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeProjectScaffold } from "./init-project.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { SettingsManager } from "./settings-manager.js";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "jensen-init-project-"));
	tempDirs.push(dir);
	return dir;
}

describe("initializeProjectScaffold", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("creates the minimal harness-ready scaffold", () => {
		const cwd = createTempDir();

		const result = initializeProjectScaffold(cwd);

		expect(result.createdFiles).toEqual([
			"JENSEN.md",
			".jensen/settings.json",
			".jensen/extensions/subagent/index.ts",
			".jensen/extensions/subagent/agents.ts",
			".jensen/agents/planner.md",
			".jensen/agents/scout.md",
			".jensen/agents/worker.md",
			".jensen/agents/reviewer.md",
			".jensen/agents/security.md",
			".jensen/agents/pentester.md",
			".jensen/agents/librarian.md",
		]);
		expect(result.updatedFiles).toEqual([]);
		expect(result.warnings).toEqual([]);
		expect(result.output).toContain("/init-project completed.");
		expect(result.output).toContain("Existing files were preserved. Safe to rerun.");

		expect(existsSync(join(cwd, "JENSEN.md"))).toBe(true);
		expect(existsSync(join(cwd, ".jensen", "JENSEN_PROTOCOL.md"))).toBe(false);
		expect(readFileSync(join(cwd, "JENSEN.md"), "utf-8")).toContain(".jensen/agents/");
		expect(readFileSync(join(cwd, ".jensen", "settings.json"), "utf-8")).toContain('"./extensions/subagent"');
		expect(readFileSync(join(cwd, ".jensen", "agents", "planner.md"), "utf-8")).toContain("name: planner");
		expect(readFileSync(join(cwd, ".jensen", "extensions", "subagent", "index.ts"), "utf-8")).toContain(
			"pi.registerTool(createSubagentTool());",
		);
	});

	it("preserves existing files and only fills missing scaffold pieces", () => {
		const cwd = createTempDir();
		mkdirSync(join(cwd, ".jensen", "agents"), { recursive: true });
		writeFileSync(join(cwd, "JENSEN.md"), "# Existing overlay\n", "utf-8");
		writeFileSync(join(cwd, ".jensen", "agents", "worker.md"), "custom worker\n", "utf-8");
		writeFileSync(join(cwd, ".jensen", "settings.json"), '{\n  "theme": "dark"\n}\n', "utf-8");

		const result = initializeProjectScaffold(cwd);

		expect(result.createdFiles).toContain(".jensen/extensions/subagent/index.ts");
		expect(result.updatedFiles).toEqual([".jensen/settings.json"]);
		expect(result.skippedFiles).toContain("JENSEN.md");
		expect(result.skippedFiles).toContain(".jensen/agents/worker.md");
		expect(readFileSync(join(cwd, "JENSEN.md"), "utf-8")).toBe("# Existing overlay\n");
		expect(readFileSync(join(cwd, ".jensen", "agents", "worker.md"), "utf-8")).toBe("custom worker\n");
		expect(readFileSync(join(cwd, ".jensen", "settings.json"), "utf-8")).toContain('"theme": "dark"');
		expect(readFileSync(join(cwd, ".jensen", "settings.json"), "utf-8")).toContain('"./extensions/subagent"');
	});

	it("creates the Protocol marker only when requested and exposes it to the resource loader", async () => {
		const cwd = createTempDir();
		const agentDir = createTempDir();
		const nestedWorkspaceDir = join(cwd, "services", "api");
		mkdirSync(nestedWorkspaceDir, { recursive: true });

		const result = initializeProjectScaffold(cwd, { includeProtocol: true });
		const protocolContextPath = join(cwd, ".jensen", "JENSEN_PROTOCOL.md");

		expect(result.createdFiles).toContain(".jensen/JENSEN_PROTOCOL.md");
		expect(existsSync(protocolContextPath)).toBe(true);
		expect(readFileSync(protocolContextPath, "utf-8")).toContain("Jensen-Protocol workspace boundary");
		expect(readFileSync(protocolContextPath, "utf-8")).toContain("nearest ancestor `.jensen/JENSEN_PROTOCOL.md`");

		const loader = new DefaultResourceLoader({
			cwd: nestedWorkspaceDir,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
		});
		await loader.reload();

		expect(loader.getAgentsFiles().agentsFiles.map((file) => file.path)).toEqual([
			join(cwd, "JENSEN.md"),
			protocolContextPath,
		]);
	});

	it("preserves an existing Protocol marker on rerun", () => {
		const cwd = createTempDir();
		mkdirSync(join(cwd, ".jensen"), { recursive: true });
		writeFileSync(join(cwd, ".jensen", "JENSEN_PROTOCOL.md"), "# Existing protocol\n", "utf-8");

		const result = initializeProjectScaffold(cwd, { includeProtocol: true });

		expect(result.skippedFiles).toContain(".jensen/JENSEN_PROTOCOL.md");
		expect(readFileSync(join(cwd, ".jensen", "JENSEN_PROTOCOL.md"), "utf-8")).toBe("# Existing protocol\n");
	});

	it("warns and preserves invalid existing settings.json", () => {
		const cwd = createTempDir();
		mkdirSync(join(cwd, ".jensen"), { recursive: true });
		writeFileSync(join(cwd, ".jensen", "settings.json"), "{ invalid json\n", "utf-8");

		const result = initializeProjectScaffold(cwd);

		expect(readFileSync(join(cwd, ".jensen", "settings.json"), "utf-8")).toBe("{ invalid json\n");
		expect(result.warnings).toEqual([
			{
				code: "invalid-settings",
				path: ".jensen/settings.json",
				message: expect.stringContaining("existing settings.json is not valid JSON"),
			},
		]);
	});

	it("does not create JENSEN.md when another root context file already exists", () => {
		const cwd = createTempDir();
		writeFileSync(join(cwd, "AGENTS.md"), "# Legacy context\n", "utf-8");

		const result = initializeProjectScaffold(cwd);

		expect(existsSync(join(cwd, "JENSEN.md"))).toBe(false);
		expect(result.warnings).toEqual([
			{
				code: "context-file-exists",
				path: "AGENTS.md",
				message: "Skipped JENSEN.md creation because AGENTS.md already exists at the project root.",
			},
		]);
	});
});
