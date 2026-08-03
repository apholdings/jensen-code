/**
 * Durable background-job subsystem types.
 *
 * A Jensen-started job is owned through authoritative process lifecycle
 * primitives: process-group (POSIX) / process-tree (Windows) ownership, PID
 * reuse protection via start-time + command identity, idempotent stop, and
 * conservative adoption that never matches on PID/name alone.
 */

export type BackgroundJobState =
	| "starting"
	| "running"
	| "stopping"
	| "stopped"
	| "failed"
	| "exited"
	| "orphaned"
	| "adoption_required";

export interface BackgroundJobRecord {
	jobId: string;
	ownerRunId?: string;
	workspaceId?: string;
	commandIdentity: string;
	executable: string;
	/** Sanitized args (secrets redacted). */
	sanitizedArguments: string[];
	cwd: string;
	processIdentity: string;
	processTreeIdentity?: string;
	/** POSIX start time (ticks) or Windows creation timestamp for PID-reuse check. */
	processStartIdentity?: number;
	startedAt: string;
	state: BackgroundJobState;
	exitCode?: number;
	health?: "healthy" | "degraded" | "unknown";
	restartPolicy?: string;
	logArtifactId?: string;
	/** Lineage: previous process identities across restarts. */
	restarts?: Array<{ previousProcessIdentity: string; cause: string; at: string; newProcessIdentity: string }>;
	restartCount?: number;
}

export type BackgroundJobEvent =
	| { event: "BACKGROUND_JOB_REGISTERED"; jobId: string; at: number }
	| { event: "BACKGROUND_JOB_STARTED"; jobId: string; processIdentity: string; at: number }
	| { event: "BACKGROUND_JOB_HEALTHY"; jobId: string; at: number }
	| { event: "BACKGROUND_JOB_DEGRADED"; jobId: string; reason: string; at: number }
	| { event: "BACKGROUND_JOB_STOP_REQUESTED"; jobId: string; at: number }
	| { event: "BACKGROUND_JOB_STOPPED"; jobId: string; at: number }
	| { event: "BACKGROUND_JOB_EXITED"; jobId: string; exitCode: number; at: number }
	| { event: "BACKGROUND_JOB_FAILED"; jobId: string; reason: string; at: number }
	| {
			event: "BACKGROUND_JOB_RESTARTED";
			jobId: string;
			previousProcessIdentity: string;
			newProcessIdentity: string;
			at: number;
	  }
	| { event: "BACKGROUND_JOB_ADOPTED"; jobId: string; processIdentity: string; at: number };

export type JobStatusClassification =
	| { kind: "recorded_running_and_alive"; record: BackgroundJobRecord }
	| { kind: "recorded_running_but_missing"; record: BackgroundJobRecord }
	| { kind: "process_identity_mismatch"; record: BackgroundJobRecord; reason: string; adoptionRequired: true }
	| { kind: "exited_with_code"; record: BackgroundJobRecord; exitCode: number }
	| { kind: "health_degraded"; record: BackgroundJobRecord; health: "degraded" }
	| { kind: "adoption_required"; record: BackgroundJobRecord };

export interface JobLogsRequest {
	jobId: string;
	tailLines?: number;
	maxBytes?: number;
	since?: number;
	stream?: "stdout" | "stderr" | "both";
}

export interface JobLogsResult {
	jobId: string;
	stdout: string;
	stderr: string;
	truncated: boolean;
}

/** Strong identity evidence required before a process may be adopted. */
export interface AdoptionEvidence {
	executable: string;
	arguments: string[];
	cwd: string;
	startTimeMs?: number;
	expectedListenerPort?: number;
	// Command-line identity (cmdline join) must match.
	commandLine?: string;
}

export const isWindows = process.platform === "win32";
