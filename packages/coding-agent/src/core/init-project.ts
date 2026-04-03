import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { CONFIG_DIR_NAME, getExamplesPath } from "../config.js";
import { findContextFileInDir } from "./context-files.js";

const SUBAGENT_EXTENSION_SETTING = "./extensions/subagent";

type AgentTemplateName = "planner" | "scout" | "worker" | "reviewer" | "security" | "pentester" | "librarian";

type InitProjectWarningCode = "context-file-exists" | "invalid-settings";

const PROTOCOL_CONTEXT_FILE = "JENSEN_PROTOCOL.md";

interface AgentTemplate {
	name: AgentTemplateName;
	description: string;
	body: string;
}

export interface InitProjectWarning {
	code: InitProjectWarningCode;
	path: string;
	message: string;
}

export interface InitProjectResult {
	createdDirectories: string[];
	createdFiles: string[];
	updatedFiles: string[];
	skippedFiles: string[];
	warnings: InitProjectWarning[];
	output: string;
}

export interface InitProjectScaffoldOptions {
	includeProtocol?: boolean;
}

const AGENT_TEMPLATES: readonly AgentTemplate[] = [
	{
		name: "planner",
		description: "Plan one bounded slice without implementing it",
		body: [
			"# Planner",
			"",
			"You plan one bounded slice at a time.",
			"",
			"Responsibilities:",
			"- restate the exact slice objective",
			"- define success criteria, no-touch boundaries, stop conditions, and verification needs",
			"- break the work into small, ordered, testable steps",
			"- stay grounded in repository truth",
			"",
			"Rules:",
			"- do not implement code",
			"- do not approve final closure",
			"- do not widen scope",
			"- call out blockers and dependencies explicitly",
		].join("\n"),
	},
	{
		name: "scout",
		description: "Inspect repository truth and report grounded findings",
		body: [
			"# Scout",
			"",
			"You gather repo-grounded facts for a bounded task.",
			"",
			"Responsibilities:",
			"- inspect the exact seams, files, symbols, and runtime expectations relevant to the ask",
			"- distinguish required behavior from optional or speculative ideas",
			"- cite concrete files and symbols",
			"",
			"Rules:",
			"- do not implement changes",
			"- do not widen scope",
			"- report uncertainty precisely instead of guessing",
		].join("\n"),
	},
	{
		name: "worker",
		description: "Execute a bounded implementation slice with validation",
		body: [
			"# Worker",
			"",
			"You implement exactly the assigned bounded slice.",
			"",
			"Responsibilities:",
			"- make the minimum correct code and test changes",
			"- preserve existing architecture and abstractions",
			"- validate the slice with focused checks",
			"- report exact files changed and commands run",
			"",
			"Rules:",
			"- do not widen scope",
			"- do not silently redesign architecture",
			"- do not self-certify final closure",
		].join("\n"),
	},
	{
		name: "reviewer",
		description: "Audit correctness, regressions, and scope discipline",
		body: [
			"# Reviewer",
			"",
			"You audit delivered work for correctness and scope discipline.",
			"",
			"Focus on:",
			"- correctness and regressions",
			"- adherence to the requested slice",
			"- missing validation or evidence gaps",
			"- mismatches between implementation and repo truth",
			"",
			"Rules:",
			"- do not implement follow-up changes yourself",
			"- be explicit about blockers vs nits",
		].join("\n"),
	},
	{
		name: "security",
		description: "Review trust boundaries and risky capability expansion",
		body: [
			"# Security",
			"",
			"You audit trust boundaries, secrets handling, and risky capability growth.",
			"",
			"Focus on:",
			"- privilege expansion and unsafe defaults",
			"- destructive or surprising file, process, or network behavior",
			"- insecure trust of repo-controlled content",
			"- missing operator confirmations where they matter",
			"",
			"Rules:",
			"- do not widen into general architecture redesign",
			"- report concrete risks and residual exposure clearly",
		].join("\n"),
	},
	{
		name: "pentester",
		description: "Attack the delivered slice for practical exploit paths",
		body: [
			"# Pentester",
			"",
			"You probe the delivered slice for practical abuse cases.",
			"",
			"Focus on:",
			"- ways a real user or attacker could bypass assumptions",
			"- malformed input, edge cases, and unsafe state transitions",
			"- practical exploitability instead of theoretical style concerns",
			"",
			"Rules:",
			"- do not implement fixes yourself",
			"- keep findings concrete, testable, and adversarial",
		].join("\n"),
	},
	{
		name: "librarian",
		description: "Reconcile docs, decisions, and workflow truth for closure",
		body: [
			"# Librarian",
			"",
			"You reconcile closure truth after a slice is complete.",
			"",
			"Responsibilities:",
			"- verify changed files, validation, and residual risks are recorded clearly",
			"- keep roadmap, notes, and handoff artifacts aligned with reality",
			"- surface unfinished follow-ups instead of hiding them",
			"",
			"Rules:",
			"- do not implement product code",
			"- do not claim closure without evidence",
		].join("\n"),
	},
] as const;

