/**
 * Remote Execution — target registry (2.14.0).
 *
 * A small durable catalog of concrete remote targets. It is NOT a mission store,
 * NOT an assignment store, and NOT a scheduler: it only records where execution
 * can physically happen. Target selection remains explicit/static until
 * Capability Routing.
 */

import type { RemoteExecutionTarget, RemoteTargetHealth } from "./remote-target-types.js";
import { parseRemoteExecutionTarget, RemoteTargetError } from "./remote-target-types.js";
import type { RemoteExecutionTransport } from "./remote-transport.js";

export type RemoteTargetLoadResult =
	| { status: "ok"; target: RemoteExecutionTarget }
	| { status: "missing" }
	| { status: "corrupt"; targetId: string; diagnostic: string };

export type RemoteTargetRegisterResult =
	| { status: "created" }
	| { status: "idempotent"; target: RemoteExecutionTarget }
	| { status: "conflict"; error: string };

export interface RemoteTargetStore {
	readonly storeId: string;
	register(target: RemoteExecutionTarget): Promise<RemoteTargetRegisterResult>;
	load(targetId: string): Promise<RemoteTargetLoadResult>;
	listTargets(): Promise<string[]>;
	remove(targetId: string): Promise<boolean>;
}

export interface RemoteTargetRegistryOptions {
	store: RemoteTargetStore;
	/** Transport used for health probes (optional). */
	transport?: RemoteExecutionTransport;
}

export interface RemoteTargetListResult {
	entries: RemoteExecutionTarget[];
	corrupt: { targetId: string; diagnostic: string }[];
}

export class RemoteTargetRegistry {
	private readonly _store: RemoteTargetStore;
	private readonly _transport?: RemoteExecutionTransport;

	constructor(options: RemoteTargetRegistryOptions) {
		this._store = options.store;
		this._transport = options.transport;
	}

	get store(): RemoteTargetStore {
		return this._store;
	}

	async register(target: RemoteExecutionTarget): Promise<RemoteExecutionTarget> {
		const parsed = parseRemoteExecutionTarget(target);
		if (!parsed.ok) {
			throw new RemoteTargetError("INVALID_TARGET", parsed.diagnostic, { targetId: target.targetId });
		}
		const result = await this._store.register(parsed.target);
		if (result.status === "created") return parsed.target;
		if (result.status === "idempotent") return result.target;
		throw new RemoteTargetError("TARGET_ALREADY_EXISTS", result.error, { targetId: target.targetId });
	}

	async get(targetId: string): Promise<RemoteExecutionTarget> {
		const loaded = await this._store.load(targetId);
		if (loaded.status === "missing") {
			throw new RemoteTargetError("TARGET_NOT_FOUND", `Remote target not found: ${targetId}`, { targetId });
		}
		if (loaded.status === "corrupt") {
			throw new RemoteTargetError("TARGET_CORRUPT", `Remote target ${targetId} is corrupt: ${loaded.diagnostic}`, {
				targetId,
				diagnostic: loaded.diagnostic,
			});
		}
		return loaded.target;
	}

	async list(): Promise<RemoteTargetListResult> {
		const ids = await this._store.listTargets();
		const entries: RemoteExecutionTarget[] = [];
		const corrupt: { targetId: string; diagnostic: string }[] = [];
		for (const id of ids) {
			const loaded = await this._store.load(id);
			if (loaded.status === "ok") entries.push(loaded.target);
			else if (loaded.status === "corrupt") corrupt.push({ targetId: id, diagnostic: loaded.diagnostic });
		}
		entries.sort((a, b) => (a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0));
		return { entries, corrupt };
	}

	async remove(targetId: string): Promise<boolean> {
		return this._store.remove(targetId);
	}

	/** Non-mutating reachability probe, surfacing structured health. */
	async probe(targetId: string): Promise<RemoteTargetHealth> {
		const target = await this.get(targetId);
		if (!this._transport) {
			return {
				targetId,
				status: "unknown",
				summary: "no transport configured for probes",
				observedAtMs: Date.now(),
			};
		}
		return this._transport.probe(target);
	}
}
