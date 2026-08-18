/**
 * Assignment Foundation — CLI (2.11.0).
 *
 * `jensen assignment list|show|create|release|reassign|compatibility|accept|start`
 *
 * Machine-readable `--json` exposes stable DTOs; human output is a compact
 * key: value block. There is no scheduler command.
 */

import chalk from "chalk";
import { getAgentDir } from "../../config.js";
import { defaultChildSessionDir } from "../durable-child-session/index.js";
import type { ExecutorRuntimeProof } from "../executor-registry/executor-registry-types.js";
import { createFileExecutorRegistry, ExecutorControlService } from "../executor-registry/index.js";
import { createFileDurableMissionStore } from "../mission-durable/index.js";
import { AssignmentControlService } from "./assignment-control-service.js";
import type {
	AssignMissionOutcome,
	AssignmentDetail,
	AssignmentListResult,
	MissionRequirements,
} from "./assignment-types.js";
import { type AssignmentState, isAssignmentState } from "./assignment-types.js";
import { createFileAssignmentStore } from "./file-assignment-store.js";

const SUBCOMMANDS = new Set(["list", "show", "create", "release", "reassign", "compatibility", "accept", "start"]);

function buildService(): AssignmentControlService {
	return new AssignmentControlService({
		store: createFileAssignmentStore(),
		missions: createFileDurableMissionStore(),
		executors: new ExecutorControlService({ store: createFileExecutorRegistry() }),
		sessionDir: defaultChildSessionDir(getAgentDir()),
	});
}

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

function flagValues(args: string[], name: string): string[] {
	const values: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === name && args[i + 1] !== undefined && !args[i + 1].startsWith("--")) {
			values.push(args[i + 1]);
		}
	}
	return values;
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

function requirementsFromFlags(args: string[]): MissionRequirements | undefined {
	const requirements: MissionRequirements = {};
	const os = flagValue(args, "--os");
	const arch = flagValue(args, "--arch");
	const execution = flagValues(args, "--execution");
	const providers = flagValues(args, "--provider");
	const models = flagValues(args, "--model");
	const tools = flagValues(args, "--tool");
	const specialized = flagValues(args, "--specialized");
	const extra = flagValues(args, "--extra");
	const requiredLabels = flagValues(args, "--label-required");
	const excludedLabels = flagValues(args, "--label-excluded");

	if (os || arch) requirements.platform = { os, arch };
	if (execution.length > 0) requirements.execution = [...new Set(execution)].sort();
	if (providers.length > 0) requirements.providers = [...new Set(providers)].sort();
	if (models.length > 0) requirements.models = [...new Set(models)].sort();
	if (tools.length > 0) requirements.tools = [...new Set(tools)].sort();
	if (specialized.length > 0) requirements.specialized = [...new Set(specialized)].sort();
	if (extra.length > 0) requirements.extra = [...new Set(extra)].sort();
	if (requiredLabels.length > 0 || excludedLabels.length > 0) {
		requirements.labels = {
			required: requiredLabels.length > 0 ? [...new Set(requiredLabels)].sort() : undefined,
			excluded: excludedLabels.length > 0 ? [...new Set(excludedLabels)].sort() : undefined,
		};
	}

	return Object.keys(requirements).length > 0 ? requirements : undefined;
}

function renderList(result: AssignmentListResult): void {
	if (result.entries.length === 0 && result.corrupt.length === 0) {
		process.stdout.write("(no assignments)\n");
		return;
	}
	for (const entry of result.entries) {
		process.stdout.write(
			[
				`${entry.assignmentId}  [${entry.state}]`,
				` mission=${entry.missionId}`,
				` executor=${entry.executorId}`,
				entry.current ? " current" : "",
				entry.consumedByExecutionId ? ` execution=${entry.consumedByExecutionId}` : "",
			].join(""),
		);
		process.stdout.write("\n");
	}
	for (const corrupt of result.corrupt) {
		process.stdout.write(chalk.yellow(`${corrupt.assignmentId}  [CORRUPT] ${corrupt.diagnostic}\n`));
	}
}

