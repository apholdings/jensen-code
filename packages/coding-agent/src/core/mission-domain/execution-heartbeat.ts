/**
 * Execution Heartbeat (2.8.0).
 *
 * Active lease maintenance for a single execution ownership lifetime.
 *
 * The durable execution lease protects *authoritative* mutation, but by itself
 * it cannot stop a long-running executor (local Qwen, tools, tests) from
 * continuing to burn resources after its lease expires and another process
 * takes ownership. This module is the runtime half of that contract:
 *
 *   - It renews the lease on a safe cadence while the owning execution is
 *     healthy, without ever changing the fencing token.
 *   - It classifies renewal outcomes into SUCCESS, TRANSIENT retryable failure,
 *     or DEFINITE ownership loss.
 *   - It aborts the owning execution through an injected authority-loss
 *     callback when ownership is lost or can no longer be proven before the
 *     lease safety margin.
 *
 * The heartbeat is deliberately a *local* runtime object owned by the
 * coordinator's execution lifetime. It is never a global/background timer and
 * never a daemon: it starts only after durable RUNNING ownership is confirmed
 * and stops exactly once on completion, cancellation, launch failure, authority
 * loss, or an unhandled execution error.
 */

import { ExecutionOwnershipError } from "./execution-lease.js";

// =============================================================================
// Timing policy
// =============================================================================

export interface HeartbeatTimingInput {
	/** Lease lifetime used by the coordinator/store. Must be a positive safe integer. */
	leaseDurationMs: number;
	/**
	 * Renewal cadence. Defaults to `leaseDurationMs / 3`, i.e. three renewals
	 * per lease lifetime — enough to survive a single missed renewal while
	 * keeping filesystem churn negligible relative to LLM execution.
	 */
	heartbeatIntervalMs?: number;
	/**
	 * Safety window before expiry inside which a renewal can no longer be
	 * trusted. Defaults to `leaseDurationMs / 6`. If the heartbeat reaches this
	 * window without a confirmed renewal it aborts conservatively rather than
	 * continue work on an expiring lease.
	 */
	renewalSafetyMarginMs?: number;
}

export interface ResolvedHeartbeatTiming {
	leaseDurationMs: number;
	heartbeatIntervalMs: number;
	renewalSafetyMarginMs: number;
}

/**
 * Validate and normalize heartbeat timing. Invalid configurations must never
 * silently create unsafe behavior (a heartbeat that can never run, or one that
 * only fires after the lease is already expiring).
 */
export function resolveHeartbeatTiming(input: HeartbeatTimingInput): ResolvedHeartbeatTiming {
	const { leaseDurationMs } = input;
	if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
		throw new Error(`heartbeat leaseDurationMs must be a positive safe integer, got ${String(leaseDurationMs)}`);
	}
	const heartbeatIntervalMs = input.heartbeatIntervalMs ?? Math.floor(leaseDurationMs / 3);
	const renewalSafetyMarginMs = input.renewalSafetyMarginMs ?? Math.floor(leaseDurationMs / 6);

	if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs <= 0) {
		throw new Error(`heartbeatIntervalMs must be a positive safe integer, got ${String(heartbeatIntervalMs)}`);
	}
	if (!Number.isSafeInteger(renewalSafetyMarginMs) || renewalSafetyMarginMs < 0) {
		throw new Error(
			`renewalSafetyMarginMs must be a non-negative safe integer, got ${String(renewalSafetyMarginMs)}`,
		);
	}
	if (renewalSafetyMarginMs >= leaseDurationMs) {
		throw new Error(
			`renewalSafetyMarginMs (${renewalSafetyMarginMs}) must be less than leaseDurationMs (${leaseDurationMs})`,
		);
	}
	if (heartbeatIntervalMs >= leaseDurationMs - renewalSafetyMarginMs) {
		throw new Error(
			`heartbeatIntervalMs (${heartbeatIntervalMs}) must be less than leaseDurationMs - renewalSafetyMarginMs ` +
				`(${leaseDurationMs - renewalSafetyMarginMs}) so a renewal always lands inside the safe window`,
		);
	}

	return { leaseDurationMs, heartbeatIntervalMs, renewalSafetyMarginMs };
}

// =============================================================================
// Scheduling seam
// =============================================================================

export interface HeartbeatTimer {
	clear(): void;
}

