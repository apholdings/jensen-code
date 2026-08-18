/**
 * Remote Execution — remote resume builder (2.14.0 → 3.0.0 bridge).
 *
 * Builds a `RemoteMissionExecutor` for a resolved durable child session, mirroring
 * `buildChildResumeExecutor` but with a remote transport instead of local spawn.
 * With the synchronised modern runtime, the remote child uses the durable
 * `--child-mission` / `--session-id` path: the SAME child session file is
 * materialised onto the target and the child continues the SAME logical mission
 * (continue-not-replay), never an unrelated subordinate session.
 */

import { readFileSync } from "node:fs";
import type { BuildAssignedExecutor } from "../assignment/assignment-control-service.js";
import { type BuiltChildResume, buildChildResumePrompt } from "../durable-child-session/child-session-restore.js";
import type { DurableMissionRecord } from "../mission-domain/durable-store.js";
import type { ProcessMissionVerifier } from "../mission-domain/process-mission-executor.js";
import type { SessionManager } from "../session-manager.js";
import { RemoteMissionExecutor, type RemoteMissionExecutorOptions } from "./remote-mission-executor.js";
import type { RemoteExecutionTarget } from "./remote-target-types.js";
import type { RemoteChildLaunch, RemoteCommandRunner, RemoteExecutionTransport } from "./remote-transport.js";

/**
 * Legacy projection prompt (kept for the explicitly-flagged temporary mode only;
 * never used by ordinary orchestration once a synchronised runtime is present).
 */
export function buildRemoteTaskPrompt(record: DurableMissionRecord): string {
	const criteria = record.request.acceptanceCriteria
		.map((criterion) => `- ${criterion.id}: ${criterion.description}`)
		.join("\n");
	return [
		"<remote-execution-task>",
		`You are executing durable mission ${record.missionId} on a remote execution target.`,
		"Complete the objective using the available tools, operating on the files in the current working directory.",
		"Before finishing, satisfy the acceptance criteria by running the stated verification yourself.",
		"</remote-execution-task>",
		"",
		`Objective: ${record.request.objective}`,
		"",
		"Acceptance criteria:",
		criteria.length > 0 ? criteria : "(none)",
	].join("\n");
}

export interface BuildRemoteChildResumeOptions {
	record: DurableMissionRecord;
	childSessionId: string;
	target: RemoteExecutionTarget;
	transport: RemoteExecutionTransport & RemoteCommandRunner;
	/** Resolved session manager (enables the modern durable child-session path). */
	sessionManager?: SessionManager;
	/** Override the materialised child session file content (else read from the session manager). */
	sessionFileContent?: string;
	/** Concrete remote child launch (remote jensen CLI command). */
	buildRemoteLaunch: (input: {
		request: DurableMissionRecord["request"];
		resumePrompt: string;
		childSessionId: string;
		workspaceDir: string;
		agentDir: string;
		sessionDir: string;
	}) => RemoteChildLaunch;
	/** Materialised remote models.json content (ephemeral protected config). */
	modelsJson: string;
	/** Absolute remote temp root for execution-scoped workspaces. */
	remoteTempRoot: string;
	/** Remote-relative files to hash before/after (location proof). */
	evidenceFiles?: string[];
	/** Initial workspace files to materialise on the target (remote-relative). */
	workspaceFiles?: (request: DurableMissionRecord["request"]) => { path: string; content: string }[];
	executorId?: string;
	verifier?: ProcessMissionVerifier;
	/** Shared-inference admission wiring (reverse tunnel + token issuer). */
	admission?: RemoteMissionExecutorOptions["admission"];
	/** Remote execution timeout (ms). */
	timeoutMs?: number;
}

/**
 * Build the continue-not-replay remote executor from a resolved session. When a
 * `sessionManager` is supplied, the remote child resumes the SAME durable
 * child session via `--child-mission` / `--session-id`.
 */
