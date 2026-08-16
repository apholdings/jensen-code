/**
 * Remote shared inference admission client (3.0.0 cross-host bridge).
 *
 * Implements `SharedInferenceAdmissionPort` over the structured HTTP protocol to
 * the local admission service. It NEVER re-implements the scheduling algorithm
 * and NEVER falls back to direct provider access: when the scheduler is
 * unreachable or returns an error, `acquire` resolves to a `cancelled` outcome
 * with a `scheduler_unavailable` reason, which the stream seam surfaces as a
 * fail-closed error stream.
 */

import { randomUUID } from "node:crypto";
import type { InferenceAdmissionInput, ReleaseInferenceInput, SharedInferenceAdmissionPort } from "./admission-port.js";
import {
	ADMISSION_PROTOCOL_VERSION,
	type AdmissionCancelPayload,
	type AdmissionReleasePayload,
	type AdmissionRequestPayload,
	type AdmissionResponse,
	parseAdmissionResponse,
} from "./admission-protocol.js";
import type {
	AcquireInferenceOutcome,
	AdmittedInference,
	EnqueueInferenceOutcome,
	InferenceAdmissionStatus,
	ReleaseInferenceOutcome,
	SharedInferenceResource,
} from "./types.js";

export interface RemoteAdmissionClientOptions {
	baseUrl: string;
	token: string;
	executionId: string;
	resources: SharedInferenceResource[];
	/** Poll cadence while waiting for admission. */
	pollMs?: number;
	/** Per-request HTTP timeout. */
	timeoutMs?: number;
	/** Injectable fetch (tests). */
	fetchImpl?: typeof fetch;
}

export class RemoteSchedulerAdmissionClient implements SharedInferenceAdmissionPort {
	readonly kind = "remote" as const;

	private readonly _baseUrl: string;
	private readonly _token: string;
	private readonly _executionId: string;
	private readonly _resources: SharedInferenceResource[];
	private readonly _pollMs: number;
	private readonly _timeoutMs: number;
	private readonly _fetchImpl: typeof fetch;

	constructor(options: RemoteAdmissionClientOptions) {
		this._baseUrl = options.baseUrl.replace(/\/+$/, "");
		this._token = options.token;
		this._executionId = options.executionId;
		this._resources = options.resources;
		this._pollMs = options.pollMs ?? 250;
		this._timeoutMs = options.timeoutMs ?? 10_000;
		this._fetchImpl = options.fetchImpl ?? fetch;
	}

	resourceFor(model: { provider: string; id: string }): SharedInferenceResource | undefined {
		for (const resource of this._resources) {
			if (resource.backend === model.provider && resource.model === model.id) return { ...resource };
		}
		return undefined;
	}

	async acquire(
		input: InferenceAdmissionInput & { signal?: AbortSignal; queueWaitTimeoutMs?: number },
	): Promise<AcquireInferenceOutcome> {
		const inferenceRequestId = input.inferenceRequestId ?? `inference_${randomUUID()}`;
		let first: EnqueueInferenceOutcome;
		try {
			first = await this._requestAdmission(input, inferenceRequestId);
		} catch (error) {
			return {
				status: "cancelled",
				inferenceRequestId,
				reason:
					error instanceof AdmissionUnavailableError ? error.message : `scheduler_unavailable:${String(error)}`,
			};
		}
		if (first.status === "admitted") return { status: "admitted", admitted: first.admitted };

		const enqueuedAtMs = Date.now();
		const timeoutMs = input.queueWaitTimeoutMs ?? 0;
		while (true) {
			if (input.signal?.aborted) {
				await this.cancel(inferenceRequestId);
				return { status: "cancelled", inferenceRequestId, reason: "aborted" };
			}
			const waitedMs = Date.now() - enqueuedAtMs;
			if (timeoutMs > 0 && waitedMs >= timeoutMs) {
				await this.cancel(inferenceRequestId);
				return { status: "queue_timeout", inferenceRequestId, waitedMs };
			}

			const status = await this._status(inferenceRequestId);
			if (status.status === "admitted") return { status: "admitted", admitted: status.admitted };
			if (status.status === "terminal") {
				return { status: "cancelled", inferenceRequestId, reason: `terminal:${status.state}` };
			}
			if (status.status === "unknown") {
				return { status: "cancelled", inferenceRequestId, reason: "removed_from_queue" };
			}

			await new Promise((resolve) => setTimeout(resolve, this._pollMs));
		}
	}

