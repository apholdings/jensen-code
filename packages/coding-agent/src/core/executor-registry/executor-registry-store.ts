/**
 * Executor Registry — domain-facing persistence port (2.10.0).
 *
 * Pure types + validation only. No filesystem, process, provider, or scheduler
 * machinery. A future scheduler/worker daemon consumes this same port without
 * needing the local file implementation.
 *
 * Authority model:
 *   - The registry records what executors exist and what runtimes are alive.
 *   - Capability/resource fields are advertisements and observations, never
 *     authorization grants and never assignments.
 */

import {
	type ExecutorCapabilities,
	type ExecutorDefinition,
	type ExecutorRecord,
	type ExecutorRuntime,
	isSafeExecutorId,
} from "./executor-registry-types.js";

export const EXECUTOR_REGISTRY_SCHEMA_VERSION = 1 as const;

// =============================================================================
// Store port result types
// =============================================================================

export type ExecutorRegisterResult =
	| { status: "created" }
	| { status: "idempotent"; record: ExecutorRecord }
	| { status: "conflict"; error: string };

export type ExecutorLoadResult =
	| { status: "ok"; record: ExecutorRecord }
	| { status: "missing" }
	| { status: "corrupt"; executorId: string; diagnostic: string };

/** A store-level atomic read-modify-write mutation (sync callback). */
export type ExecutorMutation<T> = { kind: "write"; next: ExecutorRecord; value: T } | { kind: "noop"; value: T };

export type ExecutorMutateResult<T> =
	| { status: "ok"; value: T }
	| { status: "missing" }
	| { status: "corrupt"; executorId: string; diagnostic: string };

/**
 * Canonical executor registry persistence port. Implementations must be
 * crash-conscious (atomic record replacement, schema validation on load,
 * deterministic corrupt handling) and must never fabricate a healthy executor.
 */
export interface ExecutorRegistryStore {
	readonly storeId: string;

	register(record: ExecutorRecord): Promise<ExecutorRegisterResult>;
	load(executorId: string): Promise<ExecutorLoadResult>;
	listExecutors(): Promise<string[]>;
	mutate<T>(
		executorId: string,
		mutation: (current: ExecutorRecord) => ExecutorMutation<T>,
	): Promise<ExecutorMutateResult<T>>;
}

// =============================================================================
// Definition equality
// =============================================================================

function stableStringify(value: unknown): string {
	if (value === undefined) return "null";
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record)
		.filter((key) => record[key] !== undefined)
		.sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

/** Structural equality of two stable executor definitions. */
export function executorDefinitionsEqual(a: ExecutorDefinition, b: ExecutorDefinition): boolean {
	return stableStringify(a) === stableStringify(b);
}

// =============================================================================
// Validation
// =============================================================================

export type ExecutorRecordParseResult = { ok: true; record: ExecutorRecord } | { ok: false; diagnostic: string };

function invalid(why: string): ExecutorRecordParseResult {
	return { ok: false, diagnostic: why };
}

function isSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function validateGpuDevice(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return "gpu device must be an object";
	const d = value as Record<string, unknown>;
	for (const key of ["id", "name", "vendor"] as const) {
		if (d[key] !== undefined && typeof d[key] !== "string") return `gpu device ${key} must be a string`;
	}
	for (const key of ["memoryTotalBytes", "memoryFreeBytes"] as const) {
		if (d[key] !== undefined && !isSafeInteger(d[key])) return `gpu device ${key} must be a safe integer`;
	}
	return undefined;
}

function validateResources(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return "resources must be an object";
	const r = value as Record<string, unknown>;
	if (!isSafeInteger(r.observedAtMs)) return "resources.observedAtMs must be a safe integer";
	if (r.cpuLogicalCount !== undefined && !isSafeInteger(r.cpuLogicalCount))
		return "resources.cpuLogicalCount must be a safe integer";
	if (r.memoryTotalBytes !== undefined && !isSafeInteger(r.memoryTotalBytes))
		return "resources.memoryTotalBytes must be a safe integer";
	if (r.memoryFreeBytes !== undefined && !isSafeInteger(r.memoryFreeBytes))
		return "resources.memoryFreeBytes must be a safe integer";
	if (r.gpu !== undefined) {
		if (typeof r.gpu !== "object" || r.gpu === null || Array.isArray(r.gpu)) return "resources.gpu must be an object";
		const gpu = r.gpu as Record<string, unknown>;
		if (gpu.status !== "unavailable" && gpu.status !== "available") return "resources.gpu.status is invalid";
		if (!Array.isArray(gpu.devices)) return "resources.gpu.devices must be an array";
		for (const device of gpu.devices) {
			const err = validateGpuDevice(device);
			if (err) return err;
		}
	}
	return undefined;
}

function validateCapabilities(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return "capabilities must be an object";
	const c = value as Record<string, unknown>;
	if (c.platform !== undefined) {
		if (typeof c.platform !== "object" || c.platform === null || Array.isArray(c.platform))
			return "capabilities.platform must be an object";
		const platform = c.platform as Record<string, unknown>;
		if (platform.os !== undefined && typeof platform.os !== "string")
			return "capabilities.platform.os must be a string";
		if (platform.arch !== undefined && typeof platform.arch !== "string")
			return "capabilities.platform.arch must be a string";
	}
	for (const key of ["execution", "providers", "models", "tools", "specialized", "extra"] as const) {
		if (c[key] !== undefined && !isStringArray(c[key])) return `capabilities.${key} must be a string array`;
	}
	return undefined;
}

