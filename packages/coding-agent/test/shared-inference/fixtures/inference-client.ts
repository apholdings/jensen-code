/**
 * Shared inference multiprocess fixture client.
 *
 * A real OS process that targets a shared file-backed inference queue. Multiple
 * such processes prove the cross-process scheduling authority: with capacity=1,
 * global active inference concurrency must never exceed 1 even though each
 * process believes it is allowed to request inference.
 *
 * Args:
 *   --dir <queueDir>      shared file-backed queue root
 *   --agent <id>          logical agent identity
 *   --requests <n>        number of acquire/release cycles
 *   --hold-ms <n>         synthetic generation wall time per request
 */

import { FileInferenceQueueStore } from "../../../src/core/shared-inference/file-inference-queue-store.js";
import { SharedInferenceScheduler } from "../../../src/core/shared-inference/scheduler.js";

function arg(args: string[], name: string): string | undefined {
	const idx = args.indexOf(name);
	return idx === -1 ? undefined : args[idx + 1];
}

function num(args: string[], name: string, fallback: number): number {
	const raw = arg(args, name);
	const n = raw === undefined ? NaN : Number(raw);
	return Number.isFinite(n) ? n : fallback;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
	const dir = arg(process.argv.slice(2), "--dir") ?? process.cwd();
	const agent = arg(process.argv.slice(2), "--agent") ?? "agent";
	const requests = num(process.argv.slice(2), "--requests", 5);
	const holdMs = num(process.argv.slice(2), "--hold-ms", 20);
	const leaseDurationMs = num(process.argv.slice(2), "--lease-ms", 600_000);
	const recover = process.argv.includes("--recover");
	const probeUnknown = process.argv.includes("--probe-unknown");
	const crashAfterAdmit = process.argv.includes("--crash-after-admit");

	const store = new FileInferenceQueueStore({ root: dir });
	const scheduler = new SharedInferenceScheduler({
		store,
		waitPollMs: 5,
		leaseDurationMs,
		ownerId: `owner_${agent}`,
	});
	const resource = {
		resourceId: "qwen38-bucephalus",
		backend: "llamacpp-qwen38-bucephalus",
		model: "qwen3.8-27b",
		location: "bucephalus",
		capacity: 1,
		state: "available" as const,
	};
	await scheduler.registerResource(resource);
	const recovered = recover ? (await scheduler.recover()).reconciledRequests : [];
	const unknownStatus = probeUnknown ? (await scheduler.admissionStatus("unknown-request")).status : undefined;

	let admittedCount = 0;
	let violations = 0;
	for (let i = 0; i < requests; i++) {
		const inferenceRequestId = `${agent}-${i + 1}`;
		const outcome = await scheduler.acquire({
			logicalAgentId: agent,
			resource,
			model: { provider: resource.backend, id: resource.model },
			inferenceRequestId,
			priority: { base: 0 },
		});
		if (outcome.status !== "admitted") {
			violations += 1;
			continue;
		}

		admittedCount += 1;
		process.stdout.write(`${JSON.stringify({ event: "admitted", inferenceRequestId })}\n`);
		if (crashAfterAdmit) await new Promise(() => undefined);
		const loaded = await store.load(resource.resourceId);
		if (loaded.status === "ok" && loaded.ledger.running.length > 1) {
			violations += 1;
		}

		await sleep(holdMs);
		await scheduler.release(outcome.admitted, { state: "COMPLETED" });
	}

	console.log(JSON.stringify({ agent, admittedCount, violations, recovered, unknownStatus }));
}

main().catch((error) => {
	console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
	process.exit(1);
});
