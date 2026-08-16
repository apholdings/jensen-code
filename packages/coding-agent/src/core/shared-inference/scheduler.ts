/**
 * Shared Inference Scheduler (3.0.0 foundation).
 *
 * Central admission authority for physical inference slots. It controls WHEN a
 * model request may run; it is NOT the model provider and never reimplements
 * provider protocol/stream handling. Scheduling/admission is kept separate from
 * provider protocol handling.
 *
 * Cross-process coordination: the scheduler mutates a durable per-resource
 * ledger (see InferenceQueueStore). Two OS processes sharing the same ledger
 * cannot each believe they own all physical slots. Slot acquisition is a
 * temporary fenced lease; it is never durable agent ownership.
 *
 * Determinism: with the same queued requests, priorities, dependency metadata,
 * controlled clock, and capacity, admission order is deterministic
 * (effective-priority desc, then enqueue time, then request id).
 */

import { randomUUID } from "node:crypto";
import { newExecutorOwnerId } from "../mission-domain/execution-lease.js";
import type { InferenceQueueStore, InferenceResourceLedger } from "./inference-queue.js";
import type {
	AcquireInferenceOutcome,
	AdmittedInference,
	EnqueueInferenceOutcome,
	InferenceAdmissionStatus,
	InferencePriority,
	InferenceRecoveryReport,
	InferenceRequestDependency,
	InferenceRequestLease,
	InferenceRequestRecord,
	InferenceRequestStatus,
	ReleaseInferenceOutcome,
	RenewInferenceOutcome,
	SharedInferenceResource,
	SharedInferenceResourceStatus,
	SharedInferenceSchedulerStatus,
} from "./types.js";

// =============================================================================
// Options
// =============================================================================

export interface SharedInferenceSchedulerOptions {
	store: InferenceQueueStore;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	/** Lease lifetime for an admitted slot (default 10 minutes). */
	leaseDurationMs?: number;
	leaseIdFactory?: () => string;
	requestIdFactory?: () => string;
	/** Stable control-plane owner identity (default host+UUID, never PID). */
	ownerId?: string;
	/** Poll cadence while waiting for cross-process admission. */
	waitPollMs?: number;
	/** Optional queue-wait deadline (0 = unbounded). */
	queueWaitTimeoutMs?: number;
	/** Deterministic priority policy knobs. */
	interactiveBoost?: number;
	verificationBoost?: number;
	dependencyWeight?: number;
	dependencyCap?: number;
	agingIntervalMs?: number;
	agingWeight?: number;
}

const DEFAULT_LEASE_DURATION_MS = 10 * 60_000;
const DEFAULT_WAIT_POLL_MS = 100;
const DEFAULT_INTERACTIVE_BOOST = 100;
const DEFAULT_VERIFICATION_BOOST = 200;
const DEFAULT_DEPENDENCY_WEIGHT = 50;
const DEFAULT_DEPENDENCY_CAP = 500;
const DEFAULT_AGING_INTERVAL_MS = 1000;
const DEFAULT_AGING_WEIGHT = 1;

// =============================================================================
// Priority (deterministic, explainable)
// =============================================================================

interface PriorityBreakdown {
	base: number;
	interactive: number;
	verification: number;
	dependency: number;
	aging: number;
	effective: number;
}

export function isInferenceRequestLeaseActive(lease: InferenceRequestLease, now: number): boolean {
	return lease.expiresAtMs > now;
}

// =============================================================================
// Scheduler
// =============================================================================

export class SharedInferenceScheduler {
	private readonly _store: InferenceQueueStore;
	private readonly _resources = new Map<string, SharedInferenceResource>();
	private readonly _now: () => number;
	private readonly _sleep: (ms: number) => Promise<void>;
	private readonly _leaseDurationMs: number;
	private readonly _leaseIdFactory: () => string;
	private readonly _requestIdFactory: () => string;
	private readonly _ownerId: string;
	private readonly _waitPollMs: number;
	private readonly _queueWaitTimeoutMs: number;
	private readonly _interactiveBoost: number;
	private readonly _verificationBoost: number;
	private readonly _dependencyWeight: number;
	private readonly _dependencyCap: number;
	private readonly _agingIntervalMs: number;
	private readonly _agingWeight: number;
	private _avoidableIdleSinceMs?: number;
	private _avoidableIdleTotalMs = 0;

