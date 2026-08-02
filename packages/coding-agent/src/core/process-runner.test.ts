import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runForegroundProcess } from "./process-runner.js";

function runNodeFixture(source: string, options: { timeout?: number; signal?: AbortSignal } = {}) {
	const child = spawn(process.execPath, ["-e", source], {
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	const stdout: string[] = [];
	const stderr: string[] = [];
	return {
		child,
		stdout,
		stderr,
		result: runForegroundProcess({
			child,
			onStdout: (data) => stdout.push(data.toString("utf8")),
			onStderr: (data) => stderr.push(data.toString("utf8")),
			signal: options.signal,
			timeout: options.timeout,
			kill: () => child.kill(),
		}),
	};
}

describe("runForegroundProcess", () => {
	it("waits for a genuinely foreground command", async () => {
		const startedAt = Date.now();
		const run = runNodeFixture("setTimeout(() => process.stdout.write('done\\n'), 150)");

		await expect(run.result).resolves.toEqual({ exitCode: 0 });
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
		expect(run.stdout.join("")).toBe("done\n");
	});

	it("completes after wrapper exit when descendant holds inherited pipes", async () => {
		const source = [
			"const { spawn } = require('node:child_process');",
			"const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: ['ignore', process.stdout, process.stderr] });",
			"process.stdout.write('BEFORE_WRAPPER_EXIT\\n');",
			"process.stderr.write('HOLDER_PID:' + holder.pid + '\\n');",
			"process.exit(0);",
		].join(" ");
		const startedAt = Date.now();
		const run = runNodeFixture(source);

		await expect(run.result).resolves.toEqual({ exitCode: 0 });
		expect(Date.now() - startedAt).toBeLessThan(2000);
		expect(run.stdout.join("")).toContain("BEFORE_WRAPPER_EXIT");

		const holderPid = Number(run.stderr.join("").match(/HOLDER_PID:(\d+)/)?.[1]);
		expect(holderPid).toBeGreaterThan(0);
		try {
			process.kill(holderPid);
		} catch {
			// Fixture may have completed during test cleanup.
		}
	});

	it("reports timeout before wrapper exit", async () => {
		const run = runNodeFixture("setTimeout(() => {}, 5000)", { timeout: 0.05 });

		await expect(run.result).rejects.toThrow("timeout:0.05");
	});

	it("reports abort once attached process is terminated", async () => {
		const controller = new AbortController();
		const run = runNodeFixture("setTimeout(() => {}, 5000)", { signal: controller.signal });
		setTimeout(() => controller.abort(), 25);

		await expect(run.result).rejects.toThrow("aborted");
	});
});
