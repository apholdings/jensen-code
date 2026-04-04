/**
 * Doctor diagnostics module for system health checks.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** Status levels for doctor checks */
export type DoctorStatus = "ok" | "warn" | "error";

/** Individual check result */
export interface DoctorCheckResult {
	name: string;
	status: DoctorStatus;
	message: string;
}

/** Complete doctor check result */
export interface DoctorResult {
	checks: DoctorCheckResult[];
	summary: string;
}

/**
 * Options for running doctor checks.
 */
export interface DoctorOptions {
	/** Current working directory (defaults to process.cwd()) */
	cwd?: string;
	/** Resource loader for getting loaded resources */
	resourceLoader?: {
		getExtensions: () => { extensions: unknown[] };
		getSkills: () => { skills: unknown[] };
		getThemes: () => { themes: unknown[] };
	};
	/** Model registry for checking model configuration */
	modelRegistry?: {
		getAvailable: () => Array<{ id: string; provider: string }>;
		getApiKey: (model: { provider: string }) => Promise<string | null | undefined>;
	};
	/** Current model (if set) */
	currentModel?: {
		id: string;
		provider: string;
	};
	/** Extension runner for checking loaded extensions */
	extensionRunner?: {
		getExtensionPaths: () => string[];
		getRegisteredCommands: () => unknown[];
	};
}

/**
 * Find config files (JENSEN.md, AGENTS.md, CLAUDE.md) walking up from cwd to root.
 */
async function findConfigFiles(cwd: string): Promise<string[]> {
	const configFiles = ["JENSEN.md", "AGENTS.md", "CLAUDE.md"];
	const found: string[] = [];
	let current = cwd;

	while (true) {
		for (const file of configFiles) {
			const filePath = path.join(current, file);
			try {
				await fs.promises.access(filePath);
				found.push(filePath);
			} catch {
				// File doesn't exist
			}
		}

		// Check if we've reached the root
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}

	return found;
}

/**
 * Check if .pi/settings.json exists and is valid JSON.
 */
async function checkSettingsFile(cwd: string): Promise<DoctorCheckResult> {
	const settingsPath = path.join(cwd, ".pi", "settings.json");

	try {
		await fs.promises.access(settingsPath);
		const content = await fs.promises.readFile(settingsPath, "utf-8");
		JSON.parse(content); // Validate JSON
		return {
			name: "settings",
			status: "ok",
			message: ".pi/settings.json exists and is valid JSON",
		};
	} catch (error) {
		if (error instanceof SyntaxError) {
			return {
				name: "settings",
				status: "error",
				message: ".pi/settings.json exists but is invalid JSON",
			};
		}
		// File doesn't exist or other error
		return {
			name: "settings",
			status: "warn",
			message: ".pi/settings.json not found",
		};
	}
}

/**
 * Check loaded extensions and skills.
 */
function checkResources(options: DoctorOptions): DoctorCheckResult[] {
	const results: DoctorCheckResult[] = [];

	// Check extensions
	if (options.resourceLoader) {
		const extensions = options.resourceLoader.getExtensions().extensions;
		results.push({
			name: "extensions",
			status: extensions.length > 0 ? "ok" : "warn",
			message: `${extensions.length} extension${extensions.length !== 1 ? "s" : ""} loaded`,
		});
	} else if (options.extensionRunner) {
		const extPaths = options.extensionRunner.getExtensionPaths();
		results.push({
			name: "extensions",
			status: extPaths.length > 0 ? "ok" : "warn",
			message: `${extPaths.length} extension${extPaths.length !== 1 ? "s" : ""} loaded`,
		});
	} else {
		results.push({
			name: "extensions",
			status: "warn",
			message: "Extension info not available",
		});
	}

	// Check skills
	if (options.resourceLoader) {
		const skills = options.resourceLoader.getSkills().skills;
		results.push({
			name: "skills",
			status: skills.length > 0 ? "ok" : "warn",
			message: `${skills.length} skill${skills.length !== 1 ? "s" : ""} loaded`,
		});
	} else {
		results.push({
			name: "skills",
			status: "warn",
			message: "Skills info not available",
		});
	}

	// Check themes
	if (options.resourceLoader) {
		const themes = options.resourceLoader.getThemes().themes;
		results.push({
			name: "themes",
			status: themes.length > 0 ? "ok" : "warn",
			message: `${themes.length} theme${themes.length !== 1 ? "s" : ""} loaded`,
		});
	} else {
		results.push({
			name: "themes",
			status: "warn",
			message: "Themes info not available",
		});
	}

	return results;
}

/**
 * Check current model configuration.
 */
