/**
 * File inference queue store (3.0.0 foundation).
 *
 * Cross-process durable ledger store. Concurrency and durability follow the
 * exact pattern of FileDurableMissionStore: per-write unique temp files,
 * fsync + atomic rename, and a per-(root, resourceId) proper-lockfile critical
 * section so two OS processes can never interleave a read-validate-write
 * mutation. Corruption is surfaced structurally; a corrupt ledger never
 * fabricates a free slot or a completed inference.
 */

import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import lockfile from "proper-lockfile";
import {
	type InferenceLedgerCreateResult,
	type InferenceLedgerLoadResult,
	type InferenceLedgerMutateResult,
	type InferenceLedgerMutation,
	type InferenceQueueStore,
	type InferenceResourceLedger,
	isSafeResourceId,
	parseInferenceResourceLedger,
} from "./inference-queue.js";

const RECORD_SUFFIX = ".inference.json";
const ATOMIC_SUFFIX = ".tmp";

const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_RETRIES = 8;
const DEFAULT_LOCK_MIN_TIMEOUT_MS = 20;
const DEFAULT_LOCK_MAX_TIMEOUT_MS = 250;

export interface FileInferenceQueueStoreOptions {
	root: string;
	storeId?: string;
	lockStaleMs?: number;
	lockRetries?: number;
	lockMinTimeoutMs?: number;
	lockMaxTimeoutMs?: number;
}

export function defaultInferenceQueueRoot(): string {
	const env = process.env.JENSEN_INFERENCE_QUEUE_DIR;
	if (env?.trim()) return env.trim();
	return path.join(os.homedir(), ".jensen", "shared-inference");
}

export class FileInferenceQueueStore implements InferenceQueueStore {
	readonly storeId: string;
	private readonly root: string;
	private readonly lockStaleMs: number;
	private readonly lockRetries: number;
	private readonly lockMinTimeoutMs: number;
	private readonly lockMaxTimeoutMs: number;

	constructor(options: FileInferenceQueueStoreOptions) {
		this.root = path.resolve(options.root);
		this.storeId = options.storeId ?? "file";
		this.lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
		this.lockRetries = options.lockRetries ?? DEFAULT_LOCK_RETRIES;
		this.lockMinTimeoutMs = options.lockMinTimeoutMs ?? DEFAULT_LOCK_MIN_TIMEOUT_MS;
		this.lockMaxTimeoutMs = options.lockMaxTimeoutMs ?? DEFAULT_LOCK_MAX_TIMEOUT_MS;
	}

	private resolve(resourceId: string): string {
		return path.join(this.root, `${resourceId}${RECORD_SUFFIX}`);
	}

	private assertResourceId(resourceId: string): void {
		if (!isSafeResourceId(resourceId)) throw new Error(`Unsafe resource id for inference queue store: ${resourceId}`);
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

	private async readRaw(resourceId: string): Promise<string | undefined> {
		try {
			return await fsp.readFile(this.resolve(resourceId), "utf8");
		} catch {
			return undefined;
		}
	}

	private async readParsed(
		resourceId: string,
	): Promise<
		| { status: "ok"; ledger: InferenceResourceLedger }
		| { status: "missing" }
		| { status: "corrupt"; diagnostic: string }
	> {
		const raw = await this.readRaw(resourceId);
		if (raw === undefined) return { status: "missing" };
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return { status: "corrupt", diagnostic: "ledger is not valid JSON" };
		}
		const result = parseInferenceResourceLedger(parsed);
		if (!result.ok) return { status: "corrupt", diagnostic: result.diagnostic };
		return { status: "ok", ledger: result.ledger };
	}

	private async withFileLock<T>(resourceId: string, fn: () => Promise<T>): Promise<T> {
		this.assertResourceId(resourceId);
		await fsp.mkdir(this.root, { recursive: true });
		const target = this.resolve(resourceId);
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
			});
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error
					? (error as { code?: unknown }).code
					: undefined;
			if (code === "ELOCKED") {
				throw new Error(`Timed out acquiring inference queue lock for resource ${resourceId}`);
			}
			if (code === "ENOTEMPTY" || code === "ENOTDIR") {
				throw new Error(`Corrupt inference queue lock metadata for resource ${resourceId}`);
			}
			throw error;
		}

		try {
			return await fn();
		} finally {
			if (release) {
				try {
					await release();
				} catch {
					// Best-effort release.
				}
			}
		}
	}

	async create(resourceId: string, ledger: InferenceResourceLedger): Promise<InferenceLedgerCreateResult> {
		this.assertResourceId(resourceId);
		return this.withFileLock(resourceId, async () => {
			const existing = await this.load(resourceId);
			if (existing.status === "ok") return { status: "idempotent", ledger: existing.ledger };
			if (existing.status === "corrupt") {
				return { status: "conflict", error: `existing ledger is corrupt: ${existing.diagnostic}` };
			}
			await this.writeAtomic(this.resolve(resourceId), JSON.stringify(ledger, null, 2));
			return { status: "created" };
		});
	}

	async load(resourceId: string): Promise<InferenceLedgerLoadResult> {
		this.assertResourceId(resourceId);
		const raw = await this.readRaw(resourceId);
		if (raw === undefined) return { status: "missing" };
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return { status: "corrupt", resourceId, diagnostic: "ledger is not valid JSON" };
		}
		const result = parseInferenceResourceLedger(parsed);
		if (!result.ok) return { status: "corrupt", resourceId, diagnostic: result.diagnostic };
		return { status: "ok", ledger: result.ledger };
	}

	async mutate<T>(
		resourceId: string,
		mutation: (current: InferenceResourceLedger) => InferenceLedgerMutation<T>,
	): Promise<InferenceLedgerMutateResult<T>> {
		this.assertResourceId(resourceId);
		return this.withFileLock(resourceId, async () => {
			const current = await this.readParsed(resourceId);
			if (current.status === "missing") return { status: "missing" };
			if (current.status === "corrupt") {
				return { status: "corrupt", resourceId, diagnostic: current.diagnostic };
			}
			const output = mutation(current.ledger);
			if (output.kind === "noop") return { status: "ok", value: output.value };

			const nextValidation = parseInferenceResourceLedger(output.next);
			if (!nextValidation.ok) {
				throw new Error(
					`Inference mutation produced an invalid ledger for ${resourceId}: ${nextValidation.diagnostic}`,
				);
			}
			await this.writeAtomic(this.resolve(resourceId), JSON.stringify(output.next, null, 2));
			return { status: "ok", value: output.value };
		});
	}

	async listResources(): Promise<string[]> {
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
			if (isSafeResourceId(id)) ids.push(id);
		}
		return ids.sort();
	}
}

export function createFileInferenceQueueStore(root: string = defaultInferenceQueueRoot()): FileInferenceQueueStore {
	return new FileInferenceQueueStore({ root });
}
