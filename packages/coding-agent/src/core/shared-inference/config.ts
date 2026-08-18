/**
 * Shared inference runtime resolution (3.0.0 cross-host bridge).
 *
 * Activation is configuration-driven and now DEFAULT-ON for configured shared
 * resources: a model that resolves to a configured `SharedInferenceResource`
 * automatically uses admission scheduling (no per-caller env flag). Cloud /
 * non-shared providers pass through unchanged. Explicit opt-out for diagnostic
 * direct access: `JENSEN_SHARED_INFERENCE=0`.
 *
 * Local processes run the scheduler in-process over the durable cross-process
 * ledger. Remote runtimes (when `JENSEN_SHARED_INFERENCE_ADMISSION_URL` is set)
 * use a `RemoteSchedulerAdmissionClient` that delegates to the central admission
 * service — never a second scheduler, never direct backend fallback.
 */

import type { StreamFn } from "@apholdings/jensen-agent-core";
import { governancePolicyFromEnv } from "../governance/evaluator.js";
import { GovernanceService } from "../governance/service.js";
import { LocalSchedulerAdmissionClient, type SharedInferenceAdmissionPort } from "./admission-port.js";
import { createFileInferenceQueueStore } from "./file-inference-queue-store.js";
import { createFileLogicalAgentStore } from "./file-logical-agent-store.js";
import { RemoteSchedulerAdmissionClient } from "./remote-admission-client.js";
import { LocalSubagentRuntime } from "./runtime.js";
import { SharedInferenceScheduler } from "./scheduler.js";
import { createScheduledStreamFn } from "./stream-fn.js";
import type { InferencePriority, InferenceRequestDependency, SharedInferenceResource } from "./types.js";

export const DEFAULT_SHARED_INFERENCE_RESOURCES: readonly SharedInferenceResource[] = [
	{
		resourceId: "qwen38-bucephalus",
		backend: "llamacpp-qwen38-bucephalus",
		model: "qwen3.8-27b",
		location: "bucephalus",
		capacity: 1,
		contextWindow: 196608,
		maxOutputTokens: 8192,
		state: "available",
	},
];

export interface SharedInferenceRuntime {
	admission: SharedInferenceAdmissionPort;
	runtime?: LocalSubagentRuntime;
	streamFn: StreamFn;
	resources: SharedInferenceResource[];
}

function isTruthy(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function parseResourcesFromEnv(): SharedInferenceResource[] | undefined {
	const raw = process.env.JENSEN_SHARED_INFERENCE_RESOURCES;
	if (!raw?.trim()) return undefined;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return undefined;
		return parsed.map((entry): SharedInferenceResource => {
			const r = entry as Record<string, unknown>;
			return {
				resourceId: String(r.resourceId),
				backend: String(r.backend),
				model: String(r.model),
				location: String(r.location ?? ""),
				capacity: typeof r.capacity === "number" ? r.capacity : 1,
				contextWindow: typeof r.contextWindow === "number" ? r.contextWindow : undefined,
				maxOutputTokens: typeof r.maxOutputTokens === "number" ? r.maxOutputTokens : undefined,
				state: (r.state as SharedInferenceResource["state"]) ?? "available",
				baseUrl: typeof r.baseUrl === "string" ? r.baseUrl : undefined,
			};
		});
	} catch {
		return undefined;
	}
}

export function sharedInferenceResources(): SharedInferenceResource[] {
	return parseResourcesFromEnv() ?? [...DEFAULT_SHARED_INFERENCE_RESOURCES];
}

export interface SharedInferenceAdmissionEndpoint {
	url?: string;
	token?: string;
	executionId?: string;
}

/** Remote admission endpoint propagated into the runtime environment (never argv). */
export function resolveAdmissionEndpoint(): SharedInferenceAdmissionEndpoint {
	return {
		url: process.env.JENSEN_SHARED_INFERENCE_ADMISSION_URL,
		token: process.env.JENSEN_SHARED_INFERENCE_TOKEN,
		executionId: process.env.JENSEN_SHARED_INFERENCE_EXECUTION_ID,
	};
}

