import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

// =============================================================================
// Package Detection
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Detect if we're running as a Bun compiled binary.
 * Bun binaries have import.meta.url containing "$bunfs", "~BUN", or "%7EBUN" (Bun's virtual filesystem path)
 */
export const isBunBinary =
	import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

/** Detect if Bun is the runtime (compiled binary or bun run) */
export const isBunRuntime = !!process.versions.bun;

/**
 * Get the base directory for resolving package assets (themes, package.json, README.md, CHANGELOG.md).
 * Note: Does NOT use environment variables to avoid circular dependency during APP_NAME detection.
 */
function findPackageDir(): string {
	if (isBunBinary) {
		return dirname(process.execPath);
	}
	// Node.js: walk up from __dirname until we find package.json
	let dir = __dirname;
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			return dir;
		}
		dir = dirname(dir);
	}
	return __dirname;
}

const PACKAGE_DIR = findPackageDir();
const pkg = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf-8"));

export const APP_NAME: string = pkg.jensenConfig?.name || pkg.piConfig?.name || "jensen";
export const CONFIG_DIR_NAME: string = pkg.jensenConfig?.configDir || pkg.piConfig?.configDir || ".jensen";
export const VERSION: string = pkg.version;
export const PACKAGE_NAME: string = pkg.name;
export const FILE_PREFIX: string = APP_NAME.toLowerCase().replace(/\s+/g, "-");
export const ENV_PREFIX: string = APP_NAME.toUpperCase().replace(/\s+/g, "_");

// =============================================================================
// Development Mode Detection
// =============================================================================

/**
 * Detect if we're running from source (development mode) rather than an installed package.
 * True when the package directory contains a `src/` directory (i.e., a development checkout).
 */
export function isDevMode(): boolean {
	return existsSync(join(PACKAGE_DIR, "src"));
}

// =============================================================================
// Version Comparison
// =============================================================================

/** Strict stable semver core: major.minor.patch with no leading zeros. */
const STRICT_SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export interface StrictVersion {
	major: number;
	minor: number;
	patch: number;
}

/**
 * Parse a strict stable semver core string.
 *
 * Accepts only the exact form major.minor.patch where each component is
 * either the single digit 0 or a positive integer with no leading zero.
 *
 * Returns null for anything else, including:
 *   - missing components ("2", "1.1")
 *   - extra components ("1.1.8.1")
 *   - leading zeros ("01.1.9")
 *   - prefixes / suffixes ("v1.1.8", "1.1.8-beta.1", "1.1.8+build.1")
 *   - whitespace, non-string types
 */
export function parseStrictStableVersion(version: string): StrictVersion | null {
	if (typeof version !== "string") return null;
	const match = version.match(STRICT_SEMVER_RE);
	if (!match) return null;
	return {
		major: parseInt(match[1], 10),
		minor: parseInt(match[2], 10),
		patch: parseInt(match[3], 10),
	};
}

/**
 * Compare two version strings using strict stable semver ordering.
 * Returns true if a > b.
 *
 * Malformed versions (anything other than major.minor.patch) are
 * rejected and comparison returns false — no update is shown.
 */
export function semverGt(a: string, b: string): boolean {
	const parsedA = parseStrictStableVersion(a);
	const parsedB = parseStrictStableVersion(b);
	if (!parsedA || !parsedB) return false;
	if (parsedA.major !== parsedB.major) return parsedA.major > parsedB.major;
	if (parsedA.minor !== parsedB.minor) return parsedA.minor > parsedB.minor;
	return parsedA.patch > parsedB.patch;
}

// =============================================================================
// Release Channel
// =============================================================================

/** Supported npm dist-tag channels for the Apholdings Jensen Code fork. */
export const VALID_RELEASE_CHANNELS = ["fork", "latest"] as const;
export type ReleaseChannel = (typeof VALID_RELEASE_CHANNELS)[number];

/**
 * Get the release channel from environment variable.
 *
 * Uses own-property presence checks, not truthiness, to distinguish
 * "absent" from "explicitly set to empty string".  An explicitly set
 * empty variable is invalid configuration and must fail closed.
 *
 * Returns undefined when neither environment variable is present.
 */
