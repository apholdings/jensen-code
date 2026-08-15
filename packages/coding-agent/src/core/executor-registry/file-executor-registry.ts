/**
 * File Executor Registry (2.10.0).
 *
 * Local durable implementation of the ExecutorRegistryStore port. Records are
 * written atomically (unique temp + fsync + rename) and schema-validated on
 * load. Each executor record is independently locked cross-process with
 * proper-lockfile, so unrelated executor ids can mutate concurrently.
 *
 * Concurrency model mirrors FileDurableMissionStore: the lock protects only the
 * short read-validate-write critical section, never held across heartbeat
 * cadences, model inference, or resource collection.
 */

import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import lockfile from "proper-lockfile";
import {
	type ExecutorLoadResult,
	type ExecutorMutateResult,
	type ExecutorMutation,
	type ExecutorRegisterResult,
	type ExecutorRegistryStore,
	executorDefinitionsEqual,
	parseExecutorRecord,
} from "./executor-registry-store.js";
import { type ExecutorRecord, ExecutorRegistryError, isSafeExecutorId } from "./executor-registry-types.js";

const RECORD_SUFFIX = ".executor.json";
const ATOMIC_SUFFIX = ".tmp";

const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_RETRIES = 8;
const DEFAULT_LOCK_MIN_TIMEOUT_MS = 20;
const DEFAULT_LOCK_MAX_TIMEOUT_MS = 250;

export interface FileExecutorRegistryOptions {
	root: string;
	storeId?: string;
	lockStaleMs?: number;
	lockRetries?: number;
	lockMinTimeoutMs?: number;
	lockMaxTimeoutMs?: number;
}

export function defaultExecutorRegistryRoot(): string {
	const env = process.env.JENSEN_EXECUTOR_REGISTRY_DIR;
	if (env?.trim()) return env.trim();
	return path.join(os.homedir(), ".jensen", "agent", "executor-registry");
}

export class FileExecutorRegistry implements ExecutorRegistryStore {
	readonly storeId: string;
	private readonly root: string;
	private readonly lockStaleMs: number;
	private readonly lockRetries: number;
	private readonly lockMinTimeoutMs: number;
	private readonly lockMaxTimeoutMs: number;

	constructor(options: FileExecutorRegistryOptions) {
		this.root = path.resolve(options.root);
		this.storeId = options.storeId ?? "file";
		this.lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
		this.lockRetries = options.lockRetries ?? DEFAULT_LOCK_RETRIES;
		this.lockMinTimeoutMs = options.lockMinTimeoutMs ?? DEFAULT_LOCK_MIN_TIMEOUT_MS;
		this.lockMaxTimeoutMs = options.lockMaxTimeoutMs ?? DEFAULT_LOCK_MAX_TIMEOUT_MS;
	}

	private resolve(executorId: string): string {
		return path.join(this.root, `${executorId}${RECORD_SUFFIX}`);
	}

