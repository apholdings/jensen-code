/**
 * Assignment mutate worker (fixture).
 *
 * Standalone tsx worker that registers+activates a distinct executor and then
 * performs one explicit `assign` or `reassign` mutation against a shared
 * assignment store. The parent test reads JSON lines from stdout.
 */

import { AssignmentControlService, FileAssignmentStore } from "../../../src/core/assignment/index.js";
import { ExecutorControlService, FileExecutorRegistry } from "../../../src/core/executor-registry/index.js";
import { FileDurableMissionStore } from "../../../src/core/mission-durable/index.js";

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined;
}

function flag(name: string): boolean {
	return process.argv.includes(name);
}

function line(payload: unknown): void {
	process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function main(): Promise<void> {
	const root = arg("--root");
	const op = arg("--op");
	const missionId = arg("--missionId");
	const executorId = arg("--executorId");
	if (!root || !op || !missionId || !executorId) {
		process.stderr.write("missing --root/--op/--missionId/--executorId\n");
		process.exit(1);
	}

	const missionStore = new FileDurableMissionStore({ root: `${root}/missions` });
	const executorStore = new FileExecutorRegistry({ root: `${root}/executors` });
	const assignmentStore = new FileAssignmentStore({ root: `${root}/assignments` });
	const executors = new ExecutorControlService({ store: executorStore, expiryMs: 30_000 });
	const service = new AssignmentControlService({ store: assignmentStore, missions: missionStore, executors });

	try {
		await executors.registerExecutor({
			executorId,
			configuredCapabilities: { platform: { os: "linux", arch: "x64" } },
		});
		try {
			await executors.activateExecutor(executorId, { platform: "linux", arch: "x64" });
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error
					? (error as { code: unknown }).code
					: undefined;
			if (code !== "EXECUTOR_ALREADY_ACTIVE") throw error;
		}

		if (op === "assign") {
			const outcome = await service.assignMission({ missionId, executorId });
			line({ t: "assign_ok", assignmentId: outcome.assignmentId, executorId });
		} else if (op === "reassign") {
			const outcome = await service.reassignMission(missionId, executorId);
			line({ t: "reassign_ok", assignmentId: outcome.assignmentId, executorId });
		} else {
			process.stderr.write(`unknown op ${op}\n`);
			process.exit(2);
		}
	} catch (error) {
		const code =
			typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : undefined;
		line({ t: `${op}_error`, code, message: error instanceof Error ? error.message : String(error) });
	}

	if (flag("--keepAlive")) {
		await new Promise<void>(() => {});
	}
	process.exit(0);
}

void main();
