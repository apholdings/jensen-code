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
 * Concurrency model (single process):
 *   - Each write uses a per-write unique temp path (never shared), so two
 *     writers cannot truncate/rename one another's temp file.
 *   - The optimistic `revision` compare-and-save is serialized by an in-process,
 *     per-(root, missionId) mutex, so two store instances in the SAME process
 *     cannot interleave a stale write; the stale writer receives a structural
 *     `{ status: "stale" }` result.
 *   - Cross-process (multiple OS processes) compare-and-save is NOT atomic in
 *     this slice. Concurrent cross-process writers can still last-write-win.
 *     Do not assume cross-process safety.
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
import {
	type DurableMissionCreateResult,
	type DurableMissionLoadResult,
	type DurableMissionRecord,
	type DurableMissionSaveOptions,
	type DurableMissionSaveResult,
	type DurableMissionStore,
	isSafeMissionId,
	missionRequestsEqual,
	parseDurableMissionRecord,
} from "../mission-domain/durable-store.js";
import { isTerminalMissionState } from "../mission-domain/mission-state.js";

const RECORD_SUFFIX = ".mission.json";
const ATOMIC_SUFFIX = ".tmp";

/**
 * In-process, per-record mutual exclusion.
 *
 * The optimistic `revision` compare-and-save is a read-check-write spanning
 * multiple awaited filesystem operations; it is not atomic across concurrent
 * callers on its own. This mutex serializes those critical sections per
 * (store root, missionId) so two store instances in the SAME process cannot
 * interleave a stale write. It is deliberately NOT a cross-process lock.
 */
type Release = () => void;

const inProcessLocks = new Map<string, Promise<void>>();

function withRecordLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const previous = inProcessLocks.get(key) ?? Promise.resolve();
	let release: Release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = previous.catch(() => {}).then(() => gate);
	inProcessLocks.set(key, tail);

	return previous
		.catch(() => {})
		.then(async () => {
			let released = false;
			const unlock = () => {
				if (released) return;
				released = true;
				release();
			};
			try {
				return await fn();
			} finally {
				unlock();
				void tail.finally(() => {
					if (inProcessLocks.get(key) === tail) inProcessLocks.delete(key);
				});
			}
		});
}

export interface FileDurableMissionStoreOptions {
	root: string;
	/** Store identity (defaults to "file"). */
	storeId?: string;
}

export function defaultDurableMissionRoot(): string {
	const env = process.env.JENSEN_DURABLE_MISSION_STORE;
	if (env?.trim()) return env.trim();
	return path.join(os.homedir(), ".jensen", "durable-missions");
}

export class FileDurableMissionStore implements DurableMissionStore {
	readonly storeId: string;
	private readonly root: string;

	constructor(options: FileDurableMissionStoreOptions) {
		this.root = path.resolve(options.root);
		this.storeId = options.storeId ?? "file";
	}

	private resolve(missionId: string): string {
		return path.join(this.root, `${missionId}${RECORD_SUFFIX}`);
	}

	private assertMissionId(missionId: string): void {
		if (!isSafeMissionId(missionId)) {
			throw new Error(`Unsafe mission id for durable file store: ${missionId}`);
		}
	}

	private lockKey(missionId: string): string {
		return `${this.root}\0${missionId}`;
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

	// =========================================================================
	// DurableMissionStore
	// =========================================================================

	async create(record: DurableMissionRecord): Promise<DurableMissionCreateResult> {
		this.assertMissionId(record.missionId);

		return withRecordLock(this.lockKey(record.missionId), async () => {
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

		return withRecordLock(this.lockKey(record.missionId), async () => {
			if (options.expectedRevision !== undefined) {
				const raw = await this.readRaw(record.missionId);
				if (raw === undefined) {
					return { status: "stale", expectedRevision: options.expectedRevision, actualRevision: undefined };
				}
				let existing: unknown;
				try {
					existing = JSON.parse(raw);
				} catch {
					return { status: "stale", expectedRevision: options.expectedRevision, actualRevision: undefined };
				}
				const parsed = parseDurableMissionRecord(existing);
				if (!parsed.ok) {
					return { status: "stale", expectedRevision: options.expectedRevision, actualRevision: undefined };
				}
				if (parsed.record.revision !== options.expectedRevision) {
					return {
						status: "stale",
						expectedRevision: options.expectedRevision,
						actualRevision: parsed.record.revision,
					};
				}
			}

			await this.writeAtomic(this.resolve(record.missionId), JSON.stringify(record, null, 2));
			return { status: "saved" };
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
			// target (if any) is what matters.
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