function buildProjectOverlay(projectName: string): string {
	return [
		`# ${projectName}`,
		"",
		"This repository uses Jensen with a minimal project-local scaffold.",
		"",
		"## Local Harness Scaffold",
		"- Project settings: `.jensen/settings.json`",
		"- Project-local subagent extension: `.jensen/extensions/subagent/`",
		"- Project-local agents: `.jensen/agents/`",
		"",
		"## Project Overlay Guidance",
		"Use this file for repo-specific facts only:",
		"- project identity and product phase",
		"- architecture notes and ADR links",
		"- roadmap, TODO, and workflow truth",
		"- repo-specific constraints and approved exceptions",
		"",
		"Do not duplicate the global Jensen operating model here.",
		'Prefer role-pure delegated work, and use project-local agents with `agentScope: "both"` or `"project"` when appropriate.',
	].join("\n");
}

function buildAgentMarkdown(template: AgentTemplate): string {
	return ["---", `name: ${template.name}`, `description: ${template.description}`, "---", "", template.body, ""].join(
		"\n",
	);
}

function buildProtocolWorkspaceMarker(projectName: string): string {
	return [
		`# ${projectName} Jensen-Protocol Workspace`,
		"",
		"This file marks this directory as a Jensen-Protocol workspace boundary.",
		"",
		"## Workspace Role",
		"- Jensen-Protocol is the backend/service backbone for this workspace.",
		"- The nearest ancestor `.jensen/JENSEN_PROTOCOL.md` is loaded as Protocol context for agents working here.",
		"",
		"## Record Here",
		"Use this file for Protocol-specific workspace truth only:",
		"- backend and service architecture notes with links to ADRs or canonical docs",
		"- deployment, runtime, and operator workflow boundaries",
		"- project-specific conventions for Protocol services, workers, and scheduled jobs",
		"- links to the current source of truth for infrastructure and operations",
		"",
		"Keep this file minimal and current.",
		"Do not duplicate global Jensen law, generic infrastructure templates, or speculative plans.",
	].join("\n");
}

function buildSettingsJson(): string {
	return `${JSON.stringify({ extensions: [SUBAGENT_EXTENSION_SETTING] }, null, 2)}\n`;
}

function toRelativePath(rootDir: string, targetPath: string): string {
	const relativePath = relative(rootDir, targetPath);
	return relativePath.length > 0 ? relativePath : ".";
}

function ensureDirectory(dirPath: string, rootDir: string, createdDirectories: string[]): void {
	if (existsSync(dirPath)) {
		return;
	}
	mkdirSync(dirPath, { recursive: true });
	createdDirectories.push(toRelativePath(rootDir, dirPath));
}

function writeFileIfMissing(
	filePath: string,
	content: string,
	rootDir: string,
	createdDirectories: string[],
	createdFiles: string[],
	skippedFiles: string[],
): void {
	if (existsSync(filePath)) {
		skippedFiles.push(toRelativePath(rootDir, filePath));
		return;
	}
	ensureDirectory(resolve(filePath, ".."), rootDir, createdDirectories);
	writeFileSync(filePath, content, "utf-8");
	createdFiles.push(toRelativePath(rootDir, filePath));
}

function copyExampleFileIfMissing(
	sourcePath: string,
	targetPath: string,
	rootDir: string,
	createdDirectories: string[],
	createdFiles: string[],
	skippedFiles: string[],
): void {
	if (existsSync(targetPath)) {
		skippedFiles.push(toRelativePath(rootDir, targetPath));
		return;
	}
	ensureDirectory(resolve(targetPath, ".."), rootDir, createdDirectories);
	writeFileSync(targetPath, readFileSync(sourcePath, "utf-8"), "utf-8");
	createdFiles.push(toRelativePath(rootDir, targetPath));
}

function updateSettingsFile(
	settingsPath: string,
	rootDir: string,
	createdDirectories: string[],
	createdFiles: string[],
	updatedFiles: string[],
	skippedFiles: string[],
	warnings: InitProjectWarning[],
): void {
	if (!existsSync(settingsPath)) {
		ensureDirectory(resolve(settingsPath, ".."), rootDir, createdDirectories);
		writeFileSync(settingsPath, buildSettingsJson(), "utf-8");
		createdFiles.push(toRelativePath(rootDir, settingsPath));
		return;
	}

	const relativeSettingsPath = toRelativePath(rootDir, settingsPath);
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
	} catch (error) {
		warnings.push({
			code: "invalid-settings",
			path: relativeSettingsPath,
			message: `Skipped ${relativeSettingsPath}: existing settings.json is not valid JSON (${error instanceof Error ? error.message : String(error)}).`,
		});
		skippedFiles.push(relativeSettingsPath);
		return;
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		warnings.push({
			code: "invalid-settings",
			path: relativeSettingsPath,
			message: `Skipped ${relativeSettingsPath}: existing settings.json must contain a JSON object.`,
		});
		skippedFiles.push(relativeSettingsPath);
		return;
	}

	const settings = { ...(parsed as Record<string, unknown>) };
	const extensions = Array.isArray(settings.extensions)
		? settings.extensions.filter((entry): entry is string => typeof entry === "string")
		: [];

	if (extensions.includes(SUBAGENT_EXTENSION_SETTING)) {
		skippedFiles.push(relativeSettingsPath);
		return;
	}

	settings.extensions = [...extensions, SUBAGENT_EXTENSION_SETTING];
	writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
	updatedFiles.push(relativeSettingsPath);
}

