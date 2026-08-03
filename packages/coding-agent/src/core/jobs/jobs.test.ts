import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackgroundJobRegistry } from "./index.js";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(nodePath.join(tmpdir(), "jensen-jobs-test-"));
});

afterEach(async () => {
	// no-op
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("background job registry", () => {
	it("registers a durable record and starts the process", async () => {
		const reg = new BackgroundJobRegistry({ storageDir: dir, workspaceId: "w", ownerRunId: "r" });
		await reg.init();
		const rec = await reg.start({
			executable: process.execPath,
			args: ["-e", "setTimeout(()=>{}, 5000)"],
			cwd: dir,
		});
		expect(rec.state).toBe("running");
		expect(rec.jobId).toMatch(/^job-/);
		expect(Number(rec.processIdentity)).toBeGreaterThan(0);
		// Durable on disk
		expect(await readdir(nodePath.join(dir, "jobs"))).not.toHaveLength(0);
		await reg.stop(rec.jobId);
		await reg.shutdown();
	});

	it("status classifies a live running job as alive with matching identity", async () => {
		const reg = new BackgroundJobRegistry({ storageDir: dir, workspaceId: "w" });
		await reg.init();
		const rec = await reg.start({ executable: process.execPath, args: ["-e", "setTimeout(()=>{}, 5000)"], cwd: dir });
		const status = await reg.status(rec.jobId);
		expect(status?.kind).toBe("recorded_running_and_alive");
		await reg.stop(rec.jobId);
	});

	it("classifies a missing process as recorded_running_but_missing", async () => {
		const reg = new BackgroundJobRegistry({ storageDir: dir, workspaceId: "w" });
		await reg.init();
		const rec = await reg.start({ executable: process.execPath, args: ["-e", "process.exit(0)"], cwd: dir });
		// Wait for it to exit.
		await sleep(600);
		// Force state to running (simulate stale durable state) then check.
		const forced = { ...rec, state: "running" as const };
		const { writeFile } = await import("node:fs/promises");
		await writeFile(nodePath.join(dir, "jobs", `${rec.jobId}.json`), JSON.stringify(forced));
		const status = await reg.status(rec.jobId);
		expect(status?.kind).toBe("recorded_running_but_missing");
	});

	it("stops a running process and marks it stopped (idempotent)", async () => {
		const reg = new BackgroundJobRegistry({ storageDir: dir, workspaceId: "w" });
		await reg.init();
		const rec = await reg.start({
			executable: process.execPath,
			args: ["-e", "setTimeout(()=>{}, 10000)"],
			cwd: dir,
		});
		const stopped = await reg.stop(rec.jobId);
		expect(stopped?.state).toBe("stopped");
		const again = await reg.stop(rec.jobId);
		expect(again?.state).toBe("stopped");
		await reg.shutdown();
	});

	it("preserves restart lineage", async () => {
		const reg = new BackgroundJobRegistry({ storageDir: dir, workspaceId: "w" });
		await reg.init();
		const rec = await reg.start({ executable: process.execPath, args: ["-e", "setTimeout(()=>{}, 5000)"], cwd: dir });
		const restarted = await reg.restart(rec.jobId, "test");
		expect(restarted?.restartCount).toBe(1);
		expect(restarted?.restarts?.[0]?.previousProcessIdentity).toBe(rec.processIdentity);
		await reg.shutdown();
	});

	it("bounds log output", async () => {
		const reg = new BackgroundJobRegistry({ storageDir: dir, workspaceId: "w" });
		await reg.init();
		const rec = await reg.start({
			executable: process.execPath,
			args: ["-e", "console.log('hello world')"],
			cwd: dir,
		});
		await sleep(600);
		const logs = await reg.logs({ jobId: rec.jobId, tailLines: 200, maxBytes: 65536 });
		expect(logs.stdout).toContain("hello world");
		await reg.shutdown();
	});

	it("refuses adoption without matching identity evidence", async () => {
		const reg = new BackgroundJobRegistry({ storageDir: dir, workspaceId: "w" });
		await reg.init();
		const rec = await reg.start({ executable: process.execPath, args: ["-e", "setTimeout(()=>{}, 5000)"], cwd: dir });
		const adopted = await reg.adopt(rec.jobId, {
			executable: "definitely-not-the-executable",
			arguments: [],
			cwd: dir,
			commandLine: "no match",
		});
		expect(adopted).toBeNull();
		await reg.stop(rec.jobId);
	});

	it("gateStepCompletion blocks unresolved running job", async () => {
		const reg = new BackgroundJobRegistry({ storageDir: dir, workspaceId: "w" });
		await reg.init();
		const rec = await reg.start({ executable: process.execPath, args: ["-e", "setTimeout(()=>{}, 5000)"], cwd: dir });
		const gate = await reg.gateStepCompletion(rec.jobId, "exited");
		expect(gate.canComplete).toBe(false);
		await reg.stop(rec.jobId);
		await reg.shutdown();
	});
});
