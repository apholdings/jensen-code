/**
 * Worker Verification Bridge (2.13.0).
 *
 * Maps a durable mission's declared acceptance criteria (each optionally
 * carrying a deterministic `VerificationSpec`) into a `ProcessMissionVerifier`
 * that the Worker can hand to the existing execution path. A clean exit-0 child
 * is only promoted from PARTIAL (unverified) to SUCCEEDED when every declared
 * verification spec passes deterministically; a model's self-reported success is
 * never the authority.
 *
 * This is deliberately a thin bridge: the Reliability Kernel's
 * `verify()` + `createWorkspaceVerificationExecutor()` remain the verification
 * authority; `ProcessMissionExecutor` remains the promotion authority. The
 * worker only composes them.
 */

import type { MissionRequest } from "../mission-domain/mission-request.js";
import type { ProcessMissionVerification, ProcessMissionVerifier } from "../mission-domain/process-mission-executor.js";
import type { VerificationSpec } from "../reliability/types.js";
import { verify } from "../reliability/verifier.js";
import { createWorkspaceVerificationExecutor } from "../reliability/workspace-verification.js";

/**
 * Build a verifier for a mission whose acceptance criteria carry deterministic
 * verification specs. Returns `undefined` when the mission declares no
 * verifiable criteria (so a bare exit-0 remains PARTIAL, never SUCCEEDED).
 */
export function buildAcceptanceCriteriaVerifier(
	request: MissionRequest,
	options: { commandTimeoutMs?: number } = {},
): ProcessMissionVerifier | undefined {
	const specs: { criterionId: string; spec: VerificationSpec }[] = [];
	for (const criterion of request.acceptanceCriteria) {
		if (criterion.verification) {
			specs.push({ criterionId: criterion.id, spec: criterion.verification });
		}
	}
	if (specs.length === 0) return undefined;

	const cwd = request.workspaceScope?.cwd ?? process.cwd();
	const executor = createWorkspaceVerificationExecutor({
		cwd,
		commandTimeoutMs: options.commandTimeoutMs,
	});

	return async (input): Promise<ProcessMissionVerification> => {
		// Only a clean, normal exit-0 execution can be promoted. Verification of a
		// crashed/failed execution is not attempted (nothing to verify).
		if (input.outcome.exitCode !== 0 || input.outcome.launchError || input.outcome.timedOut) {
			return { verified: false, summary: "execution did not complete normally" };
		}

		const results = [];
		for (const { criterionId, spec } of specs) {
			const result = await verify(spec, executor, { criterionId, cwd });
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
