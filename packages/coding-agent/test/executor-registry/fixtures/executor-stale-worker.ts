/**
 * Executor registry stale-runtime worker (fixture).
 *
 * Attempts a fenced runtime mutation with an explicit (possibly stale) proof
 * from a separate OS process, and prints a structured outcome so the parent
 * test can assert STALE_EXECUTOR_INSTANCE fencing without parsing prose.
 */

import { ExecutorControlService, FileExecutorRegistry } from "../../../src/core/executor-registry/index.js";

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
	const root = arg("--root");
	const executorId = arg("--executorId");
	const instance = arg("--instance");
	const epoch = arg("--epoch");
	const op = arg("--op") ?? "heartbeat";
	if (!root || !executorId || !instance || !epoch) {
		process.stderr.write("missing --root/--executorId/--instance/--epoch\n");
		process.exit(1);
	}

	const store = new FileExecutorRegistry({ root });
	const service = new ExecutorControlService({ store });
	const proof = { executorId, runtimeInstanceId: instance, runtimeEpoch: Number(epoch) };

	try {
		let result: unknown;
		if (op === "deactivate") {
			result = await service.deactivateExecutor(proof);
		} else if (op === "capabilities") {
			result = await service.updateRuntimeCapabilities(proof, { models: ["stale-model"] });
		} else {
			result = await service.heartbeatExecutor(proof);
		}
		process.stdout.write(`${JSON.stringify({ ok: true, op, result })}\n`);
	} catch (error) {
		const code =
			typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : undefined;
		process.stdout.write(
			`${JSON.stringify({ ok: false, op, code, message: error instanceof Error ? error.message : String(error) })}\n`,
		);
	}
}

void main();
