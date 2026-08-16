/**
 * Remote Execution — remote verification (2.14.0).
 *
 * The central verifier remains authoritative, but its deterministic commands
 * run against the remote workspace so `node test.js` actually tests the file
 * the remote child edited on the target. This adapts the existing
 * `VerificationExecutor` contract to a remote command runner; `verify()` itself
 * is unchanged.
 */

import type { MissionRequest } from "../mission-domain/mission-request.js";
import type { ProcessMissionVerification, ProcessMissionVerifier } from "../mission-domain/process-mission-executor.js";
import type { VerificationSpec } from "../reliability/types.js";
import type { VerificationExecutor } from "../reliability/verifier.js";
import { verify } from "../reliability/verifier.js";
import type { RemoteExecutionTarget } from "./remote-target-types.js";
import type { RemoteCommandRunner } from "./remote-transport.js";

export interface RemoteVerificationOptions {
	runner: RemoteCommandRunner;
	target: RemoteExecutionTarget;
	/** Remote absolute working directory for relative verification paths. */
	cwd: string;
	commandTimeoutMs?: number;
	signal?: AbortSignal;
}

/**
 * Build a VerificationExecutor whose filesystem/process operations execute on
 * the remote target. `runCommand` uses the remote command runner; file/state
 * operations round-trip through the same runner via platform-neutral helpers.
 */
export function createRemoteVerificationExecutor(options: RemoteVerificationOptions): VerificationExecutor {
	const cwd = options.cwd;
	const timeout = options.commandTimeoutMs ?? 120_000;

	const resolvePath = (p: string): string => {
		if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return p;
		return `${cwd.replace(/[\\/]+$/, "")}\\${p}`;
	};

	return {
		async runCommand(command, cwdOverride) {
			const result = await options.runner.runCommand(options.target, command, cwdOverride ?? cwd, {
				timeoutMs: timeout,
				signal: options.signal,
			});
			return {
				exitCode: result.exitCode === null ? 1 : result.exitCode,
				stdout: result.stdout,
				stderr: result.stderr,
			};
		},

		async fileExists(p, cwdOverride) {
			const result = await options.runner.runCommand(
				options.target,
				`Test-Path -LiteralPath '${resolvePath(p)}'`,
				cwdOverride ?? cwd,
				{ timeoutMs: 30_000, signal: options.signal },
			);
			return result.stdout.trim() === "True";
		},

		async readFile(p, cwdOverride) {
			const result = await options.runner.runCommand(
				options.target,
				`Get-Content -LiteralPath '${resolvePath(p)}' -Raw`,
				cwdOverride ?? cwd,
				{ timeoutMs: 30_000, signal: options.signal },
			);
			return result.stdout;
		},

		async searchMatches(pattern, cwdOverride) {
			const result = await options.runner.runCommand(
				options.target,
				`Get-ChildItem -Recurse -File | Select-String -List -Pattern '${pattern}' | Select-Object -ExpandProperty Path`,
				cwdOverride ?? cwd,
				{ timeoutMs: 30_000, signal: options.signal },
			);
			return result.stdout
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0);
		},

		async gitChangedPaths(cwdOverride) {
			const result = await options.runner.runCommand(options.target, "git diff --name-only", cwdOverride ?? cwd, {
				timeoutMs: 30_000,
				signal: options.signal,
			});
			return result.stdout
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0);
		},
	};
}

/** Collect a mission's declared deterministic verification specs. */
function collectVerificationSpecs(request: MissionRequest): { criterionId: string; spec: VerificationSpec }[] {
	const specs: { criterionId: string; spec: VerificationSpec }[] = [];
	for (const criterion of request.acceptanceCriteria) {
		if (criterion.verification) {
			specs.push({ criterionId: criterion.id, spec: criterion.verification });
		}
	}
	return specs;
}

/**
 * Build the remote acceptance-criteria verifier. Returns `undefined` when the
 * mission declares no verifiable criteria (so a clean exit-0 stays PARTIAL,
 * never SUCCEEDED). Identical semantics to the local worker verifier, but the
 * verification operations execute remotely.
 */
export function buildRemoteAcceptanceCriteriaVerifier(
	request: MissionRequest,
	options: RemoteVerificationOptions,
): ProcessMissionVerifier | undefined {
	const specs = collectVerificationSpecs(request);
	if (specs.length === 0) return undefined;

	const executor = createRemoteVerificationExecutor(options);

	return async (input): Promise<ProcessMissionVerification> => {
		if (input.outcome.exitCode !== 0 || input.outcome.launchError || input.outcome.timedOut) {
			return { verified: false, summary: "execution did not complete normally" };
		}

		const results = [];
		for (const { criterionId, spec } of specs) {
			const result = await verify(spec, executor, { criterionId, cwd: options.cwd });
			results.push(result);
		}

		const failed = results.filter((result) => !result.passed);
		const verified = failed.length === 0;
		return {
			verified,
			criterionIds: results.map((result) => result.criterionId ?? result.kind),
			summary: verified
				? `${results.length} verification spec(s) passed`
				: `${failed.length} verification spec(s) failed: ${failed
						.map((result) => result.evidence.summary)
						.join("; ")}`,
		};
	};
}