	constructor(options: SharedInferenceSchedulerOptions) {
		this._store = options.store;
		this._now = options.now ?? (() => Date.now());
		this._sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this._leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
		this._leaseIdFactory = options.leaseIdFactory ?? (() => `inflease_${randomUUID()}`);
		this._requestIdFactory = options.requestIdFactory ?? (() => `inference_${randomUUID()}`);
		this._ownerId = options.ownerId ?? newExecutorOwnerId();
		this._waitPollMs = options.waitPollMs ?? DEFAULT_WAIT_POLL_MS;
		this._queueWaitTimeoutMs = options.queueWaitTimeoutMs ?? 0;
		this._interactiveBoost = options.interactiveBoost ?? DEFAULT_INTERACTIVE_BOOST;
		this._verificationBoost = options.verificationBoost ?? DEFAULT_VERIFICATION_BOOST;
		this._dependencyWeight = options.dependencyWeight ?? DEFAULT_DEPENDENCY_WEIGHT;
		this._dependencyCap = options.dependencyCap ?? DEFAULT_DEPENDENCY_CAP;
		this._agingIntervalMs = options.agingIntervalMs ?? DEFAULT_AGING_INTERVAL_MS;
		this._agingWeight = options.agingWeight ?? DEFAULT_AGING_WEIGHT;
	}

	get ownerId(): string {
		return this._ownerId;
	}

	get store(): InferenceQueueStore {
		return this._store;
	}

	// =========================================================================
	// Resource registry
	// =========================================================================

	/** Register (or refresh) a shared resource and ensure its ledger exists. */
	async registerResource(resource: SharedInferenceResource): Promise<void> {
		if (resource.capacity < 1) throw new Error(`Resource ${resource.resourceId} capacity must be >= 1`);
		this._resources.set(resource.resourceId, { ...resource });
		const created = await this._store.create(resource.resourceId, {
			schemaVersion: 1,
			resourceId: resource.resourceId,
			capacity: resource.capacity,
			running: [],
			queue: [],
			history: [],
			nextSeq: 0,
			fencingToken: 0,
			completedCount: 0,
			cancelledCount: 0,
			failedCount: 0,
			interruptedCount: 0,
			totalQueueWaitMs: 0,
			totalInferenceMs: 0,
			totalInputTokens: 0,
			totalOutputTokens: 0,
			maxQueueDepth: 0,
			updatedAtMs: this._now(),
			revision: 1,
		});
		if (created.status === "conflict")
			throw new Error(`Cannot register resource ${resource.resourceId}: ${created.error}`);
	}

	/** Resolve the shared resource a model targets, or undefined (non-shared path). */
	resourceFor(model: { provider: string; id: string }): SharedInferenceResource | undefined {
		for (const resource of this._resources.values()) {
			if (resource.backend === model.provider && resource.model === model.id) return { ...resource };
		}
		return undefined;
	}

	listResources(): SharedInferenceResource[] {
		return [...this._resources.values()]
			.map((r) => ({ ...r }))
			.sort((a, b) => a.resourceId.localeCompare(b.resourceId));
	}

	// =========================================================================
	// Admission
	// =========================================================================

	/**
	 * Non-blocking enqueue (or immediate admit) of an inference request. This is
	 * the single authority for turning a request into either an admitted lease or
	 * a durable queued entry; `acquire` composes it with a bounded wait loop.
	 * The admission service uses `enqueue` + `admissionStatus` to expose a
	 * request/wait protocol to remote clients without duplicating the algorithm.
	 */
	async enqueue(input: {
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
	}): Promise<EnqueueInferenceOutcome> {
		const request = this._buildRequest(input);
		const result = await this._enqueueOrAdmit(request.resourceId, request);
		if (result.status === "admitted") return { status: "admitted", admitted: result.admitted };
		if (result.status === "queued")
			return { status: "queued", inferenceRequestId: result.inferenceRequestId, position: result.position };
		// The enqueue path can only produce admitted/queued; anything else is a
		// structural defect surfaced loudly rather than coerced.
		throw new Error(`Unexpected enqueue outcome: ${(result as { status: string }).status}`);
	}