export function getReleaseChannelEnv(): string | undefined {
	const jensenKey = `${ENV_PREFIX}_RELEASE_CHANNEL`;
	if (jensenKey in process.env) {
		return process.env[jensenKey];
	}
	if ("PI_RELEASE_CHANNEL" in process.env) {
		return process.env.PI_RELEASE_CHANNEL;
	}
	return undefined;
}

/**
 * Resolve a raw release channel value to a valid ReleaseChannel or undefined.
 *
 * When explicitValue is undefined (neither env nor persisted setting is set),
 * this Apholdings fork defaults to "fork".
 *
 * An explicit but invalid value returns undefined (fail-closed).  The caller
 * must not fall through to another channel source.
 */
export function resolveReleaseChannel(explicitValue: string | undefined): ReleaseChannel | undefined {
	if (explicitValue === undefined) return "fork";
	if ((VALID_RELEASE_CHANNELS as readonly string[]).includes(explicitValue)) {
		return explicitValue as ReleaseChannel;
	}
	return undefined;
}

// =============================================================================
// Install Method Detection
// =============================================================================

export type InstallMethod = "bun-binary" | "npm" | "pnpm" | "yarn" | "bun" | "unknown";

export function detectInstallMethod(): InstallMethod {
	if (isBunBinary) {
		return "bun-binary";
	}

	const resolvedPath = `${__dirname}\0${process.execPath || ""}`.toLowerCase();

	if (resolvedPath.includes("/pnpm/") || resolvedPath.includes("/.pnpm/") || resolvedPath.includes("\\pnpm\\")) {
		return "pnpm";
	}
	if (resolvedPath.includes("/yarn/") || resolvedPath.includes("/.yarn/") || resolvedPath.includes("\\yarn\\")) {
		return "yarn";
	}
	if (isBunRuntime) {
		return "bun";
	}
	if (resolvedPath.includes("/npm/") || resolvedPath.includes("/node_modules/") || resolvedPath.includes("\\npm\\")) {
		return "npm";
	}

	return "unknown";
}

export function getUpdateInstruction(packageName: string, channel?: ReleaseChannel): string {
	const method = detectInstallMethod();
	const tag = channel && channel !== "latest" ? `@${channel}` : "";
	switch (method) {
		case "bun-binary":
			return `Download from: https://github.com/apholdings/jensen-code/releases/latest`;
		case "pnpm":
			return `Run: pnpm install -g ${packageName}${tag}`;
		case "yarn":
			return `Run: yarn global add ${packageName}${tag}`;
		case "bun":
			return `Run: bun install -g ${packageName}${tag}`;
		case "npm":
			return `Run: npm install -g ${packageName}${tag}`;
		default:
			return `Run: npm install -g ${packageName}${tag}`;
	}
}

// =============================================================================
// Package Asset Paths (shipped with executable)
// =============================================================================

/**
 * Get the base directory for resolving package assets (themes, package.json, README.md, CHANGELOG.md).
 * - For Bun binary: returns the directory containing the executable
 * - For Node.js (dist/): returns __dirname (the dist/ directory)
 * - For tsx (src/): returns parent directory (the package root)
 */
export function getPackageDir(): string {
	// Allow override via environment variable (useful for Nix/Guix where store paths tokenize poorly)
	const envDir = process.env[`${ENV_PREFIX}_PACKAGE_DIR`] || process.env.PI_PACKAGE_DIR;
	if (envDir) {
		if (envDir === "~") return homedir();
		if (envDir.startsWith("~/")) return homedir() + envDir.slice(1);
		return envDir;
	}
	return PACKAGE_DIR;
}

/**
 * Get path to built-in themes directory (shipped with package)
 * - For Bun binary: theme/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/theme/
 * - For tsx (src/): src/modes/interactive/theme/
 */
export function getThemesDir(): string {
	if (isBunBinary) {
		return join(dirname(process.execPath), "theme");
	}
	// Theme is in modes/interactive/theme/ relative to src/ or dist/
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "theme");
}

/**
 * Get path to HTML export template directory (shipped with package)
 * - For Bun binary: export-html/ next to executable
 * - For Node.js (dist/): dist/core/export-html/
 * - For tsx (src/): src/core/export-html/
 */
