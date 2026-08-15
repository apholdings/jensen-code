/**
 * Execution heartbeat unit tests (2.8.0).
 *
 * Deterministic tests of the heartbeat manager itself: renewal cadence, exact
 * stop semantics, transient-vs-definite failure classification, conservative
 * near-expiry abort, and observability. These use an injectable fake clock and
 * scheduler so no real timers keep the test process alive.
 */

import { describe, expect, it } from "vitest";
import {
	classifyHeartbeatRenewalError,
	ExecutionAuthorityLostError,
	ExecutionHeartbeat,
	type HeartbeatAuthorityLossInfo,
	type HeartbeatScheduler,
	type HeartbeatTimer,
	resolveHeartbeatTiming,
} from "../../src/core/mission-domain/execution-heartbeat.js";
import { ExecutionOwnershipError } from "../../src/core/mission-domain/execution-lease.js";

interface PendingTimer {
	at: number;
	fn: () => void;
	cleared: boolean;
}

class FakeTime {
	now = 0;
	private readonly _pending: PendingTimer[] = [];

	scheduler: HeartbeatScheduler = (fn, delayMs) => {
		const timer: PendingTimer = { at: this.now + delayMs, fn, cleared: false };
		this._pending.push(timer);
		return { clear: () => this._clearTimer(timer) } satisfies HeartbeatTimer;
	};

	pendingCount(): number {
		return this._pending.filter((timer) => !timer.cleared).length;
	}

	async advance(ms: number): Promise<void> {
		this.now += ms;
		for (;;) {
			const due = this._pending
				.filter((timer) => !timer.cleared && timer.at <= this.now)
				.sort((a, b) => a.at - b.at)[0];
			if (!due) break;
			due.cleared = true;
			due.fn();
			// Flush microtasks so the async tick's `await renew(...)` continuation
			// (and any subsequent scheduling) runs before we inspect state.
			await flushMicrotasks();
		}
	}

	private _clearTimer(timer: PendingTimer): void {
		timer.cleared = true;
	}
}

