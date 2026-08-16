/**
 * Shared Inference Scheduler — deterministic tests (3.0.0 foundation).
 *
 * Proves capacity admission, deterministic priority ordering, bounded aging
 * starvation protection, dependency-criticality preference, cancellation, slot
 * leak safety, restart reconciliation, and capacity 1/2/3/4 with a controlled
 * clock and an in-memory ledger. No real Qwen is involved.
 */

import { describe, expect, it } from "vitest";
import { InMemoryInferenceQueueStore } from "../../src/core/shared-inference/in-memory-inference-queue-store.js";
import { SharedInferenceScheduler } from "../../src/core/shared-inference/scheduler.js";
import type {
	AcquireInferenceOutcome,
	AdmittedInference,
	SharedInferenceResource,
} from "../../src/core/shared-inference/types.js";

const RESOURCE: SharedInferenceResource = {
	resourceId: "qwen38-bucephalus",
	backend: "llamacpp-qwen38-bucephalus",
	model: "qwen3.8-27b",
	location: "bucephalus",
	capacity: 1,
	contextWindow: 196608,
	maxOutputTokens: 8192,
	state: "available",
};

interface Harness {
	scheduler: SharedInferenceScheduler;
	store: InMemoryInferenceQueueStore;
	setNow: (t: number) => void;
	tick: () => Promise<void>;
}

function makeHarness(options: { capacity?: number; leaseDurationMs?: number } = {}): Harness {
	const store = new InMemoryInferenceQueueStore();
	let now = 0;
	const scheduler = new SharedInferenceScheduler({
		store,
		now: () => now,
		sleep: () => new Promise((resolve) => setImmediate(resolve)),
		waitPollMs: 1,
		leaseDurationMs: options.leaseDurationMs ?? 60_000,
		leaseIdFactory: (() => {
			let n = 0;
			return () => `lease_${++n}`;
		})(),
		requestIdFactory: (() => {
			let n = 0;
			return () => `inference_${++n}`;
		})(),
		ownerId: "owner-test",
		agingIntervalMs: 1,
		agingWeight: 1,
		interactiveBoost: 100,
		verificationBoost: 200,
		dependencyWeight: 50,
		dependencyCap: 500,
	});
	return {
		scheduler,
		store,
		setNow: (t) => {
			now = t;
		},
		tick: () => new Promise((resolve) => setImmediate(resolve)),
	};
}

function resource(capacity: number): SharedInferenceResource {
	return { ...RESOURCE, capacity };
}

async function register(scheduler: SharedInferenceScheduler, capacity: number): Promise<SharedInferenceResource> {
	const r = resource(capacity);
	await scheduler.registerResource(r);
	return r;
}

async function admit(
	scheduler: SharedInferenceScheduler,
	r: SharedInferenceResource,
	logicalAgentId: string,
): Promise<AdmittedInference> {
	const outcome = await scheduler.acquire({
		logicalAgentId,
		resource: r,
		model: { provider: r.backend, id: r.model },
	});
	expect(outcome.status).toBe("admitted");
	return (outcome as Extract<AcquireInferenceOutcome, { status: "admitted" }>).admitted;
}

describe("SharedInferenceScheduler — capacity admission", () => {
	it("admits up to capacity and releases a slot for the next request", async () => {
		const h = makeHarness();
		const r = await register(h.scheduler, 1);

		const a = await admit(h.scheduler, r, "agent_a");
		let status = await h.scheduler.status();
		expect(status.aggregate.busySlots).toBe(1);
		expect(status.aggregate.idleSlots).toBe(0);

		await h.scheduler.release(a, { state: "COMPLETED", usage: { input: 10, output: 20 } });
		status = await h.scheduler.status();
		expect(status.aggregate.busySlots).toBe(0);
		expect(status.aggregate.idleSlots).toBe(1);
		expect(status.aggregate.completedCount).toBe(1);

		const b = await admit(h.scheduler, r, "agent_b");
		expect(b.slot).toBe(0);
	});

	it("supports capacity 1/2/3/4 and never exceeds configured capacity", async () => {
		for (const capacity of [1, 2, 3, 4]) {
			const h = makeHarness();
			const r = await register(h.scheduler, capacity);

			// First `capacity` requests admit immediately.
			const admitted: AdmittedInference[] = [];
			for (let i = 0; i < capacity; i++) {
				admitted.push(await admit(h.scheduler, r, `agent_${i}`));
			}

			// Next 3 queue (do not consume a slot).
			const pending: Promise<AcquireInferenceOutcome>[] = [];
			for (let i = 0; i < 3; i++) {
				pending.push(
					h.scheduler.acquire({
						logicalAgentId: `queued_${i}`,
						resource: r,
						model: { provider: r.backend, id: r.model },
					}),
				);
			}
			await h.tick();
			await h.tick();

			let status = await h.scheduler.status();
			expect(status.aggregate.busySlots).toBe(capacity);
			expect(status.aggregate.queueDepth).toBe(3);

			// Release the originally-admitted slots; the invariant must hold after
			// every single release (never > capacity).
			for (const a of admitted) {
				await h.scheduler.release(a, { state: "COMPLETED" });
				await h.tick();
				await h.tick();
				status = await h.scheduler.status();
				expect(status.aggregate.busySlots).toBeLessThanOrEqual(capacity);
			}

			// Drain the promoted queue: each pending acquire resolves once admitted.
			for (const p of pending) {
				const outcome = await p;
				expect(outcome.status).toBe("admitted");
				if (outcome.status === "admitted") {
					await h.scheduler.release(outcome.admitted, { state: "COMPLETED" });
				}
			}

			status = await h.scheduler.status();
			expect(status.aggregate.busySlots).toBe(0);
			expect(status.aggregate.queueDepth).toBe(0);
			expect(status.aggregate.completedCount).toBe(capacity + 3);
		}
	});
});

