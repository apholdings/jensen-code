import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	buildTestCommands,
	continuationShardFiles,
	runTestCi,
	runVitestProcess,
} from "../scripts/run-test-ci.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const productionHarnessFile = "src/core/production-todo-provider-harness.test.ts";
const orchestrationTestFile = "test/run-test-ci.test.mjs";
const exampleFile = "test/example.test.ts";
const authoritativeFixture = [
	...continuationShardFiles,
	productionHarnessFile,
	orchestrationTestFile,
	exampleFile,
];
const expectedContinuationTestNames = [
	"creates IDLE scheduler record at revision 0",
	"rejects missing --scheduler",
	"inspects a valid scheduler record",
	"reports ENOENT for missing scheduler",
	"completes schedule → dispatch → consume",
	"cancels an active SCHEDULED cycle",
	"abandons a superseded cycle",
	"rejects abandon when execution revision equals expected (not superseded)",
	"validates a scheduler record",
	"rejects contract digest mismatch",
	"rejects stale scheduler revision",
	"rejects invalid state for operation",
	"idempotent retry returns same event",
	"rejects missing required arguments",
	"missing scheduler fails for dispatch",
];
const expectedRegistrations = [
	"registerInitTests",
	"registerInspectTests",
	"registerValidateTests",
	"registerLifecycleTests",
	"registerCancelTests",
	"registerAbandonTests",
	"registerErrorHandlingTests",
];

function commandFiles(command) {
	return command.args.slice(2);
}

describe("coding-agent CI test orchestration", () => {
	it("keeps all continuation shards and remaining inventory complete and disjoint", () => {
		const commands = buildTestCommands(authoritativeFixture);
		const partitions = commands.map(commandFiles);
		const flattened = partitions.flat();

		expect(partitions.slice(0, -1)).toEqual(continuationShardFiles.map((filePath) => [filePath]));
		expect(partitions.at(-1)).toContain(productionHarnessFile);
		expect(partitions.at(-1)).toContain(orchestrationTestFile);
		expect(flattened).toHaveLength(authoritativeFixture.length);
		expect(new Set(flattened)).toEqual(new Set(authoritativeFixture));
		for (const shard of continuationShardFiles) {
			expect(flattened.filter((filePath) => filePath === shard)).toHaveLength(1);
			expect(partitions.at(-1)).not.toContain(shard);
		}
	});

	it("represents every original continuation test exactly once", () => {
		const supportSource = readFileSync(
			resolve(testDir, "long-horizon", "continuation-cli.test-support.ts"),
			"utf8",
		);
		const actualNames = [...supportSource.matchAll(/\bit\("([^"]+)"/g)].map((match) => match[1]);

		expect(actualNames).toEqual(expectedContinuationTestNames);
		expect(new Set(actualNames)).toHaveLength(15);
	});

	it("registers every semantic group exactly once in configured shard order", () => {
		const registrations = continuationShardFiles.flatMap((filePath) => {
			const source = readFileSync(resolve(testDir, filePath.replace(/^test\//, "")), "utf8");
			return [...source.matchAll(/\b(register\w+Tests)\(\);/g)].map((match) => match[1]);
		});

		expect(registrations).toEqual(expectedRegistrations);
		expect(new Set(registrations)).toHaveLength(expectedRegistrations.length);
	});

	it("rejects an inventory missing any configured continuation shard", () => {
		expect(() => buildTestCommands(authoritativeFixture.slice(1))).toThrow(
			`Vitest test inventory is missing continuation shards: ${continuationShardFiles[0]}`,
		);
	});

	it("rejects duplicate authoritative inventory entries", () => {
		expect(() => buildTestCommands([...authoritativeFixture, exampleFile])).toThrow(
			"Vitest test inventory contains duplicate files",
		);
	});

	it("runs shards in configured order before the remaining suite", async () => {
		const runProcess = vi.fn().mockResolvedValue(0);
		const exitCode = await runTestCi({ getFiles: () => authoritativeFixture, runProcess });

		expect(exitCode).toBe(0);
		expect(runProcess.mock.calls.map(([args]) => args)).toEqual(
			buildTestCommands(authoritativeFixture).map((command) => command.args),
		);
	});

	it("stops after a first-shard failure", async () => {
		const runProcess = vi.fn().mockResolvedValueOnce(17);
		const exitCode = await runTestCi({ getFiles: () => authoritativeFixture, runProcess });

		expect(exitCode).toBe(17);
		expect(runProcess).toHaveBeenCalledTimes(1);
	});

	it("stops after a middle-shard failure", async () => {
		const runProcess = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(19);
		const exitCode = await runTestCi({ getFiles: () => authoritativeFixture, runProcess });

		expect(exitCode).toBe(19);
		expect(runProcess).toHaveBeenCalledTimes(2);
	});

	it("propagates the remaining-suite exit code", async () => {
		const runProcess = vi
			.fn()
			.mockResolvedValueOnce(0)
			.mockResolvedValueOnce(0)
			.mockResolvedValueOnce(0)
			.mockResolvedValueOnce(23);
		const exitCode = await runTestCi({ getFiles: () => authoritativeFixture, runProcess });

		expect(exitCode).toBe(23);
		expect(runProcess).toHaveBeenCalledTimes(4);
	});

	it("spawns Vitest directly with inherited environment and transparent output", async () => {
		const child = new EventEmitter();
		child.kill = vi.fn();
		const spawnProcess = vi.fn(() => child);
		const signalSource = new EventEmitter();
		const result = runVitestProcess(["run", exampleFile], spawnProcess, signalSource);
		child.emit("close", 0, null);

		await expect(result).resolves.toBe(0);
		const [command, args, options] = spawnProcess.mock.calls[0];
		expect(command).toBe(process.execPath);
		expect(args.slice(1)).toEqual(["run", exampleFile]);
		expect(args[0]).toMatch(/node_modules[/\\]vitest[/\\]dist[/\\]cli\.js$/);
		expect(options).toMatchObject({ env: process.env, shell: false, stdio: "inherit" });
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

	it.each([
		["SIGINT", 130],
		["SIGTERM", 143],
	])("forwards %s and returns its conventional exit code", async (signal, expectedExitCode) => {
		const child = new EventEmitter();
		const signalSource = new EventEmitter();
		child.kill = vi.fn((forwardedSignal) => child.emit("close", null, forwardedSignal));
		const result = runVitestProcess([], () => child, signalSource);
		signalSource.emit(signal);

		await expect(result).resolves.toBe(expectedExitCode);
		expect(child.kill).toHaveBeenCalledWith(signal);
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
