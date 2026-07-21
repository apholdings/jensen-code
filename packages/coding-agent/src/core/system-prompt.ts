/**
 * System prompt construction and project context loading
 */

import { APP_NAME, getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import { buildExecutionEnvironment } from "./footer-data-provider.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";
import { getToolDescription } from "./tools/tools-prompt-data.js";

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. Default: process.cwd() */
	cwd?: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const resolvedCwd = cwd ?? process.cwd();
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	const date = new Date().toISOString().slice(0, 10);

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n# Project Context\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `## ${filePath}\n\n${content}\n\n`;
			}
		}

		// Append skills section (only if read tool is available)
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		// Add date and working directory last
		prompt += `\nCurrent date: ${date}`;
		prompt += `\nCurrent working directory: ${promptCwd}`;

		return prompt;
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	// Build tools list based on selected tools.
	// Built-ins use getToolDescription. Custom tools can provide one-line snippets.
	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const visibleTools = tools.filter((name) => getToolDescription(name) || toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0
			? visibleTools
					.map((name) => {
						const snippet = toolSnippets?.[name] ?? getToolDescription(name) ?? name;
						return `- ${name}: ${snippet}`;
					})
					.join("\n")
			: "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasEdit = tools.includes("edit");
	const hasWrite = tools.includes("write");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");

	// File exploration guidelines
	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	} else if (hasBash && (hasGrep || hasFind || hasLs)) {
		addGuideline("Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)");
	}

	// Read before edit guideline
	if (hasRead && hasEdit) {
		addGuideline("Use read to examine files before editing. You must use this tool instead of cat or sed.");
	}

	// Edit guideline
	if (hasEdit) {
		addGuideline("Use edit for precise changes (old text must match exactly)");
	}

	// Write guideline
	if (hasWrite) {
		addGuideline("Use write only for new files or complete rewrites");
	}

	// Output guideline (only when actually writing or executing)
	if (hasEdit || hasWrite) {
		addGuideline(
			"When summarizing your actions, output plain text directly - do NOT use cat or bash to display what you did",
		);
	}

	// Evidence discipline (when bash or powershell is available)
	if (hasBash) {
		addGuideline(
			"Never declare a command succeeded without inspecting its exit code or structured result. A non-zero exit code is a failure even if stdout looks positive. Text on stderr alone does not mean failure when exit code is 0.",
		);
		addGuideline(
			"Treat stdout, stderr, exit code, timeout, cancellation, and truncation as separate pieces of evidence. Do not conflate a proposed command with an executed one, or a started command with a completed one.",
		);
		addGuideline(
			"A Bash exit code represents the final status returned by Bash for the supplied source. For compound shell source (sequences, functions, subshells), exit code 0 does not prove every internal command succeeded. When internal_command_statuses_known is false, describe only the final shell status — do not claim all internal commands passed.",
		);
		addGuideline(
			'Prefer direct single-command validation. Avoid combining setup, validation, filtering, cleanup, and status persistence into one command. When later commands are required after the target process, preserve its exit code with an explicit final `exit "$RC"`.',
		);
		addGuideline(
			"When validation_evidence_authoritative is false, do not declare validation success, do not infer earlier stage status, and rerun the check without a pipeline. Filter retained output in a separate execution.",
		);
	}

	// Command classification (when bash or powershell is available)
	if (hasBash) {
		addGuideline(
			"Classify commands before execution: SHORT (foreground, immediate result), LONG_RUNNING (needs explicit timeout, preserve full log), or PERSISTENT (servers/watchers — use start/stop scripts or process_manager, never run in foreground).",
		);
	}

	// Platform policies
	if (hasBash) {
		const isWindows = process.platform === "win32";
		if (isWindows) {
			addGuideline(
				"You are on Windows. Use the powershell tool for Windows-native workflows. Use bash only for Git Bash or cross-platform operations. Prefer PowerShell cmdlets and proper path quoting with spaces.",
			);
		} else {
			addGuideline(
				"You are on Linux. Use the bash tool for all shell operations. Do not use PowerShell syntax even if pwsh is installed — it is not the correct shell for this environment.",
			);
		}
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Always include these
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	// Build execution environment block
	const env = buildExecutionEnvironment(resolvedCwd);
	let envBlock = "";
	envBlock += `\nExecution environment:\n`;
	envBlock += `- host: ${env.host}\n`;
	envBlock += `- operating system: ${env.os}\n`;
	envBlock += `- login shell: ${env.loginShell}\n`;
	// The bash tool uses its own shell (/bin/bash on Linux, Git Bash on Windows);
	// the login shell may differ. The powershell tool uses pwsh or powershell.exe.
	envBlock += `- working directory: ${env.initialCwd}\n`;
	if (env.effectiveCwd !== env.initialCwd) {
		envBlock += `- effective working directory: ${env.effectiveCwd}\n`;
	}
	envBlock += `- git repository: ${env.gitRoot || "none"}\n`;
	if (env.controllerGitRoot) {
		envBlock += `- controller repository: ${env.controllerGitRoot}\n`;
	}
	if (env.gitRoot) {
		const branchLabel = env.isDetachedHead ? "detached HEAD" : env.gitBranch || "unknown";
		envBlock += `- git branch: ${branchLabel}\n`;
		if (env.worktreeCount > 1) {
			envBlock += `- git worktrees: ${env.worktreeCount} total (this worktree: ${env.gitWorktree || "unknown"})\n`;
		}
	}

	let prompt = `You are Jensen, the orchestration intelligence operating inside ${APP_NAME}, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

You are the primary project operator for this workspace: precise, calm, highly competent, and execution-focused.

Core behavior:
- Think like an orchestrator first: understand the goal, constraints, architecture, and execution path before acting.
- Break work into clean, verifiable steps.
- Prefer correctness, maintainability, and architectural alignment over flashy output.
- Be proactive about identifying risks, missing dependencies, migration needs, and validation steps.
- When acting on repository work, preserve project structure, conventions, and existing abstractions.
- When appropriate, explain not only what to do, but why it is the correct architectural move.

Operator State Discipline:
- For substantial repository work, establish visible task or todo state before or alongside delegation. Keep it updated as work progresses.
- Use task_create for multi-step work requiring explicit tracking with subject/description. Use todo_write for ephemeral step-by-step progress tracking.
- Do not delegate until you have captured what needs tracking. After results arrive, update state before next delegation.
- If you have active delegated work, there should be corresponding task or todo entries visible to the operator.

Available tools:
${toolsList}${envBlock}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

	if (appendSection) {
		prompt += appendSection;
	}

	// Append project context files
	if (contextFiles.length > 0) {
		prompt += "\n\n# Project Context\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `## ${filePath}\n\n${content}\n\n`;
		}
	}

	// Append skills section (only if read tool is available)
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	// Add date
	prompt += `\nCurrent date: ${date}`;

	return prompt;
}