async function flushMicrotasks(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function timing(overrides: { leaseDurationMs?: number; intervalMs?: number; marginMs?: number } = {}) {
	const leaseDurationMs = overrides.leaseDurationMs ?? 1000;
	return resolveHeartbeatTiming({
		leaseDurationMs,
		heartbeatIntervalMs: overrides.intervalMs ?? 300,
		renewalSafetyMarginMs: overrides.marginMs ?? 300,
	});
}

function heartbeat(opts: {
	renew: (now: number) => Promise<{ expiresAtMs: number }>;
	onAuthorityLost?: (info: HeartbeatAuthorityLossInfo) => void;
	timingOverrides?: { leaseDurationMs?: number; intervalMs?: number; marginMs?: number };
}) {
	const time = new FakeTime();
	const losses: HeartbeatAuthorityLossInfo[] = [];
	const hb = new ExecutionHeartbeat({
		missionId: "mission_hb",
		leaseId: "lease_hb",
		fencingToken: 1,
		timing: timing(opts.timingOverrides),
		now: () => time.now,
		schedule: time.scheduler,
		renew: opts.renew,
		onAuthorityLost: (info) => {
			losses.push(info);
			opts.onAuthorityLost?.(info);
		},
	});
	return { time, hb, losses };
}

describe("heartbeat timing validation", () => {
	it("rejects non-positive lease duration, interval, and too-large safety margin", () => {
		expect(() => resolveHeartbeatTiming({ leaseDurationMs: 0 })).toThrow(/leaseDurationMs/u);
		expect(() => resolveHeartbeatTiming({ leaseDurationMs: 1000, heartbeatIntervalMs: 0 })).toThrow(
			/heartbeatIntervalMs/u,
		);
		expect(() =>
			resolveHeartbeatTiming({ leaseDurationMs: 1000, heartbeatIntervalMs: 1000, renewalSafetyMarginMs: 0 }),
		).toThrow(/safety margin|safe window/u);
		expect(() =>
			resolveHeartbeatTiming({ leaseDurationMs: 1000, heartbeatIntervalMs: 100, renewalSafetyMarginMs: 1000 }),
		).toThrow(/renewalSafetyMarginMs/u);
	});

	it("derives sensible defaults: three renewals per lease, half-interval safety", () => {
		expect(resolveHeartbeatTiming({ leaseDurationMs: 30_000 })).toEqual({
			leaseDurationMs: 30_000,
			heartbeatIntervalMs: 10_000,
			renewalSafetyMarginMs: 5000,
		});
	});
});

describe("TEST A — heartbeat renews and extends expiry without touching the fence", () => {
	it("multiple successful renewals extend expiry and count renewals", async () => {
		let renewalCalls = 0;
		const { time, hb } = heartbeat({
			renew: async (now) => {
				renewalCalls += 1;
				return { expiresAtMs: now + 1000 };
			},
		});
		hb.start(1000);

		await time.advance(300);
		await time.advance(300);
		await time.advance(300);

		expect(renewalCalls).toBe(3);
		expect(hb.telemetry().renewalCount).toBe(3);
		expect(hb.telemetry().leaseExpiresAt).toBe(900 + 1000);
		expect(hb.fencingToken).toBe(1);
		expect(hb.telemetry().authorityLost).toBe(false);
	});
});

describe("TEST B/D/E — heartbeat stops exactly once and leaves no orphan timer", () => {
	it("stop() halts renewals and clears pending timers", async () => {
		let renewalCalls = 0;
		const { time, hb } = heartbeat({
			renew: async (now) => {
				renewalCalls += 1;
				return { expiresAtMs: now + 1000 };
			},
		});
		hb.start(1000);
		await time.advance(300);
		expect(renewalCalls).toBe(1);

		hb.stop();
		expect(hb.telemetry().heartbeatActive).toBe(false);
		expect(time.pendingCount()).toBe(0);

		await time.advance(300);
		expect(renewalCalls).toBe(1);
		expect(time.pendingCount()).toBe(0);
	});
});

describe("TEST C — heartbeat stops on definitive ownership loss", () => {
	it("a stale-owner renewal invokes authority-loss exactly once and stops", async () => {
		let lossCalls = 0;
		const { time, hb, losses } = heartbeat({
			renew: async () => {
				throw new ExecutionOwnershipError("STALE_EXECUTION_OWNER", "stale owner");
			},
			onAuthorityLost: () => {
				lossCalls += 1;
			},
		});
		hb.start(1000);

		await time.advance(300);

		expect(lossCalls).toBe(1);
		expect(losses[0].reason).toBe("EXECUTION_AUTHORITY_LOST");
		expect(hb.telemetry().authorityLost).toBe(true);
		expect(hb.telemetry().heartbeatActive).toBe(false);
		expect(time.pendingCount()).toBe(0);
	});

	it("classifies only authoritative ownership codes as definite loss", () => {
		expect(classifyHeartbeatRenewalError(new ExecutionOwnershipError("STALE_EXECUTION_OWNER", "x"))).toBe(
			"DEFINITE_OWNERSHIP_LOSS",
		);
		expect(classifyHeartbeatRenewalError(new ExecutionOwnershipError("LEASE_NOT_FOUND", "x"))).toBe(
			"DEFINITE_OWNERSHIP_LOSS",
		);
		expect(classifyHeartbeatRenewalError(new ExecutionOwnershipError("LEASE_EXPIRED", "x"))).toBe(
			"DEFINITE_OWNERSHIP_LOSS",
		);
		expect(classifyHeartbeatRenewalError(new ExecutionOwnershipError("LOCK_TIMEOUT", "x"))).toBe(
			"TRANSIENT_RENEWAL_FAILURE",
		);
		expect(classifyHeartbeatRenewalError(new Error("io error"))).toBe("TRANSIENT_RENEWAL_FAILURE");
	});
});

describe("TEST F — transient renewal failure retries while validity remains", () => {
	it("retries a temporary failure and then succeeds without authority loss", async () => {
		let calls = 0;
		const { time, hb, losses } = heartbeat({
			renew: async (now) => {
				calls += 1;
				if (calls === 1) throw new Error("temporary fs contention");
				return { expiresAtMs: now + 1000 };
			},
		});
		hb.start(1000);

		await time.advance(300);
		expect(calls).toBe(1);
		expect(hb.telemetry().renewalFailureCount).toBe(1);
		expect(hb.telemetry().lastRenewalError).toMatch(/temporary/u);
		expect(losses).toHaveLength(0);

		await time.advance(300);
		expect(calls).toBe(2);
		expect(hb.telemetry().renewalCount).toBe(1);
		expect(hb.telemetry().authorityLost).toBe(false);
	});
});

describe("TEST G — near-expiry uncertainty aborts conservatively", () => {
	it("a slow transient failure that breaches the safety margin triggers HEARTBEAT_RENEWAL_FAILED", async () => {
		const { time, hb, losses } = heartbeat({
			timingOverrides: { leaseDurationMs: 1000, intervalMs: 400, marginMs: 300 },
			renew: async () => {
				// Simulate a slow filesystem: 350ms elapses during the failed renewal.
				time.now += 350;
				throw new Error("slow transient failure");
			},
		});
		hb.start(1000);

		await time.advance(400);

		expect(losses).toHaveLength(1);
		expect(losses[0].reason).toBe("HEARTBEAT_RENEWAL_FAILED");
		expect(hb.telemetry().authorityLost).toBe(true);
		expect(time.pendingCount()).toBe(0);
	});

	it("reaching the safety margin before any renewal aborts with HEARTBEAT_LEASE_EXPIRING", async () => {
		const { time, hb, losses } = heartbeat({
			timingOverrides: { leaseDurationMs: 1000, intervalMs: 400, marginMs: 300 },
			renew: async (now) => ({ expiresAtMs: now + 1000 }),
		});
		// Start with a very short known expiry so the first tick is already inside
		// the safety margin.
		hb.start(700);
		await time.advance(400);

		expect(losses).toHaveLength(1);
		expect(losses[0].reason).toBe("HEARTBEAT_LEASE_EXPIRING");
	});
});

describe("TEST T — observability reflects lifecycle", () => {
	it("telemetry tracks renewal/loss state without secrets", async () => {
		const { time, hb } = heartbeat({
			renew: async (now) => ({ expiresAtMs: now + 1000 }),
		});
		hb.start(1000);

		expect(hb.telemetry()).toMatchObject({
			heartbeatActive: true,
			heartbeatIntervalMs: 300,
			leaseExpiresAt: 1000,
			renewalCount: 0,
			renewalFailureCount: 0,
			authorityLost: false,
		});

		await time.advance(300);
		expect(hb.telemetry().renewalCount).toBe(1);
		expect(hb.telemetry().lastRenewalAt).toBe(300);
		expect(hb.telemetry().leaseExpiresAt).toBe(1300);

		hb.stop();
		expect(hb.telemetry().heartbeatActive).toBe(false);
	});
});

describe("ExecutionAuthorityLostError", () => {
	it("is a structured, distinguishable authority-loss abstraction", () => {
		const error = new ExecutionAuthorityLostError({
			reason: "EXECUTION_AUTHORITY_LOST",
			message: "authority lost",
			atMs: 5,
			detail: { fencingToken: 2 },
		});
		expect(error.code).toBe("EXECUTION_AUTHORITY_LOST");
		expect(error.reason).toBe("EXECUTION_AUTHORITY_LOST");
		expect(error).toBeInstanceOf(Error);
	});
});
