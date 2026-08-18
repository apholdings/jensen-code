/**
 * Scheduled inference stream function (3.0.0 foundation).
 *
 * The provider integration seam. The agent loop already calls a `streamFn`
 * before touching the provider. This wrapper keeps scheduling/admission
 * separate from provider protocol handling:
 *
 *   request model inference
 *          ↓
 *   shared scheduler admission (durable queue + slot lease)
 *          ↓
 *   existing provider stream (streamSimple) — untouched
 *          ↓
 *   llama.cpp
 *
 * Non-shared providers are passed through unchanged. The scheduler is
 * capability/resource driven; OpenRouter/cloud providers are not forced through
 * local-Qwen slot semantics.
 */

import { randomUUID } from "node:crypto";
import type { StreamFn } from "@apholdings/jensen-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	streamSimple,
} from "@apholdings/jensen-ai";
import type { GovernanceService } from "../governance/service.js";
import { LocalSchedulerAdmissionClient, type SharedInferenceAdmissionPort } from "./admission-port.js";
import type { LocalSubagentRuntime } from "./runtime.js";
import type { SharedInferenceScheduler } from "./scheduler.js";
import type { InferencePriority, InferenceRequestDependency } from "./types.js";

export interface ScheduledStreamCorrelation {
	logicalAgentId: string;
	missionId?: string;
	assignmentId?: string;
	executionId?: string;
	priority?: InferencePriority;
	dependency?: InferenceRequestDependency;
}

export interface ScheduledStreamFnOptions {
	/** Admission authority (local or remote). When omitted, a local scheduler is wrapped. */
	admission?: SharedInferenceAdmissionPort;
	/** Backward-compatible local scheduler (wrapped into a local admission client). */
	scheduler?: SharedInferenceScheduler;
	runtime?: LocalSubagentRuntime;
	/** Provider delegate (default streamSimple). */
	delegate?: typeof streamSimple;
	/** Resolve logical-agent + mission/assignment/execution correlation. */
	getCorrelation?: (
		model: Model<any>,
		context: Context,
		options: Record<string, unknown>,
	) => ScheduledStreamCorrelation;
	/** Metadata-only input-token estimate (never the prompt). */
	estimateInputTokens?: (context: Context) => number | undefined;
	/** Optional host/resource-pressure check used to park before admission. */
	resourcePressure?: (model: Model<any>, context: Context) => boolean | Promise<boolean>;
	/** Wait for a pressure change; the default yields to the event loop. */
	waitForResourcePressure?: () => Promise<void>;
	/** Optional Governance admission/accounting authority. */
	governance?: GovernanceService;
}

const ZERO_USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function estimateTokensHeuristic(context: Context): number | undefined {
	let chars = context.systemPrompt?.length ?? 0;
	for (const message of context.messages ?? []) {
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") chars += content.length;
		else if (Array.isArray(content)) {
			for (const block of content) {
				if (
					block &&
					typeof block === "object" &&
					"text" in block &&
					typeof (block as { text?: unknown }).text === "string"
				) {
					chars += (block as { text: string }).text.length;
				}
			}
		}
	}
	for (const tool of context.tools ?? []) {
		chars += (tool.name?.length ?? 0) + (JSON.stringify(tool.parameters ?? {}).length ?? 0);
	}
	return Math.max(1, Math.ceil(chars / 4));
}

function errorStream(model: Model<any>, message: string): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { ...ZERO_USAGE },
		stopReason: "error",
		errorMessage: message,
		timestamp: Date.now(),
	};
	stream.push({ type: "error", reason: "error", error: output });
	stream.end();
	return stream;
}

