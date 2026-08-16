/**
 * Shared inference runtime resolution (3.0.0 foundation).
 *
 * Activation is configuration-driven (never on by default): it turns on when
 * `JENSEN_SHARED_INFERENCE` is truthy or a resources list is present. When
 * active, every local Jensen process routes configured shared resources through
 * the cross-process scheduler before touching the provider.
 */

import type { StreamFn } from "@apholdings/jensen-agent-core";
import { createFileInferenceQueueStore } from "./file-inference-queue-store.js";
import { createFileLogicalAgentStore } from "./file-logical-agent-store.js";
import { LocalSubagentRuntime } from "./runtime.js";
import { SharedInferenceScheduler } from "./scheduler.js";
import { createScheduledStreamFn } from "./stream-fn.js";
import type { SharedInferenceResource } from "./types.js";

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
	scheduler: SharedInferenceScheduler;
	runtime: LocalSubagentRuntime;
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

export function isSharedInferenceEnabled(): boolean {
	return isTruthy(process.env.JENSEN_SHARED_INFERENCE) || parseResourcesFromEnv() !== undefined;
}

export interface ResolveSharedInferenceRuntimeOptions {
	sessionId?: string;
	missionId?: string;
	assignmentId?: string;
	executionId?: string;
	queueDir?: string;
	agentDir?: string;
	ownerId?: string;
	now?: () => number;
}

/**
 * Build the shared scheduler + logical-agent runtime + provider seam. Returns
 * `undefined` when shared inference is not configured (normal cloud/local
 * providers are unchanged).
 */
export function resolveSharedInferenceRuntime(
	options: ResolveSharedInferenceRuntimeOptions = {},
): SharedInferenceRuntime | undefined {
	if (!isSharedInferenceEnabled()) return undefined;

	const queueStore = createFileInferenceQueueStore(options.queueDir);
	const agentStore = createFileLogicalAgentStore(options.agentDir);
	const scheduler = new SharedInferenceScheduler({ store: queueStore, ownerId: options.ownerId, now: options.now });
	const runtime = new LocalSubagentRuntime({ store: agentStore, now: options.now });

	const resources = sharedInferenceResources();
	void Promise.all(resources.map((resource) => scheduler.registerResource(resource))).catch(() => {
		// Ledger registration is idempotent; a corrupt pre-existing ledger is
		// surfaced structurally by later acquire/status calls, never masked here.
	});

	const streamFn = createScheduledStreamFn({
		scheduler,
		runtime,
		getCorrelation: () => ({
			logicalAgentId: options.sessionId ?? process.env.JENSEN_SESSION_ID ?? "unknown",
			missionId: options.missionId ?? process.env.JENSEN_MISSION_ID,
			assignmentId: options.assignmentId ?? process.env.JENSEN_ASSIGNMENT_ID,
			executionId: options.executionId ?? process.env.JENSEN_EXECUTION_ID,
		}),
	});

	return { scheduler, runtime, streamFn, resources };
}
