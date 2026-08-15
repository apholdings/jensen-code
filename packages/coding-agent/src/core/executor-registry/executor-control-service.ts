/**
 * Executor Control Service (2.10.0).
 *
 * The authoritative application/operator boundary over executor identity and
 * runtime liveness. Read models aggregate durable records only and never mutate
 * them (liveness is computed from `now` without persisting). Mutations compose
 * the ExecutorRegistryStore atomic RMW and are fenced by runtime proof.
 *
 * This is NOT a scheduler. Registration means "this executor exists / is alive /
 * can do X"; it never means "assign a mission here".
 */

import { randomUUID } from "node:crypto";
import { createExecutorRecord, type ExecutorMutation, type ExecutorRegistryStore } from "./executor-registry-store.js";
import {
	type ActivateExecutorInput,
	type ExecutorActivationOutcome,
	type ExecutorCapabilities,
	type ExecutorDeactivateOutcome,
	type ExecutorDetail,
	type ExecutorHeartbeatOutcome,
	type ExecutorListOptions,
	type ExecutorListResult,
	type ExecutorLiveness,
	type ExecutorRecord,
	ExecutorRegistryError,
	type ExecutorRetireOutcome,
	type ExecutorRuntime,
	type ExecutorRuntimeMutationInput,
	type ExecutorRuntimeProof,
	type ExecutorSummary,
	isSafeExecutorId,
	newRuntimeOwnerId,
	type RegisterExecutorInput,
} from "./executor-registry-types.js";

export interface ExecutorControlServiceOptions {
	store: ExecutorRegistryStore;
	now?: () => number;
	/** Default runtime heartbeat expiry window. */
	expiryMs?: number;
	/** Runtime instance id factory (default: UUID, never a PID). */
	runtimeInstanceIdFactory?: () => string;
	ownerIdFactory?: () => string;
}

export const DEFAULT_EXECUTOR_HEARTBEAT_EXPIRY_MS = 30_000;

export class ExecutorControlService {
	private readonly _store: ExecutorRegistryStore;
	private readonly _now: () => number;
	private readonly _expiryMs: number;
	private readonly _runtimeInstanceIdFactory: () => string;
	private readonly _ownerIdFactory: () => string;

	constructor(options: ExecutorControlServiceOptions) {
		this._store = options.store;
		this._now = options.now ?? (() => Date.now());
		this._expiryMs = options.expiryMs ?? DEFAULT_EXECUTOR_HEARTBEAT_EXPIRY_MS;
		this._runtimeInstanceIdFactory = options.runtimeInstanceIdFactory ?? (() => `runtime_${randomUUID()}`);
		this._ownerIdFactory = options.ownerIdFactory ?? (() => newRuntimeOwnerId());
	}

	get store(): ExecutorRegistryStore {
		return this._store;
	}

	// =========================================================================
	// Read model
	// =========================================================================

	async listExecutors(options: ExecutorListOptions = {}): Promise<ExecutorListResult> {
		const ids = await this._store.listExecutors();
		const records = new Map<string, ExecutorRecord>();
		const corrupt: ExecutorListResult["corrupt"] = [];

		for (const id of ids) {
			const loaded = await this._store.load(id);
			if (loaded.status === "ok") records.set(id, loaded.record);
			else if (loaded.status === "corrupt") corrupt.push({ executorId: id, diagnostic: loaded.diagnostic });
		}

		const now = this._now();
		let entries = [...records.values()].map((record) => this._toSummary(record, now));

		const filter = options.filter;
		if (filter) {
			entries = entries.filter((entry) => {
				if (filter.status !== undefined && entry.status !== filter.status) return false;
				if (filter.platform !== undefined && entry.platform !== filter.platform) return false;
				if (filter.arch !== undefined && entry.arch !== filter.arch) return false;
				if (filter.label !== undefined && !entry.labels.includes(filter.label)) return false;
				if (filter.capability !== undefined && !this._hasCapability(entry.capabilities, filter.capability))
					return false;
				if (filter.provider !== undefined && !(entry.capabilities.providers ?? []).includes(filter.provider))
					return false;
				if (filter.model !== undefined && !(entry.capabilities.models ?? []).includes(filter.model)) return false;
				if (filter.retired !== undefined && entry.retired !== filter.retired) return false;
				return true;
			});
		}

		const sort = options.sort ?? "executorId";
		const direction = options.direction ?? "asc";
		entries.sort((a, b) => {
			let cmp: number;
			if (sort === "executorId") cmp = a.executorId < b.executorId ? -1 : a.executorId > b.executorId ? 1 : 0;
			else cmp = a[sort] - b[sort];
			return direction === "desc" ? -cmp : cmp;
		});

		const offset = options.offset ?? 0;
		if (offset > 0) entries = entries.slice(offset);
		if (options.limit !== undefined) entries = entries.slice(0, options.limit);

		return { entries, corrupt };
	}

