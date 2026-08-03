/**
 * Compatibility adapter for the example subagent extension.
 * Production role, model, alias, and permission authority lives in the
 * canonical registry exported by @apholdings/jensen-code.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, getCanonicalSubagentRegistry, parseFrontmatter } from "@apholdings/jensen-code";

export type AgentScope = "user" | "project" | "both";
export type AgentSource = "user" | "project";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export type AgentDiscoveryErrorCode = "read_error" | "parse_error" | "validation_error";
export interface AgentDiscoveryError {
	code: AgentDiscoveryErrorCode;
	path: string;
	source: AgentSource;
	reason: string;
}
export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
	errors: AgentDiscoveryError[];
}

function normalizeFsPath(filePath: string): string {
	return path.normalize(path.resolve(filePath));
}
function normalizeString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}
function normalizeTools(value: unknown): string[] | undefined {
	const values = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
	const tools = values
		.filter((tool): tool is string => typeof tool === "string")
		.map((tool) => tool.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}
function isDirectory(candidatePath: string): boolean {
	try {
		return fs.statSync(candidatePath).isDirectory();
	} catch {
		return false;
	}
}
function findNearestProjectAgentsDir(cwd: string): string | null {
	let current = normalizeFsPath(cwd);
	while (true) {
		const candidate = normalizeFsPath(path.join(current, CONFIG_DIR_NAME, "agents"));
		if (isDirectory(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}
function loadAgentsFromDir(dir: string, source: AgentSource): { agents: AgentConfig[]; errors: AgentDiscoveryError[] } {
	const agents: AgentConfig[] = [];
	const errors: AgentDiscoveryError[] = [];
	const registry = getCanonicalSubagentRegistry();
	if (!fs.existsSync(dir)) return { agents, errors };
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		errors.push({
			code: "read_error",
			path: dir,
			source,
			reason: error instanceof Error ? error.message : String(error),
		});
		return { agents, errors };
	}
	for (const entry of entries) {
		if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
		const filePath = normalizeFsPath(path.join(dir, entry.name));
		try {
			const parsed = parseFrontmatter<Record<string, unknown>>(fs.readFileSync(filePath, "utf8"));
			const name = normalizeString(parsed.frontmatter.name);
			const description = normalizeString(parsed.frontmatter.description);
			if (!name || !description) throw new Error("Missing required frontmatter fields: name, description");
			const resolved = registry.resolve(name);
			if ("code" in resolved) {
				errors.push({ code: "validation_error", path: filePath, source, reason: `${resolved.code}: ${name}` });
				continue;
			}
			agents.push({
				name: resolved.definition.name,
				description,
				tools: normalizeTools(parsed.frontmatter.tools),
				model: resolved.model.resolvedModel,
				systemPrompt: parsed.body,
				source,
				filePath,
			});
		} catch (error) {
			errors.push({
				code: "parse_error",
				path: filePath,
				source,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}
	agents.sort((left, right) => left.name.localeCompare(right.name));
	errors.sort((left, right) => left.path.localeCompare(right.path));
	return { agents, errors };
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = normalizeFsPath(path.join(getAgentDir(), "agents"));
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);
	const userDiscovery = scope === "project" ? { agents: [], errors: [] } : loadAgentsFromDir(userDir, "user");
	const projectDiscovery =
		scope === "user" || !projectAgentsDir
			? { agents: [], errors: [] }
			: loadAgentsFromDir(projectAgentsDir, "project");
	const agentMap = new Map<string, AgentConfig>();
	for (const agent of userDiscovery.agents) agentMap.set(agent.name, agent);
	for (const agent of projectDiscovery.agents) agentMap.set(agent.name, agent);
	return {
		agents: [...agentMap.values()].sort((left, right) => left.name.localeCompare(right.name)),
		projectAgentsDir,
		errors: [...userDiscovery.errors, ...projectDiscovery.errors].sort((left, right) =>
			left.path.localeCompare(right.path),
		),
	};
}
export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	const listed = agents.slice(0, maxItems);
	return {
		text: listed.length
			? listed.map((agent) => `${agent.name} (${agent.source}): ${agent.description}`).join("; ")
			: "none",
		remaining: agents.length - listed.length,
	};
}
export function findDiscoveryErrorForAgent(
	errors: AgentDiscoveryError[],
	agentName: string,
): AgentDiscoveryError | undefined {
	return errors.find((error) => path.basename(error.path).toLowerCase() === `${agentName}.md`.toLowerCase());
}
