/**
 * Remote Execution — structured error model (2.14.0).
 *
 * Transport/execution failures are categorised, never collapsed into a generic
 * EXECUTION_FAILED. The categories are the contract the control plane reasons
 * about (retryable vs not, stale vs launch, ...).
 */

export type RemoteExecutionErrorCode =
	| "REMOTE_TARGET_UNAVAILABLE"
	| "REMOTE_AUTH_FAILED"
	| "REMOTE_CONNECT_TIMEOUT"
	| "REMOTE_RUNTIME_UNAVAILABLE"
	| "REMOTE_PROTOCOL_MISMATCH"
	| "REMOTE_LAUNCH_FAILED"
	| "REMOTE_EXECUTION_FAILED"
	| "REMOTE_EXECUTION_LOST"
	| "REMOTE_HEARTBEAT_TIMEOUT"
	| "REMOTE_CANCEL_FAILED"
	| "REMOTE_RESULT_STALE"
	| "REMOTE_PROTOCOL_ERROR"
	| "REMOTE_DUPLICATE_LAUNCH";

export class RemoteExecutionError extends Error {
	readonly code: RemoteExecutionErrorCode;
	readonly details: Readonly<Record<string, unknown>>;

	constructor(code: RemoteExecutionErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
		super(message);
		this.name = "RemoteExecutionError";
		this.code = code;
		this.details = Object.freeze({ ...details });
	}
}
