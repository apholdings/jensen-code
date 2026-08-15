/**
 * Executor registry inspection worker (fixture).
 *
 * Inspects an executor through ExecutorControlService from a separate OS
 * process and records durable revision/epoch/updatedAt before and after so the
 * parent test can prove read-only inspection never mutates authoritative state.
 */

import { ExecutorControlService, FileExecutorRegistry } from "../../../src/core/executor-registry/index.js";

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
	const root = arg("--root");
	const executorId = arg("--executorId");
	if (!root || !executorId) {
		process.stderr.write("missing --root/--executorId\n");
		process.exit(1);
	}

	const store = new FileExecutorRegistry({ root });
	const service = new ExecutorControlService({ store });

	const before = await store.load(executorId);
	const detail = await service.getExecutor(executorId);
	const list = await service.listExecutors();
	const after = await store.load(executorId);

	const rev = (r: Awaited<ReturnType<typeof store.load>>): number | null =>
		r.status === "ok" ? r.record.revision : null;
	const epoch = (r: Awaited<ReturnType<typeof store.load>>): number | null =>
		r.status === "ok" ? r.record.runtimeEpoch : null;
	const updated = (r: Awaited<ReturnType<typeof store.load>>): number | null =>
		r.status === "ok" ? r.record.updatedAtMs : null;

	process.stdout.write(
		`${JSON.stringify({
			ok: true,
			status: detail.status,
			runtimeInstanceId: detail.runtime?.runtimeInstanceId,
			runtimeEpoch: detail.runtimeEpoch,
			listed: list.entries.some((e) => e.executorId === executorId),
			beforeRevision: rev(before),
			afterRevision: rev(after),
			beforeEpoch: epoch(before),
			afterEpoch: epoch(after),
			beforeUpdatedAtMs: updated(before),
			afterUpdatedAtMs: updated(after),
		})}\n`,
	);
}

void main();