function validateRuntime(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return "runtime must be an object";
	const r = value as Record<string, unknown>;
	if (typeof r.runtimeInstanceId !== "string" || r.runtimeInstanceId.length === 0)
		return "runtime.runtimeInstanceId must be a non-empty string";
	if (typeof r.ownerId !== "string" || r.ownerId.length === 0) return "runtime.ownerId must be a non-empty string";
	for (const key of ["hostname", "platform", "arch", "jensenVersion"] as const) {
		if (r[key] !== undefined && typeof r[key] !== "string") return `runtime.${key} must be a string`;
	}
	if (r.pid !== undefined && !isSafeInteger(r.pid)) return "runtime.pid must be a safe integer";
	if (r.processStartedAtMs !== undefined && !isSafeInteger(r.processStartedAtMs))
		return "runtime.processStartedAtMs must be a safe integer";
	for (const key of ["startedAtMs", "lastHeartbeatAtMs", "expiresAtMs"] as const) {
		if (!isSafeInteger(r[key])) return `runtime.${key} must be a safe integer`;
	}
	if ((r.lastHeartbeatAtMs as number) < (r.startedAtMs as number))
		return "runtime.lastHeartbeatAtMs must be >= startedAtMs";
	if ((r.expiresAtMs as number) < (r.lastHeartbeatAtMs as number))
		return "runtime.expiresAtMs must be >= lastHeartbeatAtMs";
	const capabilitiesError = validateCapabilities(r.advertisedCapabilities);
	if (capabilitiesError) return `runtime.advertisedCapabilities: ${capabilitiesError}`;
	if (r.resources !== undefined) {
		const resourcesError = validateResources(r.resources);
		if (resourcesError) return `runtime.resources: ${resourcesError}`;
	}
	return undefined;
}

/**
 * Validate an untrusted persisted value into an ExecutorRecord. Corruption is
 * surfaced structurally (`ok: false`), never silently dropped or fabricated.
 */
export function parseExecutorRecord(value: unknown): ExecutorRecordParseResult {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid("record must be an object");
	const doc = value as Record<string, unknown>;

	if (doc.schemaVersion !== EXECUTOR_REGISTRY_SCHEMA_VERSION) {
		return invalid(`unsupported schemaVersion: ${String(doc.schemaVersion)}`);
	}
	if (typeof doc.executorId !== "string" || !isSafeExecutorId(doc.executorId)) {
		return invalid("executorId is missing or unsafe");
	}
	const executorId = doc.executorId;

	if (doc.displayName !== undefined && typeof doc.displayName !== "string")
		return invalid("displayName must be a string");
	if (!isSafeInteger(doc.createdAtMs) || !isSafeInteger(doc.updatedAtMs))
		return invalid("timestamps must be safe integers");
	if (typeof doc.retired !== "boolean") return invalid("retired must be a boolean");
	if (!isStringArray(doc.labels)) return invalid("labels must be a string array");
	if (!isSafeInteger(doc.runtimeEpoch) || (doc.runtimeEpoch as number) < 0)
		return invalid("runtimeEpoch must be a non-negative integer");
	if (!isSafeInteger(doc.revision) || (doc.revision as number) < 0)
		return invalid("revision must be a non-negative integer");

	const capabilitiesError = validateCapabilities(doc.configuredCapabilities);
	if (capabilitiesError) return invalid(`configuredCapabilities: ${capabilitiesError}`);

	if (
		doc.remoteTargetId !== undefined &&
		(typeof doc.remoteTargetId !== "string" || !isSafeExecutorId(doc.remoteTargetId))
	) {
		return invalid("remoteTargetId must be a safe string identifier");
	}

	let runtime: ExecutorRuntime | undefined;
	if (doc.runtime !== undefined) {
		const runtimeError = validateRuntime(doc.runtime);
		if (runtimeError) return invalid(runtimeError);
		runtime = doc.runtime as ExecutorRuntime;
	}

	return {
		ok: true,
		record: {
			schemaVersion: EXECUTOR_REGISTRY_SCHEMA_VERSION,
			executorId,
			displayName: doc.displayName as string | undefined,
			createdAtMs: doc.createdAtMs as number,
			updatedAtMs: doc.updatedAtMs as number,
			retired: doc.retired as boolean,
			labels: (doc.labels as string[]).map((entry) => entry),
			configuredCapabilities: doc.configuredCapabilities as ExecutorCapabilities,
			remoteTargetId: doc.remoteTargetId as string | undefined,
			runtimeEpoch: doc.runtimeEpoch as number,
			runtime,
			revision: doc.revision as number,
		},
	};
}

// =============================================================================
// Record construction helper
// =============================================================================

export interface CreateExecutorRecordInput {
	executorId: string;
	displayName?: string;
	labels?: string[];
	configuredCapabilities?: ExecutorCapabilities;
	remoteTargetId?: string;
	now?: number;
}

/** Build an initial registered record (no runtime, epoch 0, not retired). */
export function createExecutorRecord(input: CreateExecutorRecordInput): ExecutorRecord {
	if (!isSafeExecutorId(input.executorId)) {
		throw new Error(`Unsafe executor id: ${input.executorId}`);
	}
	const now = input.now ?? Date.now();
	return {
		schemaVersion: EXECUTOR_REGISTRY_SCHEMA_VERSION,
		executorId: input.executorId,
		displayName: input.displayName,
		createdAtMs: now,
		updatedAtMs: now,
		retired: false,
		labels: input.labels ? [...new Set(input.labels)].sort() : [],
		configuredCapabilities: input.configuredCapabilities ?? {},
		remoteTargetId: input.remoteTargetId,
		runtimeEpoch: 0,
		revision: 1,
	};
}
