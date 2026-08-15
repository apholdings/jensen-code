/**
 * Executor registry activation worker (fixture).
 *
 * Standalone tsx worker that registers/activates a runtime, optionally emits
 * heartbeats on an interval, and optionally deactivates on exit. The parent
 * test reads JSON lines from stdout to observe the runtime proof and liveness.
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

	const expiryMs = Number(arg("--expiryMs") ?? 30_000);
	const heartbeatIntervalMs = Number(arg("--heartbeatIntervalMs") ?? 0);
	const runMs = Number(arg("--runMs") ?? 0);
	const instance = arg("--instance");

	const store = new FileExecutorRegistry({ root });
	const service = new ExecutorControlService({ store, expiryMs });

	if (flag("--register")) {
		await service.registerExecutor({ executorId });
	}

	let activation: Awaited<ReturnType<typeof service.activateExecutor>>;
	try {
		activation = await service.activateExecutor(executorId, {
			runtimeInstanceId: instance,
			platform: process.platform,
			arch: process.arch,
			hostname: process.env.EXECUTOR_QA_HOST ?? "qa-host",
		});
	} catch (error) {
		const code =
			typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : undefined;
		process.stdout.write(
			`${JSON.stringify({ t: "activate_error", code, message: error instanceof Error ? error.message : String(error) })}\n`,
		);
		process.exit(0);
	}
	line({
		t: "activated",
		executorId,
		runtimeInstanceId: activation.runtimeInstanceId,
		runtimeEpoch: activation.runtimeEpoch,
		expiresAtMs: activation.expiresAtMs,
	});

	let interval: NodeJS.Timeout | undefined;
	if (heartbeatIntervalMs > 0) {
		interval = setInterval(async () => {
			try {
				const beat = await service.heartbeatExecutor(activation.proof);
				line({
					t: "heartbeat",
					executorId,
					runtimeInstanceId: beat.runtimeInstanceId,
					runtimeEpoch: beat.runtimeEpoch,
					expiresAtMs: beat.expiresAtMs,
				});
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? (error as { code: unknown }).code
						: undefined;
				line({ t: "heartbeat_error", code, message: error instanceof Error ? error.message : String(error) });
			}
		}, heartbeatIntervalMs);
	}

	const cleanup = async () => {
		if (interval) clearInterval(interval);
		if (flag("--deactivateOnExit")) {
			try {
				await service.deactivateExecutor(activation.proof);
				line({ t: "deactivated", executorId, runtimeInstanceId: activation.runtimeInstanceId });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? (error as { code: unknown }).code
						: undefined;
				line({ t: "deactivate_error", code, message: error instanceof Error ? error.message : String(error) });
			}
		}
		process.exit(0);
	};

	if (flag("--once")) {
		process.exit(0);
	}

	if (runMs > 0) {
		setTimeout(cleanup, runMs);
	} else if (flag("--keepAlive")) {
		process.on("SIGTERM", () => void cleanup());
		process.on("SIGINT", () => void cleanup());
		await new Promise<void>(() => {});
	} else {
		await cleanup();
	}
}

void main();