	private assertExecutorId(executorId: string): void {
		if (!isSafeExecutorId(executorId)) {
			throw new ExecutorRegistryError("INVALID_EXECUTOR_ID", `Unsafe executor id: ${executorId}`, { executorId });
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

	private async readRaw(executorId: string): Promise<string | undefined> {
		try {
			return await fsp.readFile(this.resolve(executorId), "utf8");
		} catch {
			return undefined;
		}
	}

	private async withFileLock<T>(executorId: string, fn: () => Promise<T>): Promise<T> {
		this.assertExecutorId(executorId);
		await fsp.mkdir(this.root, { recursive: true });
		const target = this.resolve(executorId);

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
				throw new ExecutorRegistryError(
					"REGISTRY_LOCK_TIMEOUT",
					`Timed out acquiring registry mutation lock for executor ${executorId}`,
					{ executorId },
				);
			}
			if (code === "ENOTEMPTY" || code === "ENOTDIR") {
				throw new ExecutorRegistryError(
					"EXECUTOR_CORRUPT",
					`Corrupt registry mutation lock metadata for executor ${executorId}`,
					{ executorId },
				);
			}
			throw error;
		}

		try {
			if (compromised) {
				throw new ExecutorRegistryError(
					"EXECUTOR_CORRUPT",
					`Registry mutation lock for executor ${executorId} was compromised`,
					{ executorId },
				);
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

	private async readParsed(
		executorId: string,
	): Promise<{ status: "ok"; record: ExecutorRecord } | { status: "missing" } | { status: "corrupt" }> {
		const raw = await this.readRaw(executorId);
		if (raw === undefined) return { status: "missing" };
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return { status: "corrupt" };
		}
		const result = parseExecutorRecord(parsed);
		if (!result.ok) return { status: "corrupt" };
		return { status: "ok", record: result.record };
	}

	// =========================================================================
	// ExecutorRegistryStore
	// =========================================================================

	async register(record: ExecutorRecord): Promise<ExecutorRegisterResult> {
		this.assertExecutorId(record.executorId);

		return this.withFileLock(record.executorId, async () => {
			const existing = await this.load(record.executorId);
			if (existing.status === "ok") {
				if (
					executorDefinitionsEqual(
						{
							executorId: existing.record.executorId,
							displayName: existing.record.displayName,
							labels: existing.record.labels,
							configuredCapabilities: existing.record.configuredCapabilities,
						},
						{
							executorId: record.executorId,
							displayName: record.displayName,
							labels: record.labels,
							configuredCapabilities: record.configuredCapabilities,
						},
					)
				) {
					return { status: "idempotent", record: existing.record };
				}
				return { status: "conflict", error: "executorId already registered with a different definition" };
			}
			if (existing.status === "corrupt") {
				return { status: "conflict", error: `existing executor record is corrupt: ${existing.diagnostic}` };
			}

			await this.writeAtomic(this.resolve(record.executorId), JSON.stringify(record, null, 2));
			return { status: "created" };
		});
	}

	async load(executorId: string): Promise<ExecutorLoadResult> {
		this.assertExecutorId(executorId);
		const raw = await this.readRaw(executorId);
		if (raw === undefined) return { status: "missing" };

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return { status: "corrupt", executorId, diagnostic: "record is not valid JSON" };
		}
		const result = parseExecutorRecord(parsed);
		if (!result.ok) {
			return { status: "corrupt", executorId, diagnostic: result.diagnostic };
		}
		return { status: "ok", record: result.record };
	}

	async mutate<T>(
		executorId: string,
		mutation: (current: ExecutorRecord) => ExecutorMutation<T>,
	): Promise<ExecutorMutateResult<T>> {
		this.assertExecutorId(executorId);

		return this.withFileLock(executorId, async () => {
			const current = await this.readParsed(executorId);
			if (current.status === "missing") return { status: "missing" };
			if (current.status === "corrupt") {
				return { status: "corrupt", executorId, diagnostic: "record is not valid or schema-invalid" };
			}

			const output = mutation(current.record);
			if (output.kind === "noop") return { status: "ok", value: output.value };

			const nextValidation = parseExecutorRecord(output.next);
			if (!nextValidation.ok) {
				throw new Error(`Mutation produced an invalid record for ${executorId}: ${nextValidation.diagnostic}`);
			}

			await this.writeAtomic(this.resolve(executorId), JSON.stringify(output.next, null, 2));
			return { status: "ok", value: output.value };
		});
	}

	async listExecutors(): Promise<string[]> {
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
			if (isSafeExecutorId(id)) ids.push(id);
		}
		return ids.sort();
	}
}

/** Convenience factory using the default Jensen executor registry directory. */
export function createFileExecutorRegistry(root: string = defaultExecutorRegistryRoot()): FileExecutorRegistry {
	return new FileExecutorRegistry({ root });
}
