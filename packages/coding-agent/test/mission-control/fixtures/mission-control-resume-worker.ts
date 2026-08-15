/**
 * Mission Control resume-race worker (fixture).
 *
 * Standalone tsx worker that resumes a durable child mission through
 * MissionControlService. The parent spawns two of these concurrently against
 * the same mission; exactly one wins the execution lease and the loser receives
 * a structured MISSION_OWNED / MISSION_ACTIVE error.
 */

import { MissionControlService } from "../../../src/core/mission-control/index.js";
import { ExecutionOwnershipError } from "../../../src/core/mission-domain/index.js";
import { FileDurableMissionStore } from "../../../src/core/mission-durable/index.js";

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined;
}

function codeOf(error: unknown): string {
	if (error instanceof ExecutionOwnershipError) return error.code;
	if (typeof error === "object" && error !== null && "code" in error) {
		return String((error as { code: unknown }).code);
	}
	return "ERROR";
}

async function main(): Promise<void> {
	const root = arg("--root");
	const missionId = arg("--missionId");
	const sessionDir = arg("--sessionDir");
	const cwd = arg("--cwd");
	if (!root || !missionId || !sessionDir || !cwd) {
		process.stderr.write("missing --root/--missionId/--sessionDir/--cwd\n");
		process.exit(1);
	}

	const store = new FileDurableMissionStore({ root });
	const control = new MissionControlService({ store, sessionDir });

	try {
		const outcome = await control.resumeMission(missionId, {
			buildResumeLaunch: () => ({ command: process.execPath, args: ["-e", "process.exit(0)"], cwd }),
		});
		process.stdout.write(
			`${JSON.stringify({
				ok: true,
				missionId: outcome.missionId,
				childSessionId: outcome.childSessionId,
				attemptId: outcome.attemptId,
				executionId: outcome.executionId,
				fencingToken: outcome.fencingToken,
				state: outcome.missionState,
			})}\n`,
		);
	} catch (error) {
		process.stdout.write(
			`${JSON.stringify({
				ok: false,
				code: codeOf(error),
				name: error instanceof Error ? error.name : undefined,
				message: error instanceof Error ? error.message : String(error),
			})}\n`,
		);
	}
}

void main();
