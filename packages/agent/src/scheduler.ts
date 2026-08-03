import type { ToolEffects } from "./types.js";

/**
 * Parallel-safe deterministic scheduler.
 *
 * Executes a batch of tool calls, running only explicitly parallel-safe
 * read-only calls concurrently while preserving:
 *  - serial barriers for any mutating / exclusive / unknown-effect call;
 *  - dependency ordering (call B consuming call A runs after A);
 *  - bounded global, per-tool, per-host and per-server concurrency;
 *  - deterministic model-visible result ordering (original call order);
 *  - cancellation propagation to queued and active calls.
 *
 * Execution may finish out of order; PRESENTATION is always the original
 * canonical call order.
 */

export interface SchedulerCall<TCall = unknown> {
	/** Original position in the caller's canonical ordering. */
	index: number;
	toolCallId: string;
	toolName: string;
	args: TCall;
	effects?: ToolEffects;
	/** Explicit per-call concurrency safety override (overrides effects). */
	concurrencySafe?: boolean;
	/** toolCallIds whose results this call consumes (dependency edges). */
	consumes?: string[];
	/** Shared resource key (e.g. an exclusive workspace lease). */
	resource?: string;
	/** Network host for a per-host concurrency limit. */
	host?: string;
	/** LSP server id for a per-server request concurrency limit. */
	serverId?: string;
	/** Executes the call; must reject when aborted. */
	run: (signal?: AbortSignal) => Promise<{ result: unknown; isError: boolean }>;
}

export interface SchedulerLimits {
	globalMax?: number;
	perTool?: number;
	perHost?: number;
	perServer?: number;
}

const DEFAULT_LIMITS: Required<SchedulerLimits> = {
	globalMax: 8,
	perTool: 4,
	perHost: 3,
	perServer: 2,
};

export interface SchedulerResult<TOut = unknown> {
	index: number;
	toolCallId: string;
	executionGroupId: string;
	startedAt: number;
	finishedAt: number;
	cancelled: boolean;
	result: TOut;
	isError: boolean;
}

export class DeterministicParallelScheduler {
	private limits: Required<SchedulerLimits>;
	private groupSeq = 0;

	constructor(limits: SchedulerLimits = {}) {
		this.limits = { ...DEFAULT_LIMITS, ...limits };
	}

	/** True when this call must act as a serial barrier. */
	private isSerialBarrier(call: SchedulerCall): boolean {
		if (call.effects) {
			const e = call.effects;
			if (
				e.writesWorkspace ||
				e.createsFiles ||
				e.deletesFiles ||
				e.mutatesGit ||
				e.mutatesExternalState ||
				e.executesProcesses ||
				e.startsPersistentProcesses ||
				e.requiresExclusiveWorkspaceLease ||
				e.potentiallyDestructive
			) {
				return true;
			}
			if (e.scopes?.some((s) => s.kind === "unknown")) return true;
			if (e.parallelSafe === false) return true;
		}
		// Conservative default: absent or negative concurrency declaration is a barrier.
		return !(call.concurrencySafe ?? call.effects?.parallelSafe === true);
	}

	private callsConflict(a: SchedulerCall, b: SchedulerCall): boolean {
		// Shared exclusively-guarded resource.
		if (a.resource && b.resource && a.resource === b.resource) return true;
		// Same LSP server request category serialized.
		if (
			a.serverId &&
			b.serverId &&
			a.serverId === b.serverId &&
			needsServerSerialization(a) &&
			needsServerSerialization(b)
		) {
			return true;
		}
		return false;
	}

	/**
	 * Partition calls into sequential waves. Calls in the same wave can run
	 * concurrently; serial barriers and dependency edges separate waves.
	 */
	private partitionWaves(calls: SchedulerCall[]): SchedulerCall[][] {
		const waves: SchedulerCall[][] = [];
		let current: SchedulerCall[] = [];
		const emittedByCallId = new Map<string, number>(); // callId -> wave index
		let waveIndex = 0;

		for (const call of calls) {
			const barrier = this.isSerialBarrier(call);
			const dependsOnPast =
				call.consumes?.some((id) => {
					const w = emittedByCallId.get(id);
					return w !== undefined && w < waveIndex;
				}) ?? false;
			const conflict = current.length > 0 && current.some((c) => this.callsConflict(call, c));

			if (current.length > 0 && (barrier || dependsOnPast || conflict)) {
				waves.push(current);
				current = [];
				waveIndex += 1;
			}
			if (barrier) {
				// A barrier call runs entirely alone (its own wave).
				waves.push([call]);
				waveIndex += 1;
			} else {
				current.push(call);
			}
			emittedByCallId.set(call.toolCallId, waveIndex);
		}
		if (current.length > 0) waves.push(current);
		return waves.filter((w) => w.length > 0);
	}

