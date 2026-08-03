import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { workspaceIdFromRoot } from "./policy.js";

export interface LeaseRecord {
	leaseId: string;
	workspaceId: string;
	ownerRunId: string;
	processId: number;
	acquiredAt: number;
	lastHeartbeat: number;
	expiresAt: number;
	timeoutMs: number;
	recovered?: boolean;
}

export type LeaseResult =
	| { ok: true; lease: LeaseRecord }
	| { ok: false; reason: "lease_held"; lease: LeaseRecord }
	| { ok: false; reason: "io_error"; message: string };

export type LeaseStatus = LeaseRecord | null;

export interface LeaseStoreOptions {
	/** Absolute directory where lease records are stored. */
	storageDir: string;
	/** Timeout after which a lease is considered stale and recoverable. */
	timeoutMs?: number;
	/** Heartbeat interval. */
	heartbeatMs?: number;
	/** Injectable now() for deterministic tests. */
	now?: () => number;
	/** Injectable process-liveness checker (default: process.kill(pid, 0)). */
	isProcessAlive?: (pid: number) => boolean;
}

export class WorkspaceLeaseError extends Error {
	readonly code: string;
	readonly lease?: LeaseRecord;
	constructor(code: string, message: string, lease?: LeaseRecord) {
		super(message);
		this.code = code;
		this.lease = lease;
		this.name = "WorkspaceLeaseError";
	}
}

function defaultLiveness(pid: number): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// ESRCH means the process is gone; EPERM means it exists.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Exclusive workspace mutation lease.
 *
 * Uses an atomic exclusive-create lockfile so that only one authoritative
 * mutating transaction may hold the workspace lease. Read-only work can remain
 * concurrent. A crashed owner does not permanently lock the workspace: stale
 * leases are recovered only after a positive liveness check. Release is
 * idempotent. Unrelated workspaces are independent (per-workspace key).
 */
export class WorkspaceLeaseStore {
	private readonly timeoutMs: number;
	private readonly heartbeatMs: number;
	private readonly now: () => number;
	private readonly isProcessAlive: (pid: number) => boolean;
	readonly storageDir: string;

	constructor(options: LeaseStoreOptions) {
		this.storageDir = options.storageDir;
		this.timeoutMs = options.timeoutMs ?? 30_000;
		this.heartbeatMs = options.heartbeatMs ?? 5_000;
		this.now = options.now ?? (() => Date.now());
		this.isProcessAlive = options.isProcessAlive ?? defaultLiveness;
	}

	private leasePath(workspaceId: string): string {
		const key = workspaceId.replace(/[^a-z0-9._-]/g, "_");
		return path.join(this.storageDir, "leases", `${key}.lease.json`);
	}

	async acquire(workspaceId: string, ownerRunId: string): Promise<LeaseResult> {
		const now = this.now();
		const existing = await this.readRecord(workspaceId);
		if (existing) {
			const stale = now - existing.lastHeartbeat > this.timeoutMs;
			const ownerAlive = this.isProcessAlive(existing.processId);
			if (!(stale && !ownerAlive)) {
				return { ok: false, reason: "lease_held", lease: existing };
			}
			// Recover the stale lease.
			await fs.unlink(this.leasePath(workspaceId)).catch(() => {});
		}
		const record: LeaseRecord = {
			leaseId: randomUUID(),
			workspaceId,
			ownerRunId,
			processId: process.pid,
			acquiredAt: now,
			lastHeartbeat: now,
			expiresAt: now + this.timeoutMs,
			timeoutMs: this.timeoutMs,
		};
		try {
			await fs.mkdir(path.dirname(this.leasePath(workspaceId)), { recursive: true });
			await fs.writeFile(this.leasePath(workspaceId), JSON.stringify(record), {
				flag: "wx",
				mode: 0o600,
			});
			return { ok: true, lease: record };
		} catch {
			// Another process won the race. Re-read and report the holder.
			const winner = await this.readRecord(workspaceId);
			return winner
				? { ok: false, reason: "lease_held", lease: winner }
				: { ok: false, reason: "io_error", message: "lease file write failed" };
		}
	}

	async heartbeat(workspaceId: string): Promise<void> {
		const rec = await this.readRecord(workspaceId);
		if (!rec) return;
		if (rec.processId === process.pid) {
			rec.lastHeartbeat = this.now();
			await fs.writeFile(this.leasePath(workspaceId), JSON.stringify(rec), { mode: 0o600 }).catch(() => {});
		}
	}

	/** Idempotent release. Only the owner (or recovery) can clear the lease. */
	async release(workspaceId: string, ownerRunId: string | null): Promise<void> {
		const rec = await this.readRecord(workspaceId);
		if (!rec) return;
		if (ownerRunId !== null && rec.ownerRunId !== ownerRunId) {
			throw new WorkspaceLeaseError("not_owner", "lease not owned by this run; refusing to release", rec);
		}
		await fs.unlink(this.leasePath(workspaceId)).catch(() => {});
	}

	async status(workspaceId: string): Promise<LeaseStatus> {
		return this.readRecord(workspaceId);
	}

	/** Stale-lease recovery with positive liveness check. */
	async recoverIfStale(workspaceId: string, _ownerRunId: string): Promise<LeaseRecord | null> {
		const rec = await this.readRecord(workspaceId);
		if (!rec) return null;
		const stale = this.now() - rec.lastHeartbeat > this.timeoutMs;
		const ownerAlive = this.isProcessAlive(rec.processId);
		if (!(stale && !ownerAlive)) {
			// The current owner is alive: never steal a live lease.
			throw new WorkspaceLeaseError("lease_active", "lease owner is alive; cannot steal", rec);
		}
		await fs.unlink(this.leasePath(workspaceId)).catch(() => {});
		return rec;
	}

	private async readRecord(workspaceId: string): Promise<LeaseRecord | null> {
		try {
			const raw = await fs.readFile(this.leasePath(workspaceId), "utf-8");
			return JSON.parse(raw) as LeaseRecord;
		} catch {
			return null;
		}
	}
}

/** Convenience to derive a lease when the owner also wants a checkout of state. */
export function workspaceKeyFromRoot(root: string): string {
	return workspaceIdFromRoot(root);
}