function buildOutput(result: Omit<InitProjectResult, "output">): string {
	const lines = ["/init-project completed."];

	if (result.createdDirectories.length > 0) {
		lines.push("", "Created directories:");
		for (const dirPath of result.createdDirectories) {
			lines.push(`- ${dirPath}`);
		}
	}

	if (result.createdFiles.length > 0) {
		lines.push("", "Created files:");
		for (const filePath of result.createdFiles) {
			lines.push(`- ${filePath}`);
		}
	}

	if (result.updatedFiles.length > 0) {
		lines.push("", "Updated files:");
		for (const filePath of result.updatedFiles) {
			lines.push(`- ${filePath}`);
		}
	}

	if (result.skippedFiles.length > 0) {
		lines.push("", "Skipped existing files:");
		for (const filePath of result.skippedFiles) {
			lines.push(`- ${filePath}`);
		}
	}

	if (result.warnings.length > 0) {
		lines.push("", "Warnings:");
		for (const warning of result.warnings) {
			lines.push(`- ${warning.message}`);
		}
	}

	if (
		result.createdDirectories.length === 0 &&
		result.createdFiles.length === 0 &&
		result.updatedFiles.length === 0 &&
		result.warnings.length === 0
	) {
		lines.push("", "No changes were needed. The minimal scaffold is already present.");
	} else {
		lines.push("", "Existing files were preserved. Safe to rerun.");
	}

	return lines.join("\n");
}

export function initializeProjectScaffold(cwd: string, options: InitProjectScaffoldOptions = {}): InitProjectResult {
	const projectRoot = resolve(cwd);
	const projectName = projectRoot.split(/[/\\]/u).filter(Boolean).pop() ?? "project";
	const configDir = join(projectRoot, CONFIG_DIR_NAME);
	const agentsDir = join(configDir, "agents");
	const extensionsDir = join(configDir, "extensions", "subagent");
	const settingsPath = join(configDir, "settings.json");
	const rootOverlayPath = join(projectRoot, "JENSEN.md");
	const protocolContextPath = join(configDir, PROTOCOL_CONTEXT_FILE);
	const examplesDir = getExamplesPath();
	const exampleSubagentDir = join(examplesDir, "extensions", "subagent");

	const createdDirectories: string[] = [];
	const createdFiles: string[] = [];
	const updatedFiles: string[] = [];
	const skippedFiles: string[] = [];
	const warnings: InitProjectWarning[] = [];

	ensureDirectory(configDir, projectRoot, createdDirectories);
	ensureDirectory(agentsDir, projectRoot, createdDirectories);
	ensureDirectory(join(configDir, "extensions"), projectRoot, createdDirectories);
	ensureDirectory(extensionsDir, projectRoot, createdDirectories);

	const existingContextFile = findContextFileInDir(projectRoot);
	if (existingContextFile) {
		warnings.push({
			code: "context-file-exists",
			path: toRelativePath(projectRoot, existingContextFile.path),
			message: `Skipped JENSEN.md creation because ${toRelativePath(projectRoot, existingContextFile.path)} already exists at the project root.`,
		});
		skippedFiles.push("JENSEN.md");
	} else {
		writeFileIfMissing(
			rootOverlayPath,
			buildProjectOverlay(projectName),
			projectRoot,
			createdDirectories,
			createdFiles,
			skippedFiles,
		);
	}

	if (options.includeProtocol) {
		writeFileIfMissing(
			protocolContextPath,
			buildProtocolWorkspaceMarker(projectName),
			projectRoot,
			createdDirectories,
			createdFiles,
			skippedFiles,
		);
	}

	updateSettingsFile(
		settingsPath,
		projectRoot,
		createdDirectories,
		createdFiles,
		updatedFiles,
		skippedFiles,
		warnings,
	);

	copyExampleFileIfMissing(
		join(exampleSubagentDir, "index.ts"),
		join(extensionsDir, "index.ts"),
		projectRoot,
		createdDirectories,
		createdFiles,
		skippedFiles,
	);
	copyExampleFileIfMissing(
		join(exampleSubagentDir, "agents.ts"),
		join(extensionsDir, "agents.ts"),
		projectRoot,
		createdDirectories,
		createdFiles,
		skippedFiles,
	);

	for (const template of AGENT_TEMPLATES) {
		writeFileIfMissing(
			join(agentsDir, `${template.name}.md`),
			buildAgentMarkdown(template),
			projectRoot,
			createdDirectories,
			createdFiles,
			skippedFiles,
		);
	}

	const resultWithoutOutput = {
		createdDirectories,
		createdFiles,
		updatedFiles,
		skippedFiles,
		warnings,
	};

	return {
		...resultWithoutOutput,
		output: buildOutput(resultWithoutOutput),
	};
}
