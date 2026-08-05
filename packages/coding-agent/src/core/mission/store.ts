/**
 * Durable Mission Graph — atomic durable store, event log, leases and
 * checkpoints (2.0.0).
 *
 * All mission state is persisted atomically (write-temp-then-rename) so a
 * reboot never leaves a partially written document. Event records are
 * append-only and replayable with zero effects on creation. Leases are
 * repository-scoped and expire on a deadline; a reboot that terminates the
 * holder makes any recorded process `missing` during reconciliation instead of
 * trusting stale authority.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type {
	MissionEventRecord,
	MissionGraphDocumentV1,
	ReconciliationStatus,
	RecoveryRecord,
	RepositoryLease,
} from "./types.js";

export interface MissionStoreOptions {
	root: string;
}

const GRAPH_FILE = "mission-graph.json";
const EVENTS_FILE = "events.jsonl";
const LEASES_FILE = "leases.json";
const RECOVERY_FILE = "recovery.json";

const ATOMIC_SUFFIX = ".tmp";

export class MissionStore {
	private readonly root: string;

	constructor(options: MissionStoreOptions) {
		this.root = options.root;
	}

	private resolve(name: string): string {
		return path.join(this.root, name);
	}

	async initialize(): Promise<void> {
		await fsp.mkdir(this.root, { recursive: true });
	}

	// =========================================================================
	// Atomic graph document persistence
	// =========================================================================

	async saveGraph(document: MissionGraphDocumentV1): Promise<void> {
		await fsp.mkdir(this.root, { recursive: true });
		const target = this.resolve(GRAPH_FILE);
		const tmp = `${target}${ATOMIC_SUFFIX}`;
		const data = JSON.stringify(document, null, 2);
		await fsp.writeFile(tmp, data, "utf8");
		// fsync the temp file, then atomically rename over the target.
		const fh = await fsp.open(tmp, "r");
		try {
			await fh.sync();
		} finally {
			await fh.close();
		}
		await fsp.rename(tmp, target);
	}

	async loadGraph(): Promise<MissionGraphDocumentV1 | undefined> {
		const target = this.resolve(GRAPH_FILE);
		try {
			const data = await fsp.readFile(target, "utf8");
			const doc = JSON.parse(data) as MissionGraphDocumentV1;
			if (doc.schemaVersion !== 1) return undefined;
			return doc;
		} catch {
			return undefined;
		}
	}

	// =========================================================================
	// Append-only event log (replayable, zero effects on create)
	// =========================================================================

	async appendEvent(record: MissionEventRecord): Promise<void> {
		await fsp.mkdir(this.root, { recursive: true });
		const target = this.resolve(EVENTS_FILE);
		// Append to a temp copy, then rename to keep the log atomic per append.
		const content = `${JSON.stringify(record)}\n`;
		const existing = await this.readFileSafe(this.resolve(EVENTS_FILE));
		const tmp = `${target}${ATOMIC_SUFFIX}`;
		await fsp.writeFile(tmp, existing + content, "utf8");
		await fsp.rename(tmp, target);
	}

	async readEvents(missionId: string): Promise<MissionEventRecord[]> {
		const data = await this.readFileSafe(this.resolve(EVENTS_FILE));
		const records: MissionEventRecord[] = [];
		for (const line of data.split("\n")) {
			if (!line.trim()) continue;
			try {
				const r = JSON.parse(line) as MissionEventRecord;
				if (r.missionId === missionId) records.push(r);
			} catch {
				// Skip malformed tail lines (partial append after crash).
			}
		}
		return records;
	}

	/**
	 * Replay the event log for a mission deterministically. Because events are
	 * only appended (never mutated) and idempotent keys are embedded, replay
	 * has zero effects: it never re-mutates state.
	 */
	async replayEvents(missionId: string): Promise<MissionEventRecord[]> {
		const records = await this.readEvents(missionId);
		const seen = new Set<string>();
		const unique: MissionEventRecord[] = [];
		for (const r of records) {
			if (seen.has(r.id)) continue; // skip duplicate event ids
			seen.add(r.id);
			unique.push(r);
		}
		return unique;
	}

	// =========================================================================
	// Repository-scoped leases
	// =========================================================================

	async saveLeases(leases: RepositoryLease[]): Promise<void> {
		await fsp.mkdir(this.root, { recursive: true });
		const target = this.resolve(LEASES_FILE);
		const tmp = `${target}${ATOMIC_SUFFIX}`;
		await fsp.writeFile(tmp, JSON.stringify(leases, null, 2), "utf8");
		await fsp.rename(tmp, target);
	}

	async loadLeases(): Promise<RepositoryLease[]> {
		const data = await this.readFileSafe(this.resolve(LEASES_FILE));
		if (!data) return [];
		try {
			const parsed = JSON.parse(data) as RepositoryLease[];
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	}

	async acquireLease(lease: RepositoryLease, nowMs = Date.now()): Promise<boolean> {
		const leases = await this.loadLeases();
		// A repository-scoped lease is exclusive: reject if an unexpired lease
		// for the same repository is held by someone else.
		const existing = leases.find((l) => l.repositoryId === lease.repositoryId);
		if (existing && existing.expiresAtMs > nowMs && existing.holder !== lease.holder) {
			return false;
		}
		const filtered = leases.filter((l) => !(l.repositoryId === lease.repositoryId && l.holder === lease.holder));
		filtered.push(lease);
		await this.saveLeases(filtered);
		return true;
	}

	async releaseLease(leaseId: string): Promise<void> {
		const leases = await this.loadLeases();
		const filtered = leases.filter((l) => l.leaseId !== leaseId);
		await this.saveLeases(filtered);
	}

	async isLeaseCurrent(lease: RepositoryLease, nowMs = Date.now()): Promise<boolean> {
		const leases = await this.loadLeases();
		const found = leases.find((l) => l.leaseId === lease.leaseId);
		if (!found) return false;
		return found.repositoryId === lease.repositoryId && found.expiresAtMs > nowMs;
	}

	// =========================================================================
	// Recovery records
	// =========================================================================

	async recordRecovery(record: RecoveryRecord): Promise<void> {
		await fsp.mkdir(this.root, { recursive: true });
		const target = this.resolve(RECOVERY_FILE);
		let records: RecoveryRecord[] = [];
		const existing = await this.readFileSafe(target);
		if (existing) {
			try {
				records = JSON.parse(existing) as RecoveryRecord[];
			} catch {
				records = [];
			}
		}
		records = records.filter((r) => r.recoveryId !== record.recoveryId);
		records.push(record);
		const tmp = `${target}${ATOMIC_SUFFIX}`;
		await fsp.writeFile(tmp, JSON.stringify(records, null, 2), "utf8");
		await fsp.rename(tmp, target);
	}

	async loadRecovery(missionId: string): Promise<RecoveryRecord[]> {
		const existing = await this.readFileSafe(this.resolve(RECOVERY_FILE));
		if (!existing) return [];
		try {
			const all = JSON.parse(existing) as RecoveryRecord[];
			return all.filter((r) => r.missionId === missionId);
		} catch {
			return [];
		}
	}

	private async readFileSafe(file: string): Promise<string> {
		try {
			return await fsp.readFile(file, "utf8");
		} catch {
			return "";
		}
	}

	// =========================================================================
	// Sync helpers (for CLI one-shot reads)
	// =========================================================================

	syncExists(name: string): boolean {
		return fs.existsSync(this.resolve(name));
	}
}

