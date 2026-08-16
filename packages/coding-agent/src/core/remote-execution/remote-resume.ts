/**
 * Remote Execution — remote resume builder (2.14.0).
 *
 * Builds a `RemoteMissionExecutor` for a resolved durable child session, mirroring
 * `buildChildResumeExecutor` but with a remote transport instead of local spawn.
 * The same `resumePrompt` + child session identity are reused, and the session
 * file is materialised onto the target so the remote child continues the SAME
 * logical execution rather than starting an unrelated one.
 */

import type { BuildAssignedExecutor } from "../assignment/assignment-control-service.js";
import type { BuiltChildResume } from "../durable-child-session/child-session-restore.js";
import type { DurableMissionRecord } from "../mission-domain/durable-store.js";
import type { ProcessMissionVerifier } from "../mission-domain/process-mission-executor.js";
import { RemoteMissionExecutor } from "./remote-mission-executor.js";
import type { RemoteExecutionTarget } from "./remote-target-types.js";
import type { RemoteChildLaunch, RemoteCommandRunner, RemoteExecutionTransport } from "./remote-transport.js";

/**
 * Build the prompt the remote child receives. The remote published runtime may
 * not support the local durable `--child-mission` resume flags, so the remote
 * substrate runs a temporary subordinate session driven by the immutable
 * objective + acceptance criteria. The central mission identity remains the
 * authority; this prompt is a projection, not a new mission.
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
}

/**
 * Build the continue-not-replay remote executor from a resolved session. The
 * returned shape matches `BuiltChildResume`, so the assignment control plane
 * treats remote and local executors identically downstream.
 */
export function buildRemoteChildResumeExecutor(options: BuildRemoteChildResumeOptions): BuiltChildResume {
	const { record, childSessionId } = options;
	const resumePrompt = buildRemoteTaskPrompt(record);

	const executor = new RemoteMissionExecutor({
		executorId: options.executorId ?? "remote-child-resume",
		target: options.target,
		transport: options.transport,
		buildRemoteLaunch: ({ request, workspaceDir, agentDir, sessionDir }) =>
			options.buildRemoteLaunch({ request, resumePrompt, childSessionId, workspaceDir, agentDir, sessionDir }),
		workspaceFiles: options.workspaceFiles,
		modelsJson: options.modelsJson,
		remoteTempRoot: options.remoteTempRoot,
		evidenceFiles: options.evidenceFiles,
		verifier: options.verifier,
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
	/** Absolute path to the remote Jensen CLI JS entry (e.g. the global install). */
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
}

/**
 * Build the worker's remote executor factory for a remote-bound executor. The
 * returned `BuildAssignedExecutor` produces a `RemoteMissionExecutor` that runs
 * the real Jensen CLI on the target with the materialised agent dir.
 */
export function buildRemoteAssignedExecutor(options: BuildRemoteAssignedExecutorOptions): BuildAssignedExecutor {
	return ({ record, childSessionId }) => {
		return buildRemoteChildResumeExecutor({
			record,
			childSessionId,
			target: options.target,
			transport: options.transport,
			modelsJson: options.modelsJson,
			remoteTempRoot: options.remoteTempRoot,
			evidenceFiles: options.evidenceFiles,
			workspaceFiles: options.workspaceFiles,
			executorId: options.executorId,
			verifier: options.verifier,
			buildRemoteLaunch: ({ request, resumePrompt, sessionDir, agentDir }): RemoteChildLaunch => {
				const args: string[] = [options.remoteCliEntry, "--mode", "json", "-p", "--session-dir", sessionDir];
				if (request.modelPolicy) {
					args.push("--provider", request.modelPolicy.provider, "--model", request.modelPolicy.model);
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
					},
				};
			},
		});
	};
}
