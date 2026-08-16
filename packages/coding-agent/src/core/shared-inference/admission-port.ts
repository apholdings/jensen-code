/**
 * Shared inference admission port (3.0.0 cross-host bridge).
 *
 * The single client-facing seam for requesting, waiting on, renewing, releasing
 * and cancelling an inference slot against ONE authoritative scheduler. Local
 * processes implement the port with the in-process scheduler; remote processes
 * implement it with a structured HTTP client to the local admission service.
 * The remote client NEVER re-implements the scheduling algorithm.
 */

import type { SharedInferenceScheduler } from "./scheduler.js";
import type {
	AcquireInferenceOutcome,
	AdmittedInference,
	InferencePriority,
	InferenceRequestDependency,
	ReleaseInferenceOutcome,
	SharedInferenceResource,
} from "./types.js";

export interface InferenceAdmissionInput {
	logicalAgentId: string;
	resource: SharedInferenceResource;
	model: { provider: string; id: string };
	inferenceRequestId?: string;
	missionId?: string;
	assignmentId?: string;
	executionId?: string;
	priority?: InferencePriority;
	dependency?: InferenceRequestDependency;
	estimatedInputTokens?: number;
	maxOutputTokens?: number;
}

export interface ReleaseInferenceInput {
	state: "COMPLETED" | "FAILED" | "CANCELLED" | "INTERRUPTED";
	usage?: { input?: number; output?: number };
	errorMessage?: string;
}

export interface SharedInferenceAdmissionPort {
	readonly kind: "local" | "remote";
	/** Resolve the shared resource a model targets (undefined = non-shared). */
	resourceFor(model: { provider: string; id: string }): SharedInferenceResource | undefined;
	/** Request admission, waiting (bounded, abortable) until admitted/cancelled/timeout. */
	acquire(
		input: InferenceAdmissionInput & { signal?: AbortSignal; queueWaitTimeoutMs?: number },
	): Promise<AcquireInferenceOutcome>;
	/** Release an admitted lease (fenced by the central authority). */
	release(admitted: AdmittedInference, outcome: ReleaseInferenceInput): Promise<ReleaseInferenceOutcome>;
	/** Cancel a queued (or locally-owned running) request. */
	cancel(
		inferenceRequestId: string,
	): Promise<{ status: "cancelled" | "not_found" | "running"; inferenceRequestId: string }>;
}

/**
 * In-process admission client over a local `SharedInferenceScheduler`. This is
 * the zero-network path used by local Jensen processes on Bucephalus; the
 * scheduler's durable ledger remains the shared authority with remote clients.
 */
export class LocalSchedulerAdmissionClient implements SharedInferenceAdmissionPort {
	readonly kind = "local" as const;

	constructor(private readonly scheduler: SharedInferenceScheduler) {}

	resourceFor(model: { provider: string; id: string }): SharedInferenceResource | undefined {
		return this.scheduler.resourceFor(model);
	}

	acquire(
		input: InferenceAdmissionInput & { signal?: AbortSignal; queueWaitTimeoutMs?: number },
	): Promise<AcquireInferenceOutcome> {
		return this.scheduler.acquire(input);
	}

	release(admitted: AdmittedInference, outcome: ReleaseInferenceInput): Promise<ReleaseInferenceOutcome> {
		return this.scheduler.release(admitted, outcome);
	}

	cancel(
		inferenceRequestId: string,
	): Promise<{ status: "cancelled" | "not_found" | "running"; inferenceRequestId: string }> {
		return this.scheduler.cancel(inferenceRequestId);
	}
}
