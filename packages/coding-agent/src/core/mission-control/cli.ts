/**
 * Mission Control Plane — CLI (2.9.0).
 *
 * `jensen mission list|show|tree|attempts|ownership|result|evidence|resume|cancel|recover`
 *
 * This is the durable-mission operator surface. It routes through
 * MissionControlService rather than touching stores/session files directly, and
 * supports `--json` for stable machine-readable DTO output. Human output is a
 * compact key: value block, never a raw JSON dump by default.
 */

import chalk from "chalk";
import { getAgentDir } from "../../config.js";
import { defaultChildSessionDir } from "../durable-child-session/index.js";
import { isMissionState, type MissionState } from "../mission-domain/mission-state.js";
import { createFileDurableMissionStore } from "../mission-durable/index.js";
import { MissionControlService } from "./mission-control-service.js";
import type {
	MissionCancellationView,
	MissionControlResumeOutcome,
	MissionDetail,
	MissionListResult,
	MissionOwnershipView,
	MissionResultView,
	MissionTreeNode,
} from "./mission-control-types.js";

const CONTROL_SUBCOMMANDS = new Set([
	"list",
	"show",
	"tree",
	"attempts",
	"ownership",
	"result",
	"evidence",
	"resume",
	"cancel",
	"recover",
]);

