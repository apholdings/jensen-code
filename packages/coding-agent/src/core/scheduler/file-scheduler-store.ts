/**
 * File Scheduler Store (2.12.0).
 *
 * Local durable implementation of the SchedulingIntentStore port. One small
 * record file per intent, schema-validated on load, written atomically
 * (unique temp + fsync + rename). Intent identity is deterministic per mission
 * (`intent_<missionId>`), so enqueue and tick are idempotent across processes.
 *
 * Cross-process model:
 *   - All mutations for an intent serialize on a per-intent proper-lockfile
 *     lock. Two processes racing to enqueue/transition the same mission's
 *     intent therefore serialize; the loser observes the winner's record.
 *   - Unrelated intents lock different paths and never globally serialize.
 */

import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import lockfile from "proper-lockfile";
import {
	parseSchedulingIntentRecord,
	type SchedulingIntentCreateResult,
	type SchedulingIntentListRecordsResult,
	type SchedulingIntentLoadResult,
	type SchedulingIntentMutateResult,
	type SchedulingIntentMutation,
	type SchedulingIntentStore,
} from "./scheduler-store.js";
import { isSafeIntentId, SchedulingError, type SchedulingIntentRecord } from "./scheduler-types.js";

const RECORD_SUFFIX = ".intent.json";
const ATOMIC_SUFFIX = ".tmp";

const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_RETRIES = 8;
const DEFAULT_LOCK_MIN_TIMEOUT_MS = 20;
const DEFAULT_LOCK_MAX_TIMEOUT_MS = 250;

export interface FileSchedulerStoreOptions {
	root: string;
	storeId?: string;
	lockStaleMs?: number;
	lockRetries?: number;
	lockMinTimeoutMs?: number;
	lockMaxTimeoutMs?: number;
}

export function defaultSchedulerRoot(): string {
	const env = process.env.JENSEN_SCHEDULER_REGISTRY_DIR;
	if (env?.trim()) return env.trim();
	return path.join(os.homedir(), ".jensen", "agent", "scheduler-registry");
}

export class FileSchedulerStore implements SchedulingIntentStore {
	readonly storeId: string;
	private readonly root: string;
	private readonly lockStaleMs: number;
	private readonly lockRetries: number;
	private readonly lockMinTimeoutMs: number;
	private readonly lockMaxTimeoutMs: number;

	constructor(options: FileSchedulerStoreOptions) {
		this.root = path.resolve(options.root);
		this.storeId = options.storeId ?? "file";
		this.lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
		this.lockRetries = options.lockRetries ?? DEFAULT_LOCK_RETRIES;
		this.lockMinTimeoutMs = options.lockMinTimeoutMs ?? DEFAULT_LOCK_MIN_TIMEOUT_MS;
		this.lockMaxTimeoutMs = options.lockMaxTimeoutMs ?? DEFAULT_LOCK_MAX_TIMEOUT_MS;
	}

	private resolve(intentId: string): string {
		return path.join(this.root, `${intentId}${RECORD_SUFFIX}`);
	}

	private assertIntentId(intentId: string): void {
		if (!isSafeIntentId(intentId)) {
			throw new SchedulingError("INTENT_CORRUPT", `Unsafe intent id: ${intentId}`, { intentId });
		}
	}

	private async writeAtomic(target: string, content: string): Promise<void> {
		await fsp.mkdir(this.root, { recursive: true });
		const tmp = `${target}.${randomUUID()}${ATOMIC_SUFFIX}`;
		await fsp.writeFile(tmp, content, "utf8");
		const fh = await fsp.open(tmp, "r");
		try {
			await fh.sync();
		} finally {
			await fh.close();
		}
		await fsp.rename(tmp, target);
	}

	private async readRaw(intentId: string): Promise<string | undefined> {
		try {
			return await fsp.readFile(this.resolve(intentId), "utf8");
		} catch {
			return undefined;
		}
	}

