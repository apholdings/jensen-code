/**
 * MCP Client Foundation — structured error model (2.13.0).
 *
 * Every failure crossing the Jensen boundary is a machine-readable
 * `McpClientError` with a stable `code`, a useful human description, and
 * retained server/tool identity. Transport/process failures retain diagnostics;
 * secrets never leak through error serialization.
 */

import { ErrorCode, type McpError } from "@modelcontextprotocol/sdk/types.js";

export type McpErrorCode =
	| "MCP_SERVER_NOT_FOUND"
	| "MCP_INVALID_SERVER_CONFIG"
	| "MCP_SPAWN_FAILED"
	| "MCP_INITIALIZATION_FAILED"
	| "MCP_INCOMPATIBLE_SERVER"
	| "MCP_CONNECTION_LOST"
	| "MCP_REQUEST_TIMEOUT"
	| "MCP_REQUEST_CANCELLED"
	| "MCP_TOOL_NOT_FOUND"
	| "MCP_TOOL_CALL_FAILED"
	| "MCP_PROTOCOL_ERROR"
	| "MCP_INVALID_RESULT"
	| "MCP_SHUTDOWN_FAILED"
	| "MCP_SESSION_NOT_FOUND"
	| "MCP_SESSION_INVALID"
	| "MCP_INVALID_TOOL_CALL";

export interface McpErrorContext {
	serverId?: string;
	sessionId?: string;
	toolName?: string;
	/** Safe diagnostic detail (e.g., argv identity or stderr tail). Never env secrets. */
	detail?: string;
	cause?: unknown;
}

/**
 * Jensen MCP error. The `message` is human-facing; `code`, `serverId`,
 * `sessionId`, and `toolName` are machine-readable.
 */
export class McpClientError extends Error {
	readonly code: McpErrorCode;
	readonly serverId?: string;
	readonly sessionId?: string;
	readonly toolName?: string;
	readonly detail?: string;
	readonly cause?: unknown;

	constructor(code: McpErrorCode, message: string, context: McpErrorContext = {}) {
		super(message);
		this.name = "McpClientError";
		this.code = code;
		this.serverId = context.serverId;
		this.sessionId = context.sessionId;
		this.toolName = context.toolName;
		this.detail = context.detail;
		if (context.cause !== undefined) this.cause = context.cause;
	}

	/** Secret-safe serialization surface for CLI/evidence consumers. */
	toJSON(): Record<string, unknown> {
		return {
			name: this.name,
			code: this.code,
			message: this.message,
			serverId: this.serverId,
			sessionId: this.sessionId,
			toolName: this.toolName,
			detail: this.detail,
		};
	}
}

function isMcpError(error: unknown): error is McpError {
	return typeof error === "object" && error !== null && "code" in error && "message" in error;
}

function isAbortError(error: unknown): error is Error & { name: "AbortError" } {
	return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

function isNodeErrno(error: unknown): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error;
}

/**
 * Map an arbitrary SDK/transport/protocol error to a stable Jensen code.
 * Transport failure, protocol failure, server failure, and tool failure are
 * kept distinct so callers and the evidence system never conflate them.
 */
export function classifyMcpError(error: unknown, options: { toolName?: string } = {}): McpErrorCode {
	if (isAbortError(error)) return "MCP_REQUEST_CANCELLED";

	if (isMcpError(error)) {
		switch (error.code) {
			case ErrorCode.ConnectionClosed:
				return "MCP_CONNECTION_LOST";
			case ErrorCode.RequestTimeout:
				return "MCP_REQUEST_TIMEOUT";
			case ErrorCode.InvalidParams: {
				const message = error.message ?? "";
				if (options.toolName && /not found/i.test(message)) return "MCP_TOOL_NOT_FOUND";
				if (/not found/i.test(message)) return "MCP_TOOL_NOT_FOUND";
				return "MCP_TOOL_CALL_FAILED";
			}
			case ErrorCode.MethodNotFound:
				return "MCP_PROTOCOL_ERROR";
			case ErrorCode.InternalError:
				return "MCP_TOOL_CALL_FAILED";
			default:
				return "MCP_PROTOCOL_ERROR";
		}
	}

	if (isNodeErrno(error)) {
		// Spawn / process-level failures (ENOENT, EACCES, ENOTDIR, ...).
		return "MCP_SPAWN_FAILED";
	}

	return "MCP_PROTOCOL_ERROR";
}

/**
 * Classify a connect/initialize failure specifically. Initialization has its
 * own vocabulary (incompatible vs failed vs lost) while still respecting the
 * underlying timeout/spawn distinctions.
 */
export function classifyMcpConnectError(error: unknown): McpErrorCode {
	if (isAbortError(error)) return "MCP_REQUEST_CANCELLED";

	if (isMcpError(error)) {
		switch (error.code) {
			case ErrorCode.RequestTimeout:
				return "MCP_INITIALIZATION_FAILED";
			case ErrorCode.ConnectionClosed:
				return "MCP_CONNECTION_LOST";
			default:
				return "MCP_INITIALIZATION_FAILED";
		}
	}

	if (isNodeErrno(error)) return "MCP_SPAWN_FAILED";

	const message = error instanceof Error ? error.message : String(error);
	if (/protocol version is not supported/i.test(message)) return "MCP_INCOMPATIBLE_SERVER";

	return "MCP_INITIALIZATION_FAILED";
}
