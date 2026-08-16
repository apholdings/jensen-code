/**
 * Remote Execution — target model (2.14.0).
 *
 * A concrete remote execution substrate (a machine + transport + platform), NOT
 * an executor and NOT a worker. Jensen 3.0 keeps these domains distinct:
 *
 *   - Executor: the logical placement/capability identity a mission is assigned to.
 *   - Worker:    the long-lived control-plane daemon that owns that executor.
 *   - Target:    the physical machine where tool/process work actually runs.
 *
 * A target is selected explicitly (Capability Routing comes later). The model
 * deliberately carries no model/inference host: a remote target never implies
 * that inference runs there.
 */

// =============================================================================
// Structured errors
// =============================================================================

export type RemoteTargetErrorCode =
	| "INVALID_TARGET"
	| "TARGET_NOT_FOUND"
	| "TARGET_ALREADY_EXISTS"
	| "TARGET_CORRUPT"
	| "UNSUPPORTED_TRANSPORT";

export class RemoteTargetError extends Error {
	readonly code: RemoteTargetErrorCode;
	readonly details: Readonly<Record<string, unknown>>;

	constructor(code: RemoteTargetErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
		super(message);
		this.name = "RemoteTargetError";
		this.code = code;
		this.details = Object.freeze({ ...details });
	}
}

// =============================================================================
// Target model
// =============================================================================

export type RemoteTransportKind = "ssh";
export type RemotePlatform = "windows" | "linux" | "macos";
export type RemoteArch = "x64" | "arm64";

export interface RemoteConnectionOptions {
	/** SSH connect timeout (ms). Bounded, no infinite hangs. */
	connectTimeoutMs?: number;
	/** Max per-command wall-clock (ms) for probe/verification operations. */
	commandTimeoutMs?: number;
	/** Remote temp root for execution-scoped workspaces (e.g. `C:\Users\...\AppData\Local\Temp`). */
	remoteTempRoot?: string;
}

export interface RemoteExecutionTarget {
	/** Stable target identity, used as a config key and audit trail. */
	targetId: string;
	transport: RemoteTransportKind;
	host: string;
	user: string;
	platform: RemotePlatform;
	arch: RemoteArch;
	/** Optional host-key/connection extra options (never secrets). */
	connection?: RemoteConnectionOptions;
}

/** A safe targetId is used as a path component by the concrete store. */
export function isSafeRemoteTargetId(value: string): boolean {
	return /^[A-Za-z0-9._-]+$/u.test(value) && value !== "." && value !== "..";
}

export interface RemoteTargetParseResult {
	ok: true;
	target: RemoteExecutionTarget;
}
export interface RemoteTargetParseFailure {
	ok: false;
	diagnostic: string;
}

const REMOTE_PLATFORMS: ReadonlySet<string> = new Set<RemotePlatform>(["windows", "linux", "macos"]);
const REMOTE_ARCHES: ReadonlySet<string> = new Set<RemoteArch>(["x64", "arm64"]);

/**
 * Validate an untrusted value into a RemoteExecutionTarget. Corruption is
 * surfaced structurally, never silently coerced into a healthy target.
 */
export function parseRemoteExecutionTarget(value: unknown): RemoteTargetParseResult | RemoteTargetParseFailure {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, diagnostic: "target must be an object" };
	}
	const doc = value as Record<string, unknown>;

	if (typeof doc.targetId !== "string" || !isSafeRemoteTargetId(doc.targetId)) {
		return { ok: false, diagnostic: "targetId is missing or unsafe" };
	}
	if (doc.transport !== "ssh") {
		return { ok: false, diagnostic: `transport must be "ssh" (got ${String(doc.transport)})` };
	}
	if (typeof doc.host !== "string" || doc.host.trim().length === 0) {
		return { ok: false, diagnostic: "host must be a non-empty string" };
	}
	if (typeof doc.user !== "string" || doc.user.trim().length === 0) {
		return { ok: false, diagnostic: "user must be a non-empty string" };
	}
	if (typeof doc.platform !== "string" || !REMOTE_PLATFORMS.has(doc.platform)) {
		return { ok: false, diagnostic: `platform must be one of windows|linux|macos (got ${String(doc.platform)})` };
	}
	if (typeof doc.arch !== "string" || !REMOTE_ARCHES.has(doc.arch)) {
		return { ok: false, diagnostic: `arch must be one of x64|arm64 (got ${String(doc.arch)})` };
	}

	let connection: RemoteConnectionOptions | undefined;
	if (doc.connection !== undefined) {
		if (typeof doc.connection !== "object" || doc.connection === null || Array.isArray(doc.connection)) {
			return { ok: false, diagnostic: "connection must be an object" };
		}
		const conn = doc.connection as Record<string, unknown>;
		for (const key of ["connectTimeoutMs", "commandTimeoutMs"] as const) {
			if (conn[key] !== undefined && (!Number.isSafeInteger(conn[key]) || (conn[key] as number) <= 0)) {
				return { ok: false, diagnostic: `connection.${key} must be a positive safe integer` };
			}
		}
		if (conn.remoteTempRoot !== undefined && typeof conn.remoteTempRoot !== "string") {
			return { ok: false, diagnostic: "connection.remoteTempRoot must be a string" };
		}
		connection = {
			connectTimeoutMs: conn.connectTimeoutMs as number | undefined,
			commandTimeoutMs: conn.commandTimeoutMs as number | undefined,
			remoteTempRoot: conn.remoteTempRoot as string | undefined,
		};
	}

	return {
		ok: true,
		target: {
			targetId: doc.targetId,
			transport: "ssh",
			host: doc.host,
			user: doc.user,
			platform: doc.platform as RemotePlatform,
			arch: doc.arch as RemoteArch,
			connection,
		},
	};
}

export interface CreateRemoteTargetInput extends RemoteExecutionTarget {
	now?: number;
}

/** A plain-data health/observation result from probing a target. */
export interface RemoteTargetHealth {
	targetId: string;
	status:
		| "reachable"
		| "unreachable"
		| "auth_failed"
		| "timeout"
		| "runtime_unavailable"
		| "unsupported_runtime"
		| "unknown";
	/** Present when a structured transport/error category is available. */
	errorCode?: string;
	summary: string;
	observedAtMs: number;
	/** Best-effort remote identity observed during a successful probe. */
	remoteHost?: string;
	remoteUser?: string;
	remotePlatform?: string;
	remoteRuntime?: string;
}
