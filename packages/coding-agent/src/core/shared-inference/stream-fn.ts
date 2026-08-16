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
import type { LocalSubagentRuntime } from "./runtime.js";
import type { SharedInferenceScheduler } from "./scheduler.js";

export interface ScheduledStreamCorrelation {
	logicalAgentId: string;
	missionId?: string;
	assignmentId?: string;
	executionId?: string;
}

export interface ScheduledStreamFnOptions {
	scheduler: SharedInferenceScheduler;
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

	return async (model, context, streamOptions) => {
		const resource = options.scheduler.resourceFor(model);
		if (!resource) {
			// Non-shared provider: unchanged behavior.
			return delegate(model, context, streamOptions);
		}

		const correlation = options.getCorrelation
			? options.getCorrelation(model, context, (streamOptions ?? {}) as Record<string, unknown>)
			: { logicalAgentId: "unknown" };
		const logicalAgentId = correlation.logicalAgentId;
		const inferenceRequestId = `inference_${randomUUID()}`;

		await options.runtime?.transition(logicalAgentId, "WAITING_INFERENCE", {
			waitingReason: "shared inference admission",
			pendingInferenceRequestId: inferenceRequestId,
		});

		const acquired = await options.scheduler.acquire({
			logicalAgentId,
			resource,
			model,
			inferenceRequestId,
			missionId: correlation.missionId,
			assignmentId: correlation.assignmentId,
			executionId: correlation.executionId,
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

		const stream = delegate(model, context, streamOptions);

		void stream
			.result()
			.then(
				async (message) => {
					try {
						await options.scheduler.release(acquired.admitted, {
							state: "COMPLETED",
							usage: { input: message.usage?.input, output: message.usage?.output },
						});
						await options.runtime?.resume(logicalAgentId);
					} catch {
						// Best-effort; recovery reconciles a corrupt ledger honestly.
					}
				},
				async (error) => {
					try {
						await options.scheduler.release(acquired.admitted, {
							state: "FAILED",
							errorMessage: error instanceof Error ? error.message : String(error),
						});
						await options.runtime?.transition(logicalAgentId, "RUNNABLE", {
							waitingReason: undefined,
							pendingInferenceRequestId: undefined,
						});
					} catch {
						// Best-effort; recovery reconciles a corrupt ledger honestly.
					}
				},
			)
			.catch(() => {
				// Never surface a release failure as an unhandled rejection.
			});

		return stream;
	};
}