export function isSharedInferenceEnabled(): boolean {
	// Remote runtime with a propagated admission endpoint is always scheduled.
	if (resolveAdmissionEndpoint().url) return true;
	const explicit = process.env.JENSEN_SHARED_INFERENCE;
	if (explicit !== undefined) return isTruthy(explicit);
	// Default-on: a configured shared resource implies scheduling.
	return sharedInferenceResources().length > 0;
}

export interface ResolveSharedInferenceRuntimeOptions {
	sessionId?: string;
	missionId?: string;
	assignmentId?: string;
	executionId?: string;
	priority?: InferencePriority;
	dependency?: InferenceRequestDependency;
	queueDir?: string;
	agentDir?: string;
	ownerId?: string;
	now?: () => number;
	governance?: GovernanceService;
}

/**
 * Build the shared admission + logical-agent runtime + provider seam.
 *
 * - Remote runtime (`JENSEN_SHARED_INFERENCE_ADMISSION_URL`): a remote admission
 *   client delegating to the central service (fail-closed, no direct backend).
 * - Local runtime: the in-process scheduler over the shared durable ledger.
 *
 * Returns `undefined` when shared inference is disabled.
 */
export function resolveSharedInferenceRuntime(
	options: ResolveSharedInferenceRuntimeOptions = {},
): SharedInferenceRuntime | undefined {
	if (!isSharedInferenceEnabled()) return undefined;

	const resources = sharedInferenceResources();
	const envPriority = Number(process.env.JENSEN_INFERENCE_PRIORITY);
	const envUnblocks = Number(process.env.JENSEN_INFERENCE_UNBLOCKS);
	const priority =
		options.priority ?? (Number.isSafeInteger(envPriority) && envPriority >= 0 ? { base: envPriority } : undefined);
	const dependency =
		options.dependency ??
		(Number.isSafeInteger(envUnblocks) && envUnblocks >= 0 ? { unblocksCount: envUnblocks } : undefined);
	const verification = process.env.JENSEN_INFERENCE_VERIFICATION === "1";
	const endpoint = resolveAdmissionEndpoint();

	let admission: SharedInferenceAdmissionPort;
	let runtime: LocalSubagentRuntime;

	if (endpoint.url) {
		admission = new RemoteSchedulerAdmissionClient({
			baseUrl: endpoint.url,
			token: endpoint.token ?? "",
			executionId: endpoint.executionId ?? options.executionId ?? "unknown",
			resources,
		});
		runtime = new LocalSubagentRuntime({ store: createFileLogicalAgentStore(options.agentDir) });
	} else {
		const queueStore = createFileInferenceQueueStore(options.queueDir);
		const scheduler = new SharedInferenceScheduler({ store: queueStore, ownerId: options.ownerId, now: options.now });
		void Promise.all(resources.map((resource) => scheduler.registerResource(resource))).catch(() => {
			// Ledger registration is idempotent; a corrupt pre-existing ledger is
			// surfaced structurally by later acquire/status calls, never masked here.
		});
		admission = new LocalSchedulerAdmissionClient(scheduler);
		runtime = new LocalSubagentRuntime({ store: createFileLogicalAgentStore(options.agentDir) });
	}

	const governance =
		options.governance ??
		(options.missionId ? new GovernanceService({ policy: governancePolicyFromEnv() }) : undefined);
	const streamFn = createScheduledStreamFn({
		admission,
		runtime,
		getCorrelation: () => ({
			logicalAgentId: options.sessionId ?? process.env.JENSEN_SESSION_ID ?? "unknown",
			missionId: options.missionId ?? process.env.JENSEN_MISSION_ID,
			assignmentId: options.assignmentId ?? process.env.JENSEN_ASSIGNMENT_ID,
			executionId: options.executionId ?? process.env.JENSEN_EXECUTION_ID,
			priority: verification ? { ...(priority ?? { base: 0 }), verification: true } : priority,
			dependency,
		}),
		governance,
	});

	return { admission, runtime, streamFn, resources };
}
