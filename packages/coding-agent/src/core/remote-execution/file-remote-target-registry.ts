/**
 * File Remote Target Registry (2.14.0).
 *
 * Durable JSON-file implementation of the RemoteTargetStore port. Mirrors the
 * other file stores: atomic write, schema validation on load, deterministic
 * corrupt surfacing. Targets are a catalog, not mission state.
 */

import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import lockfile from "proper-lockfile";
import type {
	RemoteTargetLoadResult,
	RemoteTargetRegisterResult,
	RemoteTargetStore,
} from "./remote-target-registry.js";
import { parseRemoteExecutionTarget, type RemoteExecutionTarget } from "./remote-target-types.js";

const RECORD_SUFFIX = ".target.json";
const ATOMIC_SUFFIX = ".tmp";

const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_RETRIES = 8;

export interface FileRemoteTargetRegistryOptions {
	root: string;
	storeId?: string;
	lockStaleMs?: number;
	lockRetries?: number;
}

export function defaultRemoteTargetRegistryRoot(): string {
	const env = process.env.JENSEN_REMOTE_TARGET_DIR;
	if (env?.trim()) return env.trim();
	return path.join(os.homedir(), ".jensen", "agent", "remote-targets");
}

export class FileRemoteTargetRegistry implements RemoteTargetStore {
	readonly storeId: string;
	private readonly root: string;
	private readonly lockStaleMs: number;
	private readonly lockRetries: number;

	constructor(options: FileRemoteTargetRegistryOptions) {
		this.root = path.resolve(options.root);
		this.storeId = options.storeId ?? "file";
		this.lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
		this.lockRetries = options.lockRetries ?? DEFAULT_LOCK_RETRIES;
	}

	private resolve(targetId: string): string {
		return path.join(this.root, `${targetId}${RECORD_SUFFIX}`);
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

	private async withLock<T>(targetId: string, fn: () => Promise<T>): Promise<T> {
		await fsp.mkdir(this.root, { recursive: true });
		const target = this.resolve(targetId);
		let release: (() => Promise<void>) | undefined;
		try {
			release = await lockfile.lock(target, {
				realpath: false,
				stale: this.lockStaleMs,
				retries: { retries: this.lockRetries, factor: 2, minTimeout: 20, maxTimeout: 250, randomize: true },
			});
		} catch {
			throw new Error(`Timed out acquiring remote target registry lock for ${targetId}`);
		}
		try {
			return await fn();
		} finally {
			if (release) {
				try {
					await release();
				} catch {
					// best-effort release
				}
			}
		}
	}

	async register(target: RemoteExecutionTarget): Promise<RemoteTargetRegisterResult> {
		const parsed = parseRemoteExecutionTarget(target);
		if (!parsed.ok) {
			throw new Error(`Invalid remote target: ${parsed.diagnostic}`);
		}
		return this.withLock(parsed.target.targetId, async () => {
			const existing = await this.load(parsed.target.targetId);
			if (existing.status === "ok") {
				const same = JSON.stringify(existing.target) === JSON.stringify(parsed.target);
				if (same) return { status: "idempotent" as const, target: existing.target };
				return { status: "conflict" as const, error: "targetId already registered with a different definition" };
			}
			if (existing.status === "corrupt") {
				return { status: "conflict" as const, error: `existing target record is corrupt: ${existing.diagnostic}` };
			}
			await this.writeAtomic(this.resolve(parsed.target.targetId), JSON.stringify(parsed.target, null, 2));
			return { status: "created" as const };
		});
	}

	async load(targetId: string): Promise<RemoteTargetLoadResult> {
		let raw: string | undefined;
		try {
			raw = await fsp.readFile(this.resolve(targetId), "utf8");
		} catch {
			return { status: "missing" };
		}
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			return { status: "corrupt", targetId, diagnostic: "record is not valid JSON" };
		}
		const parsed = parseRemoteExecutionTarget(value);
		if (!parsed.ok) {
			return { status: "corrupt", targetId, diagnostic: parsed.diagnostic };
		}
		return { status: "ok", target: parsed.target };
	}

	async listTargets(): Promise<string[]> {
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
			ids.push(entry.slice(0, -RECORD_SUFFIX.length));
		}
		return ids.sort();
	}

	async remove(targetId: string): Promise<boolean> {
		try {
			await fsp.unlink(this.resolve(targetId));
			return true;
		} catch {
			return false;
		}
	}
}

export function createFileRemoteTargetRegistry(
	root: string = defaultRemoteTargetRegistryRoot(),
): FileRemoteTargetRegistry {
	return new FileRemoteTargetRegistry({ root });
}
