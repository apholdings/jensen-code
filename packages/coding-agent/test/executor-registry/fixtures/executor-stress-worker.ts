/**
 * Executor registry stress worker (fixture).
 *
 * Repeatedly attempts activation of a stable executor id with a short expiry.
 * Every successful activation prints its allocated epoch so the parent test can
 * assert epochs are unique and monotonic across genuinely concurrent processes.
 */

import { ExecutorControlService, FileExecutorRegistry } from "../../../src/core/executor-registry/index.js";

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined;
}

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
	const root = arg("--root");
	const executorId = arg("--executorId");
	if (!root || !executorId) {
		process.stderr.write("missing --root/--executorId\n");
		process.exit(1);
	}

	const iterations = Number(arg("--iterations") ?? 20);
	const expiryMs = Number(arg("--expiryMs") ?? 200);
	const store = new FileExecutorRegistry({ root });
	const service = new ExecutorControlService({ store, expiryMs });

	for (let i = 0; i < iterations; i++) {
		try {
			const act = await service.activateExecutor(executorId);
			process.stdout.write(
				`${JSON.stringify({ t: "activated", epoch: act.runtimeEpoch, instance: act.runtimeInstanceId })}\n`,
			);
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error
					? (error as { code: unknown }).code
					: undefined;
			process.stdout.write(`${JSON.stringify({ t: "conflict", code })}\n`);
		}
		await sleep(5 + Math.floor(Math.random() * 20));
	}
}

void main();
