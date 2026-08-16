/**
 * First-Class Mission Executor contract (2.3.0).
 *
 * The executor seam decouples mission identity from any execution mechanism.
 * Executors accept a canonical MissionRequest, produce a canonical
 * MissionHandle, and resolve a canonical MissionResult. Nothing in this file
 * references Node ChildProcess, a provider client, a CLI parser, or UI.
 */

import type { MissionHandle } from "./mission-handle.js";
import type { MissionRequest } from "./mission-request.js";
import { type MissionResult, shouldContinueMissionChain } from "./mission-result.js";

export interface MissionLaunchOptions {
	signal?: AbortSignal;
	/**
	 * Execution fencing identity (leaseId + fencingToken) carried into the
	 * executor launch so a remote substrate can correlate its result back to the
	 * authoritative owner. The durable coordinator remains the only authority
	 * that accepts/rejects the terminal commit; this field is correlation, not
	 * authorization.
	 */
	fencing?: { leaseId: string; fencingToken: number };
}

export interface MissionExecutor {
	/**
	 * Stable executor identity (e.g. "process", "in-process", "remote"). Used to
	 * select an executor and to tag executor diagnostics.
	 */
	readonly executorId: string;

	/** Launch a mission and return a handle immediately (or after the child is started). */
	launch(request: MissionRequest, options?: MissionLaunchOptions): Promise<MissionHandle>;

	/** Resolve a launched mission to its final MissionResult. */
	awaitResult(handle: MissionHandle, options?: { signal?: AbortSignal }): Promise<MissionResult>;

	/** Request cancellation of a launched mission. Idempotent. */
	cancel(handle: MissionHandle, reason?: string): Promise<void>;
}

// =============================================================================
// MissionExecutionService
// =============================================================================

export class MissionExecutionService {
	private readonly _executors = new Map<string, MissionExecutor>();
	private _defaultExecutorId = "process";

	register(executor: MissionExecutor): void {
		this._executors.set(executor.executorId, executor);
	}

	/** Set the executor used when no explicit executorId is supplied. */
	setDefaultExecutorId(executorId: string): void {
		this._defaultExecutorId = executorId;
	}

	executor(executorId: string): MissionExecutor {
		const executor = this._executors.get(executorId);
		if (!executor) throw new Error(`Unknown mission executor: ${executorId}`);
		return executor;
	}

	/**
	 * Launch + await a single mission, producing a MissionResult. The caller
	 * reasons in domain terms; executor-specific machinery stays behind the seam.
	 */
	async execute(
		request: MissionRequest,
		options: { executorId?: string; signal?: AbortSignal } = {},
	): Promise<MissionResult> {
		const executor = this.executor(options.executorId ?? this._defaultExecutorId);
		const handle = await executor.launch(request, { signal: options.signal });
		return executor.awaitResult(handle, { signal: options.signal });
	}

	/**
	 * Execute several missions concurrently and return their individual
	 * MissionResults in request order. Aggregation is the caller's concern
	 * (see `aggregateMissionResults`); this method never collapses failures into
	 * a scalar success boolean.
	 */
	async executeMany(
		requests: readonly MissionRequest[],
		options: { executorId?: string; signal?: AbortSignal } = {},
	): Promise<MissionResult[]> {
		const executor = this.executor(options.executorId ?? this._defaultExecutorId);
		return Promise.all(
			requests.map(async (request) => {
				const handle = await executor.launch(request, { signal: options.signal });
				return executor.awaitResult(handle, { signal: options.signal });
			}),
		);
	}

	/**
	 * Execute missions sequentially. The transitional runtime uses an
	 * execution-compatible chain policy: a child that SUCCEEDED (verified) or
	 * PARTIAL (execution completed normally but unverified) allows the next
	 * dependent child to run; a hard failure (FAILED / CANCELLED / TIMED_OUT /
	 * CRASHED) stops the chain. Returns the results produced up to and
	 * including the stopping child. Callers aggregate with
	 * `aggregateMissionResults` for a structured final verdict.
	 */
	async executeChain(
		requests: readonly MissionRequest[],
		options: { executorId?: string; signal?: AbortSignal } = {},
	): Promise<MissionResult[]> {
		const executor = this.executor(options.executorId ?? this._defaultExecutorId);
		const results: MissionResult[] = [];
		for (const request of requests) {
			const handle = await executor.launch(request, { signal: options.signal });
			const result = await executor.awaitResult(handle, { signal: options.signal });
			results.push(result);
			if (!shouldContinueMissionChain(result)) break;
		}
		return results;
	}
}