async function checkModel(options: DoctorOptions): Promise<DoctorCheckResult> {
	if (!options.currentModel) {
		return {
			name: "model",
			status: "warn",
			message: "No model selected",
		};
	}

	const model = options.currentModel;

	// Check if API key is available
	if (options.modelRegistry) {
		const apiKey = await options.modelRegistry.getApiKey(model);
		if (apiKey) {
			return {
				name: "model",
				status: "ok",
				message: `${model.provider}/${model.id} (API key available)`,
			};
		}
		return {
			name: "model",
			status: "error",
			message: `${model.provider}/${model.id} (no API key)`,
		};
	}

	return {
		name: "model",
		status: "ok",
		message: `${model.provider}/${model.id}`,
	};
}

/**
 * Check git repository status.
 */
function checkGit(cwd: string): DoctorCheckResult {
	try {
		execSync("git rev-parse --git-dir", { cwd, stdio: "ignore" });

		// Get current branch
		const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf-8" }).trim();

		// Check for uncommitted changes
		const status = execSync("git status --porcelain", { cwd, encoding: "utf-8" }).trim();
		const hasChanges = status.length > 0;

		return {
			name: "git",
			status: hasChanges ? "warn" : "ok",
			message: `Branch: ${branch}${hasChanges ? " (uncommitted changes)" : ""}`,
		};
	} catch {
		return {
			name: "git",
			status: "warn",
			message: "Not a git repository",
		};
	}
}

/**
 * Check shell configuration and basic commands.
 */
function checkShell(): DoctorCheckResult {
	const shell = process.env.SHELL || "unknown";
	const shellName = path.basename(shell);

	// Check if basic commands work
	try {
		execSync("echo", { stdio: "ignore" });
		return {
			name: "shell",
			status: "ok",
			message: `Shell: ${shellName}`,
		};
	} catch {
		return {
			name: "shell",
			status: "error",
			message: `Shell: ${shellName} (basic commands not working)`,
		};
	}
}

/**
 * Run all doctor diagnostics checks.
 */
export async function runDoctorChecks(options: DoctorOptions = {}): Promise<DoctorResult> {
	const cwd = options.cwd || process.cwd();
	const checks: DoctorCheckResult[] = [];

	// 1. Config files check
	const configFiles = await findConfigFiles(cwd);
	checks.push({
		name: "config",
		status: configFiles.length > 0 ? "ok" : "warn",
		message:
			configFiles.length > 0
				? `Found ${configFiles.length} config file(s): ${configFiles.map((f) => `${path.basename(path.dirname(f))}/${path.basename(f)}`).join(", ")}`
				: "No config files (JENSEN.md, AGENTS.md, CLAUDE.md) found",
	});

	// 2. Settings file check
	const settingsCheck = await checkSettingsFile(cwd);
	checks.push(settingsCheck);

	// 3. Extensions, skills, themes check
	const resourceChecks = checkResources(options);
	checks.push(...resourceChecks);

	// 4. Model check
	const modelCheck = await checkModel(options);
	checks.push(modelCheck);

	// 5. Git check
	const gitCheck = checkGit(cwd);
	checks.push(gitCheck);

	// 6. Shell check
	const shellCheck = checkShell();
	checks.push(shellCheck);

	// Generate summary
	const okCount = checks.filter((c) => c.status === "ok").length;
	const warnCount = checks.filter((c) => c.status === "warn").length;
	const errorCount = checks.filter((c) => c.status === "error").length;

	const summary = `Diagnostics complete: ${okCount} OK, ${warnCount} warning${warnCount !== 1 ? "s" : ""}, ${errorCount} error${errorCount !== 1 ? "s" : ""}`;

	return {
		checks,
		summary,
	};
}

/**
 * Format doctor result as colored text for display in TUI.
 * The theme object should have fg(color, text) and bold(text) methods.
 */
// Using `any` for the color parameter to allow both string and ThemeColor types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function formatDoctorResult(
	result: DoctorResult,
	theme: { fg: (color: any, text: string) => string; bold: (text: string) => string },
): string {
	const lines: string[] = [];

	lines.push(theme.bold("System Diagnostics"));
	lines.push("");

	for (const check of result.checks) {
		let statusIcon: string;
		let statusColor: string;

		switch (check.status) {
			case "ok":
				statusIcon = "✓";
				statusColor = "success";
				break;
			case "warn":
				statusIcon = "⚠";
				statusColor = "warning";
				break;
			case "error":
				statusIcon = "✗";
				statusColor = "error";
				break;
		}

		lines.push(`${theme.fg(statusColor, statusIcon)} ${check.name}: ${check.message}`);
	}

	lines.push("");
	lines.push(theme.fg("dim", result.summary));

	return lines.join("\n");
}
