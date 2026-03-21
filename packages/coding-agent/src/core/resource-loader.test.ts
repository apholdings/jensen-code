import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "./resource-loader.js";
import { SettingsManager } from "./settings-manager.js";
import { loadSkillsFromDir } from "./skills.js";

function createTempDir(): string {
	return mkdtempSync(join(tmpdir(), "jensen-context-"));
}

function writeFile(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, "utf8");
}

function createLoader(cwd: string, agentDir: string): DefaultResourceLoader {
	return new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: SettingsManager.inMemory(),
	});
}

const tempDirs: string[] = [];

describe("DefaultResourceLoader context files", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("loads JENSEN.md from the global directory and parent directories", async () => {
		const rootDir = createTempDir();
		tempDirs.push(rootDir);

		const agentDir = join(rootDir, "agent");
		const repoDir = join(rootDir, "repo");
		const appDir = join(repoDir, "app");

		mkdirSync(agentDir, { recursive: true });
		mkdirSync(appDir, { recursive: true });

		writeFile(join(agentDir, "JENSEN.md"), "global");
		writeFile(join(repoDir, "JENSEN.md"), "repo");
		writeFile(join(appDir, "JENSEN.md"), "app");

		const loader = createLoader(appDir, agentDir);
		await loader.reload();

		expect(loader.getAgentsFiles().agentsFiles.map((file) => file.path)).toEqual([
			join(agentDir, "JENSEN.md"),
			join(repoDir, "JENSEN.md"),
			join(appDir, "JENSEN.md"),
		]);
		expect(loader.getAgentsFiles().agentsFiles.map((file) => file.content)).toEqual(["global", "repo", "app"]);
		expect(loader.getContextDiagnostics().diagnostics).toEqual([]);
	});

	it("prefers JENSEN.md over AGENTS.md when both exist in the same directory", async () => {
		const rootDir = createTempDir();
		tempDirs.push(rootDir);

		const agentDir = join(rootDir, "agent");
		const repoDir = join(rootDir, "repo");

		mkdirSync(agentDir, { recursive: true });
		mkdirSync(repoDir, { recursive: true });

		writeFile(join(repoDir, "AGENTS.md"), "legacy");
		writeFile(join(repoDir, "JENSEN.md"), "canonical");

		const loader = createLoader(repoDir, agentDir);
		await loader.reload();

		expect(loader.getAgentsFiles().agentsFiles).toHaveLength(1);
		expect(loader.getAgentsFiles().agentsFiles[0]).toEqual({
			path: join(repoDir, "JENSEN.md"),
			content: "canonical",
		});
		expect(loader.getContextDiagnostics().diagnostics).toEqual([]);
	});

	it("falls back to AGENTS.md and reports a deprecation warning", async () => {
		const rootDir = createTempDir();
		tempDirs.push(rootDir);

		const agentDir = join(rootDir, "agent");
		const repoDir = join(rootDir, "repo");

		mkdirSync(agentDir, { recursive: true });
		mkdirSync(repoDir, { recursive: true });

		writeFile(join(repoDir, "AGENTS.md"), "legacy");

		const loader = createLoader(repoDir, agentDir);
		await loader.reload();

		expect(loader.getAgentsFiles().agentsFiles).toEqual([
			{
				path: join(repoDir, "AGENTS.md"),
				content: "legacy",
			},
		]);
		expect(loader.getContextDiagnostics().diagnostics).toEqual([
			{
				type: "warning",
				message: `AGENTS.md is deprecated. Rename ${join(repoDir, "AGENTS.md")} to JENSEN.md; AGENTS.md remains supported for now as a fallback.`,
				path: join(repoDir, "AGENTS.md"),
			},
		]);
	});
});

describe("skill discovery", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("loads only SKILL.md entrypoints and ignores README inventory docs", () => {
		const rootDir = createTempDir();
		tempDirs.push(rootDir);

		const skillsDir = join(rootDir, ".jensen", "skills");
		writeFile(join(skillsDir, "README.md"), "# Skill inventory\n");
		writeFile(join(skillsDir, "NOTES.md"), "# notes\n");
		writeFile(
			join(skillsDir, "ui-flow-verifier", "SKILL.md"),
			`---
name: ui-flow-verifier
description: Verify UI flow transitions.
---
Use this skill for UI verification.
`,
		);
		writeFile(
			join(skillsDir, "nested", "validate-unity-build", "SKILL.md"),
			`---
name: validate-unity-build
description: Validate Unity project builds.
---
Use this skill for build verification.
`,
		);
		writeFile(join(skillsDir, "fixtures", "sample.md"), "# fixture\n");
		writeFile(join(skillsDir, "notes", "debugging.md"), "# notes\n");

		const result = loadSkillsFromDir({ dir: skillsDir, source: "project" });

		expect(result.skills.map((skill) => skill.name).sort()).toEqual(["ui-flow-verifier", "validate-unity-build"]);
		expect(result.skills.map((skill) => skill.filePath).sort()).toEqual([
			join(skillsDir, "nested", "validate-unity-build", "SKILL.md"),
			join(skillsDir, "ui-flow-verifier", "SKILL.md"),
		]);
		expect(result.diagnostics).toEqual([]);
	});
});