describe("SharedInferenceScheduler — priority / fairness", () => {
	it("orders queued requests by effective priority, then enqueue time, then id", async () => {
		const h = makeHarness();
		const r = await register(h.scheduler, 1);

		const a = await admit(h.scheduler, r, "agent_a"); // occupies slot
		void a;

		void h.scheduler.acquire({
			logicalAgentId: "low",
			resource: r,
			model: { provider: r.backend, id: r.model },
			inferenceRequestId: "req_low",
			priority: { base: 0 },
		});
		await h.tick();
		void h.scheduler.acquire({
			logicalAgentId: "high",
			resource: r,
			model: { provider: r.backend, id: r.model },
			inferenceRequestId: "req_high",
			priority: { base: 100 },
		});
		await h.tick();

		// Release -> high-priority admitted first despite being enqueued later.
		const released = h.scheduler.release(a, { state: "COMPLETED" });
		await released;
		await h.tick();
		await h.tick();

		const status = await h.scheduler.status();
		const running = status.queue.filter((q) => q.state === "RUNNING");
		expect(running[0]?.inferenceRequestId).toBe("req_high");
		await h.scheduler.cancel("req_low");
	});

	it("bounded aging lets an old low-priority request overtake newer high-priority arrivals", async () => {
		const h = makeHarness();
		const r = await register(h.scheduler, 1);

		const a = await admit(h.scheduler, r, "agent_a");

		// Old low-priority request enqueued at t=0.
		const pLow = h.scheduler.acquire({
			logicalAgentId: "old_low",
			resource: r,
			model: { provider: r.backend, id: r.model },
			inferenceRequestId: "req_old_low",
			priority: { base: 0 },
		});
		await h.tick();

		// Several newer high-priority requests.
		h.setNow(100);
		await h.tick();
		const pH1 = h.scheduler.acquire({
			logicalAgentId: "h1",
			resource: r,
			model: { provider: r.backend, id: r.model },
			inferenceRequestId: "req_h1",
			priority: { base: 100 },
		});
		await h.tick();
		h.setNow(200);
		await h.tick();
		const pH2 = h.scheduler.acquire({
			logicalAgentId: "h2",
			resource: r,
			model: { provider: r.backend, id: r.model },
			inferenceRequestId: "req_h2",
			priority: { base: 100 },
		});
		await h.tick();

		// Advance clock far enough that the old low-priority request ages past base-100.
		h.setNow(600);
		await h.tick();

		await h.scheduler.release(a, { state: "COMPLETED" });
		await h.tick();
		await h.tick();

		const status = await h.scheduler.status();
		const running = status.queue.filter((q) => q.state === "RUNNING");
		expect(running[0]?.inferenceRequestId).toBe("req_old_low");

		// Drain all remaining requests cleanly.
		for (const p of [pLow, pH1, pH2]) {
			const outcome = await p;
			if (outcome.status === "admitted") await h.scheduler.release(outcome.admitted, { state: "COMPLETED" });
		}
	});

	it("dependency criticality gives a deterministic scheduling preference at equal base priority", async () => {
		const h = makeHarness();
		const r = await register(h.scheduler, 1);

		const a = await admit(h.scheduler, r, "agent_a");
		void h.scheduler.acquire({
			logicalAgentId: "speculative",
			resource: r,
			model: { provider: r.backend, id: r.model },
			inferenceRequestId: "req_spec",
			priority: { base: 0 },
		});
		await h.tick();
		void h.scheduler.acquire({
			logicalAgentId: "critical",
			resource: r,
			model: { provider: r.backend, id: r.model },
			inferenceRequestId: "req_crit",
			priority: { base: 0 },
			dependency: { unblocksCount: 5 },
		});
		await h.tick();

		await h.scheduler.release(a, { state: "COMPLETED" });
		await h.tick();
		await h.tick();

		const status = await h.scheduler.status();
		const running = status.queue.filter((q) => q.state === "RUNNING");
		expect(running[0]?.inferenceRequestId).toBe("req_crit");
		await h.scheduler.cancel("req_spec");
	});
});