	async getExecutor(executorId: string): Promise<ExecutorDetail> {
		const record = await this._requireRecord(executorId);
		const now = this._now();
		return {
			executorId: record.executorId,
			displayName: record.displayName,
			status: this._toLiveness(record, now).status,
			retired: record.retired,
			createdAtMs: record.createdAtMs,
			updatedAtMs: record.updatedAtMs,
			labels: [...record.labels],
			configuredCapabilities: { ...record.configuredCapabilities },
			runtimeEpoch: record.runtimeEpoch,
			runtime: record.runtime ? { ...record.runtime } : undefined,
			liveness: this._toLiveness(record, now),
			currentAssignments: {
				status: "unavailable",
				reason: "mission ownerId <-> executor runtime correlation is deferred to the assignment slice",
			},
		};
	}

	// =========================================================================
	// Mutations
	// =========================================================================

	/** Register stable definition. Idempotent for a compatible definition. */
	async registerExecutor(
		input: RegisterExecutorInput,
	): Promise<{ executorId: string; status: "created" | "idempotent"; record: ExecutorRecord }> {
		if (!isSafeExecutorId(input.executorId)) {
			throw new ExecutorRegistryError("INVALID_EXECUTOR_ID", `Invalid executor id: ${input.executorId}`, {
				executorId: input.executorId,
			});
		}
		const record = createExecutorRecord({
			executorId: input.executorId,
			displayName: input.displayName,
			labels: input.labels,
			configuredCapabilities: input.configuredCapabilities,
			now: this._now(),
		});
		const result = await this._store.register(record);
		if (result.status === "conflict") {
			throw new ExecutorRegistryError("EXECUTOR_ALREADY_EXISTS", result.error, { executorId: input.executorId });
		}
		if (result.status === "idempotent")
			return { executorId: input.executorId, status: "idempotent", record: result.record };
		return { executorId: input.executorId, status: "created", record };
	}

	/** Atomically activate a runtime incarnation, fencing any stale predecessor. */
	async activateExecutor(executorId: string, input: ActivateExecutorInput = {}): Promise<ExecutorActivationOutcome> {
		this._assertExecutorId(executorId);
		const now = this._now();
		const runtimeInstanceId = input.runtimeInstanceId ?? this._runtimeInstanceIdFactory();
		const expiryMs = input.expiryMs ?? this._expiryMs;

		const result = await this._store.mutate(executorId, (current): ExecutorMutation<ExecutorActivationOutcome> => {
			this._assertNotRetired(current);
			if (current.runtime && current.runtime.expiresAtMs > now) {
				throw new ExecutorRegistryError(
					"EXECUTOR_ALREADY_ACTIVE",
					`Executor ${executorId} already has a healthy runtime`,
					{
						executorId,
						runtimeInstanceId: current.runtime.runtimeInstanceId,
						runtimeEpoch: current.runtimeEpoch,
					},
				);
			}
			if (current.runtime && current.runtime.runtimeInstanceId === runtimeInstanceId) {
				throw new ExecutorRegistryError(
					"EXECUTOR_ALREADY_ACTIVE",
					`Runtime instance id ${runtimeInstanceId} must not be reused for executor ${executorId}`,
					{ executorId, runtimeInstanceId },
				);
			}

			const runtimeEpoch = current.runtimeEpoch + 1;
			const runtime: ExecutorRuntime = {
				runtimeInstanceId,
				ownerId: input.ownerId ?? this._ownerIdFactory(),
				hostname: input.hostname,
				pid: input.pid,
				platform: input.platform,
				arch: input.arch,
				processStartedAtMs: input.processStartedAtMs,
				jensenVersion: input.jensenVersion,
				startedAtMs: now,
				lastHeartbeatAtMs: now,
				expiresAtMs: now + expiryMs,
				advertisedCapabilities: input.advertisedCapabilities ?? {},
				resources: input.resources,
			};
			const next: ExecutorRecord = {
				...current,
				updatedAtMs: now,
				runtimeEpoch,
				runtime,
				revision: current.revision + 1,
			};
			const proof: ExecutorRuntimeProof = { executorId, runtimeInstanceId, runtimeEpoch };
			const value: ExecutorActivationOutcome = {
				executorId,
				runtimeInstanceId,
				runtimeEpoch,
				proof,
				expiresAtMs: runtime.expiresAtMs,
				record: next,
			};
			return { kind: "write", next, value };
		});

		return this._unwrapMutation(result, executorId, "activate");
	}