/**
 * Injectable timer scheduling (default: `setTimeout`). Recursive scheduling is
 * used so at most one renewal is ever in flight and ticks never overlap.
 */
export type HeartbeatScheduler = (fn: () => void, delayMs: number) => HeartbeatTimer;

export const defaultHeartbeatScheduler: HeartbeatScheduler = (fn, delayMs) => {
	const handle = setTimeout(fn, delayMs);
	return { clear: () => clearTimeout(handle) };
};

// =============================================================================
// Renewal classification
// =============================================================================

export type HeartbeatRenewalFailureKind = "DEFINITE_OWNERSHIP_LOSS" | "TRANSIENT_RENEWAL_FAILURE";

/**
 * Classify a renewal error. Only structured, authoritative ownership-loss codes
 * are DEFINITE; everything else (short filesystem contention, temporary lock
 * timeouts, unexpected I/O) is TRANSIENT and may be retried while lease
 * validity still remains.
 */
export function classifyHeartbeatRenewalError(error: unknown): HeartbeatRenewalFailureKind {
	if (error instanceof ExecutionOwnershipError) {
		switch (error.code) {
			case "STALE_EXECUTION_OWNER":
			case "LEASE_NOT_FOUND":
			case "LEASE_EXPIRED":
				return "DEFINITE_OWNERSHIP_LOSS";
			default:
				return "TRANSIENT_RENEWAL_FAILURE";
		}
	}
	return "TRANSIENT_RENEWAL_FAILURE";
}

// =============================================================================
// Authority loss
// =============================================================================

export type HeartbeatAuthorityLossReason =
	| "EXECUTION_AUTHORITY_LOST"
	| "HEARTBEAT_LEASE_EXPIRING"
	| "HEARTBEAT_RENEWAL_FAILED";

export interface HeartbeatAuthorityLossInfo {
	reason: HeartbeatAuthorityLossReason;
	message: string;
	atMs: number;
	detail?: Readonly<Record<string, unknown>>;
}

/**
 * Internal execution-authority-loss abstraction. Distinct from the existing
 * store/ownership errors (`STALE_EXECUTION_OWNER`, etc.): those describe a
 * fenced store mutation, whereas this describes the local runtime decision to
 * stop because the execution can no longer prove it owns the lease.
 */
export class ExecutionAuthorityLostError extends Error {
	readonly code = "EXECUTION_AUTHORITY_LOST" as const;
	readonly reason: HeartbeatAuthorityLossReason;
	readonly detail?: Readonly<Record<string, unknown>>;

	constructor(info: HeartbeatAuthorityLossInfo) {
		super(info.message);
		this.name = "ExecutionAuthorityLostError";
		this.reason = info.reason;
		this.detail = info.detail;
	}
}

// =============================================================================
// Telemetry
// =============================================================================

export interface HeartbeatTelemetry {
	heartbeatActive: boolean;
	heartbeatIntervalMs: number;
	lastRenewalAt?: number;
	leaseExpiresAt: number;
	renewalCount: number;
	renewalFailureCount: number;
	lastRenewalError?: string;
	authorityLost: boolean;
	authorityLostAt?: number;
	authorityLostReason?: HeartbeatAuthorityLossReason;
}

// =============================================================================
// Heartbeat
// =============================================================================

export interface ExecutionHeartbeatDeps {
	missionId: string;
	leaseId: string;
	fencingToken: number;
	timing: ResolvedHeartbeatTiming;
	now: () => number;
	schedule: HeartbeatScheduler;
	/**
	 * Resolve with the renewed lease expiry. Reject with an
	 * `ExecutionOwnershipError` (or an unexpected runtime error) on failure.
	 */
	renew: (now: number) => Promise<{ expiresAtMs: number }>;
	/** Called exactly once when ownership is lost or can no longer be proven. */
	onAuthorityLost: (info: HeartbeatAuthorityLossInfo) => void;
}

export class ExecutionHeartbeat {
	private readonly _deps: ExecutionHeartbeatDeps;
	private _active = false;
	private _timer: HeartbeatTimer | undefined;
	private _expiresAtMs = 0;
	private _lastRenewalAt: number | undefined;
	private _renewalCount = 0;
	private _renewalFailureCount = 0;
	private _lastRenewalError: string | undefined;
	private _authorityLost = false;
	private _authorityLostAt: number | undefined;
	private _authorityLostReason: HeartbeatAuthorityLossReason | undefined;