function buildService(): MissionControlService {
	const store = createFileDurableMissionStore();
	return new MissionControlService({ store, sessionDir: defaultChildSessionDir(getAgentDir()) });
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

// =============================================================================
// Human renderers
// =============================================================================

function renderList(result: MissionListResult): void {
	if (result.entries.length === 0 && result.corrupt.length === 0) {
		process.stdout.write("(no missions)\n");
		return;
	}
	for (const entry of result.entries) {
		process.stdout.write(
			[
				`${entry.missionId}  [${entry.state}]`,
				entry.parentMissionId ? ` parent=${entry.parentMissionId}` : "",
				entry.childSessionId ? ` session=${entry.childSessionId}` : "",
				` attempts=${entry.attemptCount}`,
				` fence=${entry.fencingToken}`,
				entry.owned ? ` owned (${entry.leaseStatus})` : "",
				entry.resumable ? " resumable" : "",
			].join(""),
		);
		process.stdout.write("\n");
	}
	for (const corrupt of result.corrupt) {
		process.stdout.write(chalk.yellow(`${corrupt.missionId}  [CORRUPT] ${corrupt.diagnostic}\n`));
	}
}

function renderDetail(detail: MissionDetail): void {
	const s = detail.summary;
	process.stdout.write(`MISSION\n`);
	process.stdout.write(`  id: ${s.missionId}\n`);
	process.stdout.write(`  state: ${s.state}\n`);
	if (s.parentMissionId) process.stdout.write(`  parent: ${s.parentMissionId}\n`);
	if (s.childSessionId) process.stdout.write(`  session: ${s.childSessionId}\n`);
	process.stdout.write(`  depth: ${s.depth}\n`);
	process.stdout.write(`  attempts: ${s.attemptCount}\n`);
	process.stdout.write(`  fence: ${s.fencingToken}\n`);
	process.stdout.write(`  terminal: ${s.terminal ? "yes" : "no"}\n`);
	process.stdout.write(`  resumable: ${s.resumable ? "yes" : "no"}\n`);
	if (s.verificationStatus) process.stdout.write(`  verification: ${s.verificationStatus}\n`);
	process.stdout.write(`OWNERSHIP\n`);
	process.stdout.write(`  owned: ${detail.ownership.owned ? "yes" : "no"}\n`);
	process.stdout.write(`  fence: ${detail.ownership.fencingToken}\n`);
	if (detail.ownership.ownerId) process.stdout.write(`  owner: ${detail.ownership.ownerId}\n`);
	if (detail.ownership.expiresAtMs) process.stdout.write(`  expires: ${detail.ownership.expiresAtMs}\n`);
	process.stdout.write(`  lease: ${detail.ownership.leaseStatus}\n`);
	if (detail.result.available) process.stdout.write(`RESULT\n  state: ${detail.result.result?.state}\n`);
	if (detail.children.length > 0) process.stdout.write(`CHILDREN\n  ${detail.children.join(", ")}\n`);
}

function renderTree(node: MissionTreeNode, prefix = ""): void {
	process.stdout.write(
		`${prefix}${node.missionId}  [${node.state}]  fence=${node.ownership.fencingToken}${node.ownership.owned ? " (owned)" : ""}\n`,
	);
	for (let i = 0; i < node.children.length; i++) {
		const last = i === node.children.length - 1;
		renderTree(node.children[i], `${prefix}${last ? "  └── " : "  ├── "}`);
	}
}

function renderOwnership(view: MissionOwnershipView): void {
	process.stdout.write(`OWNERSHIP\n`);
	process.stdout.write(`  owned: ${view.owned ? "yes" : "no"}\n`);
	process.stdout.write(`  lease: ${view.leaseStatus}\n`);
	process.stdout.write(`  fence: ${view.fencingToken}\n`);
	if (view.ownerId) process.stdout.write(`  owner: ${view.ownerId}\n`);
	if (view.leaseId) process.stdout.write(`  leaseId: ${view.leaseId}\n`);
	if (view.expiresAtMs) process.stdout.write(`  expires: ${view.expiresAtMs}\n`);
	if (view.remainingMs !== undefined) process.stdout.write(`  remaining: ${view.remainingMs}ms\n`);
	if (view.localRuntime?.heartbeatTelemetry) {
		process.stdout.write(`  local heartbeat: renewals=${view.localRuntime.heartbeatTelemetry.renewalCount}\n`);
	}
}

function renderResult(view: MissionResultView): void {
	if (!view.available || !view.result) {
		process.stdout.write("no terminal result\n");
		return;
	}
	process.stdout.write(`RESULT\n`);
	process.stdout.write(`  state: ${view.result.state}\n`);
	process.stdout.write(`  execution: ${view.result.executionOutcome}\n`);
	process.stdout.write(`  verification: ${view.result.verification.status}\n`);
	if (view.resultExecutionId) process.stdout.write(`  executionId: ${view.resultExecutionId}\n`);
}

function renderResume(outcome: MissionControlResumeOutcome): void {
	process.stdout.write(
		[
			`resumed ${outcome.missionId}`,
			`state=${outcome.missionState}`,
			`attempt=${outcome.attemptId}`,
			`fence=${outcome.fencingToken}`,
			`success=${outcome.success}`,
		].join(" "),
	);
	process.stdout.write("\n");
}

function renderCancel(view: MissionCancellationView): void {
	process.stdout.write(
		[
			`cancel ${view.missionId}`,
			`status=${view.status}`,
			`executorConfirmedStopped=${view.executorConfirmedStopped}`,
			view.reason ? `reason=${view.reason}` : "",
		]
			.filter(Boolean)
			.join(" "),
	);
	process.stdout.write("\n");
}

// =============================================================================
// Handler
// =============================================================================

export function printMissionControlUsage(): string {
	return [
		"  mission list [--json] [--state S] [--parent ID] [--terminal|--nonterminal] [--interrupted] [--owned|--unowned] [--resumable|--not-resumable] [--limit N]",
		"  mission show <MISSION_ID> [--json]",
		"  mission tree <MISSION_ID> [--json]",
		"  mission attempts <MISSION_ID> [--json]",
		"  mission ownership <MISSION_ID> [--json]",
		"  mission result <MISSION_ID> [--json]",
		"  mission evidence <MISSION_ID> [--json]",
		"  mission resume <MISSION_ID> [--json]",
		"  mission cancel <MISSION_ID> [--json]",
		"  mission recover [--json]",
	].join("\n");
}

export async function handleMissionControlCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "mission") return false;
	const sub = args[1];
	if (!sub || !CONTROL_SUBCOMMANDS.has(sub)) return false;

	const json = flag(args, "--json");
	const service = buildService();

	try {
		switch (sub) {
			case "list": {
				const limitArg = flagValue(args, "--limit");
				const depthArg = flagValue(args, "--depth");
				const stateArg = flagValue(args, "--state");
				const state: MissionState | undefined = stateArg && isMissionState(stateArg) ? stateArg : undefined;
				const depth = depthArg !== undefined ? Number(depthArg) : undefined;
				const result = await service.listMissions({
					filter: {
						state,
						parentMissionId: flagValue(args, "--parent"),
						terminal: flag(args, "--terminal") ? true : flag(args, "--nonterminal") ? false : undefined,
						interrupted: flag(args, "--interrupted") ? true : undefined,
						owned: flag(args, "--owned") ? true : flag(args, "--unowned") ? false : undefined,
						resumable: flag(args, "--resumable") ? true : flag(args, "--not-resumable") ? false : undefined,
						depth: depth !== undefined && Number.isSafeInteger(depth) ? depth : undefined,
					},
					limit: limitArg !== undefined ? Number(limitArg) : undefined,
				});
				if (json) printJson(result);
				else renderList(result);
				return true;
			}

			case "show": {
				const missionId = valueArgs(args)[2];
				if (!missionId) return missingMissionId();
				const detail = await service.getMission(missionId);
				if (json) printJson(detail);
				else renderDetail(detail);
				return true;
			}

			case "tree": {
				const missionId = valueArgs(args)[2];
				if (!missionId) return missingMissionId();
				const tree = await service.getMissionTree(missionId);
				if (json) printJson(tree);
				else renderTree(tree);
				return true;
			}

			case "attempts": {
				const missionId = valueArgs(args)[2];
				if (!missionId) return missingMissionId();
				const attempts = await service.getAttempts(missionId);
				if (json) printJson(attempts);
				else {
					for (const attempt of attempts.attempts) {
						process.stdout.write(
							`${attempt.attemptId}${attempt.executionId ? ` exec=${attempt.executionId}` : ""} started=${attempt.startedAtMs}${attempt.endReason ? ` end=${attempt.endReason}` : ""}\n`,
						);
					}
					if (attempts.currentAttemptId) process.stdout.write(`current=${attempts.currentAttemptId}\n`);
					if (attempts.resultExecutionId) process.stdout.write(`resultExecution=${attempts.resultExecutionId}\n`);
				}
				return true;
			}

			case "ownership": {
				const missionId = valueArgs(args)[2];
				if (!missionId) return missingMissionId();
				const ownership = await service.getOwnership(missionId);
				if (json) printJson(ownership);
				else renderOwnership(ownership);
				return true;
			}

			case "result": {
				const missionId = valueArgs(args)[2];
				if (!missionId) return missingMissionId();
				const result = await service.getResult(missionId);
				if (json) printJson(result);
				else renderResult(result);
				return true;
			}

			case "evidence": {
				const missionId = valueArgs(args)[2];
				if (!missionId) return missingMissionId();
				const refs = await service.getEvidenceRefs(missionId);
				if (json) printJson(refs);
				else {
					if (refs.length === 0) process.stdout.write("(no evidence references)\n");
					for (const ref of refs) {
						process.stdout.write(
							`${ref.evidenceId}${ref.available === undefined ? "" : ref.available ? " available" : " missing"}\n`,
						);
					}
				}
				return true;
			}

			case "resume": {
				const missionId = valueArgs(args)[2];
				if (!missionId) return missingMissionId();
				const outcome = await resumeViaControl(service, missionId);
				if (json) printJson(outcome);
				else renderResume(outcome);
				return true;
			}

			case "cancel": {
				const missionId = valueArgs(args)[2];
				if (!missionId) return missingMissionId();
				const view = await service.cancelMission(missionId);
				if (json) printJson(view);
				else renderCancel(view);
				return true;
			}

			case "recover": {
				const report = await service.recoverMission();
				if (json) printJson(report);
				else {
					for (const action of report.actions) process.stdout.write(`${action}\n`);
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

function missingMissionId(): boolean {
	process.stderr.write("missing mission id\n");
	process.exitCode = 1;
	return true;
}

/** Build the concrete child CLI launch and resume through Mission Control. */
async function resumeViaControl(
	service: MissionControlService,
	missionId: string,
): Promise<MissionControlResumeOutcome> {
	const cliEntry = process.argv[1];
	const command = process.execPath;
	const prefixArgs = [...process.execArgv, cliEntry];
	const sessionDir = defaultChildSessionDir(getAgentDir());

	return service.resumeMission(missionId, {
		buildResumeLaunch: ({ request, resumePrompt, childSessionId }) => {
			const launchArgs = [
				...prefixArgs,
				"--mode",
				"json",
				"-p",
				"--child-mission",
				missionId,
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
				env: { JENSEN_MISSION_ID: request.missionId },
			};
		},
	});
}
