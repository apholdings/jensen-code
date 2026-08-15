/**
 * Executor Registry — domain types, DTOs and structured errors (2.10.0).
 *
 * First-class durable model of *what executor runtimes exist*, not of what work
 * they should be assigned. This module is provider-independent and scheduler-
 * free: it records stable executor identity, per-process runtime incarnations,
 * advertised capabilities, and resource observations. It never encodes
 * assignment policy, never probes remote provider health, and never exposes
 * secrets.
 *
 * Identity model (mandatory):
 *   - `executorId`        — stable logical executor identity (survives restart).
 *   - `runtimeInstanceId` — one concrete running process/incarnation.
 *   - `runtimeEpoch`      — monotonically increasing activation generation.
 *
 * `runtimeEpoch` is a separate authority domain from the mission execution
 * `fencingToken`; the two are never conflated.
 */

import { randomUUID } from "node:crypto";
import * as os from "node:os";
import type { AssignmentSummary } from "../assignment/assignment-types.js";

// =============================================================================
// Structured errors
// =============================================================================

export type ExecutorRegistryErrorCode =
	| "EXECUTOR_NOT_FOUND"
	| "EXECUTOR_ALREADY_EXISTS"
	| "EXECUTOR_ALREADY_ACTIVE"
	| "EXECUTOR_RETIRED"
	| "STALE_EXECUTOR_INSTANCE"
	| "EXECUTOR_RUNTIME_EXPIRED"
	| "EXECUTOR_NOT_ACTIVE"
	| "INVALID_EXECUTOR_ID"
	| "EXECUTOR_CORRUPT"
	| "REGISTRY_LOCK_TIMEOUT";

export class ExecutorRegistryError extends Error {
	readonly code: ExecutorRegistryErrorCode;
	readonly details: Readonly<Record<string, unknown>>;

	constructor(code: ExecutorRegistryErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
		super(message);
		this.name = "ExecutorRegistryError";
		this.code = code;
		this.details = Object.freeze({ ...details });
	}
}

// =============================================================================
// Identity
// =============================================================================

/**
 * A safe `executorId` is used as a file path component by the concrete store.
 * Reject anything that could escape the store root or inject a path separator.
 */
export function isSafeExecutorId(value: string): boolean {
	return /^[A-Za-z0-9._-]+$/u.test(value) && value !== "." && value !== "..";
}

/**
 * Minimal proof a live runtime presents for every runtime-authoritative
 * mutation. This is the executor-domain analogue of `ExecutionLeaseProof` and
 * is deliberately NOT a mission fencing token.
 */
export interface ExecutorRuntimeProof {
	executorId: string;
	runtimeInstanceId: string;
	runtimeEpoch: number;
}

/**
 * Stable runtime owner identity. Deliberately not PID-derived (PIDs are
 * reusable) and never contains secrets. Host + random UUID are sufficient for
 * diagnosable, opaque, process-lifetime-stable identity.
 */
export function newRuntimeOwnerId(hostname: string = os.hostname()): string {
	return `runtime_${hostname}_${randomUUID()}`;
}

// =============================================================================
// Capabilities
// =============================================================================

/**
 * Provider-independent, extensible capability advertisement. Capabilities are
 * claims ("this executor can do X"), never scheduler decisions and never
 * authorization grants.
 */
export interface ExecutorCapabilities {
	/** Platform snapshot derived from the runtime, never a promise. */
	platform?: {
		os?: string;
		arch?: string;
	};
	/** Generic execution capabilities: shell, git, filesystem, ... */
	execution?: string[];
	/** Locally configured provider ids (no keys/secrets). */
	providers?: string[];
	/** Locally configured model ids/aliases (no keys/secrets). */
	models?: string[];
	/** Tool/capability names. */
	tools?: string[];
	/** Specialized capabilities: unity, dotnet, python, docker, gpu-compute, ... */
	specialized?: string[];
	/** Extensible free-form capability strings. */
	extra?: string[];
}

// =============================================================================
// Resource snapshot
// =============================================================================

export interface GpuDevice {
	id?: string;
	name?: string;
	vendor?: string;
	memoryTotalBytes?: number;
	memoryFreeBytes?: number;
}

/**
 * Intentionally non-authoritative observation at time T, not a reservation and
 * not a durable allocation. Availability is never claimed to persist.
 */
export interface ExecutorResourceSnapshot {
	observedAtMs: number;
	cpuLogicalCount?: number;
	memoryTotalBytes?: number;
	memoryFreeBytes?: number;
	/**
	 * Generic GPU representation. Unavailable is a valid, non-failing result;
	 * the registry must never require NVIDIA or any specific vendor.
	 */
	gpu?: {
		status: "unavailable" | "available";
		devices: GpuDevice[];
	};
}

// =============================================================================
// Runtime + record
// =============================================================================

/** Diagnostics-only incarnation metadata. `runtimeInstanceId` is the identity. */
export interface ExecutorRuntime {
	runtimeInstanceId: string;
	/** Opaque process-lifetime owner identity (host + UUID), never a PID. */
	ownerId: string;
	/** Diagnostics only. Never identity. */
	hostname?: string;
	pid?: number;
	platform?: string;
	arch?: string;
	processStartedAtMs?: number;
	jensenVersion?: string;

