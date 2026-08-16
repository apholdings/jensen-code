/**
 * Local Subagent Runtime — deterministic tests (3.0.0 foundation).
 *
 * Proves many logical agents coexist with one inference slot, durable parking /
 * rehydration preserves identity, and WAITING_INFERENCE never terminates a
 * Mission/Assignment.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileLogicalAgentStore } from "../../src/core/shared-inference/file-logical-agent-store.js";
import { InMemoryInferenceQueueStore } from "../../src/core/shared-inference/in-memory-inference-queue-store.js";
import { LocalSubagentRuntime } from "../../src/core/shared-inference/runtime.js";
import { SharedInferenceScheduler } from "../../src/core/shared-inference/scheduler.js";
import type { AdmittedInference, SharedInferenceResource } from "../../src/core/shared-inference/types.js";

const RESOURCE: SharedInferenceResource = {
	resourceId: "qwen38-bucephalus",
	backend: "llamacpp-qwen38-bucephalus",
	model: "qwen3.8-27b",
	location: "bucephalus",
	capacity: 1,
	state: "available",
};

let root: string;
let runtime: LocalSubagentRuntime;
let scheduler: SharedInferenceScheduler;
let resource: SharedInferenceResource;

beforeEach(async () => {
	root = mkdtempSync(path.join(tmpdir(), "subagent-runtime-"));
	runtime = new LocalSubagentRuntime({ store: new FileLogicalAgentStore({ root: path.join(root, "agents") }) });
	scheduler = new SharedInferenceScheduler({
		store: new InMemoryInferenceQueueStore(),
		sleep: () => new Promise((resolve) => setImmediate(resolve)),
		waitPollMs: 1,
		ownerId: "owner-runtime",
	});
	resource = { ...RESOURCE };
	await scheduler.registerResource(resource);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

async function registerAgent(index: number, missionId?: string): Promise<string> {
	const record = await runtime.register({
		logicalAgentId: `agent_${index}`,
		sessionId: `session_${index}`,
		missionId,
		assignmentId: missionId ? `assign_${index}` : undefined,
		activity: "RUNNABLE",
	});
	return record.logicalAgentId;
}

describe("LocalSubagentRuntime — logical agent identity", () => {
	it("registers idempotently and preserves a stable identity", async () => {
		const id = await registerAgent(0, "mission_x");
		const record = await runtime.inspect(id);
		expect(record?.logicalAgentId).toBe(id);
		expect(record?.missionId).toBe("mission_x");
		expect(record?.activity).toBe("RUNNABLE");

		const again = await runtime.register({ logicalAgentId: id, sessionId: "session_0" });
		expect(again.logicalAgentId).toBe(id);
		expect(again.missionId).toBe("mission_x");
	});

	it("10 logical agents coexist with 1 inference slot", async () => {
		const ids: string[] = [];
		for (let i = 0; i < 10; i++) ids.push(await registerAgent(i, `mission_${i}`));

		let maxBusy = 0;
		const admitted: AdmittedInference[] = [];
		const results = await Promise.all(
			ids.map(async (id) => {
				const outcome = await scheduler.acquire({
					logicalAgentId: id,
					resource,
					model: { provider: resource.backend, id: resource.model },
				});
				expect(outcome.status).toBe("admitted");
				const a = (outcome as { status: "admitted"; admitted: AdmittedInference }).admitted;
				admitted.push(a);
				const status = await scheduler.status();
				maxBusy = Math.max(maxBusy, status.aggregate.busySlots);
				expect(status.aggregate.busySlots).toBeLessThanOrEqual(1);
				// Simulate a short generation then release.
				await new Promise((resolve) => setImmediate(resolve));
				await scheduler.release(a, { state: "COMPLETED" });
				return id;
			}),
		);

		expect(maxBusy).toBe(1);
		expect(new Set(results).size).toBe(10); // no dropped/duplicated identity

		const records = await runtime.list();
		expect(records.length).toBe(10);
		for (const id of ids) {
			const record = await runtime.inspect(id);
			expect(record?.logicalAgentId).toBe(id);
		}

		const status = await scheduler.status();
		expect(status.aggregate.busySlots).toBe(0);
		expect(status.aggregate.completedCount).toBe(10);
	});

	it("WAITING_INFERENCE does not terminate the Mission/Assignment correlation", async () => {
		const id = await registerAgent(0, "mission_wait");
		await runtime.transition(id, "WAITING_INFERENCE", { waitingReason: "shared inference admission" });
		const record = await runtime.inspect(id);
		expect(record?.activity).toBe("WAITING_INFERENCE");
		expect(record?.missionId).toBe("mission_wait");
		expect(record?.assignmentId).toBe("assign_0");
	});
});

describe("LocalSubagentRuntime — park / rehydrate", () => {
	it("parks and resumes the same logical agent with its correlation intact", async () => {
		const id = await registerAgent(0, "mission_park");
		await runtime.transition(id, "WAITING_INFERENCE", {
			pendingInferenceRequestId: "req_1",
			waitingReason: "queued",
		});
		await runtime.park(id, "scheduler restart");

		const parked = await runtime.inspect(id);
		expect(parked?.activity).toBe("PARKED");
		expect(parked?.logicalAgentId).toBe(id);
		expect(parked?.missionId).toBe("mission_park");

		await runtime.resume(id);
		const resumed = await runtime.inspect(id);
		expect(resumed?.activity).toBe("RUNNABLE");
		expect(resumed?.logicalAgentId).toBe(id);
		expect(resumed?.missionId).toBe("mission_park");

		await runtime.complete(id);
		const done = await runtime.inspect(id);
		expect(done?.activity).toBe("COMPLETED");
	});

	it("parked agents do not require an active inference slot", async () => {
		const ids: string[] = [];
		for (let i = 0; i < 10; i++) {
			const id = await registerAgent(i, `mission_${i}`);
			await runtime.park(id, "waiting for capacity");
			ids.push(id);
		}
		// No inference was requested: zero busy slots, yet ten durable agents exist.
		const status = await scheduler.status();
		expect(status.aggregate.busySlots).toBe(0);
		expect((await runtime.list()).length).toBe(10);
		expect(ids.length).toBe(10);
	});
});

describe("LocalSubagentRuntime — tool/inference overlap signal", () => {
	it("tracks a tooling agent independently of an inferencing agent", async () => {
		const tooling = await registerAgent(0);
		const inferencing = await registerAgent(1);
		await runtime.transition(tooling, "RUNNING_TOOL", { waitingReason: "running tests" });
		await runtime.transition(inferencing, "RUNNING_INFERENCE");

		const counts = await runtime.activityCounts();
		expect(counts.tooling).toBe(1);
		expect(counts.runningInference).toBe(1);
		expect(counts.total).toBe(2);
	});
});
