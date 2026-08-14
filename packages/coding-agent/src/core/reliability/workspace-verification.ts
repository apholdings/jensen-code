/**
 * Workspace Verification Executor — real filesystem/process verification for
 * live sessions.
 *
 * Deterministic verification in a real Jensen session needs a provider that can
 * actually run commands, inspect files, search the repository, and read git
 * scope. This adapter implements the VerificationExecutor contract against the
 * session's working directory using the shared `execCommand` helper and
 * node:fs. It is used by the Reliability Kernel's automatic final verification;
 * it never trusts model output.
 */

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execCommand } from "../exec.js";
import type { VerificationExecutor } from "./verifier.js";

export interface WorkspaceVerificationOptions {
	/** Working directory for relative paths and commands. */
	cwd: string;
	/** Maximum wall-clock time for a single command (default 120s). */
	commandTimeoutMs?: number;
	/** Abort signal honoured by spawned processes. */
	signal?: AbortSignal;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

export function createWorkspaceVerificationExecutor(options: WorkspaceVerificationOptions): VerificationExecutor {
	const cwd = options.cwd;
	const timeout = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

	const resolvePath = (p: string, cwdOverride?: string): string => {
		const base = cwdOverride ?? cwd;
		if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return p;
		return join(base, p);
	};

	return {
		async runCommand(command, cwdOverride) {
			const result = await execCommand("sh", ["-c", command], cwdOverride ?? cwd, {
				timeout,
				signal: options.signal,
			});
			// A timed-out/killed process is reported as a non-zero exit code so a
			// timed-out verification can never be mistaken for success.
			return {
				exitCode: result.killed ? 124 : result.code,
				stdout: result.stdout,
				stderr: result.stderr,
			};
		},

		async fileExists(p, cwdOverride) {
			try {
				await access(resolvePath(p, cwdOverride));
				return true;
			} catch {
				return false;
			}
		},

		async readFile(p, cwdOverride) {
			try {
				return await readFile(resolvePath(p, cwdOverride), "utf8");
			} catch {
				return "";
			}
		},

		async searchMatches(pattern, cwdOverride) {
			const result = await execCommand("grep", ["-rl", "--", pattern, "."], cwdOverride ?? cwd, {
				timeout: 30_000,
				signal: options.signal,
			});
			return result.stdout
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0);
		},

		async gitChangedPaths(cwdOverride) {
			const result = await execCommand("git", ["diff", "--name-only"], cwdOverride ?? cwd, {
				timeout: 30_000,
				signal: options.signal,
			});
			return result.stdout
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0);
		},
	};
}
