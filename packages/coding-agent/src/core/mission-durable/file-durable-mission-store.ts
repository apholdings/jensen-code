/**
 * File Durable Mission Store (2.4.0).
 *
 * Concrete local implementation of the DurableMissionStore port. Records are
 * written atomically (unique temp + fsync + rename) so a process exit never
 * leaves a partially-written authoritative record. On load, records are
 * schema-validated and corruption is surfaced structurally — never silently
 * dropped and never fabricated into a default success.
 *
 * File naming is derived only from the stable `missionId` (a safe path
 * component), never from untrusted objective text.
 *
 * Concurrency model (cross-process):
 *   - Each write uses a per-write unique temp path (never shared), so two
 *     writers cannot truncate/rename one another's temp file.
 *   - Every mutation (`create`, `save`, `mutate`) is serialized by a
 *     per-(root, missionId) cross-process file lock (proper-lockfile, atomic
 *     exclusive lock-directory creation). Two independent OS processes cannot
 *     interleave a read-check-write critical section.
 *   - The optimistic `revision` compare-and-save therefore is atomic across
 *     processes: exactly one writer wins, the stale writer receives a
 *     structural `{ status: "stale" }`.
 *   - Execution-authoritative saves may additionally carry a `leaseProof`;
 *     the store verifies the current durable lease under the same critical
 *     section and rejects stale owners (see `ExecutionLease`).
 *
 * Durability policy:
 *   - The temp file is fsynced, then atomically renamed over the target.
 *   - The containing directory is NOT fsynced after rename, matching the
 *     strongest existing Jensen convention (MissionFileStore and MissionStore
 *     also omit directory fsync). On POSIX this means the file CONTENT is
 *     durable and the rename is atomic, but a sudden power loss could in
 *     theory lose the directory entry. This is the same guarantee the rest of
 *     the Jensen durability layer provides; it is not weakened or strengthened
 *     here.
 */

import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import lockfile from "proper-lockfile";
import {
	type DurableMissionCreateResult,
	type DurableMissionLoadResult,
	type DurableMissionMutateResult,
	type DurableMissionMutation,
	type DurableMissionRecord,
	type DurableMissionSaveOptions,
	type DurableMissionSaveResult,
	type DurableMissionStore,
	isSafeMissionId,
	missionRequestsEqual,
	parseDurableMissionRecord,
} from "../mission-domain/durable-store.js";
import { ExecutionOwnershipError } from "../mission-domain/execution-lease.js";
import { isTerminalMissionState } from "../mission-domain/mission-state.js";

const RECORD_SUFFIX = ".mission.json";
const ATOMIC_SUFFIX = ".tmp";

/**
 * Default cross-process mutation lock tuning. The lock is held only for a short
 * read-validate-write critical section (milliseconds), never across model
 * inference or execution. A crashed lock holder is recovered via proper-lockfile
 * staleness after `lockStaleMs`.
 */
const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_RETRIES = 8;
const DEFAULT_LOCK_MIN_TIMEOUT_MS = 20;
const DEFAULT_LOCK_MAX_TIMEOUT_MS = 250;

export interface FileDurableMissionStoreOptions {
	root: string;
	/** Store identity (defaults to "file"). */
	storeId?: string;
	/** Cross-process mutation lock staleness window. */
	lockStaleMs?: number;
	lockRetries?: number;
	lockMinTimeoutMs?: number;
	lockMaxTimeoutMs?: number;
}

export function defaultDurableMissionRoot(): string {
	const env = process.env.JENSEN_DURABLE_MISSION_STORE;
	if (env?.trim()) return env.trim();
	return path.join(os.homedir(), ".jensen", "durable-missions");
}

export class FileDurableMissionStore implements DurableMissionStore {
	readonly storeId: string;
	private readonly root: string;
	private readonly lockStaleMs: number;
	private readonly lockRetries: number;
	private readonly lockMinTimeoutMs: number;
	private readonly lockMaxTimeoutMs: number;

	constructor(options: FileDurableMissionStoreOptions) {
		this.root = path.resolve(options.root);
		this.storeId = options.storeId ?? "file";
		this.lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
		this.lockRetries = options.lockRetries ?? DEFAULT_LOCK_RETRIES;
		this.lockMinTimeoutMs = options.lockMinTimeoutMs ?? DEFAULT_LOCK_MIN_TIMEOUT_MS;
		this.lockMaxTimeoutMs = options.lockMaxTimeoutMs ?? DEFAULT_LOCK_MAX_TIMEOUT_MS;
	}

	private resolve(missionId: string): string {
		return path.join(this.root, `${missionId}${RECORD_SUFFIX}`);
	}

