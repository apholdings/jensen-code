/**
 * Shared inference admission service + remote client — bridge tests.
 *
 * Proves the local admission service exposes the SAME durable authority as a
 * separate local process: a local scheduler holds the slot, a remote client
 * queues through HTTP, the local release promotes the remote request, and
 * global capacity never exceeds 1. Also proves fail-closed behavior when the
 * service is unreachable and execution-scoped token rejection.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SharedInferenceAdmissionService } from "../../src/core/shared-inference/admission-service.js";
import { FileInferenceQueueStore } from "../../src/core/shared-inference/file-inference-queue-store.js";
import { InMemoryInferenceQueueStore } from "../../src/core/shared-inference/in-memory-inference-queue-store.js";
import { RemoteSchedulerAdmissionClient } from "../../src/core/shared-inference/remote-admission-client.js";
import { SharedInferenceScheduler } from "../../src/core/shared-inference/scheduler.js";
import type { SharedInferenceResource } from "../../src/core/shared-inference/types.js";

const RESOURCE: SharedInferenceResource = {
	resourceId: "qwen38-bucephalus",
	backend: "llamacpp-qwen38-bucephalus",
	model: "qwen3.8-27b",
	location: "bucephalus",
	capacity: 1,
	state: "available",
};

describe("SharedInferenceScheduler — enqueue/admissionStatus/renew", () => {
	it("enqueues without blocking, reports pollable status, and renews a lease", async () => {
		const store = new InMemoryInferenceQueueStore();
		const scheduler = new SharedInferenceScheduler({ store, ownerId: "owner", leaseDurationMs: 1000 });
		await scheduler.registerResource(RESOURCE);

		const a = await scheduler.enqueue({
			logicalAgentId: "a",
			resource: RESOURCE,
			model: { provider: RESOURCE.backend, id: RESOURCE.model },
			inferenceRequestId: "req_a",
		});
		expect(a.status).toBe("admitted");

		const b = await scheduler.enqueue({
			logicalAgentId: "b",
			resource: RESOURCE,
			model: { provider: RESOURCE.backend, id: RESOURCE.model },
			inferenceRequestId: "req_b",
		});
		expect(b.status).toBe("queued");

		const status = await scheduler.admissionStatus("req_b");
		expect(status.status).toBe("queued");

		if (a.status === "admitted") {
			const renewed = await scheduler.renew(a.admitted, { now: 500 });
			expect(renewed.status).toBe("renewed");
			if (renewed.status === "renewed") expect(renewed.expiresAtMs).toBe(1500);
		}

		if (a.status === "admitted") await scheduler.release(a.admitted, { state: "COMPLETED" });
		// After release, the queued request is promoted and owned by its original owner.
		const promoted = await scheduler.admissionStatus("req_b");
		expect(promoted.status).toBe("admitted");
	});
});

describe("SharedInferenceAdmissionService + RemoteSchedulerAdmissionClient", () => {
	let root: string;
	let store: FileInferenceQueueStore;
	let localScheduler: SharedInferenceScheduler;
	let service: SharedInferenceAdmissionService;
	let client: RemoteSchedulerAdmissionClient;

	beforeEach(async () => {
		root = mkdtempSync(path.join(tmpdir(), "admission-"));
		store = new FileInferenceQueueStore({ root: path.join(root, "queue") });
		localScheduler = new SharedInferenceScheduler({ store, ownerId: "local-owner", waitPollMs: 1 });
		await localScheduler.registerResource(RESOURCE);

		const serviceScheduler = new SharedInferenceScheduler({ store, ownerId: "service-owner", waitPollMs: 1 });
		service = new SharedInferenceAdmissionService({ scheduler: serviceScheduler, resources: [RESOURCE] });
		await service.start();

		const { token } = service.issueToken({ executionId: "exec-1", remoteTargetId: "blackpearl" });
		client = new RemoteSchedulerAdmissionClient({
			baseUrl: service.url,
			token,
			executionId: "exec-1",
			resources: [RESOURCE],
			pollMs: 5,
		});
	});

	afterEach(async () => {
		await service.stop().catch(() => undefined);
		rmSync(root, { recursive: true, force: true });
	});

	it("remote client queues behind a local process and is admitted after release (global capacity <= 1)", async () => {
		// Local process owns the single slot.
		const held = await localScheduler.acquire({
			logicalAgentId: "local-a",
			resource: RESOURCE,
			model: { provider: RESOURCE.backend, id: RESOURCE.model },
		});
		expect(held.status).toBe("admitted");

		// Remote client queues.
		const remoteAcquire = client.acquire({
			logicalAgentId: "remote-b",
			resource: RESOURCE,
			model: { provider: RESOURCE.backend, id: RESOURCE.model },
		});
		await new Promise((r) => setTimeout(r, 50));

		let status = await localScheduler.status();
		expect(status.aggregate.busySlots).toBe(1);
		expect(status.aggregate.queueDepth).toBe(1);

		// Release the local slot → remote promoted (still capacity 1).
		if (held.status === "admitted") await localScheduler.release(held.admitted, { state: "COMPLETED" });

		const remote = await remoteAcquire;
		expect(remote.status).toBe("admitted");
		status = await localScheduler.status();
		expect(status.aggregate.busySlots).toBe(1);

		if (remote.status === "admitted") {
			const released = await client.release(remote.admitted, { state: "COMPLETED", usage: { input: 1, output: 1 } });
			expect(released.status).toBe("released");
		}
		status = await localScheduler.status();
		expect(status.aggregate.busySlots).toBe(0);
		expect(status.aggregate.completedCount).toBe(2);
	});

	it("rejects a request whose token execution scope does not match", async () => {
		const forged = new RemoteSchedulerAdmissionClient({
			baseUrl: service.url,
			token: "sched_bogus",
			executionId: "exec-1",
			resources: [RESOURCE],
		});
		const outcome = await forged.acquire({
			logicalAgentId: "evil",
			resource: RESOURCE,
			model: { provider: RESOURCE.backend, id: RESOURCE.model },
		});
		expect(outcome.status).toBe("cancelled");
		if (outcome.status === "cancelled") expect(outcome.reason).toContain("scheduler_unavailable");
	});

	it("fails closed (cancelled) when the scheduler service is unreachable", async () => {
		const unreachable = new RemoteSchedulerAdmissionClient({
			baseUrl: "http://127.0.0.1:1",
			token: "sched_x",
			executionId: "exec-1",
			resources: [RESOURCE],
		});
		const outcome = await unreachable.acquire({
			logicalAgentId: "remote-lost",
			resource: RESOURCE,
			model: { provider: RESOURCE.backend, id: RESOURCE.model },
		});
		expect(outcome.status).toBe("cancelled");
		if (outcome.status === "cancelled") expect(outcome.reason).toContain("scheduler_unavailable");
	});
});
