/**
 * Remote Execution — wire protocol (2.14.0).
 *
 * The control protocol over SSH/stdIO is a strict JSONL frame stream. Remote
 * application/tool stdout is relayed INSIDE frames (`REMOTE_STDOUT`/`REMOTE_STDERR`),
 * never interleaved raw on the transport, so it cannot corrupt control frames.
 *
 * Protocol version is explicit and pinned: the parent rejects a runner with an
 * incompatible version structurally (REMOTE_PROTOCOL_MISMATCH), never silently
 * misparses a changed schema.
 */

export const REMOTE_PROTOCOL_VERSION = 1 as const;

export type RemoteProtocolFrameType =
	| "REMOTE_STARTED"
	| "REMOTE_HEARTBEAT"
	| "REMOTE_STDOUT"
	| "REMOTE_STDERR"
	| "REMOTE_EVIDENCE"
	| "REMOTE_RESULT"
	| "REMOTE_EXIT"
	| "REMOTE_ERROR";

export interface RemoteLocationIdentity {
	host: string;
	user: string;
	cwd: string;
	pid: number;
	platform: string;
}

export interface RemoteStartedPayload {
	protocolVersion: number;
	executionId: string;
	remoteTargetId: string;
	launchId: string;
	/** Fencing identity carried across the boundary (echoed, never an authority). */
	fencing?: { leaseId: string; fencingToken: number };
	location: RemoteLocationIdentity;
	command: { argv: string[]; cwd: string };
	startedAtMs: number;
}

export interface RemoteHeartbeatPayload {
	atMs: number;
	elapsedMs: number;
	alive: boolean;
}

export interface RemoteStreamPayload {
	chunk: string;
}

export interface RemoteEvidencePayload {
	executionId: string;
	/** Remote file/process proof: host, user, path, hashes, command results. */
	host: string;
	user: string;
	cwd: string;
	items: {
		kind: "file_hash" | "command_exit" | "workspace";
		path?: string;
		sha256Before?: string;
		sha256After?: string;
		command?: string;
		exitCode?: number;
		stdout?: string;
	}[];
}

export interface RemoteResultPayload {
	executionId: string;
	success: boolean;
	summary?: string;
}

export interface RemoteExitPayload {
	executionId: string;
	exitCode: number | null;
	signal?: string;
	/** True when the child was terminated by the controller (cancellation). */
	cancelled?: boolean;
}

export interface RemoteErrorPayload {
	code: string;
	message: string;
}

export interface RemoteProtocolFrame {
	type: RemoteProtocolFrameType;
	payload: unknown;
}

/** Serialize one protocol frame to a single JSON line (no trailing ambiguity). */
export function serializeRemoteFrame(type: RemoteProtocolFrameType, payload: unknown): string {
	return `${JSON.stringify({ type, payload })}\n`;
}

export interface ParsedRemoteFrame {
	type: RemoteProtocolFrameType;
	payload: Record<string, unknown>;
}

/**
 * Parse one raw line into a protocol frame. Returns `undefined` for blank or
 * non-JSON lines (e.g. stray child bytes accidentally emitted outside a frame);
 * the transport treats those as protocol noise, never as control frames.
 */
export function parseRemoteFrame(line: string): ParsedRemoteFrame | undefined {
	const trimmed = line.trim();
	if (trimmed.length === 0) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const doc = parsed as Record<string, unknown>;
	if (typeof doc.type !== "string" || typeof doc.payload !== "object" || doc.payload === null) return undefined;
	return { type: doc.type as RemoteProtocolFrameType, payload: doc.payload as Record<string, unknown> };
}
