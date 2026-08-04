import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { sha256 } from "./identity.js";

/**
 * The identity of the executable that starts the Jensen evaluation candidate.
 * The launcher is authorized by *identity* (a validated absolute path to the
 * verified runtime executable), never by its display basename. Renaming the
 * binary must not change its identity, and an unrelated executable that merely
 * shares the basename must not inherit launcher authority.
 */
export type LauncherId = "jensen_source_runtime" | "jensen_compiled_runtime" | "external_explicit";
export type LauncherSource = "current_process" | "configured" | "fixture";

export interface RuntimeExecutableIdentity {
	runtimeKind: "node_source" | "bun_compiled" | "native_packaged" | "configured_external";
	requestedPath: string;
	resolvedPath: string;
	realPath?: string;
	basename: string;
	platform: string;
	fileIdentity?: string;
	contentHash?: string;
	trustedOrigin: LauncherSource;
	launcherId: LauncherId;
}

export interface EvaluationCandidateLauncher {
	launcherId: LauncherId;
	executablePath: string;
	executableIdentity: string;
	invocationPrefix: string[];
	source: LauncherSource;
	trustedByRuntime: boolean;
}

/**
 * A logical capability mapped to a resolved executable identity. The mapping
 * separates a capability name (for example "node") from the actual resolved
 * executable path, so a capability never confers trust on every executable
 * whose basename happens to match.
 */
export interface AuthorizedExecutable {
	capabilityId: string;
	resolvedPath: string;
	allowedArguments?: string[];
	effectClass: string;
	source: string;
}

export interface ResolvedExecutable {
	requestedPath: string;
	resolvedPath: string;
	realPath?: string;
	basename: string;
	exists: boolean;
	executable: boolean;
	resolutionError?: string;
}

export const JENSEN_CANDIDATE_MARKER = ".jensen-candidate-complete";

// Structured probe used as the sandbox candidate when running through a
// compiled (Bun) runtime. It must be deterministic, non-interactive and free of
// provider or browser machinery so it can run inside a bare sandbox root.
export const SANDBOX_SELF_PROBE = ["eval", "self-probe", "--json"] as const;

const isWindows = process.platform === "win32";

/** Normalize path separators for comparison (backslash -> slash). */
function normalizeSeparators(value: string): string {
	return value.replace(/\\/g, "/");
}

function normalizeComponent(value: string): string {
	return normalizeSeparators(value);
}

