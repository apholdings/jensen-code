/**
 * Inference scheduling benchmark harness — smoke tests (3.0.0 foundation).
 *
 * Exercises the synthetic benchmark across capacity 1 and 2 to prove the
 * harness is reproducible and the scheduler remains capacity-agnostic. Real
 * Qwen measurements are separate; these results are explicitly synthetic.
 */

import { describe, expect, it } from "vitest";
import { runInferenceSchedulerBenchmark } from "../../src/core/shared-inference/benchmark.js";

describe("inference scheduling benchmark harness", () => {
	it("produces a complete synthetic profile at capacity 1 and 2", async () => {
		for (const capacity of [1, 2]) {
			const result = await runInferenceSchedulerBenchmark({
				capacity,
				agentCount: 4,
				requestsPerAgent: 2,
				generationMs: 10,
				toolMs: 5,
			});
			expect(result.profile.backend).toBe("synthetic");
			expect(result.requestCount).toBe(8);
			expect(result.completedCount).toBe(8);
			expect(result.failedCount).toBe(0);
			expect(result.queueWaitMs.max).toBeGreaterThanOrEqual(0);
			expect(result.ttftMs.max).toBeGreaterThanOrEqual(0);
			expect(result.busySlotPercent).toBeGreaterThanOrEqual(0);
		}
	});
});