	/** Pollable admission state for a request owned by this scheduler instance. */
	async admissionStatus(
		inferenceRequestId: string,
		options: { ownerId?: string } = {},
	): Promise<InferenceAdmissionStatus> {
		const ownerId = options.ownerId ?? this._ownerId;
		for (const resourceId of await this._store.listResources()) {
			const loaded = await this._store.load(resourceId);
			if (loaded.status !== "ok") continue;
			const ledger = loaded.ledger;
			const running = ledger.running.find(
				(r) => r.inferenceRequestId === inferenceRequestId && r.lease?.ownerId === ownerId,
			);
			if (running?.lease) return { status: "admitted", admitted: this._toAdmitted(running) };
			const queuedIndex = ledger.queue.findIndex((r) => r.inferenceRequestId === inferenceRequestId);
			if (queuedIndex >= 0) {
				return { status: "queued", inferenceRequestId, position: queuedIndex + 1 };
			}
			const summary = ledger.history.find((r) => r.inferenceRequestId === inferenceRequestId);
			if (summary) return { status: "terminal", inferenceRequestId, state: summary.state };
		}
		return { status: "unknown", inferenceRequestId };
	}

	/** Renew an active lease (keeps long-running generations from expiring mid-stream). */
	async renew(admitted: AdmittedInference, options: { now?: number } = {}): Promise<RenewInferenceOutcome> {
		const now = options.now ?? this._now();
		const result = await this._store.mutate<RenewInferenceOutcome>(admitted.resourceId, (ledger) => {
			const index = ledger.running.findIndex((r) => r.inferenceRequestId === admitted.inferenceRequestId);
			if (index < 0)
				return { kind: "noop", value: { status: "not_found", inferenceRequestId: admitted.inferenceRequestId } };
			const running = ledger.running[index];
			if (
				!running.lease ||
				running.lease.leaseId !== admitted.lease.leaseId ||
				running.lease.ownerId !== this._ownerId
			) {
				return { kind: "noop", value: { status: "not_found", inferenceRequestId: admitted.inferenceRequestId } };
			}
			const expiresAtMs = now + this._leaseDurationMs;
			const next: InferenceResourceLedger = {
				...ledger,
				running: ledger.running.map((r, i) => (i === index ? { ...r, lease: { ...r.lease!, expiresAtMs } } : r)),
				updatedAtMs: now,
				revision: ledger.revision + 1,
			};
			return {
				kind: "write",
				next,
				value: {
					status: "renewed",
					admitted: this._toAdmitted({ ...running, lease: { ...running.lease!, expiresAtMs } }),
					expiresAtMs,
				},
			};
		});
		if (result.status === "missing") return { status: "not_found", inferenceRequestId: admitted.inferenceRequestId };
		if (result.status === "corrupt")
			throw new Error(`Inference queue for ${admitted.resourceId} is corrupt: ${result.diagnostic}`);
		return result.value;
	}

	/**
	 * Request an inference slot. If capacity is available the request is admitted
	 * immediately; otherwise it is durably queued and the caller waits (bounded
	 * poll, abortable, queue-timeout aware) until admission, cancellation, or
	 * timeout.
	 */
	async acquire(input: {
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
		signal?: AbortSignal;
		queueWaitTimeoutMs?: number;
	}): Promise<AcquireInferenceOutcome> {
		const inferenceRequestId = input.inferenceRequestId ?? this._requestIdFactory();

		const first = await this.enqueue({
			...input,
			inferenceRequestId,
		});
		if (first.status === "admitted") return { status: "admitted", admitted: first.admitted };

		const enqueuedAtMs = this._now();
		const timeoutMs = input.queueWaitTimeoutMs ?? this._queueWaitTimeoutMs;
		while (true) {
			if (input.signal?.aborted) {
				await this.cancel(inferenceRequestId);
				return { status: "cancelled", inferenceRequestId, reason: "aborted" };
			}
			const waitedMs = this._now() - enqueuedAtMs;
			if (timeoutMs > 0 && waitedMs >= timeoutMs) {
				await this.cancel(inferenceRequestId);
				return { status: "queue_timeout", inferenceRequestId, waitedMs };
			}

			const state = await this.admissionStatus(inferenceRequestId);
			if (state.status === "admitted") return { status: "admitted", admitted: state.admitted };
			if (state.status === "terminal")
				return { status: "cancelled", inferenceRequestId, reason: `terminal:${state.state}` };
			if (state.status === "unknown") {
				return { status: "cancelled", inferenceRequestId, reason: "removed_from_queue" };
			}

			await this._sleep(this._waitPollMs);
		}
	}