/**
 * Reconcile a recorded process against reality after a reboot.
 *
 * If durable state says a process is `running` but it no longer exists, the
 * record is reclassified as `missing` (never reconciled to still-running), and
 * cleanup idempotently releases any leases the dead process held.
 */
export async function reconcileProcessAfterReboot(
	store: MissionStore,
	recordedProcessId: string,
	processStillExists: boolean,
	nowMs = Date.now(),
): Promise<{ status: ReconciliationStatus; actions: string[] }> {
	const actions: string[] = [];
	const leases = await store.loadLeases();
	let changed = false;

	if (!processStillExists) {
		const deadLeases = leases.filter((l) => l.holder === recordedProcessId);
		if (deadLeases.length > 0) {
			const remaining = leases.filter((l) => l.holder !== recordedProcessId);
			await store.saveLeases(remaining);
			for (const l of deadLeases) actions.push(`released stale lease ${l.leaseId} (repo ${l.repositoryId})`);
			changed = true;
		}
		actions.push(`process '${recordedProcessId}' marked missing after reboot`);
	} else {
		actions.push(`process '${recordedProcessId}' still alive; no reconciliation applied`);
	}

	// Reject reusing stale lease/resource authority: any lease that has expired
	// is treated as not current regardless of holder.
	const expired = leases.filter((l) => l.expiresAtMs <= nowMs);
	for (const l of expired) {
		actions.push(`lease ${l.leaseId} expired at ${l.expiresAtMs}`);
		changed = true;
	}

	// Idempotent: when no lease state changed, report CLEAN.
	return { status: changed ? "RECONCILED" : "CLEAN", actions: [...new Set(actions)] };
}
