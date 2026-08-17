/**
 * Worker Daemon — CLI (2.13.0).
 *
 * `jensen worker run|status|list|show`
 *
 * `run` starts a long-lived daemon (or a single `--once` cycle) bound to one
 * logical executor. `status`/`list`/`show` expose the durable worker read model.
 * Machine-readable `--json` exposes stable DTOs; human output is a compact
 * key: value block.
 */

import chalk from "chalk";
import { getAgentDir } from "../../config.js";
import { AssignmentControlService, type BuildAssignedResumeLaunch } from "../assignment/assignment-control-service.js";
import { createFileAssignmentStore } from "../assignment/file-assignment-store.js";
import { defaultChildSessionDir } from "../durable-child-session/index.js";
import { createFileExecutorRegistry, ExecutorControlService } from "../executor-registry/index.js";
import { createFileDurableMissionStore } from "../mission-durable/index.js";
import { listWorkers, WorkerControlService } from "./worker-control-service.js";
import { type WorkerListResult, type WorkerStatus, workerIdForExecutor } from "./worker-types.js";

const SUBCOMMANDS = new Set(["run", "status", "list", "show"]);

function valueArgs(args: string[]): string[] {
	return args.filter((a) => !a.startsWith("--"));
}

function flag(args: string[], name: string): boolean {
	return args.includes(name);
}

function flagValue(args: string[], name: string): string | undefined {
	const idx = args.indexOf(name);
	if (idx === -1) return undefined;
	return args[idx + 1];
}