describe("SharedInferenceScheduler — cancellation / failure / leak", () => {
	it("a cancelled queued request never consumes a slot", async () => {
		const h = makeHarness();
		const r = await register(h.scheduler, 1);
		const a = await admit(h.scheduler, r, "agent_a");

		void h.scheduler.acquire({
			logicalAgentId: "queued",
			resource: r,
			model: { provider: r.backend, id: r.model },
			inferenceRequestId: "req_queued",
			priority: { base: 0 },
		});
		await h.tick();
		await h.tick();

		expect((await h.scheduler.status()).aggregate.queueDepth).toBe(1);
		const cancelled = await h.scheduler.cancel("req_queued");
		expect(cancelled.status).toBe("cancelled");

		const status = await h.scheduler.status();
		expect(status.aggregate.queueDepth).toBe(0);
		expect(status.aggregate.busySlots).toBe(1);

		await h.scheduler.release(a, { state: "COMPLETED" });
		const after = await h.scheduler.status();
		expect(after.aggregate.busySlots).toBe(0);
		expect(after.aggregate.queueDepth).toBe(0);
		expect(after.resources[0]?.cancelledCount).toBe(1);
	});

	it("releases the slot on failure and admits the next request", async () => {
		const h = makeHarness();
		const r = await register(h.scheduler, 1);

		const a = await admit(h.scheduler, r, "agent_a");
		const pB = h.scheduler.acquire({
			logicalAgentId: "b",
			resource: r,
			model: { provider: r.backend, id: r.model },
			inferenceRequestId: "req_b",
		});
		await h.tick();
		await h.tick();

		await h.scheduler.release(a, { state: "FAILED", errorMessage: "backend unavailable" });
		await h.tick();
		await h.tick();

		const status = await h.scheduler.status();
		expect(status.aggregate.busySlots).toBe(1); // b now admitted
		expect(status.resources[0]?.failedCount).toBe(1);

		const b = await pB;
		if (b.status === "admitted") await h.scheduler.release(b.admitted, { state: "COMPLETED" });
		expect((await h.scheduler.status()).aggregate.busySlots).toBe(0);
	});

	it("every terminal path (success/failure/cancel) leaves zero leaked slots", async () => {
		const h = makeHarness();
		const r = await register(h.scheduler, 2);

		const a = await admit(h.scheduler, r, "a");
		const b = await admit(h.scheduler, r, "b");
		await h.scheduler.release(a, { state: "COMPLETED" });
		await h.scheduler.release(b, { state: "FAILED" });
		expect((await h.scheduler.status()).aggregate.busySlots).toBe(0);

		const c = await admit(h.scheduler, r, "c");
		await h.scheduler.release(c, { state: "CANCELLED" });
		expect((await h.scheduler.status()).aggregate.busySlots).toBe(0);
	});

	it("a stale/duplicate release cannot release a slot twice", async () => {
		const h = makeHarness();
		const r = await register(h.scheduler, 1);
		const a = await admit(h.scheduler, r, "a");
		await h.scheduler.release(a, { state: "COMPLETED" });
		const dup = await h.scheduler.release(a, { state: "COMPLETED" });
		expect(dup.status).toBe("not_found");
		expect((await h.scheduler.status()).aggregate.busySlots).toBe(0);
	});
});

describe("SharedInferenceScheduler — restart reconciliation", () => {
	it("reconciles an expired running lease and preserves queued work", async () => {
		const h = makeHarness({ leaseDurationMs: 1000 });
		const r = await register(h.scheduler, 1);

		const a = await admit(h.scheduler, r, "a");
		void h.scheduler.acquire({
			logicalAgentId: "b",
			resource: r,
			model: { provider: r.backend, id: r.model },
			inferenceRequestId: "req_b",
		});
		await h.tick();
		await h.tick();

		// Advance beyond the lease; simulate scheduler death by not releasing A.
		h.setNow(5000);
		const report = await h.scheduler.recover();
		expect(report.reconciledRequests).toContain(a.inferenceRequestId);

		await h.tick();
		await h.tick();
		const status = await h.scheduler.status();
		expect(status.resources[0]?.interruptedCount).toBe(1);
		// Queued B was promoted after the expired slot was reclaimed.
		expect(status.aggregate.queueDepth).toBe(0);
		expect(status.aggregate.busySlots).toBe(1);
	});

	it("does not fabricate completion for an in-flight request after scheduler death", async () => {
		const h = makeHarness({ leaseDurationMs: 1000 });
		const r = await register(h.scheduler, 1);
		const a = await admit(h.scheduler, r, "a");
		await h.scheduler.recover();
		const status = await h.scheduler.status();
		expect(status.resources[0]?.completedCount).toBe(0);
		expect(a).toBeDefined();
	});
});
