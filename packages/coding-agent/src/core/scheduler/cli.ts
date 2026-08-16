/**
 * Scheduler Foundation — CLI (2.12.0).
 *
 * `jensen scheduler list|show|enqueue|cancel|run|preview`
 *
 * Machine-readable `--json` exposes stable DTOs; human output is a compact
 * key: value block. `run` produces durable assignments; `preview` is a read-only
 * dry run. Neither executes missions.
 */

import chalk from "chalk";
import { getAgentDir } from "../../config.js";
import { AssignmentControlService } from "../assignment/assignment-control-service.js";
import type { MissionRequirements } from "../assignment/assignment-types.js";
import { createFileAssignmentStore } from "../assignment/file-assignment-store.js";
import { defaultChildSessionDir } from "../durable-child-session/index.js";
import { createFileExecutorRegistry, ExecutorControlService } from "../executor-registry/index.js";
import { createFileDurableMissionStore } from "../mission-durable/index.js";
import { createFileSchedulerStore } from "./file-scheduler-store.js";
import { SchedulerControlService } from "./scheduler-control-service.js";
import {
	type EnqueueSchedulingIntentOutcome,
	intentIdForMission,
	isSchedulingIntentState,
	type SchedulingIntentDetail,
	type SchedulingIntentListResult,
	type SchedulingIntentState,
	type SchedulingPolicy,
	type SchedulingTickResult,
} from "./scheduler-types.js";

const SUBCOMMANDS = new Set(["list", "show", "enqueue", "cancel", "run", "preview"]);