	private _buildRequest(input: {
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
	}): InferenceRequestRecord {
		const now = this._now();
		const requestId = input.inferenceRequestId ?? this._requestIdFactory();
		return {
			schemaVersion: 1,
			inferenceRequestId: requestId,
			logicalAgentId: input.logicalAgentId,
			ownerId: this._ownerId,
			missionId: input.missionId,
			assignmentId: input.assignmentId,
			executionId: input.executionId,
			resourceId: input.resource.resourceId,
			provider: input.model.provider,
			model: input.model.id,
			requestedAtMs: now,
			enqueuedAtMs: now,
			priority: input.priority ?? { base: 0 },
			dependency: input.dependency,
			estimatedInputTokens: input.estimatedInputTokens,
			maxOutputTokens: input.maxOutputTokens,
			state: "QUEUED",
		};
	}

	private async _enqueueOrAdmit(
		resourceId: string,
		request: InferenceRequestRecord,
	): Promise<AcquireInferenceOutcome> {
		const now = this._now();
		const result = await this._store.mutate<AcquireInferenceOutcome>(resourceId, (ledger) => {
			const running = ledger.running.find((r) => r.inferenceRequestId === request.inferenceRequestId);
			if (running?.lease) {
				return { kind: "noop", value: { status: "admitted" as const, admitted: this._toAdmitted(running) } };
			}
			const queuedIndex = ledger.queue.findIndex((r) => r.inferenceRequestId === request.inferenceRequestId);
			if (queuedIndex >= 0) {
				return {
					kind: "noop",
					value: {
						status: "queued" as const,
						inferenceRequestId: request.inferenceRequestId,
						position: queuedIndex + 1,
					},
				};
			}

			if (ledger.running.length < ledger.capacity) {
				const next = this._admitInto(ledger, request, now, { incrementFence: true });
				return {
					kind: "write",
					next,
					value: { status: "admitted" as const, admitted: this._admittedFrom(next, request.inferenceRequestId) },
				};
			}

			const queued: InferenceRequestRecord = { ...request, state: "QUEUED" };
			const queue = [...ledger.queue, queued];
			const next: InferenceResourceLedger = {
				...ledger,
				queue,
				maxQueueDepth: Math.max(ledger.maxQueueDepth, queue.length),
				updatedAtMs: now,
				revision: ledger.revision + 1,
			};
			return {
				kind: "write",
				next,
				value: {
					status: "queued" as const,
					inferenceRequestId: request.inferenceRequestId,
					position: queue.length,
				},
			};
		});

		if (result.status === "missing") {
			throw new Error(`Inference resource ${resourceId} is not registered`);
		}
		if (result.status === "corrupt") {
			throw new Error(`Inference queue for ${resourceId} is corrupt: ${result.diagnostic}`);
		}
		return result.value;
	}