	private async withIntentLock<T>(intentId: string, fn: () => Promise<T>): Promise<T> {
		this.assertIntentId(intentId);
		await fsp.mkdir(this.root, { recursive: true });
		const target = path.join(this.root, intentId);

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
				throw new SchedulingError(
					"INTENT_LOCK_TIMEOUT",
					`Timed out acquiring intent mutation lock for ${intentId}`,
					{ intentId },
				);
			}
			if (code === "ENOTEMPTY" || code === "ENOTDIR") {
				throw new SchedulingError("INTENT_CORRUPT", `Corrupt intent mutation lock metadata for ${intentId}`, {
					intentId,
				});
			}
			throw error;
		}

		try {
			if (compromised) {
				throw new SchedulingError("INTENT_CORRUPT", `Intent mutation lock for ${intentId} was compromised`, {
					intentId,
				});
			}
			return await fn();
		} finally {
			if (release) {
				try {
					await release();
				} catch {
					// Best-effort release; a successful mutation must never become an error.
				}
			}
		}
	}

	// =========================================================================
	// SchedulingIntentStore
	// =========================================================================

	async create(record: SchedulingIntentRecord): Promise<SchedulingIntentCreateResult> {
		this.assertIntentId(record.intentId);
		return this.withIntentLock(record.intentId, async () => {
			const existing = await this.readRaw(record.intentId);
			if (existing !== undefined) {
				return { status: "conflict", error: `intent ${record.intentId} already exists` };
			}
			const validation = parseSchedulingIntentRecord(record);
			if (!validation.ok) {
				throw new Error(`Cannot create invalid intent ${record.intentId}: ${validation.diagnostic}`);
			}
			await this.writeAtomic(this.resolve(record.intentId), JSON.stringify(record, null, 2));
			return { status: "created" };
		});
	}

	async load(intentId: string): Promise<SchedulingIntentLoadResult> {
		this.assertIntentId(intentId);
		const raw = await this.readRaw(intentId);
		if (raw === undefined) return { status: "missing" };

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return { status: "corrupt", intentId, diagnostic: "record is not valid JSON" };
		}
		const result = parseSchedulingIntentRecord(parsed);
		if (!result.ok) {
			return { status: "corrupt", intentId, diagnostic: result.diagnostic };
		}
		return { status: "ok", record: result.record };
	}

	async listIntents(): Promise<string[]> {
		let entries: string[];
		try {
			entries = await fsp.readdir(this.root);
		} catch {
			return [];
		}
		const ids: string[] = [];
		for (const entry of entries) {
			if (entry.endsWith(ATOMIC_SUFFIX)) continue;
			if (!entry.endsWith(RECORD_SUFFIX)) continue;
			const id = entry.slice(0, -RECORD_SUFFIX.length);
			if (isSafeIntentId(id)) ids.push(id);
		}
		return ids.sort();
	}

	async listRecords(): Promise<SchedulingIntentListRecordsResult> {
		const ids = await this.listIntents();
		const records: SchedulingIntentRecord[] = [];
		const corrupt: SchedulingIntentListRecordsResult["corrupt"] = [];
		for (const id of ids) {
			const loaded = await this.load(id);
			if (loaded.status === "ok") records.push(loaded.record);
			else if (loaded.status === "corrupt") corrupt.push({ intentId: id, diagnostic: loaded.diagnostic });
		}
		return { records, corrupt };
	}

	async mutate<T>(
		intentId: string,
		mutation: (current: SchedulingIntentRecord) => SchedulingIntentMutation<T>,
	): Promise<SchedulingIntentMutateResult<T>> {
		this.assertIntentId(intentId);

		return this.withIntentLock(intentId, async () => {
			const loaded = await this.load(intentId);
			if (loaded.status === "missing") return { status: "missing" };
			if (loaded.status === "corrupt") {
				return { status: "corrupt", intentId, diagnostic: loaded.diagnostic };
			}

			const output = mutation(loaded.record);
			if (output.kind === "noop") return { status: "ok", value: output.value };

			const validation = parseSchedulingIntentRecord(output.next);
			if (!validation.ok) {
				throw new Error(`Mutation produced an invalid intent for ${intentId}: ${validation.diagnostic}`);
			}
			await this.writeAtomic(this.resolve(intentId), JSON.stringify(output.next, null, 2));
			return { status: "ok", value: output.value };
		});
	}
}

/** Convenience factory using the default Jensen scheduler registry directory. */
export function createFileSchedulerStore(root: string = defaultSchedulerRoot()): FileSchedulerStore {
	return new FileSchedulerStore({ root });
}
