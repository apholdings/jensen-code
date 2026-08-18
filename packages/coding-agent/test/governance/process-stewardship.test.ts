import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	captureHostResourceSnapshot,
	classifyHostPressure,
	cleanupOwnedProcess,
	countLinuxProcesses,
	reconcileOwnedProcesses,
} from "../../src/core/governance/index.js";
import { BackgroundJobRegistry } from "../../src/core/jobs/index.js";

describe("Governance process stewardship", () => {
	it("captures deterministic host facts and explicit pressure states", async () => {
		const snapshot = await captureHostResourceSnapshot(123);
		expect(snapshot.capturedAtMs).toBe(123);
		expect(snapshot.totalMemoryBytes).toBeGreaterThan(0);
		expect(classifyHostPressure({ ...snapshot, memoryPressureRatio: undefined })).toBe("UNKNOWN");
		expect(classifyHostPressure({ ...snapshot, memoryPressureRatio: 0.96 })).toBe("CRITICAL");
		expect(classifyHostPressure({ ...snapshot, memoryPressureRatio: 0.1, staleJensenOwnedProcessCount: 1 })).toBe(
			"LEAK_SUSPECTED",
		);
		if (process.platform === "linux") expect(snapshot.processCount).toBeGreaterThan(0);
	});

	it("counts only numeric Linux process entries from an injected proc fixture", async () => {
		const procRoot = await mkdtemp(join(tmpdir(), "jensen-proc-fixture-"));
		try {
			await mkdir(join(procRoot, "101"));
			await mkdir(join(procRoot, "202"));
			await writeFile(join(procRoot, "meminfo"), "MemAvailable: 1024 kB\n");
			expect(await countLinuxProcesses(procRoot, readdir, "linux")).toBe(2);
			const snapshot = await captureHostResourceSnapshot(456, { procRoot, platform: "linux" });
			expect(snapshot.platform).toBe("linux");
			expect(snapshot.processCount).toBe(2);
			expect(snapshot.availableMemoryBytes).toBe(1024 * 1024);
		} finally {
			await rm(procRoot, { recursive: true, force: true });
		}
	});

	it("never cleans a job without positive ownership", async () => {
		const root = await mkdtemp(join(tmpdir(), "jensen-process-stewardship-"));
		try {
			const registry = new BackgroundJobRegistry({ storageDir: root });
			await registry.init();
			const unknown = await registry.start({
				jobId: "unknown",
				executable: process.execPath,
				args: ["-e", "setTimeout(() => {}, 10000)"],
			});
			const result = await cleanupOwnedProcess(registry, unknown.jobId, {
				ownerKind: "mission",
				ownerId: "different",
			});
			expect(result).toMatchObject({ action: "skipped", reason: "unknown_ownership" });
			const status = await registry.status(unknown.jobId);
			expect(status?.kind).toBe("recorded_running_and_alive");
			await registry.stop(unknown.jobId);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("classifies owned live state and separately reports unknown state", async () => {
		const root = await mkdtemp(join(tmpdir(), "jensen-process-reconcile-"));
		try {
			const registry = new BackgroundJobRegistry({ storageDir: root });
			await registry.init();
			await registry.start({
				jobId: "owned",
				executable: process.execPath,
				args: ["-e", "setTimeout(() => {}, 10000)"],
				ownership: { ownerKind: "mission", ownerId: "m1" },
			});
			await registry.start({
				jobId: "unknown",
				executable: process.execPath,
				args: ["-e", "setTimeout(() => {}, 10000)"],
			});
			const results = await reconcileOwnedProcesses(registry, { ownerKind: "mission", ownerId: "m1" });
			expect(results.find((entry) => entry.jobId === "owned")?.classification).toBe("owned_alive");
			expect(results.find((entry) => entry.jobId === "unknown")?.classification).toBe("unknown_ownership");
			await registry.stop("owned");
			await registry.stop("unknown");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