	/** Fenced runtime heartbeat. A lapsed current runtime must be re-activated. */
	async heartbeatExecutor(
		proof: ExecutorRuntimeProof,
		input: ExecutorRuntimeMutationInput = {},
	): Promise<ExecutorHeartbeatOutcome> {
		this._assertProof(proof);
		const now = this._now();
		const expiryMs = input.expiryMs ?? this._expiryMs;

		const result = await this._store.mutate(
			proof.executorId,
			(current): ExecutorMutation<ExecutorHeartbeatOutcome> => {
				this._assertNotRetired(current);
				const runtime = this._assertRuntimeProof(current, proof);
				if (runtime.expiresAtMs <= now) {
					throw new ExecutorRegistryError(
						"EXECUTOR_RUNTIME_EXPIRED",
						`Runtime ${runtime.runtimeInstanceId} of executor ${proof.executorId} has expired; activate a new runtime`,
						{ executorId: proof.executorId, runtimeInstanceId: runtime.runtimeInstanceId },
					);
				}
				const lastHeartbeatAtMs = now;
				const expiresAtMs = now + expiryMs;
				const next: ExecutorRecord = {
					...current,
					updatedAtMs: now,
					revision: current.revision + 1,
					runtime: {
						...runtime,
						lastHeartbeatAtMs,
						expiresAtMs,
						advertisedCapabilities: input.advertisedCapabilities ?? runtime.advertisedCapabilities,
						resources: input.resources ?? runtime.resources,
					},
				};
				const value: ExecutorHeartbeatOutcome = {
					executorId: proof.executorId,
					runtimeInstanceId: runtime.runtimeInstanceId,
					runtimeEpoch: proof.runtimeEpoch,
					lastHeartbeatAtMs,
					expiresAtMs,
					record: next,
				};
				return { kind: "write", next, value };
			},
		);

		return this._unwrapMutation(result, proof.executorId, "heartbeat");
	}

	/** Fenced capability update (does not change epoch; requires online runtime). */
	async updateRuntimeCapabilities(
		proof: ExecutorRuntimeProof,
		capabilities: ExecutorCapabilities,
	): Promise<ExecutorRecord> {
		this._assertProof(proof);
		const now = this._now();

		const result = await this._store.mutate(proof.executorId, (current): ExecutorMutation<ExecutorRecord> => {
			this._assertNotRetired(current);
			const runtime = this._assertRuntimeProof(current, proof);
			if (runtime.expiresAtMs <= now) {
				throw new ExecutorRegistryError(
					"EXECUTOR_RUNTIME_EXPIRED",
					`Runtime ${runtime.runtimeInstanceId} of executor ${proof.executorId} has expired`,
					{ executorId: proof.executorId, runtimeInstanceId: runtime.runtimeInstanceId },
				);
			}
			const next: ExecutorRecord = {
				...current,
				updatedAtMs: now,
				revision: current.revision + 1,
				runtime: { ...runtime, advertisedCapabilities: capabilities },
			};
			return { kind: "write", next, value: next };
		});

		return this._unwrapMutation(result, proof.executorId, "update-capabilities");
	}

