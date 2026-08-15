/**
 * Mission Control inspection worker (fixture).
 *
 * Standalone tsx worker that inspects a durable mission through
 * MissionControlService from a separate OS process. It records the durable
 * revision and lease before and after inspection so the parent test can prove
 * read-only control-plane operations never mutate authoritative state.
 */

import { MissionControlService } from "../../../src/core/mission-control/index.js";
import { FileDurableMissionStore } from "../../../src/core/mission-durable/index.js";

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
	const root = arg("--root");
	const missionId = arg("--missionId");
	if (!root || !missionId) {
		process.stderr.write("missing --root/--missionId\n");
		process.exit(1);
	}

	const store = new FileDurableMissionStore({ root });
	const control = new MissionControlService({ store });

	const before = await store.load(missionId);
	const detail = await control.getMission(missionId);
	const ownership = await control.getOwnership(missionId);
	const attempts = await control.getAttempts(missionId);
	const after = await store.load(missionId);

	process.stdout.write(
		`${JSON.stringify({
			ok: true,
			state: detail.summary.state,
			owned: ownership.owned,
			leaseStatus: ownership.leaseStatus,
			localRuntimeKnown: ownership.localRuntime?.known ?? false,
			attemptsCount: attempts.attempts.length,
			beforeRevision: before.status === "ok" ? before.record.revision : null,
			afterRevision: after.status === "ok" ? after.record.revision : null,
			beforeLease: before.status === "ok" ? before.record.lease : null,
			afterLease: after.status === "ok" ? after.record.lease : null,
			beforeUpdatedAtMs: before.status === "ok" ? before.record.updatedAtMs : null,
			afterUpdatedAtMs: after.status === "ok" ? after.record.updatedAtMs : null,
		})}\n`,
	);
}

void main();