	/**
	 * Execute all calls, preserving original order in the returned results.
	 */
	async run(calls: SchedulerCall[], signal: AbortSignal | undefined): Promise<SchedulerResult[]> {
		const ordered = [...calls].sort((a, b) => a.index - b.index);
		const _byId = new Map(ordered.map((c) => [c.toolCallId, c]));
		const waves = this.partitionWaves(ordered);
		const allResults: SchedulerResult[] = [];

		for (const wave of waves) {
			const groupId = `g-${++this.groupSeq}`;
			const waveResults = await this.runWave(wave, groupId, signal);
			// Deterministic presentation: restore original call order within wave.
			waveResults.sort((a, b) => a.index - b.index);
			allResults.push(...waveResults);
		}
		// Final safety: order by original index.
		allResults.sort((a, b) => a.index - b.index);
		return allResults;
	}

	private async runWave(
		wave: SchedulerCall[],
		groupId: string,
		signal: AbortSignal | undefined,
	): Promise<SchedulerResult[]> {
		// Bounded-concurrency pool.
		const results: SchedulerResult[] = [];
		let next = 0;
		const perToolCount = new Map<string, number>();
		const perHostCount = new Map<string, number>();
		const perServerCount = new Map<string, number>();

		const slotLimit = Math.max(1, Math.min(this.limits.globalMax, wave.length));

		const worker = async (): Promise<void> => {
			while (true) {
				const idx = next++;
				if (idx >= wave.length) return;
				const call = wave[idx];
				await waitForSlot(call, perToolCount, perHostCount, perServerCount, this.limits, signal);
				const callStarted = Date.now();
				let cancelled = false;
				let outcome = { result: undefined as unknown, isError: true };
				try {
					if (signal?.aborted) {
						cancelled = true;
						outcome = { result: "cancelled", isError: true };
					} else {
						outcome = await call.run(signal);
					}
				} catch (err) {
					cancelled = signal?.aborted ?? false;
					outcome = { result: err instanceof Error ? err.message : String(err), isError: true };
				} finally {
					decSlot(call, perToolCount, perHostCount, perServerCount);
				}
				results.push({
					index: call.index,
					toolCallId: call.toolCallId,
					executionGroupId: groupId,
					startedAt: callStarted,
					finishedAt: Date.now(),
					cancelled,
					result: outcome.result,
					isError: outcome.isError,
				});
			}
		};

		const workers: Promise<void>[] = [];
		for (let i = 0; i < slotLimit; i++) workers.push(worker());
		await Promise.all(workers);
		return results;
	}
}

function needsServerSerialization(call: SchedulerCall): boolean {
	// Mutating/document-sync requests serialize; pure semantic reads may run
	// concurrently when the server supports it. Conservative: serialize unless
	// explicitly flagged as a safe read.
	if (call.concurrencySafe === true) return false;
	return true;
}

function waitForSlot(
	call: SchedulerCall,
	perTool: Map<string, number>,
	perHost: Map<string, number>,
	perServer: Map<string, number>,
	limits: Required<SchedulerLimits>,
	signal: AbortSignal | undefined,
): Promise<void> {
	return new Promise((resolve) => {
		const check = () => {
			if (signal?.aborted) {
				resolve();
				return;
			}
			const t = (perTool.get(call.toolName) ?? 0) < limits.perTool;
			const h = !call.host || (perHost.get(call.host) ?? 0) < limits.perHost;
			const s = !call.serverId || (perServer.get(call.serverId) ?? 0) < limits.perServer;
			if (t && h && s) {
				perTool.set(call.toolName, (perTool.get(call.toolName) ?? 0) + 1);
				if (call.host) perHost.set(call.host, (perHost.get(call.host) ?? 0) + 1);
				if (call.serverId) perServer.set(call.serverId, (perServer.get(call.serverId) ?? 0) + 1);
				resolve();
			} else {
				setTimeout(check, 1);
			}
		};
		check();
	});
}

function decSlot(
	call: SchedulerCall,
	perTool: Map<string, number>,
	perHost: Map<string, number>,
	perServer: Map<string, number>,
): void {
	const t = (perTool.get(call.toolName) ?? 1) - 1;
	if (t <= 0) perTool.delete(call.toolName);
	else perTool.set(call.toolName, t);
	if (call.host) {
		const h = (perHost.get(call.host) ?? 1) - 1;
		if (h <= 0) perHost.delete(call.host);
		else perHost.set(call.host, h);
	}
	if (call.serverId) {
		const s = (perServer.get(call.serverId) ?? 1) - 1;
		if (s <= 0) perServer.delete(call.serverId);
		else perServer.set(call.serverId, s);
	}
}