export function createScheduledStreamFn(options: ScheduledStreamFnOptions): StreamFn {
	const delegate = options.delegate ?? streamSimple;
	const admission =
		options.admission ?? (options.scheduler ? new LocalSchedulerAdmissionClient(options.scheduler) : undefined);
	if (!admission && !options.governance) {
		throw new Error("createScheduledStreamFn requires an admission port, local scheduler, or Governance service");
	}

	return async (model, context, streamOptions) => {
		const resource = admission?.resourceFor(model);
		const correlation = options.getCorrelation
			? options.getCorrelation(model, context, (streamOptions ?? {}) as Record<string, unknown>)
			: { logicalAgentId: "unknown" };
		const logicalAgentId = correlation.logicalAgentId;
		const inferenceRequestId = `inference_${randomUUID()}`;
		if (options.governance && correlation.missionId) {
			const governanceAdmission = await options.governance.admitInference({
				missionId: correlation.missionId,
				eventId: inferenceRequestId,
				provider: model.provider,
				model: model.id,
				atMs: Date.now(),
			});
			if (!governanceAdmission.allowed)
				return errorStream(model, `Governance admission denied: ${governanceAdmission.reason ?? "unknown"}`);
		}

		if (!resource) {
			const delegateStream = delegate(model, context, streamOptions);
			if (!options.governance || !correlation.missionId) return delegateStream;
			const stream = createAssistantMessageEventStream();
			void (async () => {
				try {
					for await (const event of delegateStream) {
						if (event.type === "done") {
							await options.governance?.recordInferenceResult({
								missionId: correlation.missionId!,
								eventId: `${inferenceRequestId}:result`,
								provider: model.provider,
								model: model.id,
								inputTokens: event.message.usage?.input,
								outputTokens: event.message.usage?.output,
								costUsd: model.provider.startsWith("llamacpp-") ? undefined : event.message.usage?.cost.total,
								costStatus: model.provider.startsWith("llamacpp-")
									? undefined
									: event.message.usage?.cost.total === undefined
										? "UNKNOWN"
										: "KNOWN",
								atMs: Date.now(),
							});
						}
						stream.push(event);
						if (event.type === "done" || event.type === "error") return;
					}
					stream.end();
				} catch (error) {
					stream.push({
						type: "error",
						reason: "error",
						error: {
							role: "assistant",
							content: [],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: { ...ZERO_USAGE },
							stopReason: "error",
							errorMessage: error instanceof Error ? error.message : String(error),
							timestamp: Date.now(),
						},
					});
					stream.end();
				}
			})();
			return stream;
		}

		if (options.resourcePressure && (await options.resourcePressure(model, context))) {
			await options.runtime?.park(logicalAgentId, "resource pressure");
			await (options.waitForResourcePressure ?? (() => new Promise((resolve) => setImmediate(resolve)))());
			await options.runtime?.resume(logicalAgentId);
		}

		await options.runtime?.transition(logicalAgentId, "WAITING_INFERENCE", {
			waitingReason: "shared inference admission",
			pendingInferenceRequestId: inferenceRequestId,
		});

		const acquired = await admission!.acquire({
			logicalAgentId,
			resource,
			model,
			inferenceRequestId,
			missionId: correlation.missionId,
			assignmentId: correlation.assignmentId,
			executionId: correlation.executionId,
			priority: correlation.priority,
			dependency: correlation.dependency,
			estimatedInputTokens: options.estimateInputTokens
				? options.estimateInputTokens(context)
				: estimateTokensHeuristic(context),
			maxOutputTokens: typeof streamOptions?.maxTokens === "number" ? streamOptions.maxTokens : undefined,
			signal: streamOptions?.signal,
		});

		if (acquired.status !== "admitted") {
			const reason = acquired.status === "cancelled" ? acquired.reason : `inference admission ${acquired.status}`;
			await options.runtime?.transition(logicalAgentId, "RUNNABLE", {
				waitingReason: undefined,
				pendingInferenceRequestId: undefined,
			});
			return errorStream(model, `Shared inference admission failed: ${reason}`);
		}

		await options.runtime?.transition(logicalAgentId, "RUNNING_INFERENCE", {
			waitingReason: undefined,
			pendingInferenceRequestId: acquired.admitted.inferenceRequestId,
		});

		const delegateStream = delegate(model, context, streamOptions);

		// Wrap the delegate stream so the scheduler release happens BEFORE the
		// terminal event / `result()` resolves. A fire-and-forget release is lost
		// when a CLI process exits immediately after the final message.
		const stream = createAssistantMessageEventStream();
		let released = false;
		const syntheticFailure = (errorMessage: string): AssistantMessage => ({
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { ...ZERO_USAGE },
			stopReason: "error",
			errorMessage,
			timestamp: Date.now(),
		});

		const releaseOnce = async (message: AssistantMessage, failed: boolean): Promise<Error | undefined> => {
			if (released) return undefined;
			released = true;
			let accountingError: Error | undefined;
			if (options.governance && correlation.missionId) {
				try {
					await options.governance.recordInferenceResult({
						missionId: correlation.missionId,
						eventId: `${inferenceRequestId}:result`,
						provider: model.provider,
						model: model.id,
						inputTokens: message.usage?.input,
						outputTokens: message.usage?.output,
						costUsd: model.provider.startsWith("llamacpp-") ? undefined : message.usage?.cost.total,
						costStatus: model.provider.startsWith("llamacpp-")
							? undefined
							: message.usage?.cost.total === undefined
								? "UNKNOWN"
								: "KNOWN",
						atMs: Date.now(),
					});
				} catch (error) {
					accountingError = error instanceof Error ? error : new Error(String(error));
				}
			}
			try {
				await admission!.release(acquired.admitted, {
					state: failed || accountingError ? "FAILED" : "COMPLETED",
					usage:
						failed || accountingError
							? undefined
							: { input: message.usage?.input, output: message.usage?.output },
					errorMessage: accountingError?.message ?? (failed ? message.errorMessage : undefined),
				});
				if (failed || accountingError)
					await options.runtime?.transition(logicalAgentId, "RUNNABLE", {
						waitingReason: undefined,
						pendingInferenceRequestId: undefined,
					});
				else await options.runtime?.resume(logicalAgentId);
			} catch (error) {
				return error instanceof Error ? error : new Error(String(error));
			}
			return accountingError;
		};

		void (async () => {
			try {
				for await (const event of delegateStream) {
					if (event.type === "done") {
						const releaseError = await releaseOnce(event.message, false);
						if (releaseError) {
							stream.push({ type: "error", reason: "error", error: syntheticFailure(releaseError.message) });
							stream.end();
							return;
						}
						stream.push(event);
						return;
					}
					if (event.type === "error") {
						await releaseOnce(event.error, true);
						stream.push(event);
						return;
					}
					stream.push(event);
				}
				// Delegate ended without a terminal event: release honestly, never
				// fabricate a completion.
				await releaseOnce(syntheticFailure("provider stream ended without a terminal event"), true);
				stream.end();
			} catch (error) {
				await releaseOnce(syntheticFailure(error instanceof Error ? error.message : String(error)), true);
				stream.end();
			}
		})();

		return stream;
	};
}
