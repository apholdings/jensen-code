import { describe, expect, it, vi } from "vitest";
import {
	SchedulerWorkerDriver,
	type SchedulerWorkerTerminalCleanup,
} from "../../src/core/orchestration/scheduler-worker-driver.js";
import type { SchedulerControlService } from "../../src/core/scheduler/scheduler-control-service.js";
import type { WorkerControlService } from "../../src/core/worker-daemon/worker-control-service.js";

function harness(options: {
	runTick?: () => Promise<void>;
	runOnce?: () => Promise<void>;
	cleanup?: () => Promise<void>;
}) {
	const scheduler = {
		runTick: vi.fn(options.runTick ?? (async () => undefined)),
	} as unknown as SchedulerControlService;
	const worker = {
		start: vi.fn(async () => undefined),
		stop: vi.fn(async () => undefined),
		runOnce: vi.fn(options.runOnce ?? (async () => undefined)),
	} as unknown as WorkerControlService;
	const terminalCleanup = {
		cleanup: vi.fn(options.cleanup ?? (async () => undefined)),
	} as unknown as SchedulerWorkerTerminalCleanup;
	const driver = new SchedulerWorkerDriver({
		scheduler,
		worker,
		terminalCleanup,
		maxTicks: 2,
	});
	return { driver, scheduler, worker, terminalCleanup };
}

function failedWhenAborted(signal: AbortSignal): Promise<{ state: "FAILED" }> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve({ state: "FAILED" });
			return;
		}
		signal.addEventListener("abort", () => resolve({ state: "FAILED" }), { once: true });
	});
}

describe("SchedulerWorkerDriver exceptional finalization", () => {
	it.each(["scheduler", "worker"] as const)(
		"returns durable FAILED outcome when %s pump pass fails",
		async (failurePoint) => {
			const pumpError = new Error(`${failurePoint} pump failure`);
			const harnessResult = harness({
				runTick:
					failurePoint === "scheduler"
						? async () => {
								throw pumpError;
							}
						: undefined,
				runOnce:
					failurePoint === "worker"
						? async () => {
								throw pumpError;
							}
						: undefined,
				cleanup: async () => undefined,
			});

			const result = await harnessResult.driver.execute((signal) => failedWhenAborted(signal), {
				parentMissionId: "parent-failed",
			});

			expect(result).toEqual({ state: "FAILED" });
			expect(harnessResult.terminalCleanup?.cleanup).toHaveBeenCalledWith("parent-failed");
			expect(harnessResult.worker.stop).toHaveBeenCalledTimes(1);
		},
	);

	it("preserves the primary operation error when cleanup also fails and permits retry", async () => {
		const primaryError = new Error("primary operation failure");
		const cleanupError = new Error("cleanup failure");
		let cleanupAttempts = 0;
		const harnessResult = harness({
			cleanup: async () => {
				cleanupAttempts++;
				if (cleanupAttempts === 1) throw cleanupError;
			},
		});

		const first = harnessResult.driver.execute(
			async () => {
				throw primaryError;
			},
			{ parentMissionId: "parent-retry" },
		);
		await expect(first).rejects.toSatisfy((error: unknown) => {
			expect(error).toBeInstanceOf(AggregateError);
			expect((error as AggregateError).errors).toEqual([primaryError, cleanupError]);
			return true;
		});

		const result = await harnessResult.driver.execute(async () => ({ state: "FAILED" as const }), {
			parentMissionId: "parent-retry",
		});
		expect(result).toEqual({ state: "FAILED" });
		expect(cleanupAttempts).toBe(2);
	});
});