export function getExportTemplateDir(): string {
	if (isBunBinary) {
		return join(dirname(process.execPath), "export-html");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "core", "export-html");
}

/** Get path to package.json */
export function getPackageJsonPath(): string {
	return join(getPackageDir(), "package.json");
}

/** Get path to README.md */
export function getReadmePath(): string {
	return resolve(join(getPackageDir(), "README.md"));
}

/** Get path to docs directory */
export function getDocsPath(): string {
	return resolve(join(getPackageDir(), "docs"));
}

/** Get path to examples directory */
export function getExamplesPath(): string {
	return resolve(join(getPackageDir(), "examples"));
}

/** Get path to CHANGELOG.md */
export function getChangelogPath(): string {
	return resolve(join(getPackageDir(), "CHANGELOG.md"));
}

// =============================================================================
// App Config
// =============================================================================

// e.g., JENSEN_CODE_CODING_AGENT_DIR or PI_CODING_AGENT_DIR
export const ENV_AGENT_DIR = `${ENV_PREFIX}_CODING_AGENT_DIR`;

const DEFAULT_SHARE_VIEWER_URL = "https://jensen.dev/session/";

/** Get the share viewer URL for a gist ID */
export function getShareViewerUrl(gistId: string): string {
	const baseUrl =
		process.env[`${ENV_PREFIX}_SHARE_VIEWER_URL`] || process.env.PI_SHARE_VIEWER_URL || DEFAULT_SHARE_VIEWER_URL;
	return `${baseUrl}#${gistId}`;
}

/** Get if offline mode is enabled via environment variable */
export function getOfflineEnv(): string | undefined {
	return process.env[`${ENV_PREFIX}_OFFLINE`] || process.env.PI_OFFLINE;
}

/** Get if version check should be skipped via environment variable */
export function getSkipVersionCheckEnv(): string | undefined {
	return process.env[`${ENV_PREFIX}_SKIP_VERSION_CHECK`] || process.env.PI_SKIP_VERSION_CHECK;
}

/** Get if timings should be enabled via environment variable */
export function getTimingEnv(): string | undefined {
	return process.env[`${ENV_PREFIX}_TIMING`] || process.env.PI_TIMING;
}

/** Get if hardware cursor should be shown via environment variable */
export function getHardwareCursorEnv(): string | undefined {
	return process.env[`${ENV_PREFIX}_HARDWARE_CURSOR`] || process.env.PI_HARDWARE_CURSOR;
}

/** Get if clear on shrink is enabled via environment variable */
export function getClearOnShrinkEnv(): string | undefined {
	return process.env[`${ENV_PREFIX}_CLEAR_ON_SHRINK`] || process.env.PI_CLEAR_ON_SHRINK;
}

// =============================================================================
// User Config Paths (~/.jensen/agent/*)
// =============================================================================

/** Get the agent config directory (e.g., ~/.jensen/agent/) */
export function getAgentDir(): string {
	const envDir = process.env[ENV_AGENT_DIR] || process.env.PI_CODING_AGENT_DIR;
	if (envDir) {
		// Expand tilde to home directory
		if (envDir === "~") return homedir();
		if (envDir.startsWith("~/")) return homedir() + envDir.slice(1);
		return envDir;
	}
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

/** Get path to user's custom themes directory */
export function getCustomThemesDir(): string {
	return join(getAgentDir(), "themes");
}

/** Get path to models.json */
export function getModelsPath(): string {
	return join(getAgentDir(), "models.json");
}

/** Get path to auth.json */
export function getAuthPath(): string {
	return join(getAgentDir(), "auth.json");
}

/** Get path to settings.json */
export function getSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

/** Get path to tools directory */
export function getToolsDir(): string {
	return join(getAgentDir(), "tools");
}

/** Get path to managed binaries directory (fd, rg) */
export function getBinDir(): string {
	return join(getAgentDir(), "bin");
}

/** Get path to prompt templates directory */
export function getPromptsDir(): string {
	return join(getAgentDir(), "prompts");
}

/** Get path to sessions directory */
export function getSessionsDir(): string {
	return join(getAgentDir(), "sessions");
}

/** Get path to debug log file */
export function getDebugLogPath(): string {
	return join(getAgentDir(), `${APP_NAME}-debug.log`);
}