	/** Release an admitted slot and promote queued work. Fenced by lease identity. */
	async release(
		admitted: AdmittedInference,
		outcome: {
			state: "COMPLETED" | "FAILED" | "CANCELLED" | "INTERRUPTED";
			usage?: { input?: number; output?: number };
			errorMessage?: string;
		},
	): Promise<ReleaseInferenceOutcome> {
		const now = this._now();
		const result = await this._store.mutate<ReleaseInferenceOutcome>(admitted.resourceId, (ledger) => {
			const index = ledger.running.findIndex((r) => r.inferenceRequestId === admitted.inferenceRequestId);
			if (index < 0) return { kind: "noop", value: { status: "not_found" as const } };
			const running = ledger.running[index];
			if (
				!running.lease ||
				running.lease.leaseId !== admitted.lease.leaseId ||
				running.lease.ownerId !== this._ownerId
			) {
				return { kind: "noop", value: { status: "not_found" as const } };
			}

			const finishedAtMs = now;
			const queueWaitMs = running.admittedAtMs
				? running.admittedAtMs - running.enqueuedAtMs
				: now - running.enqueuedAtMs;
			const inferenceWallMs = running.admittedAtMs ? finishedAtMs - running.admittedAtMs : 0;
			const summary = {
				inferenceRequestId: running.inferenceRequestId,
				logicalAgentId: running.logicalAgentId,
				resourceId: running.resourceId,
				provider: running.provider,
				model: running.model,
				requestedAtMs: running.requestedAtMs,
				enqueuedAtMs: running.enqueuedAtMs,
				state: outcome.state,
				admittedAtMs: running.admittedAtMs,
				finishedAtMs,
				queueWaitMs,
				inferenceWallMs,
				inputTokens: outcome.usage?.input,
				outputTokens: outcome.usage?.output,
				errorMessage: outcome.errorMessage,
			};

			const counters = {
				completedCount: outcome.state === "COMPLETED" ? ledger.completedCount + 1 : ledger.completedCount,
				cancelledCount: outcome.state === "CANCELLED" ? ledger.cancelledCount + 1 : ledger.cancelledCount,
				failedCount: outcome.state === "FAILED" ? ledger.failedCount + 1 : ledger.failedCount,
				interruptedCount: outcome.state === "INTERRUPTED" ? ledger.interruptedCount + 1 : ledger.interruptedCount,
			};

			const next: InferenceResourceLedger = {
				...ledger,
				running: ledger.running.filter((_, i) => i !== index),
				history: [summary, ...ledger.history].slice(0, 1000),
				...counters,
				totalQueueWaitMs: ledger.totalQueueWaitMs + queueWaitMs,
				totalInferenceMs: ledger.totalInferenceMs + inferenceWallMs,
				totalInputTokens: ledger.totalInputTokens + (outcome.usage?.input ?? 0),
				totalOutputTokens: ledger.totalOutputTokens + (outcome.usage?.output ?? 0),
				updatedAtMs: now,
				revision: ledger.revision + 1,
			};

			// Promote queued work up to free capacity.
			const promoted = this._promoteQueued(next, now);
			return {
				kind: "write",
				next: promoted,
				value: { status: "released" as const, inferenceRequestId: admitted.inferenceRequestId },
			};
		});

		if (result.status === "missing") return { status: "not_found" };
		if (result.status === "corrupt")
			throw new Error(`Inference queue for ${admitted.resourceId} is corrupt: ${result.diagnostic}`);
		return result.value;
	}

	/** Cancel a queued (or locally-owned running) request. Queued requests never consume a slot afterward. */
	async cancel(
		inferenceRequestId: string,
	): Promise<{ status: "cancelled" | "not_found" | "running"; inferenceRequestId: string }> {
		const now = this._now();
		const ids = await this._store.listResources();
		for (const resourceId of ids) {
			const result = await this._store.mutate<{ status: "cancelled" | "not_found" | "running" }>(
				resourceId,
				(ledger) => {
					const qIndex = ledger.queue.findIndex((r) => r.inferenceRequestId === inferenceRequestId);
					if (qIndex >= 0) {
						const request = ledger.queue[qIndex];
						const summary = {
							inferenceRequestId: request.inferenceRequestId,
							logicalAgentId: request.logicalAgentId,
							resourceId,
							provider: request.provider,
							model: request.model,
							requestedAtMs: request.requestedAtMs,
							enqueuedAtMs: request.enqueuedAtMs,
							state: "CANCELLED" as const,
							finishedAtMs: now,
							queueWaitMs: now - request.enqueuedAtMs,
						};
						const next: InferenceResourceLedger = {
							...ledger,
							queue: ledger.queue.filter((_, i) => i !== qIndex),
							history: [summary, ...ledger.history].slice(0, 1000),
							cancelledCount: ledger.cancelledCount + 1,
							totalQueueWaitMs: ledger.totalQueueWaitMs + (now - request.enqueuedAtMs),
							updatedAtMs: now,
							revision: ledger.revision + 1,
						};
						return { kind: "write", next, value: { status: "cancelled" as const } };
					}
					const rIndex = ledger.running.findIndex((r) => r.inferenceRequestId === inferenceRequestId);
					if (rIndex >= 0 && ledger.running[rIndex].lease?.ownerId === this._ownerId) {
						return { kind: "noop", value: { status: "running" as const } };
					}
					return { kind: "noop", value: { status: "not_found" as const } };
				},
			);
			if (result.status === "ok" && result.value.status !== "not_found") {
				return { status: result.value.status, inferenceRequestId };
			}
		}
		return { status: "not_found", inferenceRequestId };
	}