function optionalPositiveNumber(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const n = Number(value);
	return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

function printJson(payload: unknown): void {
	process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function codeOf(error: unknown): string | undefined {
	if (typeof error === "object" && error !== null && "code" in error) {
		return String((error as { code: unknown }).code);
	}
	return undefined;
}

function renderError(error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	const code = codeOf(error);
	process.stderr.write(`${chalk.red(code ? `${code}: ${message}` : message)}\n`);
}

/** Build the concrete child CLI launch for a local durable-child resume. */
function buildChildCliResumeLaunch(): BuildAssignedResumeLaunch {
	const cliEntry = process.argv[1];
	const command = process.execPath;
	const prefixArgs = [...process.execArgv, cliEntry];
	const sessionDir = defaultChildSessionDir(getAgentDir());

	return ({ request, resumePrompt, childSessionId }) => {
		const launchArgs = [
			...prefixArgs,
			"--mode",
			"json",
			"-p",
			"--child-mission",
			request.missionId,
			"--session-id",
			childSessionId,
			"--session-dir",
			sessionDir,
		];
		if (request.modelPolicy) {
			launchArgs.push("--provider", request.modelPolicy.provider, "--model", request.modelPolicy.model);
		}
		if (request.capabilities && request.capabilities.length > 0) {
			launchArgs.push("--tools", request.capabilities.join(","));
		}
		launchArgs.push(resumePrompt);
		const orchestration = request.orchestration;
		return {
			command,
			args: launchArgs,
			cwd: request.workspaceScope?.cwd ?? process.cwd(),
			env: {
				JENSEN_MISSION_ID: request.missionId,
				...(orchestration?.priority !== undefined
					? { JENSEN_INFERENCE_PRIORITY: String(orchestration.priority) }
					: {}),
				...(orchestration?.dependencyCriticality !== undefined
					? { JENSEN_INFERENCE_UNBLOCKS: String(orchestration.dependencyCriticality) }
					: {}),
				...(orchestration?.verification ? { JENSEN_INFERENCE_VERIFICATION: "1" } : {}),
			},
		};
	};
}

interface WorkerServiceBundle {
	executors: ExecutorControlService;
	assignments: AssignmentControlService;
	missions: ReturnType<typeof createFileDurableMissionStore>;
}

function buildServices(): WorkerServiceBundle {
	const missions = createFileDurableMissionStore();
	const executors = new ExecutorControlService({ store: createFileExecutorRegistry() });
	const assignments = new AssignmentControlService({
		store: createFileAssignmentStore(),
		missions,
		executors,
		sessionDir: defaultChildSessionDir(getAgentDir()),
	});
	return { executors, assignments, missions };
}

function renderList(result: WorkerListResult): void {
	if (result.entries.length === 0 && result.corrupt.length === 0) {
		process.stdout.write("(no workers)\n");
		return;
	}
	for (const entry of result.entries) {
		process.stdout.write(
			[
				`${entry.executorId}  [${entry.status}]`,
				entry.workerInstanceId ? ` instance=${entry.workerInstanceId}` : "",
				` epoch=${entry.workerEpoch}`,
				entry.currentAssignmentId ? ` assignment=${entry.currentAssignmentId}` : "",
				entry.currentAssignmentState ? ` assignmentState=${entry.currentAssignmentState}` : "",
				entry.currentMissionState ? ` missionState=${entry.currentMissionState}` : "",
			].join(""),
		);
		process.stdout.write("\n");
	}
	for (const corrupt of result.corrupt) {
		process.stdout.write(chalk.yellow(`${corrupt.executorId}  [CORRUPT] ${corrupt.diagnostic}\n`));
	}
}

function renderStatus(status: WorkerStatus): void {
	const i = status.identity;
	process.stdout.write(`WORKER\n`);
	process.stdout.write(`  worker: ${i.workerId}\n`);
	process.stdout.write(`  executor: ${i.executorId}\n`);
	process.stdout.write(`  instance: ${i.workerInstanceId || "(none)"}\n`);
	process.stdout.write(`  epoch: ${i.workerEpoch}\n`);
	if (i.ownerId) process.stdout.write(`  owner: ${i.ownerId}\n`);
	if (i.hostname) process.stdout.write(`  host: ${i.hostname}\n`);
	if (i.pid !== undefined) process.stdout.write(`  pid: ${i.pid}\n`);
	if (i.startedAtMs) process.stdout.write(`  started: ${i.startedAtMs}\n`);
	process.stdout.write(`  liveness: ${status.liveness}\n`);
	process.stdout.write(`  daemon: ${status.daemonState}\n`);
	process.stdout.write(`  activity: ${status.activity}\n`);
	if (status.currentAssignment) {
		const a = status.currentAssignment;
		process.stdout.write(`ASSIGNMENT\n`);
		process.stdout.write(`  id: ${a.assignmentId}\n`);
		process.stdout.write(`  mission: ${a.missionId}\n`);
		process.stdout.write(`  state: ${a.state}\n`);
		if (a.attemptId) process.stdout.write(`  attempt: ${a.attemptId}\n`);
		if (a.executionId) process.stdout.write(`  execution: ${a.executionId}\n`);
	}
	if (status.currentExecution) {
		const e = status.currentExecution;
		process.stdout.write(`EXECUTION\n`);
		process.stdout.write(`  missionState: ${e.missionState}\n`);
		if (e.currentExecutionId) process.stdout.write(`  execution: ${e.currentExecutionId}\n`);
		if (e.waitReason) process.stdout.write(`  wait: ${e.waitReason}\n`);
	}
	if (status.lastError) process.stdout.write(`  lastError: ${status.lastError}\n`);
}

// =============================================================================
// Handler
// =============================================================================

export function printWorkerUsage(): string {
	return [
		"  worker run --executor <EXECUTOR_ID> [--once] [--poll-ms N] [--heartbeat-ms N] [--expiry-ms N] [--json]",
		"  worker status <EXECUTOR_ID> [--json]",
		"  worker list [--json]",
		"  worker show <EXECUTOR_ID> [--json]",
	].join("\n");
}

export async function handleWorkerCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "worker") return false;
	const sub = args[1];
	if (!sub || !SUBCOMMANDS.has(sub)) return false;

	const json = flag(args, "--json");

	try {
		switch (sub) {
			case "run": {
				const executorId = flagValue(args, "--executor");
				if (!executorId) {
					process.stderr.write("worker run requires --executor <EXECUTOR_ID>\n");
					process.exitCode = 1;
					return true;
				}
				const bundle = buildServices();
				const worker = new WorkerControlService({
					executorId,
					executors: bundle.executors,
					assignments: bundle.assignments,
					missions: bundle.missions,
					buildResumeLaunch: buildChildCliResumeLaunch(),
					pollMs: optionalPositiveNumber(flagValue(args, "--poll-ms")),
					heartbeatMs: optionalPositiveNumber(flagValue(args, "--heartbeat-ms")),
					expiryMs: optionalPositiveNumber(flagValue(args, "--expiry-ms")),
				});

				const started = await worker.start();
				if (json) printJson(started);
				else {
					process.stdout.write(
						`started ${workerIdForExecutor(executorId)} executor=${executorId} instance=${started.runtimeInstanceId} epoch=${started.runtimeEpoch}\n`,
					);
				}

				if (flag(args, "--once")) {
					const outcome = await worker.runOnce();
					if (json) printJson({ start: started, run: outcome });
					else if (outcome.kind === "idle") process.stdout.write("idle (no eligible assignment)\n");
					else if (outcome.kind === "skipped")
						process.stdout.write(`skipped ${outcome.assignmentId}: ${outcome.reason}\n`);
					else
						process.stdout.write(
							`executed ${outcome.assignmentId} mission=${outcome.missionId} missionState=${outcome.missionState} success=${outcome.success}\n`,
						);
					await worker.stop();
					return true;
				}

				// Long-lived daemon: keep timers alive, stop cleanly on signals.
				const shutdown = async (reason: string) => {
					await worker.stop(reason);
					process.exit(0);
				};
				process.once("SIGTERM", () => void shutdown("SIGTERM"));
				process.once("SIGINT", () => void shutdown("SIGINT"));
				return true;
			}

			case "status":
			case "show": {
				const executorId = valueArgs(args)[2];
				if (!executorId) {
					process.stderr.write(`worker ${sub} requires <EXECUTOR_ID>\n`);
					process.exitCode = 1;
					return true;
				}
				const bundle = buildServices();
				const worker = new WorkerControlService({
					executorId,
					executors: bundle.executors,
					assignments: bundle.assignments,
					missions: bundle.missions,
					buildResumeLaunch: buildChildCliResumeLaunch(),
				});
				const status = await worker.status();
				if (json) printJson(status);
				else renderStatus(status);
				return true;
			}

			case "list": {
				const bundle = buildServices();
				const result = await listWorkers(bundle);
				if (json) printJson(result);
				else renderList(result);
				return true;
			}

			default:
				return false;
		}
	} catch (error) {
		renderError(error);
		process.exitCode = 1;
		return true;
	}
}
