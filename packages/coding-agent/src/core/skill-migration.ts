import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.js";
import { loadSkills } from "./skills.js";
import { validateSkillAgentReferences } from "./subagent-registry.js";

export interface SkillMigrationPreview {
	sourceSkillPath: string;
	effectivePrecedence: string;
	referencedAgents: string[];
	unresolvedReferences: string[];
	staleAliases: string[];
	modelChanges: string[];
	permissionChanges: string[];
	proposedEdits: string[];
	contentHash: string;
}

function hash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

export function previewSkillMigration(cwd = process.cwd(), agentDir = getAgentDir()): SkillMigrationPreview[] {
	const loaded = loadSkills({ cwd, agentDir });
	return loaded.skills
		.filter((skill) => skill.name === "cavecrew" || skill.filePath.includes("cavecrew"))
		.map((skill) => {
			const content = readFileSync(skill.filePath, "utf8");
			const diagnostics = validateSkillAgentReferences(skill.name, skill.filePath, content);
			const referencedAgents = [...new Set(content.match(/cavecrew-[a-z0-9-]+|planner|worker/gu) ?? [])];
			return {
				sourceSkillPath: skill.filePath,
				effectivePrecedence: skill.source === "user" ? "user shadows packaged" : skill.source,
				referencedAgents,
				unresolvedReferences: diagnostics.map((diagnostic) => diagnostic.missingAgent ?? "unknown"),
				staleAliases: referencedAgents.filter(
					(agent) => agent === "cavecrew-investigate" || agent === "cavecrew-build",
				),
				modelChanges: [],
				permissionChanges: [],
				proposedEdits: [],
				contentHash: hash(content),
			};
		});
}

export function applySkillMigration(
	cwd = process.cwd(),
	agentDir = getAgentDir(),
): { applied: false; previews: SkillMigrationPreview[] } {
	return { applied: false, previews: previewSkillMigration(cwd, agentDir) };
}

export function packagedCavecrewPath(packageRoot: string): string {
	return join(packageRoot, "skills", "cavecrew", "SKILL.md");
}

export function skillMigrationSourceExists(path: string): boolean {
	return existsSync(path);
}