	constructor(deps: ExecutionHeartbeatDeps) {
		this._deps = deps;
	}

	get missionId(): string {
		return this._deps.missionId;
	}

	get leaseId(): string {
		return this._deps.leaseId;
	}

	get fencingToken(): number {
		return this._deps.fencingToken;
	}

	/** Begin renewal after the initial ownership has been durably confirmed. */
	start(initialExpiresAtMs: number): void {
		if (this._active) return;
		this._active = true;
		this._expiresAtMs = initialExpiresAtMs;
		this._scheduleNext();
	}

	/** Idempotent stop. Never invokes the authority-loss callback. */
	stop(): void {
		if (!this._active && !this._timer) return;
		this._active = false;
		this._clearTimer();
	}

	telemetry(): HeartbeatTelemetry {
		return {
			heartbeatActive: this._active,
			heartbeatIntervalMs: this._deps.timing.heartbeatIntervalMs,
			lastRenewalAt: this._lastRenewalAt,
			leaseExpiresAt: this._expiresAtMs,
			renewalCount: this._renewalCount,
			renewalFailureCount: this._renewalFailureCount,
			lastRenewalError: this._lastRenewalError,
			authorityLost: this._authorityLost,
			authorityLostAt: this._authorityLostAt,
			authorityLostReason: this._authorityLostReason,
		};
	}

	private _scheduleNext(): void {
		if (!this._active) return;
		this._clearTimer();
		this._timer = this._deps.schedule(() => {
			this._timer = undefined;
			void this._tick();
		}, this._deps.timing.heartbeatIntervalMs);
	}

	private _clearTimer(): void {
		if (this._timer) {
			this._timer.clear();
			this._timer = undefined;
		}
	}

	private async _tick(): Promise<void> {
		if (!this._active) return;
		const now = this._deps.now();
		const remaining = this._expiresAtMs - now;

		if (remaining <= this._deps.timing.renewalSafetyMarginMs) {
			this._triggerAuthorityLost({
				reason: "HEARTBEAT_LEASE_EXPIRING",
				message: `Cannot renew lease for mission ${this._deps.missionId} before the safety margin`,
				atMs: now,
				detail: { remainingMs: remaining, expiresAtMs: this._expiresAtMs },
			});
			return;
		}

		try {
			const renewed = await this._deps.renew(now);
			if (!this._active) return;
			this._expiresAtMs = renewed.expiresAtMs;
			this._lastRenewalAt = now;
			this._renewalCount += 1;
			this._lastRenewalError = undefined;
			this._scheduleNext();
		} catch (error) {
			if (!this._active) return;

			const kind = classifyHeartbeatRenewalError(error);
			if (kind === "DEFINITE_OWNERSHIP_LOSS") {
				this._triggerAuthorityLost({
					reason: "EXECUTION_AUTHORITY_LOST",
					message: `Execution authority for mission ${this._deps.missionId} was lost`,
					atMs: now,
					detail: {
						leaseId: this._deps.leaseId,
						fencingToken: this._deps.fencingToken,
						errorCode: error instanceof ExecutionOwnershipError ? error.code : undefined,
					},
				});
				return;
			}

			this._renewalFailureCount += 1;
			this._lastRenewalError = error instanceof Error ? error.message : String(error);

			const remainingAfter = this._expiresAtMs - this._deps.now();
			if (remainingAfter <= this._deps.timing.renewalSafetyMarginMs) {
				this._triggerAuthorityLost({
					reason: "HEARTBEAT_RENEWAL_FAILED",
					message: `Heartbeat renewal failed and lease validity can no longer be confirmed for mission ${this._deps.missionId}`,
					atMs: this._deps.now(),
					detail: { remainingMs: remainingAfter, lastError: this._lastRenewalError },
				});
				return;
			}

			this._scheduleNext();
		}
	}

	private _triggerAuthorityLost(info: HeartbeatAuthorityLossInfo): void {
		if (this._authorityLost) return;
		this._authorityLost = true;
		this._authorityLostAt = info.atMs;
		this._authorityLostReason = info.reason;
		this._active = false;
		this._clearTimer();
		this._deps.onAuthorityLost(info);
	}
}
