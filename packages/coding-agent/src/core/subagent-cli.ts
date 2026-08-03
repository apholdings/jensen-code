import { existsSync, readFileSync } from "node:fs";
import { getAgentDir } from "../config.js";
import type { Skill } from "./skills.js";
import { loadSkills } from "./skills.js";
import { getCanonicalSubagentRegistry, validateSkillAgentReferences } from "./subagent-registry.js";

function printJson(value: unknown, json: boolean): void {
	console.log(json ? JSON.stringify(value, null, 2) : JSON.stringify(value, null, 2));
}

function skillDependencies(skill: Skill) {
	if (!existsSync(skill.filePath)) return [];
	return validateSkillAgentReferences(skill.name, skill.filePath, readFileSync(skill.filePath, "utf8"));
}

export async function handleSubagentCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "agents" && args[0] !== "skills") return false;
	const registry = getCanonicalSubagentRegistry();
	const json = args.includes("--json");
	if (args[0] === "agents") {
		const command = args[1] ?? "list";
		if (command === "list" || command === "models") {
			printJson(
				command === "models"
					? registry.list().map((agent) => ({
							agent: agent.name,
							provider: agent.provider,
							model: agent.model,
							resolutionPolicy: agent.modelResolutionPolicy,
						}))
					: registry.list(),
				json,
			);
			return true;
		}
		if (command === "aliases") {
			printJson(registry.aliasesList(), json);
			return true;
		}
		if (command === "validate") {
			printJson(registry.validate(), json);
			process.exitCode = registry.validate().valid ? 0 : 1;
			return true;
		}
		if (command === "inspect" || command === "resolve") {
			const name = args[2];
			if (!name) throw new Error(`jensen agents ${command} requires <agent>`);
			const result = registry.resolve(name);
			printJson(result, json);
			if ("code" in result) process.exitCode = 1;
			return true;
		}
	}
	if (args[0] === "skills") {
		const loaded = loadSkills({ cwd: process.cwd(), agentDir: getAgentDir() });
		const command = args[1] ?? "list";
		if (command === "list") {
			printJson(loaded.skills, json);
			return true;
		}
		if (command === "validate" || command === "dependencies") {
			const selected =
				command === "dependencies" && args[2]
					? loaded.skills.filter((skill) => skill.name === args[2])
					: loaded.skills;
			if (command === "dependencies" && args[2] && selected.length === 0) {
				throw new Error(`Unknown skill: ${args[2]}`);
			}
			const dependencies = selected.flatMap(skillDependencies);
			printJson({ valid: dependencies.length === 0, dependencies }, json);
			process.exitCode = dependencies.length === 0 ? 0 : 1;
			return true;
		}
		if (command === "inspect") {
			const skill = loaded.skills.find((candidate) => candidate.name === args[2]);
			if (!skill) throw new Error(`Unknown skill: ${args[2]}`);
			printJson({ ...skill, dependencies: skillDependencies(skill) }, json);
			return true;
		}
	}
	return false;
}
