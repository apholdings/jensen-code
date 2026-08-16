/**
 * Worker Daemon multiprocess fixture process.
 *
 * A real OS daemon used by worker-daemon-multiprocess.test.ts. It builds the
 * same durable stores/services the CLI uses, but rooted at a caller-supplied
 * temp directory, and runs a deterministic local child (a configurable slow
 * process) so tests can exercise claim races, kill/restart, and heartbeat
 * staleness without a model or a build step.
 *
 * Args:
 *   --root <dir>        shared store root (missions/executors/assignments)
 *   --executor <id>     logical executor this worker serves
 *   --session-dir <dir> child AgentSession directory
 *   --once              run one claim/execute cycle then exit
 *   --slow-ms <n>       child execution wall time (default 0)
 *   --poll-ms <n>       poll cadence (default 200)
 *   --heartbeat-ms <n>  heartbeat cadence (default 200)
 *   --expiry-ms <n>     heartbeat expiry (default 1000)
 */

import * as path from "node:path";
import { AssignmentControlService, FileAssignmentStore } from "../../../src/core/assignment/index.js";
import { ExecutorControlService, FileExecutorRegistry } from "../../../src/core/executor-registry/index.js";
import { FileDurableMissionStore } from "../../../src/core/mission-durable/index.js";
import { WorkerControlService } from "../../../src/core/worker-daemon/index.js";

function arg(args: string[], name: string): string | undefined {
	const idx = args.indexOf(name);
	return idx === -1 ? undefined : args[idx + 1];
}

function num(args: string[], name: string, fallback: number): number {
	const raw = arg(args, name);
	const n = raw === undefined ? NaN : Number(raw);
	return Number.isFinite(n) ? n : fallback;
}

async function main(): Promise<void> {
	const root = arg(process.argv.slice(2), "--root") ?? process.cwd();
	const executorId = arg(process.argv.slice(2), "--executor") ?? "worker-executor";
	const sessionDir = arg(process.argv.slice(2), "--session-dir") ?? path.join(root, "sessions");
	const once = process.argv.includes("--once");
	const slowMs = num(process.argv.slice(2), "--slow-ms", 0);
	const pollMs = num(process.argv.slice(2), "--poll-ms", 200);
	const heartbeatMs = num(process.argv.slice(2), "--heartbeat-ms", 200);
	const expiryMs = num(process.argv.slice(2), "--expiry-ms", 1000);

	const missions = new FileDurableMissionStore({ root: path.join(root, "missions") });
	const executors = new ExecutorControlService({
		store: new FileExecutorRegistry({ root: path.join(root, "executors") }),
		expiryMs,
	});
	const assignments = new AssignmentControlService({
		store: new FileAssignmentStore({ root: path.join(root, "assignments") }),
		missions,
		executors,
		sessionDir,
	});

	const worker = new WorkerControlService({
		executorId,
		executors,
		assignments,
		missions,
		buildResumeLaunch: () => ({
			command: process.execPath,
			args: ["-e", `setTimeout(() => process.exit(0), ${slowMs})`],
			cwd: root,
		}),
		verifier: async () => ({ verified: true, summary: "multiprocess fixture verified", criterionIds: [] }),
		pollMs,
		heartbeatMs,
		expiryMs,
	});

	const started = await worker.start();
	process.stdout.write(
		`${JSON.stringify({ kind: "started", executorId, instance: started.runtimeInstanceId, epoch: started.runtimeEpoch })}\n`,
	);

	if (once) {
		const outcome = await worker.runOnce();
		process.stdout.write(`${JSON.stringify(outcome)}\n`);
		await worker.stop();
		process.exit(0);
	}

	let stopping = false;
	const shutdown = async (reason: string) => {
		if (stopping) return;
		stopping = true;
		await worker.stop(reason);
		process.exit(0);
	};
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
