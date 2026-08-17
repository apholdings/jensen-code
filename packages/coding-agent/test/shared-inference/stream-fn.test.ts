/**
 * Scheduled stream function — seam tests (3.0.0 foundation).
 *
 * Proves non-shared providers bypass scheduling unchanged, shared providers are
 * admitted before the delegate runs, queued work does not touch the provider
 * until a slot frees, and the logical-agent activity reflects
 * WAITING_INFERENCE → RUNNING_INFERENCE → RUNNABLE.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createAssistantMessageEventStream } from "@apholdings/jensen-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileLogicalAgentStore } from "../../src/core/shared-inference/file-logical-agent-store.js";
import { InMemoryInferenceQueueStore } from "../../src/core/shared-inference/in-memory-inference-queue-store.js";
import { LocalSubagentRuntime } from "../../src/core/shared-inference/runtime.js";
import { SharedInferenceScheduler } from "../../src/core/shared-inference/scheduler.js";
import { createScheduledStreamFn } from "../../src/core/shared-inference/stream-fn.js";
import type { SharedInferenceResource } from "../../src/core/shared-inference/types.js";

const RESOURCE: SharedInferenceResource = {
	resourceId: "qwen38-bucephalus",
	backend: "llamacpp-qwen38-bucephalus",
	model: "qwen3.8-27b",
	location: "bucephalus",
	capacity: 1,
	state: "available",
};

const SHARED_MODEL = { provider: "llamacpp-qwen38-bucephalus", id: "qwen3.8-27b" } as never;
const CLOUD_MODEL = { provider: "openrouter", id: "openai/gpt-5.6-luna" } as never;
const CONTEXT = { systemPrompt: "sys", messages: [{ role: "user" as const, content: "hi" }], tools: [] } as never;

let root: string;
let scheduler: SharedInferenceScheduler;
let runtime: LocalSubagentRuntime;

beforeEach(async () => {
	root = mkdtempSync(path.join(tmpdir(), "stream-fn-"));
	runtime = new LocalSubagentRuntime({ store: new FileLogicalAgentStore({ root: path.join(root, "agents") }) });
	scheduler = new SharedInferenceScheduler({
		store: new InMemoryInferenceQueueStore(),
		sleep: () => new Promise((resolve) => setImmediate(resolve)),
		waitPollMs: 1,
		ownerId: "owner-stream",
	});
	await scheduler.registerResource(RESOURCE);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("waitFor timeout");
}

function fakeDelegate() {
	let calls = 0;
	const delegate = (_model: unknown, _context: unknown, _options: unknown) => {
		calls += 1;
		const stream = createAssistantMessageEventStream();
		stream.push({
			type: "done",
			reason: "stop",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				api: "openai-completions",
				provider: "llamacpp-qwen38-bucephalus",
				model: "qwen3.8-27b",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		});
		stream.end();
		return stream;
	};
	return { delegate, calls: () => calls };
}

describe("createScheduledStreamFn — provider seam", () => {
	it("passes non-shared providers through to the delegate unchanged", async () => {
		const { delegate, calls } = fakeDelegate();
		const streamFn = createScheduledStreamFn({ scheduler, runtime, delegate });
		const stream = await streamFn(CLOUD_MODEL, CONTEXT, {});
		expect(calls()).toBe(1);
		expect((await stream.result()).model).toBe("qwen3.8-27b");
	});

	it("admits a shared resource before invoking the delegate and releases after completion", async () => {
		const { delegate, calls } = fakeDelegate();
		const streamFn = createScheduledStreamFn({
			scheduler,
			runtime,
			delegate,
			getCorrelation: () => ({
				logicalAgentId: "agent_seam",
				priority: { base: 7 },
				dependency: { unblocksCount: 3 },
			}),
		});
		await runtime.register({ logicalAgentId: "agent_seam", sessionId: "session_seam" });

		const stream = await streamFn(SHARED_MODEL, CONTEXT, {});
		expect(calls()).toBe(1);

		// While the delegate stream has completed, release is fire-and-forget.
		await stream.result();
		await waitFor(async () => (await runtime.inspect("agent_seam"))?.activity === "RUNNABLE");

		const status = await scheduler.status();
		expect(status.aggregate.busySlots).toBe(0);
		expect(status.aggregate.completedCount).toBe(1);
		const record = await runtime.inspect("agent_seam");
		expect(record?.activity).toBe("RUNNABLE");
	});

	it("does not invoke the delegate while the shared slot is busy", async () => {
		const { delegate, calls } = fakeDelegate();
		const streamFn = createScheduledStreamFn({
			scheduler,
			runtime,
			delegate,
			getCorrelation: () => ({ logicalAgentId: "agent_queued" }),
		});
		await runtime.register({ logicalAgentId: "agent_queued", sessionId: "session_queued" });

		// Hold the single slot.
		const held = await scheduler.acquire({
			logicalAgentId: "holder",
			resource: RESOURCE,
			model: { provider: RESOURCE.backend, id: RESOURCE.model },
		});
		expect(held.status).toBe("admitted");

		const pending = streamFn(SHARED_MODEL, CONTEXT, {});
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));
		expect(calls()).toBe(0);

		if (held.status === "admitted") {
			await scheduler.release(held.admitted, { state: "COMPLETED" });
		}

		const stream = await pending;
		expect(calls()).toBe(1);
		await stream.result();
	});
});
