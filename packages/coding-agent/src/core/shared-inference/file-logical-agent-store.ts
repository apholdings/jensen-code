/**
 * File logical agent store (3.0.0 foundation).
 *
 * Per-agent files with atomic writes + per-agent cross-process file lock,
 * mirroring FileDurableMissionStore. Optimistic revision compare-save prevents
 * two control planes from silently overwriting a transition.
 */

import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import lockfile from "proper-lockfile";
import {
	isSafeLogicalAgentId,
	type LogicalAgentLoadResult,
	type LogicalAgentSaveResult,
	type LogicalAgentStore,
	parseLogicalAgentRecord,
} from "./logical-agent.js";
import type { LogicalAgentRecord } from "./types.js";

const RECORD_SUFFIX = ".agent.json";
const ATOMIC_SUFFIX = ".tmp";

const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_RETRIES = 8;
const DEFAULT_LOCK_MIN_TIMEOUT_MS = 20;
const DEFAULT_LOCK_MAX_TIMEOUT_MS = 250;

export interface FileLogicalAgentStoreOptions {
	root: string;
	storeId?: string;
}

export function defaultLogicalAgentRoot(): string {
	const env = process.env.JENSEN_LOGICAL_AGENT_DIR;
	if (env?.trim()) return env.trim();
	return path.join(os.homedir(), ".jensen", "logical-agents");
}

export class FileLogicalAgentStore implements LogicalAgentStore {
	readonly storeId: string;
	private readonly root: string;

	constructor(options: FileLogicalAgentStoreOptions) {
		this.root = path.resolve(options.root);
		this.storeId = options.storeId ?? "file";
	}

	private resolve(logicalAgentId: string): string {
		return path.join(this.root, `${logicalAgentId}${RECORD_SUFFIX}`);
	}

	private assertId(logicalAgentId: string): void {
		if (!isSafeLogicalAgentId(logicalAgentId)) throw new Error(`Unsafe logical agent id: ${logicalAgentId}`);
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

	private async readRaw(logicalAgentId: string): Promise<string | undefined> {
		try {
			return await fsp.readFile(this.resolve(logicalAgentId), "utf8");
		} catch {
			return undefined;
		}
	}

	private async withFileLock<T>(logicalAgentId: string, fn: () => Promise<T>): Promise<T> {
		this.assertId(logicalAgentId);
		await fsp.mkdir(this.root, { recursive: true });
		const target = this.resolve(logicalAgentId);
		let release: (() => Promise<void>) | undefined;
		try {
			release = await lockfile.lock(target, {
				realpath: false,
				stale: DEFAULT_LOCK_STALE_MS,
				retries: {
					retries: DEFAULT_LOCK_RETRIES,
					factor: 2,
					minTimeout: DEFAULT_LOCK_MIN_TIMEOUT_MS,
					maxTimeout: DEFAULT_LOCK_MAX_TIMEOUT_MS,
					randomize: true,
				},
			});
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error
					? (error as { code?: unknown }).code
					: undefined;
			if (code === "ELOCKED") throw new Error(`Timed out acquiring logical agent lock for ${logicalAgentId}`);
			if (code === "ENOTEMPTY" || code === "ENOTDIR")
				throw new Error(`Corrupt logical agent lock metadata for ${logicalAgentId}`);
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

	async load(logicalAgentId: string): Promise<LogicalAgentLoadResult> {
		this.assertId(logicalAgentId);
		const raw = await this.readRaw(logicalAgentId);
		if (raw === undefined) return { status: "missing" };
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return { status: "corrupt", logicalAgentId, diagnostic: "record is not valid JSON" };
		}
		const result = parseLogicalAgentRecord(parsed);
		if (!result.ok) return { status: "corrupt", logicalAgentId, diagnostic: result.diagnostic };
		return { status: "ok", record: result.record };
	}

	async save(
		record: LogicalAgentRecord,
		options: { expectedRevision?: number } = {},
	): Promise<LogicalAgentSaveResult> {
		this.assertId(record.logicalAgentId);
		return this.withFileLock(record.logicalAgentId, async () => {
			if (options.expectedRevision !== undefined) {
				const current = await this.load(record.logicalAgentId);
				if (current.status !== "ok") {
					return { status: "stale", expectedRevision: options.expectedRevision, actualRevision: undefined };
				}
				if (current.record.revision !== options.expectedRevision) {
					return {
						status: "stale",
						expectedRevision: options.expectedRevision,
						actualRevision: current.record.revision,
					};
				}
			}
			const next: LogicalAgentRecord = {
				...record,
				updatedAtMs: Date.now(),
				revision: record.revision + 1,
			};
			await this.writeAtomic(this.resolve(record.logicalAgentId), JSON.stringify(next, null, 2));
			return { status: "saved", record: next };
		});
	}

	async list(): Promise<string[]> {
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
			if (isSafeLogicalAgentId(id)) ids.push(id);
		}
		return ids.sort();
	}
}

export function createFileLogicalAgentStore(root: string = defaultLogicalAgentRoot()): FileLogicalAgentStore {
	return new FileLogicalAgentStore({ root });
}