	// =========================================================================
	// Recovery (restart reconciliation)
	// =========================================================================

	/** Reconcile expired RUNNING leases after a scheduler/process restart. Never fabricates completion. */
	async recover(options: { now?: number } = {}): Promise<InferenceRecoveryReport> {
		const now = options.now ?? this._now();
		const ids = await this._store.listResources();
		const report: InferenceRecoveryReport = {
			scannedResources: ids.length,
			reconciledRequests: [],
			unchangedRunning: [],
			corruptResources: [],
			actions: [],
		};

		for (const resourceId of ids) {
			const loaded = await this._store.load(resourceId);
			if (loaded.status === "corrupt") {
				report.corruptResources.push({ resourceId, diagnostic: loaded.diagnostic });
				report.actions.push(`resource '${resourceId}' is corrupt; surfaced, not recovered`);
				continue;
			}
			if (loaded.status === "missing") continue;
			const ledger = loaded.ledger;

			const expired = ledger.running.filter((r) => !r.lease || !isInferenceRequestLeaseActive(r.lease, now));
			if (expired.length === 0) {
				for (const r of ledger.running) report.unchangedRunning.push(r.inferenceRequestId);
				continue;
			}

			const expiredIds = new Set(expired.map((r) => r.inferenceRequestId));
			const result = await this._store.mutate<{ reconciled: string[] }>(resourceId, (current) => {
				const stillExpired = current.running.filter(
					(r) => !r.lease || !isInferenceRequestLeaseActive(r.lease, now),
				);
				if (stillExpired.length === 0) return { kind: "noop", value: { reconciled: [] } };
				const idsToExpire = new Set(stillExpired.map((r) => r.inferenceRequestId));

				const history = stillExpired.map((r) => ({
					inferenceRequestId: r.inferenceRequestId,
					logicalAgentId: r.logicalAgentId,
					resourceId,
					provider: r.provider,
					model: r.model,
					requestedAtMs: r.requestedAtMs,
					enqueuedAtMs: r.enqueuedAtMs,
					state: "INTERRUPTED" as const,
					admittedAtMs: r.admittedAtMs,
					finishedAtMs: now,
					queueWaitMs: r.admittedAtMs ? r.admittedAtMs - r.enqueuedAtMs : now - r.enqueuedAtMs,
					inferenceWallMs: r.admittedAtMs ? now - r.admittedAtMs : 0,
				}));

				let next: InferenceResourceLedger = {
					...current,
					running: current.running.filter((r) => !idsToExpire.has(r.inferenceRequestId)),
					history: [...history, ...current.history].slice(0, 1000),
					interruptedCount: current.interruptedCount + stillExpired.length,
					updatedAtMs: now,
					revision: current.revision + 1,
				};
				next = this._promoteQueued(next, now);
				return { kind: "write", next, value: { reconciled: stillExpired.map((r) => r.inferenceRequestId) } };
			});

			if (result.status === "ok") {
				for (const id of result.value.reconciled) {
					report.reconciledRequests.push(id);
					report.actions.push(`inference request '${id}' reconciled RUNNING → INTERRUPTED (expired lease)`);
				}
			} else if (result.status === "corrupt") {
				report.corruptResources.push({ resourceId, diagnostic: result.diagnostic });
				report.actions.push(`resource '${resourceId}' became corrupt during recovery`);
			}
			for (const r of ledger.running) {
				if (!expiredIds.has(r.inferenceRequestId)) report.unchangedRunning.push(r.inferenceRequestId);
			}
		}

		return report;
	}

	// =========================================================================
	// Status / telemetry
	// =========================================================================

