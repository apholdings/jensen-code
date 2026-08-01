import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitestCliPath = resolve(packageRoot, "../../node_modules/vitest/dist/cli.js");
export const continuationShardFiles = [
	"test/long-horizon/continuation-cli-basics.test.ts",
	"test/long-horizon/continuation-cli-transitions.test.ts",
	"test/long-horizon/continuation-cli-errors.test.ts",
];
export const executionRevisionShardFiles = [
	"test/long-horizon/execution-cli-revision-malformed-a.test.ts",
	"test/long-horizon/execution-cli-revision-malformed-b.test.ts",
	"test/long-horizon/execution-cli-revision-controls.test.ts",
];
export const rpcIsolatedTestFiles = [...continuationShardFiles, ...executionRevisionShardFiles];
const productionHarnessFile = "src/core/production-todo-provider-harness.test.ts";
const orchestrationTestFile = "test/run-test-ci.test.mjs";

function normalizeInventoryPath(filePath) {
	return filePath.replaceAll("\\", "/");
}

export function listTestFiles() {
	const result = spawnSync(process.execPath, [vitestCliPath, "list", "--filesOnly"], {
		cwd: packageRoot,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		throw new Error(`Vitest test inventory failed with exit code ${result.status}: ${result.stderr}`);
	}

	const files = result.stdout
		.split(/\r?\n/)
		.map((filePath) => normalizeInventoryPath(filePath.trim()))
		.filter(Boolean);
	if (files.length === 0) {
		throw new Error("Vitest test inventory was empty");
	}
	return files;
}

export function buildTestCommands(files) {
	const normalizedFiles = files.map(normalizeInventoryPath);
	const uniqueFiles = new Set(normalizedFiles);
	if (uniqueFiles.size !== normalizedFiles.length) {
		throw new Error("Vitest test inventory contains duplicate files");
	}
	const missingShards = rpcIsolatedTestFiles.filter((filePath) => !uniqueFiles.has(filePath));
	if (missingShards.length > 0) {
		throw new Error(`Vitest test inventory is missing RPC-isolated shards: ${missingShards.join(", ")}`);
	}
	if (!uniqueFiles.has(productionHarnessFile)) {
		throw new Error(`Vitest test inventory is missing ${productionHarnessFile}`);
	}
	if (!uniqueFiles.has(orchestrationTestFile)) {
		throw new Error(`Vitest test inventory is missing ${orchestrationTestFile}`);
	}

	const isolatedSet = new Set(rpcIsolatedTestFiles);
	const remainingFiles = normalizedFiles.filter((filePath) => !isolatedSet.has(filePath));
	const remainingSet = new Set(remainingFiles);
	if (rpcIsolatedTestFiles.some((filePath) => remainingSet.has(filePath))) {
		throw new Error("An RPC-isolated shard appears in both CI partitions");
	}
	if (remainingSet.size + rpcIsolatedTestFiles.length !== uniqueFiles.size) {
		throw new Error("Vitest CI process inventories are not disjoint and complete");
	}

	return [
		...rpcIsolatedTestFiles.map((filePath) => ({
			name: `RPC-isolated test shard: ${filePath}`,
			args: ["run", "--passWithNoTests", filePath],
		})),
		{
			name: "remaining coding-agent tests",
			args: ["run", "--passWithNoTests", ...remainingFiles],
		},
	];
}

function signalExitCode(signal) {
	return signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1;
}

export function runVitestProcess(args, spawnProcess = spawn, signalSource = process) {
	return new Promise((resolveResult) => {
		const child = spawnProcess(process.execPath, [vitestCliPath, ...args], {
			cwd: packageRoot,
			env: process.env,
			shell: false,
			stdio: "inherit",
		});
		let settled = false;
		const signals = ["SIGINT", "SIGTERM"];
		const signalHandlers = new Map();
		const finish = (code, signal) => {
			if (settled) return;
			settled = true;
			for (const [forwardedSignal, handler] of signalHandlers) {
				signalSource.removeListener(forwardedSignal, handler);
			}
			resolveResult(code ?? signalExitCode(signal));
		};

		for (const signal of signals) {
			const handler = () => child.kill(signal);
			signalHandlers.set(signal, handler);
			signalSource.once(signal, handler);
		}
		child.once("error", (error) => {
			console.error("Failed to start Vitest process:", error);
			finish(1);
		});
		child.once("close", (code, signal) => finish(code, signal));
	});
}

export async function runTestCi({ getFiles = listTestFiles, runProcess = runVitestProcess } = {}) {
	const commands = buildTestCommands(getFiles());
	for (const command of commands) {
		const exitCode = await runProcess(command.args);
		if (exitCode !== 0) {
			return exitCode;
		}
	}
	return 0;
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
	try {
		process.exitCode = await runTestCi();
	} catch (error) {
		console.error(error);
		process.exitCode = 1;
	}
}