/** Case-insensitive path comparison on Windows, case-sensitive elsewhere. */
export function samePath(left: string, right: string): boolean {
	const a = normalizeComponent(resolve(left));
	const b = normalizeComponent(resolve(right));
	return isWindows ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function executableBasename(path: string): string {
	return basename(path).replace(/\.exe$/i, "");
}

/**
 * Resolve the identity of a command/executable path. Relative commands are
 * resolved against the provided working directory. realpath is applied to
 * follow symlinks where the target exists.
 */
export async function resolveExecutable(command: string, cwd: string): Promise<ResolvedExecutable> {
	const requestedPath = command;
	const candidate = isAbsolute(command) ? command : resolve(cwd, command);
	let realPath: string | undefined;
	let exists = false;
	let executable = false;
	let resolutionError: string | undefined;
	try {
		realPath = await realpath(candidate);
		exists = true;
		try {
			const stats = await stat(realPath);
			executable = stats.isFile();
		} catch (error: unknown) {
			resolutionError = error instanceof Error ? error.message : "stat failed";
		}
	} catch (error: unknown) {
		resolutionError = error instanceof Error ? error.message : "resolve failed";
	}
	return {
		requestedPath,
		resolvedPath: candidate,
		realPath,
		basename: executableBasename(candidate),
		exists,
		executable,
		resolutionError,
	};
}

/** Determine the current runtime kind from the running environment. */
export function detectCurrentRuntimeKind(): {
	runtimeKind: RuntimeExecutableIdentity["runtimeKind"];
	executablePath: string;
	basename: string;
} {
	const execPath = process.execPath;
	const name = executableBasename(execPath);
	const isBun =
		typeof process !== "undefined" && "isBun" in process && (process as { isBun?: boolean }).isBun === true;
	if (isBun) return { runtimeKind: "bun_compiled", executablePath: execPath, basename: name };
	if (name === "node" || name === "nodejs")
		return { runtimeKind: "node_source", executablePath: execPath, basename: name };
	// Ambiguous host executable; treat node-detected hosts as source and the
	// fallback as a compiled/native launcher.
	return { runtimeKind: "native_packaged", executablePath: execPath, basename: name };
}

export interface ResolveLauncherOptions {
	cwd?: string;
	/** Configured external launcher; only honored when explicitly provided. */
	configuredExternal?: { executablePath: string; invocationPrefix: string[]; source: LauncherSource };
	/** Enable the current-process launcher (default true). */
	useCurrentProcess?: boolean;
}

/**
 * Resolve the trusted candidate launcher. The current-process launcher is
 * derived from the verified running executable. An external launcher is only
 * used when explicitly configured with an absolute path.
 */
export async function resolveCandidateLauncher(
	options: ResolveLauncherOptions = {},
): Promise<EvaluationCandidateLauncher> {
	const cwd = options.cwd ?? process.cwd();
	if (options.configuredExternal) {
		const external = options.configuredExternal;
		if (!isAbsolute(external.executablePath))
			throw new Error(`external candidate launcher must use an absolute path: ${external.executablePath}`);
		const identity = await resolveExecutable(external.executablePath, cwd);
		if (!identity.exists || !identity.executable)
			throw new Error(
				`external candidate launcher does not exist or is not executable: ${external.executablePath}${
					identity.resolutionError ? ` (${identity.resolutionError})` : ""
				}`,
			);
		const executablePath = identity.realPath ?? identity.resolvedPath;
		return {
			launcherId: "external_explicit",
			executablePath,
			executableIdentity: `external:${basename(executablePath)}@${sha256(executablePath).slice(0, 12)}`,
			invocationPrefix: [...external.invocationPrefix],
			source: external.source,
			trustedByRuntime: true,
		};
	}
	const kind = detectCurrentRuntimeKind();
	const identity = await resolveExecutable(kind.executablePath, cwd);
	const executablePath = identity.realPath ?? identity.resolvedPath;
	if (!identity.exists || !identity.executable)
		throw new Error(
			`current process executable is not a usable launcher: ${kind.executablePath}${
				identity.resolutionError ? ` (${identity.resolutionError})` : ""
			}`,
		);
	const launcherId: LauncherId =
		kind.runtimeKind === "node_source"
			? "jensen_source_runtime"
			: kind.runtimeKind === "bun_compiled"
				? "jensen_compiled_runtime"
				: "external_explicit";
	// Source runtimes accept an inline `-e` probe; compiled/native runtimes use
	// the bundled deterministic self-probe subcommand.
	const invocationPrefix =
		kind.runtimeKind === "node_source"
			? [
					"-e",
					"const fs=require('node:fs');const p=process.cwd()+'/.jensen-candidate-complete';fs.writeFileSync(p,'candidate');process.stdout.write(process.cwd());",
				]
			: [...SANDBOX_SELF_PROBE];
	return {
		launcherId,
		executablePath,
		executableIdentity: `${basename(executablePath)}@${launcherId}.${process.platform}-${process.arch}.${sha256(
			executablePath,
		).slice(0, 12)}`,
		invocationPrefix,
		source: "current_process",
		trustedByRuntime: true,
	};
}

export async function createRuntimeExecutableIdentity(
	options: ResolveLauncherOptions = {},
): Promise<RuntimeExecutableIdentity> {
	const cwd = options.cwd ?? process.cwd();
	const kind = detectCurrentRuntimeKind();
	const identity = await resolveExecutable(kind.executablePath, cwd);
	return {
		runtimeKind: kind.runtimeKind,
		requestedPath: kind.executablePath,
		resolvedPath: identity.resolvedPath,
		realPath: identity.realPath,
		basename: kind.basename,
		platform: `${process.platform}-${process.arch}`,
		fileIdentity: identity.realPath ? basename(identity.realPath) : undefined,
		contentHash: identity.exists ? sha256(identity.realPath ?? identity.resolvedPath) : undefined,
		trustedOrigin: "current_process",
		launcherId:
			kind.runtimeKind === "node_source"
				? "jensen_source_runtime"
				: kind.runtimeKind === "bun_compiled"
					? "jensen_compiled_runtime"
					: "external_explicit",
	};
}