	startedAtMs: number;
	lastHeartbeatAtMs: number;
	expiresAtMs: number;

	advertisedCapabilities: ExecutorCapabilities;
	resources?: ExecutorResourceSnapshot;
}

/** Stable configuration/definition, independent of any running incarnation. */
export interface ExecutorDefinition {
	executorId: string;
	displayName?: string;
	labels: string[];
	configuredCapabilities: ExecutorCapabilities;
}

/** One durable executor record: stable definition + current runtime state. */
export interface ExecutorRecord {
	schemaVersion: 1;
	executorId: string;
	displayName?: string;
	createdAtMs: number;
	updatedAtMs: number;
	retired: boolean;
	labels: string[];
	configuredCapabilities: ExecutorCapabilities;
	/** Monotonic activation generation; 0 until the first activation. */
	runtimeEpoch: number;
	runtime?: ExecutorRuntime;
	/** Monotonic generation for stale-update detection. */
	revision: number;
}

// =============================================================================
// Liveness
// =============================================================================

export type ExecutorLivenessStatus = "REGISTERED" | "ONLINE" | "STALE" | "OFFLINE" | "RETIRED";

export interface ExecutorLiveness {
	status: ExecutorLivenessStatus;
	heartbeatValid: boolean;
	expiresAtMs?: number;
	remainingMs?: number;
}

// =============================================================================
// Views (stable operator DTOs)
// =============================================================================

export interface ExecutorSummary {
	executorId: string;
	displayName?: string;
	status: ExecutorLivenessStatus;
	retired: boolean;
	createdAtMs: number;
	updatedAtMs: number;
	runtimeEpoch: number;
	runtimeInstanceId?: string;
	hostname?: string;
	platform?: string;
	arch?: string;
	lastHeartbeatAtMs?: number;
	expiresAtMs?: number;
	labels: string[];
	capabilities: ExecutorCapabilities;
}

export interface ExecutorDetail {
	executorId: string;
	displayName?: string;
	status: ExecutorLivenessStatus;
	retired: boolean;
	createdAtMs: number;
	updatedAtMs: number;
	labels: string[];
	configuredCapabilities: ExecutorCapabilities;
	runtimeEpoch: number;
	runtime?: ExecutorRuntime;
	liveness: ExecutorLiveness;
	/**
	 * Bounded current-assignment summaries. Present only when an assignment
	 * store is wired; otherwise `unavailable` (never fabricated).
	 */
	currentAssignments:
		| { status: "available"; assignments: AssignmentSummary[] }
		| { status: "unavailable"; reason: string };
}

export type ExecutorListSort = "createdAtMs" | "updatedAtMs" | "executorId";
export type ExecutorListDirection = "asc" | "desc";

export interface ExecutorListFilter {
	status?: ExecutorLivenessStatus;
	platform?: string;
	arch?: string;
	label?: string;
	capability?: string;
	provider?: string;
	model?: string;
	retired?: boolean;
}

export interface ExecutorListOptions {
	filter?: ExecutorListFilter;
	sort?: ExecutorListSort;
	direction?: ExecutorListDirection;
	limit?: number;
	offset?: number;
}

export interface ExecutorListResult {
	entries: ExecutorSummary[];
	/** Corrupt records surfaced structurally, never folded into healthy state. */
	corrupt: { executorId: string; diagnostic: string }[];
}

// =============================================================================
// Mutation inputs / outcomes
// =============================================================================

export interface RegisterExecutorInput {
	executorId: string;
	displayName?: string;
	labels?: string[];
	configuredCapabilities?: ExecutorCapabilities;
}

export interface ActivateExecutorInput {
	/** Caller-allocated incarnation id; generated when omitted. */
	runtimeInstanceId?: string;
	ownerId?: string;
	hostname?: string;
	pid?: number;
	platform?: string;
	arch?: string;
	processStartedAtMs?: number;
	jensenVersion?: string;
	advertisedCapabilities?: ExecutorCapabilities;
	resources?: ExecutorResourceSnapshot;
	/** Heartbeat expiry window (ms). Default from service. */
	expiryMs?: number;
}

export interface ExecutorRuntimeMutationInput {
	resources?: ExecutorResourceSnapshot;
	advertisedCapabilities?: ExecutorCapabilities;
	/** Expiry window for heartbeat. */
	expiryMs?: number;
}

export interface ExecutorActivationOutcome {
	executorId: string;
	runtimeInstanceId: string;
	runtimeEpoch: number;
	proof: ExecutorRuntimeProof;
	expiresAtMs: number;
	record: ExecutorRecord;
}

export interface ExecutorHeartbeatOutcome {
	executorId: string;
	runtimeInstanceId: string;
	runtimeEpoch: number;
	lastHeartbeatAtMs: number;
	expiresAtMs: number;
	record: ExecutorRecord;
}

export interface ExecutorDeactivateOutcome {
	executorId: string;
	runtimeInstanceId: string;
	runtimeEpoch: number;
	record: ExecutorRecord;
}

export type ExecutorRetireStatus = "retired" | "retired_active_runtime";

export interface ExecutorRetireOutcome {
	executorId: string;
	status: ExecutorRetireStatus;
	runtimeInstanceId?: string;
	record: ExecutorRecord;
}
