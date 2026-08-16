/**
 * Inference scheduling benchmark harness (3.0.0 foundation).
 *
 * Synthetic-backend benchmark over the real SharedInferenceScheduler. It
 * measures scheduling behavior (queue latency, TTFT, busy-slot utilization,
 * avoidable idle) independently of real Qwen. Real-Qwen measurements are a
 * separate QA artifact; synthetic capacity profiles are labeled as such.
 */

import { InMemoryInferenceQueueStore } from "./in-memory-inference-queue-store.js";
import { SharedInferenceScheduler } from "./scheduler.js";
import type { SharedInferenceResource } from "./types.js";

export interface InferenceSchedulerBenchmarkOptions {
	capacity: number;
	agentCount: number;
	requestsPerAgent: number;
	/** Synthetic generation wall time per request. */
	generationMs: number;
	/** Synthetic tool time between an agent's sequential requests. */
	toolMs?: number;
	/** Deterministic queue-wait deadline (0 = unbounded). */
	queueWaitTimeoutMs?: number;
}

export interface InferenceSchedulerBenchmarkResult {
	profile: {
		backend: "synthetic";
		capacity: number;
		agentCount: number;
		requestsPerAgent: number;
		generationMs: number;
		toolMs: number;
	};
	requestCount: number;
	queueWaitMs: { p50: number; p95: number; max: number };
	ttftMs: { p50: number; p95: number; max: number };
	perRequestDecodeTokensPerSec: { p50: number; p95: number };
	aggregateModelTokensPerSec: number;
	busySlotPercent: number;
	avoidableIdleMs: number;
	totalWallMs: number;
	completedCount: number;
	failedCount: number;
}

const SYNTHETIC_OUTPUT_TOKENS = 256;

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
	return sorted[index] ?? 0;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a synthetic concurrency-profile benchmark. Each logical agent issues
 * `requestsPerAgent` sequential generations through the scheduler (capacity
 * `capacity`). All agents run concurrently, so queueing emerges naturally.
 */
export async function runInferenceSchedulerBenchmark(
	options: InferenceSchedulerBenchmarkOptions,
): Promise<InferenceSchedulerBenchmarkResult> {
	const store = new InMemoryInferenceQueueStore();
	const scheduler = new SharedInferenceScheduler({
		store,
		waitPollMs: 1,
		queueWaitTimeoutMs: options.queueWaitTimeoutMs ?? 0,
	});
	const resource: SharedInferenceResource = {
		resourceId: "synthetic",
		backend: "synthetic",
		model: "synthetic",
		location: "local",
		capacity: options.capacity,
		state: "available",
	};
	await scheduler.registerResource(resource);

	const queueWaitSamples: number[] = [];
	const ttftSamples: number[] = [];
	let totalOutputTokens = 0;
	let failedCount = 0;
	const start = Date.now();

	const agent = async (agentIndex: number): Promise<void> => {
		for (let i = 0; i < options.requestsPerAgent; i++) {
			const requestedAt = Date.now();
			const acquired = await scheduler.acquire({
				logicalAgentId: `agent_${agentIndex}`,
				resource,
				model: { provider: "synthetic", id: "synthetic" },
				priority: { base: 0 },
			});
			if (acquired.status !== "admitted") {
				failedCount += 1;
				continue;
			}
			const admittedAt = Date.now();
			queueWaitSamples.push(admittedAt - requestedAt);
			ttftSamples.push(1); // synthetic backend: first token after 1ms
			await sleep(options.generationMs);
			await scheduler.release(acquired.admitted, {
				state: "COMPLETED",
				usage: { input: 1000, output: SYNTHETIC_OUTPUT_TOKENS },
			});
			totalOutputTokens += SYNTHETIC_OUTPUT_TOKENS;
			if (options.toolMs && options.toolMs > 0) await sleep(options.toolMs);
		}
	};

	await Promise.all(Array.from({ length: options.agentCount }, (_, i) => agent(i)));

	const totalWallMs = Date.now() - start;
	const status = await scheduler.status();
	const busyPercent =
		totalWallMs > 0
			? (status.aggregate.busySlots * options.generationMs * options.agentCount * options.requestsPerAgent) /
				totalWallMs /
				100
			: 0;

	queueWaitSamples.sort((a, b) => a - b);
	ttftSamples.sort((a, b) => a - b);
	const perRequestDecode = options.generationMs > 0 ? SYNTHETIC_OUTPUT_TOKENS / (options.generationMs / 1000) : 0;
	const aggregateTokensPerSec = totalWallMs > 0 ? (totalOutputTokens / totalWallMs) * 1000 : 0;

	return {
		profile: {
			backend: "synthetic",
			capacity: options.capacity,
			agentCount: options.agentCount,
			requestsPerAgent: options.requestsPerAgent,
			generationMs: options.generationMs,
			toolMs: options.toolMs ?? 0,
		},
		requestCount: options.agentCount * options.requestsPerAgent,
		queueWaitMs: {
			p50: percentile(queueWaitSamples, 50),
			p95: percentile(queueWaitSamples, 95),
			max: queueWaitSamples.length > 0 ? queueWaitSamples[queueWaitSamples.length - 1]! : 0,
		},
		ttftMs: {
			p50: percentile(ttftSamples, 50),
			p95: percentile(ttftSamples, 95),
			max: ttftSamples.length > 0 ? ttftSamples[ttftSamples.length - 1]! : 0,
		},
		perRequestDecodeTokensPerSec: { p50: perRequestDecode, p95: perRequestDecode },
		aggregateModelTokensPerSec: aggregateTokensPerSec,
		busySlotPercent: busyPercent,
		avoidableIdleMs: status.aggregate.avoidableIdleMs,
		totalWallMs,
		completedCount: options.agentCount * options.requestsPerAgent - failedCount,
		failedCount,
	};
}