	async status(): Promise<SharedInferenceSchedulerStatus> {
		const now = this._now();
		const resources: SharedInferenceResourceStatus[] = [];
		const queue: InferenceRequestStatus[] = [];
		let totalSlots = 0;
		let busySlots = 0;
		let idleSlots = 0;
		let queueDepth = 0;
		let completedCount = 0;

		for (const resourceId of await this._store.listResources()) {
			const loaded = await this._store.load(resourceId);
			if (loaded.status !== "ok") continue;
			const ledger = loaded.ledger;
			const registered = this._resources.get(resourceId);
			const capacity = registered?.capacity ?? ledger.capacity;

			const contextActive = ledger.running.reduce((sum, r) => sum + (r.estimatedInputTokens ?? 0), 0);
			const contextQueued = ledger.queue.reduce((sum, r) => sum + (r.estimatedInputTokens ?? 0), 0);

			resources.push({
				resourceId,
				backend: registered?.backend ?? ledger.running[0]?.provider ?? ledger.queue[0]?.provider ?? "",
				model: registered?.model ?? ledger.running[0]?.model ?? ledger.queue[0]?.model ?? "",
				location: registered?.location ?? "",
				capacity,
				busySlots: ledger.running.length,
				idleSlots: Math.max(0, capacity - ledger.running.length),
				queueDepth: ledger.queue.length,
				completedCount: ledger.completedCount,
				cancelledCount: ledger.cancelledCount,
				failedCount: ledger.failedCount,
				interruptedCount: ledger.interruptedCount,
				totalQueueWaitMs: ledger.totalQueueWaitMs,
				totalInferenceMs: ledger.totalInferenceMs,
				totalInputTokens: ledger.totalInputTokens,
				totalOutputTokens: ledger.totalOutputTokens,
				maxQueueDepth: ledger.maxQueueDepth,
				contextTokensActive: contextActive,
				contextTokensQueued: contextQueued,
				state: registered?.state ?? "available",
				observedAtMs: now,
			});

			totalSlots += capacity;
			busySlots += ledger.running.length;
			idleSlots += Math.max(0, capacity - ledger.running.length);
			queueDepth += ledger.queue.length;
			completedCount += ledger.completedCount;

			for (const r of ledger.running) {
				queue.push(
					this._requestStatus(
						r,
						now,
						ledger.running.findIndex((x) => x.inferenceRequestId === r.inferenceRequestId) + 1,
					),
				);
			}
			const queued = this._sortedQueue(ledger.queue, now);
			for (let i = 0; i < queued.length; i++) queue.push(this._requestStatus(queued[i]!, now, i + 1));
		}

		this._observeAvoidableIdle(now, queueDepth, idleSlots);

		resources.sort((a, b) => a.resourceId.localeCompare(b.resourceId));
		queue.sort((a, b) =>
			a.effectivePriority === b.effectivePriority
				? a.queuedAtMs - b.queuedAtMs
				: b.effectivePriority - a.effectivePriority,
		);

		return {
			resources,
			queue,
			aggregate: {
				totalSlots,
				busySlots,
				idleSlots,
				queueDepth,
				completedCount,
				avoidableIdleMs: this._avoidableIdleTotalMs,
			},
			agents: { runningInference: 0, waitingInference: 0, tooling: 0, parked: 0, runnable: 0, total: 0 },
			observedAtMs: now,
		};
	}

	/** Deterministic avoidable-idle observation: queue non-empty + free slot + no admission. */
	private _observeAvoidableIdle(now: number, queueDepth: number, idleSlots: number): void {
		const avoidable = queueDepth > 0 && idleSlots > 0;
		if (avoidable) {
			if (this._avoidableIdleSinceMs === undefined) this._avoidableIdleSinceMs = now;
			this._avoidableIdleTotalMs += now - (this._avoidableIdleSinceMs ?? now);
			this._avoidableIdleSinceMs = now;
		} else {
			if (this._avoidableIdleSinceMs !== undefined) {
				this._avoidableIdleTotalMs += now - this._avoidableIdleSinceMs;
			}
			this._avoidableIdleSinceMs = undefined;
		}
	}

	// =========================================================================
	// Internals
	// =========================================================================

	private _toAdmitted(request: InferenceRequestRecord): AdmittedInference {
		return {
			inferenceRequestId: request.inferenceRequestId,
			resourceId: request.resourceId,
			logicalAgentId: request.logicalAgentId,
			slot: request.lease!.slot,
			lease: request.lease!,
		};
	}

	private _admittedFrom(ledger: InferenceResourceLedger, inferenceRequestId: string): AdmittedInference {
		const request = ledger.running.find((r) => r.inferenceRequestId === inferenceRequestId)!;
		return this._toAdmitted(request);
	}

