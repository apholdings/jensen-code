import { describe, expect, it } from "vitest";
import { DeterministicParallelScheduler, type SchedulerCall } from "./scheduler.js";
import type { ToolEffects } from "./types.js";

const readEffects: ToolEffects = {
	readsWorkspace: true,
	writesWorkspace: false,
	createsFiles: false,
	deletesFiles: false,
	executesProcesses: false,
	startsPersistentProcesses: false,
	accessesNetwork: false,
	mutatesGit: false,
	mutatesExternalState: false,
	handlesSecrets: false,
	potentiallyDestructive: false,
	requiresExclusiveWorkspaceLease: false,
	parallelSafe: true,
};

const writeEffects: ToolEffects = {
	...readEffects,
	writesWorkspace: true,
	parallelSafe: false,
	requiresExclusiveWorkspaceLease: true,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function call(index: number, toolName: string, opts: Partial<SchedulerCall> = {}): SchedulerCall {
	const run =
		opts.run ??
		(async () => {
			await sleep(20);
			return { result: `${toolName}:${index}`, isError: false };
		});
	return {
		index,
		toolCallId: `c${index}`,
		toolName,
		args: {},
		effects: readEffects,
		...opts,
		run,
	};
}

describe("deterministic parallel scheduler", () => {
	it("runs three read-only calls concurrently and renders in call order", async () => {
		let concurrent = 0;
		let maxConcurrent = 0;
		const order: number[] = [];
		const calls = [0, 1, 2].map((i) =>
			call(i, "read", {
				run: async () => {
					concurrent++;
					maxConcurrent = Math.max(maxConcurrent, concurrent);
					await sleep(30 - i * 5);
					order.push(i);
					concurrent--;
					return { result: `r${i}`, isError: false };
				},
			}),
		);
		const sched = new DeterministicParallelScheduler();
		const results = await sched.run(calls, undefined);
		expect(results.map((r) => r.index)).toEqual([0, 1, 2]);
		expect(maxConcurrent).toBeGreaterThan(1);
	});

	it("mutations become serial barriers", async () => {
		let active = 0;
		let maxActive = 0;
		const calls: SchedulerCall[] = [
			call(0, "read", {
				run: async () => {
					active++;
					maxActive = Math.max(maxActive, active);
					await sleep(20);
					active--;
					return { result: "r0", isError: false };
				},
			}),
			call(1, "edit", {
				effects: writeEffects,
				run: async () => {
					active++;
					maxActive = Math.max(maxActive, active);
					await sleep(10);
					active--;
					return { result: "w1", isError: false };
				},
			}),
			call(2, "read", {
				run: async () => {
					active++;
					maxActive = Math.max(maxActive, active);
					await sleep(20);
					active--;
					return { result: "r2", isError: false };
				},
			}),
		];
		const sched = new DeterministicParallelScheduler();
		const results = await sched.run(calls, undefined);
		expect(results.map((r) => r.index)).toEqual([0, 1, 2]);
		// The mutation barrier never runs concurrently with a sibling.
		expect(maxActive).toBe(1);
	});

	it("serializes dependent calls", async () => {
		const execution: string[] = [];
		const calls: SchedulerCall[] = [
			call(0, "read", {
				run: async () => {
					execution.push("A");
					await sleep(10);
					return { result: "x", isError: false };
				},
			}),
			call(1, "read", {
				consumes: ["c0"],
				run: async () => {
					execution.push("B");
					return { result: "y", isError: false };
				},
			}),
		];
		const sched = new DeterministicParallelScheduler();
		const results = await sched.run(calls, undefined);
		expect(results.map((r) => r.index)).toEqual([0, 1]);
		expect(execution).toEqual(["A", "B"]);
	});

	it("preserves deterministic order when results finish out of order", async () => {
		const calls = [0, 1, 2, 3].map((i) =>
			call(i, "read", {
				run: async () => {
					await sleep(40 - i * 10);
					return { result: `v${i}`, isError: false };
				},
			}),
		);
		const sched = new DeterministicParallelScheduler();
		const results = await sched.run(calls, undefined);
		expect(results.map((r) => r.result)).toEqual(["v0", "v1", "v2", "v3"]);
	});

	it("bounded concurrency respects the global max", async () => {
		let active = 0;
		let maxActive = 0;
		const calls = Array.from({ length: 12 }, (_, i) =>
			call(i, "read", {
				run: async () => {
					active++;
					maxActive = Math.max(maxActive, active);
					await sleep(15);
					active--;
					return { result: i, isError: false };
				},
			}),
		);
		const sched = new DeterministicParallelScheduler({ globalMax: 4 });
		await sched.run(calls, undefined);
		expect(maxActive).toBeLessThanOrEqual(4);
	});

	it("per-tool concurrency limit is enforced", async () => {
		let active = 0;
		let maxActive = 0;
		const calls = Array.from({ length: 10 }, (_, i) =>
			call(i, "read", {
				run: async () => {
					active++;
					maxActive = Math.max(maxActive, active);
					await sleep(10);
					active--;
					return { result: i, isError: false };
				},
			}),
		);
		const sched = new DeterministicParallelScheduler({ perTool: 2, globalMax: 10 });
		await sched.run(calls, undefined);
		expect(maxActive).toBeLessThanOrEqual(2);
	});

	it("cancellation aborts active calls", async () => {
		const ac = new AbortController();
		let cancelled = false;
		const calls = [
			call(0, "read", {
				run: async (signal) => {
					return new Promise((resolve) => {
						signal?.addEventListener("abort", () => {
							cancelled = true;
							resolve({ result: "cancelled", isError: true });
						});
					});
				},
			}),
		];
		const sched = new DeterministicParallelScheduler();
		const p = sched.run(calls, ac.signal);
		await sleep(10);
		ac.abort();
		const results = await p;
		expect(cancelled).toBe(true);
		expect(results[0].isError).toBe(true);
	});

	it("lease-requiring calls cannot overlap", async () => {
		let active = 0;
		let maxActive = 0;
		const leaseEffects: ToolEffects = { ...writeEffects, requiresExclusiveWorkspaceLease: true };
		const calls = [
			call(0, "edit", {
				effects: leaseEffects,
				resource: "workspace",
				run: async () => {
					active++;
					maxActive = Math.max(maxActive, active);
					await sleep(15);
					active--;
					return { result: "a", isError: false };
				},
			}),
			call(1, "edit", {
				effects: leaseEffects,
				resource: "workspace",
				run: async () => {
					active++;
					maxActive = Math.max(maxActive, active);
					await sleep(15);
					active--;
					return { result: "b", isError: false };
				},
			}),
		];
		const sched = new DeterministicParallelScheduler();
		await sched.run(calls, undefined);
		expect(maxActive).toBe(1);
	});

	it("a denied sibling is isolated without corrupting other results", async () => {
		const calls = [
			call(0, "read", { run: async () => ({ result: "ok0", isError: false }) }),
			call(1, "read", { run: async () => ({ result: "denied", isError: true }) }),
			call(2, "read", { run: async () => ({ result: "ok2", isError: false }) }),
		];
		const sched = new DeterministicParallelScheduler();
		const results = await sched.run(calls, undefined);
		expect(results[0].isError).toBe(false);
		expect(results[1].isError).toBe(true);
		expect(results[2].isError).toBe(false);
	});
});
