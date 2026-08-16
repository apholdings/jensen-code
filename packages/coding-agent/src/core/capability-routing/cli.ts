/**
 * Capability Routing — CLI (2.15.0).
 *
 * `jensen route preview|explain <MISSION_ID>`
 *
 * Deterministic, read-only routing preview. Never creates an Assignment, never
 * executes work, and never mutates a store. `preview` emits the stable DTO;
 * `explain` renders why each route is eligible/rejected. Inference routing is
 * out of scope.
 */

import chalk from "chalk";
import { getAgentDir } from "../../config.js";
import { AssignmentControlService } from "../assignment/assignment-control-service.js";
import type { MissionRequirements } from "../assignment/assignment-types.js";
import { createFileAssignmentStore } from "../assignment/file-assignment-store.js";
import { defaultChildSessionDir } from "../durable-child-session/index.js";
import { createFileExecutorRegistry, ExecutorControlService } from "../executor-registry/index.js";
import { createFileDurableMissionStore } from "../mission-durable/index.js";
import {
	createFileRemoteTargetRegistry,
	RemoteTargetRegistry,
	SshRemoteExecutionTransport,
} from "../remote-execution/index.js";
import { createFileSchedulerStore, SchedulerControlService } from "../scheduler/index.js";
import { CapabilityRouter } from "./capability-router.js";
import type { RouteCandidate, RoutingEvaluation } from "./route-types.js";

const SUBCOMMANDS = new Set(["preview", "explain"]);

function buildServices(): { router: CapabilityRouter; scheduler: SchedulerControlService } {
	const missions = createFileDurableMissionStore();
	const executors = new ExecutorControlService({ store: createFileExecutorRegistry() });
	const assignments = new AssignmentControlService({
		store: createFileAssignmentStore(),
		missions,
		executors,
		sessionDir: defaultChildSessionDir(getAgentDir()),
	});
	const targets = new RemoteTargetRegistry({
		store: createFileRemoteTargetRegistry(),
		transport: new SshRemoteExecutionTransport(),
	});
	const router = new CapabilityRouter({ executors, targets });
	const scheduler = new SchedulerControlService({
		store: createFileSchedulerStore(),
		missions,
		executors,
		assignments,
	});
	return { router, scheduler };
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

function requirementsFromFlags(args: string[]): MissionRequirements | undefined {
	const requirements: MissionRequirements = {};
	const os = flagValue(args, "--os");
	const arch = flagValue(args, "--arch");
	const mode = flagValue(args, "--mode");
	const execution = flagValues(args, "--execution");
	const providers = flagValues(args, "--provider");
	const models = flagValues(args, "--model");
	const tools = flagValues(args, "--tool");
	const specialized = flagValues(args, "--specialized");
	const extra = flagValues(args, "--extra");
	const requiredLabels = flagValues(args, "--label-required");
	const excludedLabels = flagValues(args, "--label-excluded");
	const preferMode = flagValue(args, "--prefer-mode");
	const preferExecutor = flagValue(args, "--prefer-executor");
	const preferTarget = flagValue(args, "--prefer-target");

	if (os || arch) requirements.platform = { os, arch };
	if (mode === "local" || mode === "remote") requirements.executionMode = mode;
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
	if (preferMode === "local" || preferMode === "remote" || preferExecutor || preferTarget) {
		requirements.preferences = {
			executionMode: preferMode === "local" || preferMode === "remote" ? preferMode : undefined,
			executorId: preferExecutor,
			remoteTargetId: preferTarget,
		};
	}
	return Object.keys(requirements).length > 0 ? requirements : undefined;
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

function renderCandidate(candidate: RouteCandidate): void {
	const marker = candidate.eligible
		? chalk.green("ELIGIBLE")
		: candidate.status.startsWith("UNAVAILABLE")
			? chalk.yellow(candidate.status)
			: chalk.red(candidate.status);
	const mode = `${candidate.executionMode}${candidate.remoteTargetId ? ` (target=${candidate.remoteTargetId})` : ""}`;
	process.stdout.write(`  ${candidate.executorId}  [${marker}]  mode=${mode}`);
	if (candidate.platform) process.stdout.write(`  platform=${candidate.platform}/${candidate.arch ?? "?"}`);
	if (candidate.workerStatus !== "ONLINE") process.stdout.write(`  worker=${candidate.workerStatus}`);
	if (candidate.targetHealth) process.stdout.write(`  target=${candidate.targetHealth.status}`);
	process.stdout.write("\n");
	for (const reason of candidate.rejectionReasons) {
		process.stdout.write(`    - ${reason}\n`);
	}
	if (candidate.preferenceReasons.length > 0) {
		process.stdout.write(
			`    prefer (score=${candidate.preferenceScore}): ${candidate.preferenceReasons.join("; ")}\n`,
		);
	}
}

function renderEvaluation(evaluation: RoutingEvaluation): void {
	const req = evaluation.requirements;
	process.stdout.write(`ROUTING PREVIEW${evaluation.missionId ? ` (mission=${evaluation.missionId})` : ""}\n`);
	process.stdout.write(`  eligible=${evaluation.eligibleCount}/${evaluation.candidates.length}\n`);
	if (req.platform?.os) process.stdout.write(`  platform.os: ${req.platform.os}\n`);
	if (req.platform?.arch) process.stdout.write(`  platform.arch: ${req.platform.arch}\n`);
	if (req.executionMode) process.stdout.write(`  executionMode: ${req.executionMode}\n`);
	if (req.execution?.length) process.stdout.write(`  execution: ${req.execution.join(", ")}\n`);
	if (req.specialized?.length) process.stdout.write(`  specialized: ${req.specialized.join(", ")}\n`);
	if (req.preferences) process.stdout.write(`  preferences: ${JSON.stringify(req.preferences)}\n`);
	for (const candidate of evaluation.candidates) renderCandidate(candidate);
	for (const corrupt of evaluation.corrupt) {
		process.stdout.write(chalk.yellow(`  ${corrupt.executorId} [CORRUPT] ${corrupt.diagnostic}\n`));
	}
	for (const corrupt of evaluation.targetCorrupt) {
		process.stdout.write(chalk.yellow(`  target ${corrupt.targetId} [CORRUPT] ${corrupt.diagnostic}\n`));
	}
}

export function printRouteUsage(): string {
	return [
		"  route preview <MISSION_ID> [--json] [--os OS] [--arch A] [--mode local|remote] [--execution C]... [--specialized S]... [--prefer-mode local|remote] [--prefer-executor E] [--prefer-target T]",
		"  route explain <MISSION_ID> [--json] [same flags]",
	].join("\n");
}

export async function handleRouteCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "route") return false;
	const sub = args[1];
	if (!sub || !SUBCOMMANDS.has(sub)) return false;

	const missionId = valueArgs(args)[2];
	if (!missionId) {
		process.stderr.write("missing mission id\n");
		process.exitCode = 1;
		return true;
	}

	const json = flag(args, "--json");
	const { router, scheduler } = buildServices();

	try {
		let requirements = requirementsFromFlags(args);
		if (requirements === undefined) {
			// Reuse the scheduling intent's structured requirements when present.
			try {
				const intent = await scheduler.getIntentForMission(missionId);
				requirements = intent.requirements ?? {};
			} catch {
				requirements = {};
			}
		}

		const evaluation = await router.evaluate({ requirements, missionId });
		if (json) printJson(evaluation);
		else renderEvaluation(evaluation);
		return true;
	} catch (error) {
		renderError(error);
		process.exitCode = 1;
		return true;
	}
}
