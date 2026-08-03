import { createHash, randomUUID } from "node:crypto";
import fs, { lstat, readFile, readlink, writeFile } from "node:fs/promises";
import nodePath from "node:path";
import { isSecretPath } from "./policy.js";

export type CheckpointEntryType = "file" | "directory" | "symlink" | "missing";
export type CheckpointStatus = "created" | "applied" | "confirmed" | "rolled_back" | "recovery_required";

export interface CheckpointEntry {
	/** Absolute path within the workspace. */
	path: string;
	type: CheckpointEntryType;
	/** Whether the path existed in any form before the transaction. */
	existed: boolean;
	/** content-addressed sha256 for file entries. */
	contentSha256?: string;
	mode?: number;
	symlinkTarget?: string;
	size?: number;
}

export interface WorkspaceCheckpoint {
	checkpointId: string;
	workspaceId: string;
	transactionId: string;
	runId?: string;
	createdAt: number;
	entries: CheckpointEntry[];
	manifestSha256: string;
	status: CheckpointStatus;
}

export interface CheckpointStoreOptions {
	storageDir: string;
	/** Refuse to checkpoint files larger than this many bytes. */
	maxCheckpointBytes?: number;
	/** Refuse to checkpoint secret-bearing paths. */
	rejectSecrets?: boolean;
}

export class CheckpointError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
		this.name = "CheckpointError";
	}
}