	/** Clean shutdown of the current runtime. Epoch is preserved. */
	async deactivateExecutor(proof: ExecutorRuntimeProof): Promise<ExecutorDeactivateOutcome> {
		this._assertProof(proof);
		const now = this._now();

		const result = await this._store.mutate(
			proof.executorId,
			(current): ExecutorMutation<ExecutorDeactivateOutcome> => {
				const runtime = this._assertRuntimeProof(current, proof);
				const next: ExecutorRecord = {
					...current,
					updatedAtMs: now,
					runtime: undefined,
					revision: current.revision + 1,
				};
				const value: ExecutorDeactivateOutcome = {
					executorId: proof.executorId,
					runtimeInstanceId: runtime.runtimeInstanceId,
					runtimeEpoch: proof.runtimeEpoch,
					record: next,
				};
				return { kind: "write", next, value };
			},
		);

		return this._unwrapMutation(result, proof.executorId, "deactivate");
	}

	/** Retire stable identity. Blocks future activation; never deletes history. */
	async retireExecutor(executorId: string): Promise<ExecutorRetireOutcome> {
		this._assertExecutorId(executorId);
		const now = this._now();

		const result = await this._store.mutate(executorId, (current): ExecutorMutation<ExecutorRetireOutcome> => {
			const runtimeStillActive = current.runtime !== undefined && current.runtime.expiresAtMs > now;
			if (current.retired) {
				return {
					kind: "noop",
					value: {
						executorId,
						status: runtimeStillActive ? ("retired_active_runtime" as const) : ("retired" as const),
						runtimeInstanceId: current.runtime?.runtimeInstanceId,
						record: current,
					},
				};
			}
			const next: ExecutorRecord = {
				...current,
				retired: true,
				updatedAtMs: now,
				revision: current.revision + 1,
			};
			const value: ExecutorRetireOutcome = {
				executorId,
				status: runtimeStillActive ? "retired_active_runtime" : "retired",
				runtimeInstanceId: current.runtime?.runtimeInstanceId,
				record: next,
			};
			return { kind: "write", next, value };
		});

		return this._unwrapMutation(result, executorId, "retire");
	}

	// =========================================================================
	// Internals
	// =========================================================================

	private async _requireRecord(executorId: string): Promise<ExecutorRecord> {
		this._assertExecutorId(executorId);
		const loaded = await this._store.load(executorId);
		if (loaded.status === "missing") {
			throw new ExecutorRegistryError("EXECUTOR_NOT_FOUND", `Executor not found: ${executorId}`, { executorId });
		}
		if (loaded.status === "corrupt") {
			throw new ExecutorRegistryError(
				"EXECUTOR_CORRUPT",
				`Executor ${executorId} is corrupt: ${loaded.diagnostic}`,
				{
					executorId,
					diagnostic: loaded.diagnostic,
				},
			);
		}
		return loaded.record;
	}

	private _assertExecutorId(executorId: string): void {
		if (!isSafeExecutorId(executorId)) {
			throw new ExecutorRegistryError("INVALID_EXECUTOR_ID", `Invalid executor id: ${executorId}`, { executorId });
		}
	}

	private _assertProof(proof: ExecutorRuntimeProof): void {
		this._assertExecutorId(proof.executorId);
		if (typeof proof.runtimeInstanceId !== "string" || proof.runtimeInstanceId.length === 0) {
			throw new ExecutorRegistryError("INVALID_EXECUTOR_ID", "runtimeInstanceId is required", {
				executorId: proof.executorId,
			});
		}
		if (!Number.isSafeInteger(proof.runtimeEpoch) || proof.runtimeEpoch < 1) {
			throw new ExecutorRegistryError("INVALID_EXECUTOR_ID", "runtimeEpoch must be a positive integer", {
				executorId: proof.executorId,
			});
		}
	}

	private _assertNotRetired(record: ExecutorRecord): void {
		if (record.retired) {
			throw new ExecutorRegistryError("EXECUTOR_RETIRED", `Executor ${record.executorId} is retired`, {
				executorId: record.executorId,
			});
		}
	}