function buildService(policy?: SchedulingPolicy): SchedulerControlService {
	const missions = createFileDurableMissionStore();
	const executors = new ExecutorControlService({ store: createFileExecutorRegistry() });
	const assignments = new AssignmentControlService({
		store: createFileAssignmentStore(),
		missions,
		executors,
		sessionDir: defaultChildSessionDir(getAgentDir()),
	});
	return new SchedulerControlService({
		store: createFileSchedulerStore(),
		missions,
		executors,
		assignments,
		policy,
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

function policyFromArgs(args: string[]): SchedulingPolicy | undefined {
	const mode = flagValue(args, "--policy");
	if (mode === "least-assigned") return { mode: "least-assigned" };
	if (mode === "first-fit") return { mode: "first-fit" };
	return undefined;
}

function renderList(result: SchedulingIntentListResult): void {
	if (result.entries.length === 0 && result.corrupt.length === 0) {
		process.stdout.write("(no scheduling intents)\n");
		return;
	}
	for (const entry of result.entries) {
		process.stdout.write(
			[
				`${entry.intentId}  [${entry.state}]`,
				` mission=${entry.missionId}`,
				` priority=${entry.priority}`,
				entry.assignmentId ? ` assignment=${entry.assignmentId}` : "",
				entry.unschedulableReason ? ` reason=${entry.unschedulableReason}` : "",
			].join(""),
		);
		process.stdout.write("\n");
	}
	for (const corrupt of result.corrupt) {
		process.stdout.write(chalk.yellow(`${corrupt.intentId}  [CORRUPT] ${corrupt.diagnostic}\n`));
	}
}

function renderDetail(detail: SchedulingIntentDetail): void {
	process.stdout.write(`SCHEDULING INTENT\n`);
	process.stdout.write(`  intent: ${detail.intentId}\n`);
	process.stdout.write(`  mission: ${detail.missionId}\n`);
	process.stdout.write(`  state: ${detail.state}\n`);
	process.stdout.write(`  priority: ${detail.priority}\n`);
	if (detail.assignmentId) process.stdout.write(`  assignment: ${detail.assignmentId}\n`);
	if (detail.unschedulableReason) process.stdout.write(`  reason: ${detail.unschedulableReason}\n`);
	if (detail.requirements) {
		const req = detail.requirements;
		if (req.platform?.os) process.stdout.write(`  platform.os: ${req.platform.os}\n`);
		if (req.platform?.arch) process.stdout.write(`  platform.arch: ${req.platform.arch}\n`);
		if (req.execution?.length) process.stdout.write(`  execution: ${req.execution.join(", ")}\n`);
		if (req.providers?.length) process.stdout.write(`  providers: ${req.providers.join(", ")}\n`);
		if (req.models?.length) process.stdout.write(`  models: ${req.models.join(", ")}\n`);
		if (req.tools?.length) process.stdout.write(`  tools: ${req.tools.join(", ")}\n`);
		if (req.specialized?.length) process.stdout.write(`  specialized: ${req.specialized.join(", ")}\n`);
		if (req.labels?.required?.length) process.stdout.write(`  label.required: ${req.labels.required.join(", ")}\n`);
		if (req.labels?.excluded?.length) process.stdout.write(`  label.excluded: ${req.labels.excluded.join(", ")}\n`);
	}
}

function renderEnqueue(outcome: EnqueueSchedulingIntentOutcome): void {
	process.stdout.write(`${outcome.status} ${outcome.intentId} mission=${outcome.missionId} state=${outcome.state}\n`);
}

function renderTick(result: SchedulingTickResult): void {
	process.stdout.write(
		`${result.dryRun ? "preview" : "run"} ${result.runId} policy=${result.policy.mode} assigned=${result.intentsAssigned} unschedulable=${result.intentsUnschedulable} assignmentsCreated=${result.assignmentsCreated}\n`,
	);
	for (const decision of result.decisions) {
		const chosen = decision.eligibility.find((entry) => entry.chosen);
		process.stdout.write(
			[
				`  ${decision.intentId} ${decision.decision}`,
				decision.executorId ? ` executor=${decision.executorId}` : "",
				decision.assignmentId ? ` assignment=${decision.assignmentId}` : "",
				decision.reason ? ` reason=${decision.reason}` : "",
				chosen ? ` chosen=${chosen.executorId}` : "",
			].join(""),
		);
		process.stdout.write("\n");
	}
	for (const corrupt of result.corrupt) {
		process.stdout.write(chalk.yellow(`  ${corrupt.intentId} [CORRUPT] ${corrupt.diagnostic}\n`));
	}
}

// =============================================================================
// Handler
// =============================================================================

export function printSchedulerUsage(): string {
	return [
		"  scheduler list [--json] [--state S] [--limit N]",
		"  scheduler show <MISSION_ID_OR_INTENT_ID> [--json]",
		"  scheduler enqueue <MISSION_ID> [--json] [--priority N] [--os OS] [--arch A] [--execution C]... [--provider P]... [--model M]... [--tool T]... [--specialized S]... [--extra X]... [--label-required L]... [--label-excluded L]...",
		"  scheduler cancel <MISSION_ID> [--json]",
		"  scheduler preview [--json] [--policy first-fit|least-assigned]",
		"  scheduler run [--json] [--policy first-fit|least-assigned]",
	].join("\n");
}

export async function handleSchedulerCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "scheduler") return false;
	const sub = args[1];
	if (!sub || !SUBCOMMANDS.has(sub)) return false;

	const json = flag(args, "--json");
	const service = buildService(policyFromArgs(args));

	try {
		switch (sub) {
			case "list": {
				const stateArg = flagValue(args, "--state");
				const state: SchedulingIntentState | undefined =
					stateArg && isSchedulingIntentState(stateArg) ? stateArg : undefined;
				const limitArg = flagValue(args, "--limit");
				const result = await service.listIntents({
					filter: { state, missionId: flagValue(args, "--mission") },
					limit: limitArg !== undefined ? Number(limitArg) : undefined,
				});
				if (json) printJson(result);
				else renderList(result);
				return true;
			}

			case "show": {
				const raw = valueArgs(args)[2];
				if (!raw) return missingId();
				const intentId = raw.startsWith("intent_") ? raw : intentIdForMission(raw);
				const detail = await service.getIntent(intentId);
				if (json) printJson(detail);
				else renderDetail(detail);
				return true;
			}

			case "enqueue": {
				const missionId = valueArgs(args)[2];
				if (!missionId) return missingId();
				const priorityArg = flagValue(args, "--priority");
				const priority = priorityArg !== undefined ? Number(priorityArg) : undefined;
				const outcome = await service.enqueueIntent(missionId, {
					requirements: requirementsFromFlags(args),
					priority: Number.isSafeInteger(priority ?? 0) ? priority : undefined,
				});
				if (json) printJson(outcome);
				else renderEnqueue(outcome);
				return true;
			}

			case "cancel": {
				const missionId = valueArgs(args)[2];
				if (!missionId) return missingId();
				const record = await service.cancelIntent(missionId);
				if (json) printJson(record);
				else process.stdout.write(`cancelled ${record.intentId} state=${record.state}\n`);
				return true;
			}

			case "preview": {
				const result = await service.previewTick();
				if (json) printJson(result);
				else renderTick(result);
				return true;
			}

			case "run": {
				const result = await service.runTick();
				if (json) printJson(result);
				else renderTick(result);
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

function missingId(): boolean {
	process.stderr.write("missing mission id or intent id\n");
	process.exitCode = 1;
	return true;
}
