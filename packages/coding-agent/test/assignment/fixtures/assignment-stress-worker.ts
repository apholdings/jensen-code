/**
 * Assignment stress worker (fixture).
 *
 * Repeatedly assigns / reassigns / releases a single mission for a distinct
 * executor. It treats structured conflicts as ordinary outcomes (never crashes),
 * which lets multiple processes churn the same mission under the per-mission
 * lock and prove the current-assignment invariant survives contention.
 */

import { AssignmentControlService, FileAssignmentStore } from "../../../src/core/assignment/index.js";
import { ExecutorControlService, FileExecutorRegistry } from "../../../src/core/executor-registry/index.js";
import { FileDurableMissionStore } from "../../../src/core/mission-durable/index.js";

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined;
}

function line(payload: unknown): void {
	process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function codeOf(error: unknown): string | undefined {
	if (typeof error === "object" && error !== null && "code" in error) {
		return String((error as { code: unknown }).code);
	}
	return undefined;
}

async function main(): Promise<void> {
	const root = arg("--root");
	const missionId = arg("--missionId");
	const executorId = arg("--executorId");
	const iterations = Number(arg("--iterations") ?? 10);
	if (!root || !missionId || !executorId) {
		process.stderr.write("missing --root/--missionId/--executorId\n");
		process.exit(1);
	}

	const missionStore = new FileDurableMissionStore({ root: `${root}/missions` });
	const executorStore = new FileExecutorRegistry({ root: `${root}/executors` });
	const assignmentStore = new FileAssignmentStore({ root: `${root}/assignments` });
	const executors = new ExecutorControlService({ store: executorStore, expiryMs: 30_000 });
	const service = new AssignmentControlService({ store: assignmentStore, missions: missionStore, executors });

	await executors.registerExecutor({ executorId, configuredCapabilities: { platform: { os: "linux" } } });
	try {
		await executors.activateExecutor(executorId, { platform: "linux", arch: "x64" });
	} catch {
		// Already active is fine; this worker just needs to be ONLINE.
	}

	for (let i = 0; i < iterations; i++) {
		try {
			const assigned = await service.assignMission({ missionId, executorId });
			line({ t: "assign_ok", assignmentId: assigned.assignmentId, executorId });
			try {
				await service.releaseAssignment(assigned.assignmentId);
				line({ t: "release_ok", assignmentId: assigned.assignmentId });
			} catch (error) {
				line({ t: "release_error", code: codeOf(error) });
			}
		} catch (error) {
			const code = codeOf(error);
			if (code === "MISSION_ALREADY_ASSIGNED") {
				try {
					const reassigned = await service.reassignMission(missionId, executorId);
					line({ t: "reassign_ok", assignmentId: reassigned.assignmentId, executorId });
				} catch (reassignError) {
					line({ t: "reassign_error", code: codeOf(reassignError) });
				}
			} else {
				line({ t: "assign_error", code });
			}
		}
	}

	process.exit(0);
}

void main();