	private assertMissionId(missionId: string): void {
		if (!isSafeMissionId(missionId)) {
			throw new Error(`Unsafe mission id for durable file store: ${missionId}`);
		}
	}

	private async writeAtomic(target: string, content: string): Promise<void> {
		await fsp.mkdir(this.root, { recursive: true });
		// Unique per-write temp path so concurrent writers can never truncate,
		// delete, or rename one another's temporary file. The suffix still ends
		// in `.tmp` so `listMissions` skips incomplete writes after a crash.
		const tmp = `${target}.${randomUUID()}${ATOMIC_SUFFIX}`;
		await fsp.writeFile(tmp, content, "utf8");
		// fsync the temp file before the atomic rename over the target.
		const fh = await fsp.open(tmp, "r");
		try {
			await fh.sync();
		} finally {
			await fh.close();
		}
		await fsp.rename(tmp, target);
	}

	private async readRaw(missionId: string): Promise<string | undefined> {
		try {
			return await fsp.readFile(this.resolve(missionId), "utf8");
		} catch {
			return undefined;
		}
	}

	/**
	 * Acquire the per-mission cross-process mutation lock, run `fn`, release.
	 *
	 * The lock protects only the short read-validate-write critical section. It
	 * is never held across executor/model work. Lock acquisition has bounded
	 * retries/backoff; exhaustion is a structured LOCK_TIMEOUT, and a
	 * compromised lock is CORRUPT_LOCK_METADATA.
	 */
	private async withFileLock<T>(missionId: string, fn: () => Promise<T>): Promise<T> {
		this.assertMissionId(missionId);
		await fsp.mkdir(this.root, { recursive: true });
		const target = this.resolve(missionId);

		let compromised = false;
		let release: (() => Promise<void>) | undefined;
		try {
			release = await lockfile.lock(target, {
				realpath: false,
				stale: this.lockStaleMs,
				retries: {
					retries: this.lockRetries,
					factor: 2,
					minTimeout: this.lockMinTimeoutMs,
					maxTimeout: this.lockMaxTimeoutMs,
					randomize: true,
				},
				onCompromised: () => {
					compromised = true;
				},
			});
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error
					? (error as { code?: unknown }).code
					: undefined;
			if (code === "ELOCKED") {
				throw new ExecutionOwnershipError(
					"LOCK_TIMEOUT",
					`Timed out acquiring mutation lock for mission ${missionId}`,
					{ missionId },
				);
			}
			// A non-empty lock directory is corrupt lock metadata (proper-lockfile
			// can only remove an empty lock dir during stale recovery). Surface it
			// structurally rather than fabricating ownership; the operator/test may
			// remove the corrupt `.lock` directory and retry.
			if (code === "ENOTEMPTY" || code === "ENOTDIR") {
				throw new ExecutionOwnershipError(
					"CORRUPT_LOCK_METADATA",
					`Corrupt mutation lock metadata for mission ${missionId}`,
					{ missionId },
				);
			}
			throw error;
		}

		try {
			if (compromised) {
				throw new ExecutionOwnershipError(
					"CORRUPT_LOCK_METADATA",
					`Mutation lock for mission ${missionId} was compromised`,
					{ missionId },
				);
			}
			return await fn();
		} finally {
			if (release) {
				try {
					await release();
				} catch {
					// A compromised/recovered lock may already be invalid; releasing
					// is best-effort and never turns a successful mutation into an error.
				}
			}
		}
	}