function renderDetail(detail: AssignmentDetail): void {
	process.stdout.write(`ASSIGNMENT\n`);
	process.stdout.write(`  id: ${detail.assignmentId}\n`);
	process.stdout.write(`  mission: ${detail.missionId}\n`);
	process.stdout.write(`  executor: ${detail.executorId}\n`);
	process.stdout.write(`  state: ${detail.state}\n`);
	process.stdout.write(`  current: ${detail.current ? "yes" : "no"}\n`);
	if (detail.assignedBy) process.stdout.write(`  assignedBy: ${detail.assignedBy}\n`);
	if (detail.acceptedAtMs) process.stdout.write(`  accepted: ${detail.acceptedAtMs}\n`);
	if (detail.executionStartedAtMs) process.stdout.write(`  executionStarted: ${detail.executionStartedAtMs}\n`);
	if (detail.completedAtMs) process.stdout.write(`  completed: ${detail.completedAtMs}\n`);
	if (detail.releasedAtMs) process.stdout.write(`  released: ${detail.releasedAtMs}\n`);
	if (detail.supersededByAssignmentId) process.stdout.write(`  supersededBy: ${detail.supersededByAssignmentId}\n`);
	if (detail.consumedByAttemptId) process.stdout.write(`  attempt: ${detail.consumedByAttemptId}\n`);
	if (detail.consumedByExecutionId) process.stdout.write(`  execution: ${detail.consumedByExecutionId}\n`);
	if (detail.terminalMissionState) process.stdout.write(`  terminalMission: ${detail.terminalMissionState}\n`);
	if (detail.executionOwnerIdentity) {
		const owner = detail.executionOwnerIdentity;
		process.stdout.write(
			`  owner: ${owner.executorId} ${owner.runtimeInstanceId} epoch=${owner.runtimeEpoch} leaseOwner=${owner.ownerId}\n`,
		);
	}
}

function renderAssign(outcome: AssignMissionOutcome): void {
	process.stdout.write(
		`assigned ${outcome.assignmentId} mission=${outcome.missionId} executor=${outcome.executorId} state=${outcome.state}\n`,
	);
}

// =============================================================================
// Handler
// =============================================================================

export function printAssignmentUsage(): string {
	return [
		"  assignment list [--json] [--mission M] [--executor E] [--state S] [--current|--not-current] [--limit N]",
		"  assignment show <ASSIGNMENT_ID> [--json]",
		"  assignment create --mission M --executor E [--json] [--os OS] [--arch A] [--execution C]... [--provider P]... [--model M]... [--tool T]... [--specialized S]... [--extra X]... [--label-required L]... [--label-excluded L]...",
		"  assignment release <ASSIGNMENT_ID> [--json]",
		"  assignment reassign <ASSIGNMENT_ID> --executor E [--json]",
		"  assignment compatibility --mission M --executor E [--json]",
		"  assignment accept <ASSIGNMENT_ID> --instance I --epoch N [--json]",
		"  assignment start <ASSIGNMENT_ID> --instance I --epoch N [--json]",
	].join("\n");
}