	async release(admitted: AdmittedInference, outcome: ReleaseInferenceInput): Promise<ReleaseInferenceOutcome> {
		const response = await this._post("/v1/release", {
			protocolVersion: ADMISSION_PROTOCOL_VERSION,
			executionId: this._executionId,
			admitted,
			outcome,
		} satisfies AdmissionReleasePayload);
		if (response.kind !== "release_result") {
			throw new Error(`unexpected release response: ${response.kind}`);
		}
		return response.outcome;
	}

	async cancel(
		inferenceRequestId: string,
	): Promise<{ status: "cancelled" | "not_found" | "running"; inferenceRequestId: string }> {
		const response = await this._post("/v1/cancel", {
			protocolVersion: ADMISSION_PROTOCOL_VERSION,
			executionId: this._executionId,
			inferenceRequestId,
		} satisfies AdmissionCancelPayload);
		if (response.kind !== "cancel_result") {
			throw new Error(`unexpected cancel response: ${response.kind}`);
		}
		return response.outcome;
	}

	// =========================================================================
	// Internals
	// =========================================================================

	private async _requestAdmission(
		input: InferenceAdmissionInput,
		inferenceRequestId: string,
	): Promise<EnqueueInferenceOutcome> {
		const response = await this._post("/v1/request", {
			protocolVersion: ADMISSION_PROTOCOL_VERSION,
			executionId: this._executionId,
			logicalAgentId: input.logicalAgentId,
			provider: input.model.provider,
			model: input.model.id,
			inferenceRequestId,
			missionId: input.missionId,
			assignmentId: input.assignmentId,
			priority: input.priority,
			dependency: input.dependency,
			estimatedInputTokens: input.estimatedInputTokens,
			maxOutputTokens: input.maxOutputTokens,
		} satisfies AdmissionRequestPayload);
		if (response.kind !== "request_result") {
			throw new AdmissionUnavailableError(`unexpected request response: ${response.kind}`, inferenceRequestId);
		}
		return response.outcome;
	}

	private async _status(
		inferenceRequestId: string,
	): Promise<InferenceAdmissionStatus | { status: "cancelled"; inferenceRequestId: string; reason: string }> {
		try {
			const response = await this._get(
				`/v1/status?inferenceRequestId=${encodeURIComponent(inferenceRequestId)}&executionId=${encodeURIComponent(this._executionId)}`,
			);
			if (response.kind !== "status_result") {
				return {
					status: "cancelled",
					inferenceRequestId,
					reason: `scheduler_unavailable:unexpected status response ${response.kind}`,
				};
			}
			return response.status;
		} catch (error) {
			return {
				status: "cancelled",
				inferenceRequestId,
				reason: `scheduler_unavailable:${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	private async _post(path: string, body: unknown): Promise<AdmissionResponse> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this._timeoutMs);
		try {
			const response = await this._fetchImpl(`${this._baseUrl}${path}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${this._token}`,
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			return this._decodeResponse(response);
		} finally {
			clearTimeout(timer);
		}
	}

	private async _get(path: string): Promise<AdmissionResponse> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this._timeoutMs);
		try {
			const response = await this._fetchImpl(`${this._baseUrl}${path}`, {
				method: "GET",
				headers: { authorization: `Bearer ${this._token}` },
				signal: controller.signal,
			});
			return this._decodeResponse(response);
		} finally {
			clearTimeout(timer);
		}
	}

	private async _decodeResponse(response: Response): Promise<AdmissionResponse> {
		const text = await response.text();
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new Error(`admission service returned non-JSON (HTTP ${response.status})`);
		}
		const decoded = parseAdmissionResponse(parsed);
		if (!response.ok) {
			if (decoded.kind === "error") throw new Error(`${decoded.code}: ${decoded.message}`);
			throw new Error(`admission service HTTP ${response.status}`);
		}
		return decoded;
	}
}

/** Fail-closed marker used to convert transport failure into a cancelled outcome. */
export class AdmissionUnavailableError extends Error {
	readonly inferenceRequestId: string;
	constructor(reason: string, inferenceRequestId: string) {
		super(reason);
		this.name = "AdmissionUnavailableError";
		this.inferenceRequestId = inferenceRequestId;
	}
}