export function buildRemoteChildResumeExecutor(options: BuildRemoteChildResumeOptions): BuiltChildResume {
	const { record, childSessionId } = options;
	const resumePrompt = options.sessionManager
		? buildChildResumePrompt(record, options.sessionManager)
		: buildRemoteTaskPrompt(record);

	let sessionFileContent = options.sessionFileContent;
	if (sessionFileContent === undefined && options.sessionManager) {
		const sessionFile = options.sessionManager.getSessionFile();
		if (sessionFile) sessionFileContent = readFileSync(sessionFile, "utf8");
	}

	const executor = new RemoteMissionExecutor({
		executorId: options.executorId ?? "remote-child-resume",
		target: options.target,
		transport: options.transport,
		buildRemoteLaunch: ({ request, workspaceDir, agentDir, sessionDir }) =>
			options.buildRemoteLaunch({ request, resumePrompt, childSessionId, workspaceDir, agentDir, sessionDir }),
		workspaceFiles: options.workspaceFiles,
		modelsJson: options.modelsJson,
		childSessionId,
		sessionFileContent,
		remoteTempRoot: options.remoteTempRoot,
		evidenceFiles: options.evidenceFiles,
		verifier: options.verifier,
		admission: options.admission,
		timeoutMs: options.timeoutMs,
	});

	return { childSessionId, resumePrompt, executor };
}

// =============================================================================
// Worker-facing remote executor builder
// =============================================================================

export interface BuildRemoteAssignedExecutorOptions {
	executorId: string;
	target: RemoteExecutionTarget;
	transport: RemoteExecutionTransport & RemoteCommandRunner;
	/** Absolute path to the synchronised remote Jensen CLI JS entry. */
	remoteCliEntry: string;
	/** Materialised remote models.json content (ephemeral protected config). */
	modelsJson: string;
	/** Absolute remote temp root for execution-scoped workspaces. */
	remoteTempRoot: string;
	/** Remote-relative files to hash before/after (location proof). */
	evidenceFiles?: string[];
	/** Initial workspace files to materialise on the target (remote-relative). */
	workspaceFiles?: (request: DurableMissionRecord["request"]) => { path: string; content: string }[];
	verifier?: ProcessMissionVerifier;
	/** Shared-inference admission wiring (reverse tunnel + token issuer). */
	admission?: RemoteMissionExecutorOptions["admission"];
	/** Remote execution timeout (ms). */
	timeoutMs?: number;
}

/**
 * Build the worker's remote executor factory for a remote-bound executor. The
 * returned `BuildAssignedExecutor` produces a `RemoteMissionExecutor` that runs
 * the synchronised current Jensen CLI on the target with the materialised agent
 * dir and the durable child-session path.
 */
export function buildRemoteAssignedExecutor(options: BuildRemoteAssignedExecutorOptions): BuildAssignedExecutor {
	return ({ record, sessionManager, childSessionId, assignmentId }) => {
		return buildRemoteChildResumeExecutor({
			record,
			childSessionId,
			sessionManager,
			target: options.target,
			transport: options.transport,
			modelsJson: options.modelsJson,
			remoteTempRoot: options.remoteTempRoot,
			evidenceFiles: options.evidenceFiles,
			workspaceFiles: options.workspaceFiles,
			executorId: options.executorId,
			verifier: options.verifier,
			admission: options.admission,
			timeoutMs: options.timeoutMs,
			buildRemoteLaunch: ({
				request,
				resumePrompt,
				childSessionId: sessionId,
				sessionDir,
				agentDir,
			}): RemoteChildLaunch => {
				const args: string[] = [
					options.remoteCliEntry,
					"--mode",
					"json",
					"-p",
					"--child-mission",
					record.missionId,
					"--session-id",
					sessionId,
					"--session-dir",
					sessionDir,
				];
				if (request.modelPolicy) {
					args.push("--provider", request.modelPolicy.provider, "--model", request.modelPolicy.model);
				}
				if (request.capabilities && request.capabilities.length > 0) {
					args.push("--tools", request.capabilities.join(","));
				}
				args.push(resumePrompt);
				return {
					command: "node",
					args,
					cwd: "", // overridden by the executor to the execution workspace
					env: {
						JENSEN_CODING_AGENT_DIR: agentDir,
						JENSEN_CODE_CODING_AGENT_DIR: agentDir,
						PI_CODING_AGENT_DIR: agentDir,
						JENSEN_MISSION_ID: request.missionId,
						JENSEN_ASSIGNMENT_ID: assignmentId,
						JENSEN_SESSION_ID: sessionId,
						...(request.orchestration?.priority !== undefined
							? { JENSEN_INFERENCE_PRIORITY: String(request.orchestration.priority) }
							: {}),
						...(request.orchestration?.dependencyCriticality !== undefined
							? { JENSEN_INFERENCE_UNBLOCKS: String(request.orchestration.dependencyCriticality) }
							: {}),
						...(request.orchestration?.verification ? { JENSEN_INFERENCE_VERIFICATION: "1" } : {}),
					},
				};
			},
		});
	};
}