export async function handleAssignmentCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "assignment") return false;
	const sub = args[1];
	if (!sub || !SUBCOMMANDS.has(sub)) return false;

	const json = flag(args, "--json");
	const service = buildService();

	try {
		switch (sub) {
			case "list": {
				const stateArg = flagValue(args, "--state");
				const state: AssignmentState | undefined = stateArg && isAssignmentState(stateArg) ? stateArg : undefined;
				const limitArg = flagValue(args, "--limit");
				const result = await service.listAssignments({
					filter: {
						missionId: flagValue(args, "--mission"),
						executorId: flagValue(args, "--executor"),
						state,
						current: flag(args, "--current") ? true : flag(args, "--not-current") ? false : undefined,
					},
					limit: limitArg !== undefined ? Number(limitArg) : undefined,
				});
				if (json) printJson(result);
				else renderList(result);
				return true;
			}

			case "show": {
				const assignmentId = valueArgs(args)[2];
				if (!assignmentId) return missingId("assignment id");
				const detail = await service.getAssignment(assignmentId);
				if (json) printJson(detail);
				else renderDetail(detail);
				return true;
			}

			case "create": {
				const missionId = flagValue(args, "--mission");
				const executorId = flagValue(args, "--executor");
				if (!missionId || !executorId) {
					process.stderr.write("create requires --mission and --executor\n");
					process.exitCode = 1;
					return true;
				}
				const outcome = await service.assignMission({
					missionId,
					executorId,
					requirements: requirementsFromFlags(args),
					assignedBy: flagValue(args, "--assigned-by"),
				});
				if (json) printJson(outcome);
				else renderAssign(outcome);
				return true;
			}

			case "release": {
				const assignmentId = valueArgs(args)[2];
				if (!assignmentId) return missingId("assignment id");
				const record = await service.releaseAssignment(assignmentId);
				if (json) printJson(record);
				else process.stdout.write(`released ${record.assignmentId} state=${record.state}\n`);
				return true;
			}

			case "reassign": {
				const assignmentId = valueArgs(args)[2];
				const executorId = flagValue(args, "--executor");
				if (!assignmentId || !executorId) {
					process.stderr.write("reassign requires <ASSIGNMENT_ID> and --executor\n");
					process.exitCode = 1;
					return true;
				}
				const current = await service.getAssignment(assignmentId);
				const outcome = await service.reassignMission(current.missionId, executorId, {
					requirements: requirementsFromFlags(args),
					assignedBy: flagValue(args, "--assigned-by"),
				});
				if (json) printJson(outcome);
				else renderAssign(outcome);
				return true;
			}

			case "compatibility": {
				const missionId = flagValue(args, "--mission");
				const executorId = flagValue(args, "--executor");
				if (!missionId || !executorId) {
					process.stderr.write("compatibility requires --mission and --executor\n");
					process.exitCode = 1;
					return true;
				}
				const result = await service.evaluateCompatibility(missionId, executorId, requirementsFromFlags(args));
				if (json) printJson(result);
				else {
					process.stdout.write(
						`${result.missionId} -> ${result.executorId} compatible=${result.assignability.compatible} assignable=${result.assignability.assignable} status=${result.assignability.status}\n`,
					);
					if (result.assignability.compatibility.unsatisfied.length > 0) {
						for (const item of result.assignability.compatibility.unsatisfied) {
							process.stdout.write(`  unsatisfied: ${item.kind} = ${item.requirement}\n`);
						}
					}
				}
				return true;
			}

			case "accept": {
				const assignmentId = valueArgs(args)[2];
				const proof = proofFromArgs(args, assignmentId);
				if (!assignmentId || !proof) return missingProof();
				const outcome = await service.acceptAssignment(assignmentId, proof);
				if (json) printJson(outcome);
				else process.stdout.write(`accepted ${outcome.assignmentId} state=${outcome.state}\n`);
				return true;
			}

			case "start": {
				const assignmentId = valueArgs(args)[2];
				const proof = proofFromArgs(args, assignmentId);
				if (!assignmentId || !proof) return missingProof();
				const outcome = await startViaControl(service, assignmentId, proof);
				if (json) printJson(outcome);
				else {
					process.stdout.write(
						`started ${outcome.assignmentId} mission=${outcome.missionId} assignmentState=${outcome.assignmentState} missionState=${outcome.missionState} success=${outcome.success}\n`,
					);
				}
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

function missingId(what: string): boolean {
	process.stderr.write(`missing ${what}\n`);
	process.exitCode = 1;
	return true;
}

function missingProof(): boolean {
	process.stderr.write("missing runtime proof (--instance and --epoch are required)\n");
	process.exitCode = 1;
	return true;
}

function proofFromArgs(args: string[], executorIdFallback?: string): ExecutorRuntimeProof | undefined {
	const instance = flagValue(args, "--instance");
	const epochArg = flagValue(args, "--epoch");
	if (!instance || epochArg === undefined) return undefined;
	const epoch = Number(epochArg);
	if (!Number.isSafeInteger(epoch) || epoch < 1) return undefined;
	return { executorId: executorIdFallback ?? "", runtimeInstanceId: instance, runtimeEpoch: epoch };
}

/** Build the concrete child CLI launch and drive the assigned start. */
async function startViaControl(
	service: AssignmentControlService,
	assignmentId: string,
	proof: ExecutorRuntimeProof,
): Promise<Awaited<ReturnType<AssignmentControlService["startAssignedMission"]>>> {
	const current = await service.getAssignment(assignmentId);
	const cliEntry = process.argv[1];
	const command = process.execPath;
	const prefixArgs = [...process.execArgv, cliEntry];
	const sessionDir = defaultChildSessionDir(getAgentDir());

	return service.startAssignedMission(
		assignmentId,
		{ executorId: current.executorId, runtimeInstanceId: proof.runtimeInstanceId, runtimeEpoch: proof.runtimeEpoch },
		{
			buildResumeLaunch: ({ request, resumePrompt, childSessionId }) => {
				const launchArgs = [
					...prefixArgs,
					"--mode",
					"json",
					"-p",
					"--child-mission",
					current.missionId,
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
				return {
					command,
					args: launchArgs,
					cwd: request.workspaceScope?.cwd ?? process.cwd(),
					env: { JENSEN_MISSION_ID: request.missionId, JENSEN_ASSIGNMENT_ID: assignmentId },
				};
			},
		},
	);
}
