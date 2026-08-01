import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { buildTestCommands, runTestCi, runVitestProcess } from "../scripts/run-test-ci.mjs";

const longHorizonFile = "test/long-horizon/continuation-cli.test.ts";
const productionHarnessFile = "src/core/production-todo-provider-harness.test.ts";

describe("coding-agent CI test orchestration", () => {
	it("keeps the long-horizon and remaining inventories complete and disjoint", () => {
		const files = [longHorizonFile, productionHarnessFile, "test/example.test.ts"];
		const commands = buildTestCommands(files);
		const firstFiles = commands[0].args.slice(2);
		const secondFiles = commands[1].args.slice(2);

		expect(firstFiles).toEqual([longHorizonFile]);
		expect(secondFiles).toContain(productionHarnessFile);
		expect(secondFiles).not.toContain(longHorizonFile);
		expect(new Set([...firstFiles, ...secondFiles])).toEqual(new Set(files));
	});

	it("does not start the remaining process after a first-process failure", async () => {
		const runProcess = vi.fn().mockResolvedValueOnce(17);
		const exitCode = await runTestCi({
			getFiles: () => [longHorizonFile, productionHarnessFile],
			runProcess,
		});

		expect(exitCode).toBe(17);
		expect(runProcess).toHaveBeenCalledTimes(1);
		expect(runProcess).toHaveBeenCalledWith(["run", "--passWithNoTests", longHorizonFile]);
	});

	it("returns the second process exit code", async () => {
		const runProcess = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(23);
		const exitCode = await runTestCi({
			getFiles: () => [longHorizonFile, productionHarnessFile],
			runProcess,
		});

		expect(exitCode).toBe(23);
		expect(runProcess).toHaveBeenCalledTimes(2);
	});

	it("spawns Vitest directly with inherited environment and transparent output", async () => {
		const child = new EventEmitter();
		child.kill = vi.fn();
		const spawnProcess = vi.fn(() => child);
		const signalSource = new EventEmitter();
		const result = runVitestProcess(["run", "test/example.test.ts"], spawnProcess, signalSource);
		child.emit("close", 0, null);

		await expect(result).resolves.toBe(0);
		expect(spawnProcess).toHaveBeenCalledTimes(1);
		const [command, args, options] = spawnProcess.mock.calls[0];
		expect(command).toBe(process.execPath);
		expect(args.slice(1)).toEqual(["run", "test/example.test.ts"]);
		expect(args[0]).toMatch(/node_modules[/\\]vitest[/\\]dist[/\\]cli\.js$/);
		expect(options).toMatchObject({
			env: process.env,
			shell: false,
			stdio: "inherit",
		});
		expect(options.cwd).toMatch(/packages[/\\]coding-agent$/);
	});

	it("fails authoritatively when the child process cannot spawn", async () => {
		const child = new EventEmitter();
		child.kill = vi.fn();
		const signalSource = new EventEmitter();
		const error = new Error("spawn failed");
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const result = runVitestProcess([], () => child, signalSource);
		child.emit("error", error);

		await expect(result).resolves.toBe(1);
		expect(consoleError).toHaveBeenCalledWith("Failed to start Vitest process:", error);
		expect(signalSource.listenerCount("SIGINT")).toBe(0);
		expect(signalSource.listenerCount("SIGTERM")).toBe(0);
		consoleError.mockRestore();
	});

	it("forwards termination signals and returns the signal exit code", async () => {
		const child = new EventEmitter();
		const signalSource = new EventEmitter();
		child.kill = vi.fn((signal) => child.emit("close", null, signal));
		const result = runVitestProcess([], () => child, signalSource);
		signalSource.emit("SIGTERM");

		await expect(result).resolves.toBe(143);
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		expect(signalSource.listenerCount("SIGINT")).toBe(0);
		expect(signalSource.listenerCount("SIGTERM")).toBe(0);
	});

	it("never synthesizes success when no exit status is available", async () => {
		const child = new EventEmitter();
		child.kill = vi.fn();
		const result = runVitestProcess([], () => child, new EventEmitter());
		child.emit("close", null, null);

		await expect(result).resolves.toBe(1);
	});
});