	private _admitInto(
		ledger: InferenceResourceLedger,
		request: InferenceRequestRecord,
		now: number,
		options: { incrementFence: boolean },
	): InferenceResourceLedger {
		const slot = ledger.running.length;
		const fencingToken = options.incrementFence ? ledger.fencingToken + 1 : ledger.fencingToken;
		const lease: InferenceRequestLease = {
			ownerId: request.ownerId,
			leaseId: this._leaseIdFactory(),
			slot,
			acquiredAtMs: now,
			expiresAtMs: now + this._leaseDurationMs,
		};
		const admitted: InferenceRequestRecord = {
			...request,
			state: "RUNNING",
			lease,
			admittedAtMs: now,
		};
		return {
			...ledger,
			running: [...ledger.running, admitted],
			fencingToken,
			updatedAtMs: now,
			revision: ledger.revision + 1,
		};
	}

	/** Sort the queue deterministically and promote up to free capacity. */
	private _promoteQueued(ledger: InferenceResourceLedger, now: number): InferenceResourceLedger {
		let next = ledger;
		const freeSlots = ledger.capacity - ledger.running.length;
		if (freeSlots <= 0 || ledger.queue.length === 0) return next;

		const sorted = this._sortedQueue(ledger.queue, now);
		const promote = sorted.slice(0, freeSlots);
		const remaining = sorted.slice(freeSlots);

		let running = ledger.running;
		let fencingToken = ledger.fencingToken;
		for (const request of promote) {
			const admitted: InferenceRequestRecord = {
				...request,
				state: "RUNNING",
				lease: {
					ownerId: request.ownerId,
					leaseId: this._leaseIdFactory(),
					slot: running.length,
					acquiredAtMs: now,
					expiresAtMs: now + this._leaseDurationMs,
				},
				admittedAtMs: now,
			};
			running = [...running, admitted];
			fencingToken += 1;
		}

		next = {
			...ledger,
			running,
			queue: remaining,
			fencingToken,
			updatedAtMs: now,
			revision: ledger.revision + 1,
		};
		return this._normalizeSlots(next);
	}

	/** Keep running[i].lease.slot === i. */
	private _normalizeSlots(ledger: InferenceResourceLedger): InferenceResourceLedger {
		const running = ledger.running.map((r, i) => (r.lease ? { ...r, lease: { ...r.lease, slot: i } } : r));
		return { ...ledger, running };
	}

	private _sortedQueue(queue: InferenceRequestRecord[], now: number): InferenceRequestRecord[] {
		return [...queue].sort((a, b) => this._compare(a, b, now));
	}

	private _compare(a: InferenceRequestRecord, b: InferenceRequestRecord, now: number): number {
		const pa = this._breakdown(a, now).effective;
		const pb = this._breakdown(b, now).effective;
		if (pa !== pb) return pb - pa;
		if (a.enqueuedAtMs !== b.enqueuedAtMs) return a.enqueuedAtMs - b.enqueuedAtMs;
		return a.inferenceRequestId < b.inferenceRequestId ? -1 : a.inferenceRequestId > b.inferenceRequestId ? 1 : 0;
	}

	private _breakdown(request: InferenceRequestRecord, now: number): PriorityBreakdown {
		const interactive = request.priority.interactive ? this._interactiveBoost : 0;
		const verification = request.priority.verification ? this._verificationBoost : 0;
		const dependency = request.dependency
			? Math.min(request.dependency.unblocksCount * this._dependencyWeight, this._dependencyCap)
			: 0;
		const ageMs = Math.max(0, now - request.enqueuedAtMs);
		const aging = Math.floor(ageMs / this._agingIntervalMs) * this._agingWeight;
		const base = request.priority.base;
		return {
			base,
			interactive,
			verification,
			dependency,
			aging,
			effective: base + interactive + verification + dependency + aging,
		};
	}

	private _requestStatus(request: InferenceRequestRecord, now: number, position: number): InferenceRequestStatus {
		const breakdown = this._breakdown(request, now);
		return {
			inferenceRequestId: request.inferenceRequestId,
			logicalAgentId: request.logicalAgentId,
			resourceId: request.resourceId,
			state: request.state,
			position: request.state === "QUEUED" ? position : undefined,
			effectivePriority: breakdown.effective,
			basePriority: breakdown.base,
			agingContribution: breakdown.aging,
			dependencyContribution: breakdown.dependency,
			queuedAtMs: request.enqueuedAtMs,
			requestedAtMs: request.requestedAtMs,
		};
	}
}
