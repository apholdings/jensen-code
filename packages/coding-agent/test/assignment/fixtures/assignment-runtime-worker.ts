/**
 * Assignment runtime worker (fixture).
 *
 * Registers (optionally) and activates an executor runtime, optionally emits
 * heartbeats, and either exits (`--once`) or stays alive (`--keepAlive`). The
 * parent test uses it to create real independent OS processes for runtime
 * incarnation / stale-proof QA.
 */

import { ExecutorControlService, FileExecutorRegistry } from "../../../src/core/executor-registry/index.js";

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined;
}

function flag(name: string): boolean {
	return process.argv.includes(name);
}

function line(payload: unknown): void {
	process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function main(): Promise<void> {
	const root = arg("--root");
	const executorId = arg("--executorId");
	if (!root || !executorId) {
		process.stderr.write("missing --root/--executorId\n");
		process.exit(1);
	}

	const store = new FileExecutorRegistry({ root: `${root}/executors` });
	const service = new ExecutorControlService({ store, expiryMs: Number(arg("--expiryMs") ?? 30_000) });

	if (flag("--register")) {
		await service.registerExecutor({ executorId });
	}

	try {
		const activation = await service.activateExecutor(executorId, {
			platform: "linux",
			arch: "x64",
			hostname: "qa-host",
		});
		line({
			t: "activated",
			executorId,
			runtimeInstanceId: activation.runtimeInstanceId,
			runtimeEpoch: activation.runtimeEpoch,
			expiresAtMs: activation.expiresAtMs,
		});
	} catch (error) {
		const code =
			typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : undefined;
		line({ t: "activate_error", code, message: error instanceof Error ? error.message : String(error) });
		if (flag("--once")) process.exit(0);
		await new Promise<void>(() => {});
	}

	if (flag("--once")) process.exit(0);
	await new Promise<void>(() => {});
}

void main();
