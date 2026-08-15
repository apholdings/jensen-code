/**
 * Execution Lease + Fencing (2.7.0).
 *
 * First-class durable execution ownership for a single durable mission.
 *
 * The local file-backed store already guarantees an atomic record swap and an
 * atomic cross-process mutation critical section. This module models the
 * *long-lived* ownership contract layered on top of that short critical
 * section:
 *
 *   - `ExecutionLease` identifies the single current execution owner.
 *   - `fencingToken` is the monotonic ownership epoch for that mission. It is
 *     stored on the durable record itself (not only inside the lease) so it
 *     survives lease clearing and can never move backward across takeover or
 *     recovery revocation.
 *   - `ExecutionLeaseProof` is the small credential a live owner presents on
 *     every execution-authoritative mutation.
 *
 * The file mutation lock is deliberately NOT this lease: the lock protects
 * milliseconds-long record swaps, the lease protects minutes/hours-long
 * ownership. A stale lock and an expired lease are different failure domains.
 */

import { randomUUID } from "node:crypto";
import * as os from "node:os";

/** Default execution-ownership lease lifetime. Configurable per coordinator. */
export const DEFAULT_EXECUTION_LEASE_DURATION_MS = 30 * 60_000;

export interface ExecutionLease {
	/** Opaque, non-PID-derived executor owner identity. Stable for one ownership lifetime. */
	ownerId: string;
	/** Unique acquisition identity for this ownership instance. */
	leaseId: string;
	/** Monotonic ownership epoch; strictly increases on every acquisition and recovery revocation. */
	fencingToken: number;
	acquiredAtMs: number;
	renewedAtMs: number;
	expiresAtMs: number;
}

/** Minimal proof a live owner presents for execution-authoritative mutation. */
export interface ExecutionLeaseProof {
	leaseId: string;
	fencingToken: number;
}

/** True while the lease still authorizes execution-authoritative mutation. */
export function isExecutionLeaseActive(lease: ExecutionLease, now: number): boolean {
	return lease.expiresAtMs > now;
}

/**
 * Stable executor owner identity. Deliberately not PID-derived (PIDs are
 * reusable) and never contains secrets. Host + random UUID are sufficient for
 * diagnosable, opaque, process-lifetime-stable identity.
 */
export function newExecutorOwnerId(hostname: string = os.hostname()): string {
	return `owner_${hostname}_${randomUUID()}`;
}

export type ExecutionOwnershipErrorCode =
	| "MISSION_OWNED"
	| "STALE_REVISION"
	| "STALE_EXECUTION_OWNER"
	| "LEASE_EXPIRED"
	| "LEASE_NOT_FOUND"
	| "LEASE_CONFLICT"
	| "LOCK_TIMEOUT"
	| "CORRUPT_LOCK_METADATA";

/**
 * Structured ownership error. Core logic never relies on message string
 * matching; consumers switch on `code`.
 */
export class ExecutionOwnershipError extends Error {
	readonly code: ExecutionOwnershipErrorCode;
	readonly detail?: Readonly<Record<string, unknown>>;

	constructor(code: ExecutionOwnershipErrorCode, message: string, detail?: Readonly<Record<string, unknown>>) {
		super(message);
		this.name = "ExecutionOwnershipError";
		this.code = code;
		this.detail = detail ? Object.freeze({ ...detail }) : undefined;
	}
}
