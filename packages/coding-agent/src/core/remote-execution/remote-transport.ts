/**
 * Remote Execution — transport port (2.14.0).
 *
 * A transport-independent remote execution seam. SSH is the first transport;
 * future transports (container, cloud worker, ...) implement the same contract.
 * The port is platform-neutral: target-specific command building lives in the
 * concrete SSH implementation, never in this interface or in the mission
 * executor.
 */

import type { RemoteExecutionTarget, RemoteTargetHealth } from "./remote-target-types.js";

// =============================================================================
// Launch spec
// =============================================================================

/**
 * A concrete remote child launch. `argv` is an argument vector (never a shell
 * string) so untrusted mission data is never concatenated into a shell.
 */
export interface RemoteChildLaunch {
	command: string;
	args: readonly string[];
	cwd: string;
	env?: Record<string, string | undefined>;
}

/** Everything needed to materialise + start one remote execution. */
export interface RemoteLaunchSpec {
	executionId: string;
	launchId: string;
	remoteTargetId: string;
	/** Fencing identity carried for correlation; the durable authority stays central. */
	fencing?: { leaseId: string; fencingToken: number };
	/** Remote temp root for the execution-scoped workspace (already resolved). */
	workspaceDir: string;
	/** The remote agent directory to materialise (models.json, child-sessions, ...). */
	agentDir: string;
	/** Remote models.json content (ephemeral protected config; cleaned up after). */
	modelsJson: string;
	/** Remote session file content keyed by childSessionId. */
	childSessionId?: string;
	sessionFileContent?: string;
	/** Initial workspace files to materialise (remote-relative to workspaceDir). */
	workspaceFiles?: { path: string; contentB64: string }[];
	/** The actual child launch to run remotely. */
	launch: RemoteChildLaunch;
	/** Protocol runner heartbeat interval (ms). */
	heartbeatMs?: number;
	/** Bounded execution timeout (ms). */
	timeoutMs?: number;
	/** Remote-relative files to hash before/after execution (location proof). */
	evidenceFiles?: string[];
	/** Optional framing/adapter callback hooks for tests and observability. */
	callbacks?: {
		onFrame?: (frame: { type: string; payload: unknown }) => void;
	};
}

// =============================================================================
// Events + handle
// =============================================================================

export interface RemoteTransportEvent {
	type:
		| "connected"
		| "launch_acknowledged"
		| "remote_started"
		| "remote_active"
		| "frame"
		| "remote_result"
		| "remote_exit"
		| "transport_closed"
		| "transport_error"
		| "timeout"
		| "cancelled";
	payload?: unknown;
	atMs: number;
}

export interface RemoteTransportOutcome {
	exitCode: number | null;
	signal?: string;
	cancelled?: boolean;
	timedOut?: boolean;
	launchError?: string;
	/** Bounded raw child stdout (already framed during streaming). */
	stdout: string;
	stderr: string;
	/** Location + evidence proof emitted by the remote runner. */
	location?: {
		host: string;
		user: string;
		cwd: string;
		pid: number;
		platform: string;
	};
	evidence?: unknown[];
	/** Whether the runner produced a structured result frame. */
	remoteResult?: { success: boolean; summary?: string };
	/** Last structured transport error code, if any. */
	errorCode?: string;
}

export interface RemoteExecutionHandle {
	executionId: string;
	launchId: string;
	outcomePromise: Promise<RemoteTransportOutcome>;
	cancel: (reason?: string) => Promise<void>;
}

export interface RemoteTransportProbeOptions {
	signal?: AbortSignal;
}

export interface RemoteTransportLaunchOptions {
	signal?: AbortSignal;
}

/** Narrow command runner shared by the SSH transport and remote verification. */
export interface RemoteCommandRunner {
	runCommand(
		target: RemoteExecutionTarget,
		command: string,
		cwd: string,
		options?: { timeoutMs?: number; signal?: AbortSignal },
	): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut?: boolean; launchError?: string }>;
}

// =============================================================================
// Port
// =============================================================================

export interface RemoteExecutionTransport {
	readonly transportId: string;

	/** Non-mutating reachability/auth/runtime probe. Never fabricates health. */
	probe(target: RemoteExecutionTarget, options?: RemoteTransportProbeOptions): Promise<RemoteTargetHealth>;

	/**
	 * Materialise + start a remote execution. Returns a handle immediately after
	 * the remote child is acknowledged, without waiting for terminal state.
	 * The transport must not close without a terminal result signalling success.
	 */
	launch(
		target: RemoteExecutionTarget,
		spec: RemoteLaunchSpec,
		options?: RemoteTransportLaunchOptions,
	): Promise<RemoteExecutionHandle>;
}
