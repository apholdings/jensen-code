/**
 * Shared inference admission protocol (3.0.0 cross-host bridge).
 *
 * Structured HTTP + JSON protocol between a remote Jensen runtime and the local
 * admission service. The service owns the scheduler; the remote client only
 * asks (request/wait/renew/release/cancel). Protocol version is explicit and a
 * mismatch is a structural failure, never a silent reinterpretation.
 *
 * No credentials, prompts, or message bodies cross this protocol: only
 * correlation ids, scheduling metadata, and lease identities.
 */

import type {
	AdmittedInference,
	EnqueueInferenceOutcome,
	InferenceAdmissionStatus,
	InferencePriority,
	InferenceRequestDependency,
	ReleaseInferenceOutcome,
	RenewInferenceOutcome,
} from "./types.js";

export const ADMISSION_PROTOCOL_VERSION = 1 as const;

export type AdmissionCancelOutcome = { status: "cancelled" | "not_found" | "running"; inferenceRequestId: string };

// =============================================================================
// Request payloads (client -> service)
// =============================================================================

export interface AdmissionRequestPayload {
	protocolVersion: typeof ADMISSION_PROTOCOL_VERSION;
	/** Execution-scoped correlation (validated against the bearer token scope). */
	executionId: string;
	logicalAgentId: string;
	/** Resource identity is resolved CENTRALLY; the client never declares capacity. */
	provider: string;
	model: string;
	inferenceRequestId?: string;
	missionId?: string;
	assignmentId?: string;
	priority?: InferencePriority;
	dependency?: InferenceRequestDependency;
	estimatedInputTokens?: number;
	maxOutputTokens?: number;
}

export interface AdmissionStatusQuery {
	inferenceRequestId: string;
	executionId: string;
}

export interface AdmissionReleasePayload {
	protocolVersion: typeof ADMISSION_PROTOCOL_VERSION;
	executionId: string;
	admitted: AdmittedInference;
	outcome: {
		state: "COMPLETED" | "FAILED" | "CANCELLED" | "INTERRUPTED";
		usage?: { input?: number; output?: number };
		errorMessage?: string;
	};
}

export interface AdmissionRenewPayload {
	protocolVersion: typeof ADMISSION_PROTOCOL_VERSION;
	executionId: string;
	admitted: AdmittedInference;
}

export interface AdmissionCancelPayload {
	protocolVersion: typeof ADMISSION_PROTOCOL_VERSION;
	executionId: string;
	inferenceRequestId: string;
}

// =============================================================================
// Response envelopes (service -> client)
// =============================================================================

export type AdmissionResponse =
	| { kind: "request_result"; outcome: EnqueueInferenceOutcome }
	| { kind: "status_result"; status: InferenceAdmissionStatus }
	| { kind: "release_result"; outcome: ReleaseInferenceOutcome }
	| { kind: "renew_result"; outcome: RenewInferenceOutcome }
	| { kind: "cancel_result"; outcome: AdmissionCancelOutcome }
	| { kind: "error"; code: AdmissionErrorCode; message: string };

export type AdmissionErrorCode =
	| "UNAUTHORIZED"
	| "PROTOCOL_MISMATCH"
	| "RESOURCE_NOT_REGISTERED"
	| "MALFORMED_REQUEST"
	| "SCHEDULER_UNAVAILABLE"
	| "INTERNAL_ERROR";

export class AdmissionProtocolError extends Error {
	readonly code: AdmissionErrorCode;
	constructor(code: AdmissionErrorCode, message: string) {
		super(message);
		this.name = "AdmissionProtocolError";
		this.code = code;
	}
}

/** Validate an untrusted response envelope from the service. */
export function parseAdmissionResponse(value: unknown): AdmissionResponse {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new AdmissionProtocolError("MALFORMED_REQUEST", "response must be an object");
	}
	const doc = value as Record<string, unknown>;
	if (doc.kind === "request_result")
		return { kind: "request_result", outcome: doc.outcome as EnqueueInferenceOutcome };
	if (doc.kind === "status_result") return { kind: "status_result", status: doc.status as InferenceAdmissionStatus };
	if (doc.kind === "release_result")
		return { kind: "release_result", outcome: doc.outcome as ReleaseInferenceOutcome };
	if (doc.kind === "renew_result") return { kind: "renew_result", outcome: doc.outcome as RenewInferenceOutcome };
	if (doc.kind === "cancel_result") return { kind: "cancel_result", outcome: doc.outcome as AdmissionCancelOutcome };
	if (doc.kind === "error") {
		return { kind: "error", code: doc.code as AdmissionErrorCode, message: String(doc.message ?? "") };
	}
	throw new AdmissionProtocolError("PROTOCOL_MISMATCH", `unknown response kind: ${String(doc.kind)}`);
}