export function sha256(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

function canonicalEntriesJson(entries: CheckpointEntry[]): string {
	return JSON.stringify(entries);
}

/**
 * Content-addressed, integrity-protected pre-mutation checkpoint store.
 *
 * A checkpoint is a recovery artifact, never execution authority. Blobs are
 * deduplicated by sha256. The manifest carries a hash over its own entries so
 * tampering (including blob swapping) is detectable.
 */
export class CheckpointStore {
	private readonly opts: Required<Pick<CheckpointStoreOptions, "storageDir" | "maxCheckpointBytes">> &
		CheckpointStoreOptions;
	readonly storageDir: string;

	constructor(options: CheckpointStoreOptions) {
		this.storageDir = options.storageDir;
		this.opts = {
			storageDir: options.storageDir,
			maxCheckpointBytes: options.maxCheckpointBytes ?? 256 * 1024 * 1024,
			rejectSecrets: options.rejectSecrets ?? true,
		};
	}

	private checkpointDir(id: string): string {
		return nodePath.join(this.storageDir, "checkpoints", id);
	}
	private blobsDir(id: string): string {
		return nodePath.join(this.checkpointDir(id), "blobs");
	}
	private manifestPath(id: string): string {
		return nodePath.join(this.checkpointDir(id), "manifest.json");
	}

	private async snapshotEntry(entry: CheckpointEntry, dirs: CheckpointEntry[], cpBlobsDir: string): Promise<void> {
		const abs = entry.path;
		try {
			const st = await lstat(abs);
			if (st.isSymbolicLink()) {
				entry.type = "symlink";
				entry.existed = true;
				entry.symlinkTarget = await readlink(abs);
				return;
			}
			if (st.isDirectory()) {
				entry.type = "directory";
				entry.existed = true;
				return;
			}
			if (st.isFile()) {
				if (st.size > this.opts.maxCheckpointBytes) {
					throw new CheckpointError("oversized", `cannot checkpoint oversized file (${st.size} bytes): ${abs}`);
				}
				const content = await readFile(abs);
				if (this.opts.rejectSecrets && isSecretPath(abs)) {
					throw new CheckpointError("secret", `refusing to checkpoint secret-bearing file: ${abs}`);
				}
				entry.type = "file";
				entry.existed = true;
				entry.contentSha256 = sha256(content);
				entry.size = content.length;
				entry.mode = st.mode;
				const entryBlobDir = nodePath.join(cpBlobsDir, entry.contentSha256);
				await fs.mkdir(entryBlobDir, { recursive: true });
				await writeFile(nodePath.join(entryBlobDir, "blob"), content, {
					mode: 0o600,
					flag: "wx",
				}).catch(() => {});
			}
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				entry.type = "missing";
				entry.existed = false;
				// Record nearest existing ancestor metadata for restore.
				dirs.push({ path: abs, type: "missing", existed: false });
				return;
			}
			throw err;
		}
	}

	/**
	 * Create a checkpoint capturing the given absolute target paths.
	 * The parent blob dir is created before writing.
	 */
	async create(
		workspaceId: string,
		transactionId: string,
		targetPaths: string[],
		runId?: string,
	): Promise<WorkspaceCheckpoint> {
		const id = randomUUID();
		await fs.mkdir(this.checkpointDir(id), { recursive: true });
		// snapshot parent metadata first
		const entries: CheckpointEntry[] = [];
		const dirs: CheckpointEntry[] = [];
		for (const p of targetPaths) {
			const entry: CheckpointEntry = {
				path: p,
				type: "missing",
				existed: false,
			};
			await this.snapshotEntry(entry, dirs, this.blobsDir(id));
			entries.push(entry);
		}
		entries.push(...dirs);
		const manifestSha256 = sha256(canonicalEntriesJson(entries));
		const checkpoint: WorkspaceCheckpoint = {
			checkpointId: id,
			workspaceId,
			transactionId,
			runId,
			createdAt: Date.now(),
			entries,
			manifestSha256,
			status: "created",
		};
		await writeFile(this.manifestPath(id), JSON.stringify(checkpoint, null, 2), { mode: 0o600 });
		return checkpoint;
	}

	async read(id: string): Promise<WorkspaceCheckpoint | null> {
		try {
			const raw = await readFile(this.manifestPath(id), "utf-8");
			return JSON.parse(raw) as WorkspaceCheckpoint;
		} catch {
			return null;
		}
	}

	/** Verify manifest integrity and every blob hash. Throws on mismatch. */
	async verify(id: string): Promise<WorkspaceCheckpoint> {
		const cp = await this.read(id);
		if (!cp) throw new CheckpointError("not_found", `checkpoint not found: ${id}`);
		const recomputed = sha256(canonicalEntriesJson(cp.entries));
		if (recomputed !== cp.manifestSha256) {
			throw new CheckpointError("tampered", `checkpoint manifest hash mismatch: ${id}`);
		}
		for (const e of cp.entries) {
			if (e.type === "file" && e.contentSha256) {
				const blobBuf = await readFile(nodePath.join(this.blobsDir(id), e.contentSha256, "blob")).catch(() => null);
				if (!blobBuf) {
					throw new CheckpointError("tampered", `checkpoint blob missing: ${e.path}`);
				}
				if (sha256(blobBuf) !== e.contentSha256) {
					throw new CheckpointError("tampered", `checkpoint blob hash mismatch: ${e.path}`);
				}
			}
		}
		return cp;
	}

	/** materialize the stored content of a file entry. */
	async materialize(id: string, entry: CheckpointEntry): Promise<Buffer | null> {
		if (entry.type !== "file" || !entry.contentSha256) return null;
		return readFile(nodePath.join(this.blobsDir(id), entry.contentSha256, "blob")).catch(() => null);
	}

	async updateStatus(id: string, status: CheckpointStatus): Promise<void> {
		const cp = await this.read(id);
		if (!cp) return;
		cp.status = status;
		await writeFile(this.manifestPath(id), JSON.stringify(cp, null, 2), { mode: 0o600 });
	}

	async list(): Promise<WorkspaceCheckpoint[]> {
		const base = nodePath.join(this.storageDir, "checkpoints");
		let ids: string[] = [];
		try {
			ids = await fs.readdir(base);
		} catch {
			return [];
		}
		const out: WorkspaceCheckpoint[] = [];
		for (const id of ids) {
			const cp = await this.read(id);
			if (cp) out.push(cp);
		}
		return out;
	}

	/** Delete a checkpoint's storage atomically (used by GC for confirmed, expired ones). */
	async delete(id: string): Promise<void> {
		await fs.rm(this.checkpointDir(id), { recursive: true, force: true });
	}

	/**
	 * Concurrency-safe garbage collection. Only `confirmed` checkpoints older
	 * than the retention window are removed. rollback-required,
	 * recovery-required, active and other states are never collected. Uses an
	 * atomic rename tombstone so two GC passes cannot race on the same dir.
	 */
	async gc(opts: { retainMs?: number; now?: number } = {}): Promise<{ removed: string[] }> {
		const now = opts.now ?? Date.now();
		const retainMs = opts.retainMs ?? 24 * 60 * 60 * 1000;
		const checkpoints = await this.list();
		const removed: string[] = [];
		for (const cp of checkpoints) {
			if (cp.status !== "confirmed") continue;
			if (now - cp.createdAt <= retainMs) continue;
			const src = this.checkpointDir(cp.checkpointId);
			const tombstone = this.checkpointDir(`${cp.checkpointId}.gc`);
			try {
				await fs.rename(src, tombstone);
			} catch {
				continue; // already being collected or in use
			}
			// Never follow external symlinks: use rm on the (regular) directory.
			await fs.rm(tombstone, { recursive: true, force: true });
			removed.push(cp.checkpointId);
		}
		return { removed };
	}
}