	private async readParsed(
		missionId: string,
	): Promise<{ status: "ok"; record: DurableMissionRecord } | { status: "missing" } | { status: "corrupt" }> {
		const raw = await this.readRaw(missionId);
		if (raw === undefined) return { status: "missing" };
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return { status: "corrupt" };
		}
		const result = parseDurableMissionRecord(parsed);
		if (!result.ok) return { status: "corrupt" };
		return { status: "ok", record: result.record };
	}

	// =========================================================================
	// DurableMissionStore
	// =========================================================================

	async create(record: DurableMissionRecord): Promise<DurableMissionCreateResult> {
		this.assertMissionId(record.missionId);

		return this.withFileLock(record.missionId, async () => {
			const existing = await this.load(record.missionId);
			if (existing.status === "ok") {
				if (missionRequestsEqual(existing.record.request, record.request)) {
					return { status: "idempotent", record: existing.record };
				}
				return {
					status: "conflict",
					error: "missionId already exists with a different immutable MissionRequest",
				};
			}
			if (existing.status === "corrupt") {
				return {
					status: "conflict",
					error: `existing durable record is corrupt: ${existing.diagnostic}`,
				};
			}

			await this.writeAtomic(this.resolve(record.missionId), JSON.stringify(record, null, 2));
			return { status: "created" };
		});
	}

	async load(missionId: string): Promise<DurableMissionLoadResult> {
		this.assertMissionId(missionId);
		const raw = await this.readRaw(missionId);
		if (raw === undefined) return { status: "missing" };

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return { status: "corrupt", missionId, diagnostic: "record is not valid JSON" };
		}

		const result = parseDurableMissionRecord(parsed);
		if (!result.ok) {
			return { status: "corrupt", missionId, diagnostic: result.diagnostic };
		}
		return { status: "ok", record: result.record };
	}

	async save(
		record: DurableMissionRecord,
		options: DurableMissionSaveOptions = {},
	): Promise<DurableMissionSaveResult> {
		this.assertMissionId(record.missionId);

		return this.withFileLock(record.missionId, async () => {
			if (options.expectedRevision !== undefined || options.leaseProof !== undefined) {
				const current = await this.readParsed(record.missionId);
				if (current.status !== "ok") {
					return {
						status: "stale",
						expectedRevision: options.expectedRevision ?? 0,
						actualRevision: undefined,
					};
				}

				if (options.expectedRevision !== undefined && current.record.revision !== options.expectedRevision) {
					return {
						status: "stale",
						expectedRevision: options.expectedRevision,
						actualRevision: current.record.revision,
					};
				}

				if (options.leaseProof !== undefined) {
					const lease = current.record.lease;
					if (!lease) return { status: "lease_not_found" };
					if (
						lease.leaseId !== options.leaseProof.leaseId ||
						lease.fencingToken !== options.leaseProof.fencingToken
					) {
						return { status: "stale_owner", leaseId: lease.leaseId, fencingToken: lease.fencingToken };
					}
				}
			}

			await this.writeAtomic(this.resolve(record.missionId), JSON.stringify(record, null, 2));
			return { status: "saved" };
		});
	}

	async mutate<T>(
		missionId: string,
		mutation: (current: DurableMissionRecord) => DurableMissionMutation<T>,
	): Promise<DurableMissionMutateResult<T>> {
		this.assertMissionId(missionId);

		return this.withFileLock(missionId, async () => {
			const current = await this.readParsed(missionId);
			if (current.status === "missing") return { status: "missing" };
			if (current.status === "corrupt") {
				return { status: "corrupt", missionId, diagnostic: "record is not valid or schema-invalid" };
			}

			const output = mutation(current.record);
			if (output.kind === "noop") return { status: "ok", value: output.value };

			// Defense in depth: never persist a mutation result that does not
			// round-trip through the canonical schema validator.
			const nextValidation = parseDurableMissionRecord(output.next);
			if (!nextValidation.ok) {
				throw new Error(`Mutation produced an invalid record for ${missionId}: ${nextValidation.diagnostic}`);
			}

			await this.writeAtomic(this.resolve(missionId), JSON.stringify(output.next, null, 2));
			return { status: "ok", value: output.value };
		});
	}

	async listMissions(): Promise<string[]> {
		let entries: string[];
		try {
			entries = await fsp.readdir(this.root);
		} catch {
			return [];
		}
		const ids: string[] = [];
		for (const entry of entries) {
			// Skip incomplete temp files from a crash mid-write; the authoritative
			// target (if any) is what matters. Lock directories also never end in
			// the record suffix, so they are naturally excluded.
			if (entry.endsWith(ATOMIC_SUFFIX)) continue;
			if (!entry.endsWith(RECORD_SUFFIX)) continue;
			const id = entry.slice(0, -RECORD_SUFFIX.length);
			if (isSafeMissionId(id)) ids.push(id);
		}
		return ids.sort();
	}

	async listNonterminalMissions(): Promise<string[]> {
		const ids = await this.listMissions();
		const nonterminal: string[] = [];
		for (const id of ids) {
			const loaded = await this.load(id);
			if (loaded.status !== "ok") continue; // corrupt/missing surfaced via load, not listing
			if (!isTerminalMissionState(loaded.record.state)) nonterminal.push(id);
		}
		return nonterminal;
	}

	async listChildren(parentMissionId: string): Promise<string[]> {
		this.assertMissionId(parentMissionId);
		const ids = await this.listMissions();
		const children: string[] = [];
		for (const id of ids) {
			const loaded = await this.load(id);
			if (loaded.status === "ok" && loaded.record.parentMissionId === parentMissionId) {
				children.push(id);
			}
		}
		return children;
	}
}

/**
 * Convenience factory using the default Jensen state directory.
 */
export function createFileDurableMissionStore(root: string = defaultDurableMissionRoot()): FileDurableMissionStore {
	return new FileDurableMissionStore({ root });
}