	private _assertRuntimeProof(record: ExecutorRecord, proof: ExecutorRuntimeProof): ExecutorRuntime {
		if (!record.runtime) {
			throw new ExecutorRegistryError("EXECUTOR_NOT_ACTIVE", `Executor ${record.executorId} has no active runtime`, {
				executorId: record.executorId,
			});
		}
		if (record.runtime.runtimeInstanceId !== proof.runtimeInstanceId || record.runtimeEpoch !== proof.runtimeEpoch) {
			throw new ExecutorRegistryError(
				"STALE_EXECUTOR_INSTANCE",
				`Runtime ${proof.runtimeInstanceId} (epoch ${proof.runtimeEpoch}) is not authoritative for executor ${record.executorId}`,
				{
					executorId: record.executorId,
					authoritativeInstanceId: record.runtime.runtimeInstanceId,
					authoritativeEpoch: record.runtimeEpoch,
					staleInstanceId: proof.runtimeInstanceId,
					staleEpoch: proof.runtimeEpoch,
				},
			);
		}
		return record.runtime;
	}

	private _unwrapMutation<T>(
		result:
			| { status: "ok"; value: T }
			| { status: "missing" }
			| { status: "corrupt"; executorId: string; diagnostic: string },
		executorId: string,
		op: string,
	): T {
		if (result.status === "missing") {
			throw new ExecutorRegistryError("EXECUTOR_NOT_FOUND", `Executor not found during ${op}: ${executorId}`, {
				executorId,
			});
		}
		if (result.status === "corrupt") {
			throw new ExecutorRegistryError("EXECUTOR_CORRUPT", `Executor ${executorId} is corrupt during ${op}`, {
				executorId,
				diagnostic: result.diagnostic,
			});
		}
		return result.value;
	}

	private _toLiveness(record: ExecutorRecord, now: number): ExecutorLiveness {
		if (record.retired) return { status: "RETIRED", heartbeatValid: false };
		const runtime = record.runtime;
		if (!runtime) {
			return {
				status: record.runtimeEpoch === 0 ? "REGISTERED" : "OFFLINE",
				heartbeatValid: false,
			};
		}
		const valid = runtime.expiresAtMs > now;
		if (valid) {
			return {
				status: "ONLINE",
				heartbeatValid: true,
				expiresAtMs: runtime.expiresAtMs,
				remainingMs: Math.max(0, runtime.expiresAtMs - now),
			};
		}
		return {
			status: "STALE",
			heartbeatValid: false,
			expiresAtMs: runtime.expiresAtMs,
			remainingMs: 0,
		};
	}

	private _mergeCapabilities(record: ExecutorRecord): ExecutorCapabilities {
		const configured = record.configuredCapabilities;
		const advertised = record.runtime?.advertisedCapabilities ?? {};
		const union = (...lists: (string[] | undefined)[]): string[] | undefined => {
			const seen = new Set<string>();
			for (const list of lists) {
				for (const entry of list ?? []) seen.add(entry);
			}
			return seen.size > 0 ? [...seen].sort() : undefined;
		};
		return {
			platform: advertised.platform ?? configured.platform,
			execution: union(configured.execution, advertised.execution),
			providers: union(configured.providers, advertised.providers),
			models: union(configured.models, advertised.models),
			tools: union(configured.tools, advertised.tools),
			specialized: union(configured.specialized, advertised.specialized),
			extra: union(configured.extra, advertised.extra),
		};
	}

	private _hasCapability(capabilities: ExecutorCapabilities, capability: string): boolean {
		const lists = [
			capabilities.execution,
			capabilities.providers,
			capabilities.models,
			capabilities.tools,
			capabilities.specialized,
			capabilities.extra,
		];
		return lists.some((list) => (list ?? []).includes(capability));
	}

	private _toSummary(record: ExecutorRecord, now: number): ExecutorSummary {
		const liveness = this._toLiveness(record, now);
		const capabilities = this._mergeCapabilities(record);
		return {
			executorId: record.executorId,
			displayName: record.displayName,
			status: liveness.status,
			retired: record.retired,
			createdAtMs: record.createdAtMs,
			updatedAtMs: record.updatedAtMs,
			runtimeEpoch: record.runtimeEpoch,
			runtimeInstanceId: record.runtime?.runtimeInstanceId,
			hostname: record.runtime?.hostname,
			platform: record.runtime?.platform ?? capabilities.platform?.os,
			arch: record.runtime?.arch ?? capabilities.platform?.arch,
			lastHeartbeatAtMs: record.runtime?.lastHeartbeatAtMs,
			expiresAtMs: record.runtime?.expiresAtMs,
			labels: [...record.labels],
			capabilities,
		};
	}
}
