import { randomUUID } from "node:crypto";
import fs, { chmod, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import nodePath from "node:path";
import type { WorkspaceBoundary } from "./boundary.js";
import { type CheckpointEntry, type CheckpointStore, sha256 } from "./checkpoint.js";
import type { ExecutionMode, PolicyDecision, RecoveryClass, RollbackCapability, TransactionId } from "./types.js";

export type WorkspaceEdit =
	| { kind: "create_file"; path: string; content: string }
	| { kind: "replace_file"; path: string; content: string; expectedSha256?: string }
	| { kind: "delete_file"; path: string }
	| { kind: "create_directory"; path: string }
	| { kind: "delete_directory"; path: string };

export interface ValidationGate {
	id: string;
	/** command identity / human label */
	label: string;
	run: (() => Promise<{ exitCode: number; outputArtifact: string }>) | null;
}

export type TransactionStage =
	| "prepared"
	| "checkpointed"
	| "applied"
	| "validating"
	| "validated"
	| "confirmed"
	| "rolled_back"
	| "recovery_required";

export interface TransactionRecord {
	transactionId: TransactionId;
	workspaceId: string;
	runId?: string;
	mode: ExecutionMode;
	createdAt: number;
	policy: PolicyDecision | null;
	checkpointId?: string;
	stage: TransactionStage;
	appliedPaths: string[];
	/** sha of the transaction-intended post-state per path. */
	appliedSha: Record<string, string | null>;
	output?: {
		created: string[];
		modified: string[];
		deleted: string[];
		bytesChanged: number;
	};
	validation?: {
		command: string;
		exitCode: number;
		outputArtifact: string;
		durationMs: number;
		timedOut: boolean;
		aborted: boolean;
		result: "passed" | "failed" | "skipped" | "timed_out" | "aborted";
	};
	rollbackCapability: RollbackCapability;
}

export interface ApplyResult {
	changed: { path: string; sha256: string | null }[];
	bytesChanged: number;
}

export interface RollbackResult {
	status: "rolled_back" | "conflict" | "nothing_to_do";
	conflicts: RollbackConflict[];
	restored: string[];
}

export interface RollbackConflict {
	path: string;
	expectedTransactionSha: string | null;
	currentSha: string;
	checkpointSha: string | null;
	message: string;
}

export class TransactionError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
		this.name = "TransactionError";
	}
}

/**
 * Transactional edit batches over the workspace.
 *
 * Lifecycle: begin → checkpoint → apply → validate → confirm | rollback →
 * release. All target paths are resolved/validated up-front. Partial apply
 * triggers rollback. Validation gates run before confirmation and failed
 * validation rolls back (rollback is idempotent). Drift caused by unrelated
 * post-transaction user edits is reported as a structured conflict rather than
 * silently overwritten.
 */
export class WorkspaceTransactionManager {
	readonly storageDir: string;
	private readonly boundary: WorkspaceBoundary;
	private readonly checkpoints: CheckpointStore;

	constructor(storageDir: string, boundary: WorkspaceBoundary, checkpoints: CheckpointStore) {
		this.storageDir = storageDir;
		this.boundary = boundary;
		this.checkpoints = checkpoints;
	}

	private txPath(id: string): string {
		return nodePath.join(this.storageDir, "transactions", `${id}.json`);
	}

	async begin(
		workspaceId: string,
		opts: {
			runId?: string;
			mode: ExecutionMode;
			policy: PolicyDecision | null;
			rollbackCapability?: RollbackCapability;
		},
	): Promise<TransactionRecord> {
		const record: TransactionRecord = {
			transactionId: randomUUID(),
			workspaceId,
			runId: opts.runId,
			mode: opts.mode,
			createdAt: Date.now(),
			policy: opts.policy,
			stage: "prepared",
			appliedPaths: [],
			appliedSha: {},
			rollbackCapability: opts.rollbackCapability ?? "full",
		};
		await fs.mkdir(nodePath.dirname(this.txPath(record.transactionId)), { recursive: true });
		await this.persist(record);
		return record;
	}

	/** Plan-mode preview: reports intended effect with zero physical mutation. */
	async preview(edits: WorkspaceEdit[]): Promise<{
		created: string[];
		modified: string[];
		deleted: string[];
		bytesChanged: number;
	}> {
		const created: string[] = [];
		const modified: string[] = [];
		const deleted: string[] = [];
		let bytesChanged = 0;
		for (const e of edits) {
			await this.boundary.resolveWithin(e.path);
			if (e.kind === "create_file") {
				created.push(e.path);
				bytesChanged += Buffer.byteLength(e.content);
			} else if (e.kind === "replace_file") {
				modified.push(e.path);
				bytesChanged += Buffer.byteLength(e.content);
			} else if (e.kind === "delete_file" || e.kind === "delete_directory") {
				deleted.push(e.path);
			} else if (e.kind === "create_directory") {
				created.push(e.path);
			}
		}
		return { created, modified, deleted, bytesChanged };
	}

	async resolvePaths(edits: WorkspaceEdit[]): Promise<string[]> {
		const out: string[] = [];
		for (const e of edits) {
			out.push(await this.boundary.resolveWithin(e.path));
			out.push(await this.boundary.resolveWithin(nodePath.dirname(e.path)));
		}
		return [...new Set(out)];
	}

	async checkpoint(record: TransactionRecord, editPaths: string[]): Promise<string> {
		const cp = await this.checkpoints.create(record.workspaceId, record.transactionId, editPaths, record.runId);
		record.checkpointId = cp.checkpointId;
		record.stage = "checkpointed";
		await this.persist(record);
		return cp.checkpointId;
	}

	/**
	 * Apply a batch of edits deterministically. Order: create_directory first,
	 * then create_file/replace_file, then delete_file, then delete_directory.
	 * Returns hash results. Drift/expectedSha preconditions abort safely.
	 */
	async apply(record: TransactionRecord, edits: WorkspaceEdit[]): Promise<ApplyResult> {
		const absEdits: { e: WorkspaceEdit; abs: string }[] = [];
		for (const e of edits) {
			absEdits.push({ e, abs: await this.boundary.resolveWithin(e.path) });
		}
		const byKind = {
			create_directory: [] as typeof absEdits,
			files: [] as typeof absEdits,
			delete: [] as typeof absEdits,
		};
		for (const x of absEdits) {
			if (x.e.kind === "create_directory") byKind.create_directory.push(x);
			else if (x.e.kind === "delete_file" || x.e.kind === "delete_directory") byKind.delete.push(x);
			else byKind.files.push(x);
		}
		const changed: ApplyResult["changed"] = [];
		let bytesChanged = 0;
		try {
			const create = async (x: { e: WorkspaceEdit; abs: string }) => {
				await this.boundary.assertParentWithin(x.abs);
				await writeFile(x.abs, (x.e as { content: string }).content, { encoding: "utf-8", flag: "wx" });
				const content = (x.e as { content: string }).content;
				bytesChanged += Buffer.byteLength(content);
				changed.push({ path: x.abs, sha256: sha256(content) });
				record.appliedSha[x.abs] = sha256(content);
			};
			const replace = async (x: { e: WorkspaceEdit; abs: string }) => {
				const e = x.e as { kind: "replace_file"; path: string; content: string; expectedSha256?: string };
				await this.boundary.assertParentWithin(x.abs);
				if (e.expectedSha256) {
					const cur = await readFile(x.abs).catch(() => null);
					if (cur && sha256(cur) !== e.expectedSha256) {
						throw new TransactionError("drift", `precondition hash mismatch for ${x.abs}`);
					}
				}
				await writeFile(x.abs, e.content, { encoding: "utf-8", flag: "w" });
				bytesChanged += Buffer.byteLength(e.content);
				changed.push({ path: x.abs, sha256: sha256(e.content) });
				record.appliedSha[x.abs] = sha256(e.content);
			};
			const del = async (x: { e: WorkspaceEdit; abs: string }) => {
				await this.boundary.assertParentWithin(x.abs);
				await rm(x.abs, { recursive: true, force: true });
				changed.push({ path: x.abs, sha256: null });
				record.appliedSha[x.abs] = null;
			};
			for (const x of byKind.create_directory) {
				await this.boundary.assertParentWithin(x.abs);
				await mkdir(x.abs, { recursive: true });
				changed.push({ path: x.abs, sha256: null });
				record.appliedSha[x.abs] = null;
			}
			for (const x of byKind.files) {
				if (x.e.kind === "create_file") await create(x);
				else await replace(x);
			}
			for (const x of byKind.delete) await del(x);
		} catch (err) {
			// Partial application: roll back.
			record.appliedPaths = changed.map((c) => c.path);
			await this.rollback(record).catch(() => {});
			throw err;
		}
		record.stage = "applied";
		record.appliedPaths = changed.map((c) => c.path);
		record.output = {
			created: edits.filter((e) => e.kind === "create_file").map((e) => e.path),
			modified: edits.filter((e) => e.kind === "replace_file").map((e) => e.path),
			deleted: edits.filter((e) => e.kind === "delete_file" || e.kind === "delete_directory").map((e) => e.path),
			bytesChanged,
		};
		await this.persist(record);
		return { changed, bytesChanged };
	}

	async validate(record: TransactionRecord, gate: ValidationGate): Promise<TransactionRecord> {
		if (!gate.run) {
			record.validation = {
				command: gate.label,
				exitCode: 0,
				outputArtifact: "",
				durationMs: 0,
				timedOut: false,
				aborted: false,
				result: "skipped",
			};
			return record;
		}
		record.stage = "validating";
		const started = Date.now();
		let exitCode = 1;
		let outputArtifact = "";
		let aborted = false;
		const timedOut = false;
		try {
			const r = await gate.run();
			exitCode = r.exitCode;
			outputArtifact = r.outputArtifact;
		} catch {
			aborted = true;
		}
		record.validation = {
			command: gate.label,
			exitCode,
			outputArtifact,
			durationMs: Date.now() - started,
			timedOut,
			aborted,
			result: aborted ? "aborted" : exitCode === 0 ? "passed" : "failed",
		};
		return record;
	}

	async confirm(record: TransactionRecord): Promise<void> {
		if (record.validation && record.validation.result !== "passed" && record.validation.result !== "skipped") {
			record.stage = "recovery_required";
			await this.persist(record);
			throw new TransactionError("validation_failed", "cannot confirm a transaction whose validation did not pass");
		}
		record.stage = "confirmed";
		await this.persist(record);
		if (record.checkpointId) await this.checkpoints.updateStatus(record.checkpointId, "confirmed");
	}

	async persist(record: TransactionRecord): Promise<void> {
		await writeFile(this.txPath(record.transactionId), JSON.stringify(record, null, 2), { mode: 0o600 });
	}

	async read(id: TransactionId): Promise<TransactionRecord | null> {
		try {
			return JSON.parse(await readFile(this.txPath(id), "utf-8")) as TransactionRecord;
		} catch {
			return null;
		}
	}

	async list(): Promise<TransactionRecord[]> {
		const base = nodePath.join(this.storageDir, "transactions");
		let names: string[] = [];
		try {
			names = await fs.readdir(base);
		} catch {
			return [];
		}
		const out: TransactionRecord[] = [];
		for (const n of names) {
			if (!n.endsWith(".json")) continue;
			const rec = await this.read(n.slice(0, -5));
			if (rec) out.push(rec);
		}
		out.sort((a, b) => b.createdAt - a.createdAt);
		return out;
	}

	/**
	 * Drift-aware rollback. Restores prior state from the checkpoint without
	 * overwriting unrelated post-transaction user changes.
	 */
	async rollback(record: TransactionRecord): Promise<RollbackResult> {
		if (!record.checkpointId) return { status: "nothing_to_do", conflicts: [], restored: [] };
		const cp = await this.checkpoints.verify(record.checkpointId);
		const conflicts: RollbackConflict[] = [];
		const restored: string[] = [];
		// Restore only the top-level target paths; ignore parent-metadata dirs.
		const targets = cp.entries.filter((e) => record.appliedPaths.includes(e.path));
		const targetSet = new Set(targets.map((t) => t.path));
		const restoreEntry = async (entry: CheckpointEntry) => {
			const abs = entry.path;
			await this.boundary.assertParentWithin(abs);
			const current = await readFile(abs).catch(() => null);
			const currentSha = current ? sha256(current) : null;
			const applied = record.appliedSha[abs] ?? null;
			// If the transaction intended a different state than what's there now,
			// and what's there now isn't the transaction's own state, it's user drift.
			if (entry.type === "file" && entry.existed) {
				if (current !== null && applied !== null && currentSha !== applied) {
					// Somebody changed it after the transaction wrote `applied`.
					// Only restore if current still equals the transaction's write.
					conflicts.push({
						path: abs,
						expectedTransactionSha: applied as string,
						currentSha: currentSha as string,
						checkpointSha: entry.contentSha256 ?? null,
						message: "post-transaction user edit detected; refusing to overwrite",
					});
					return;
				}
				const content = await this.checkpoints.materialize(cp.checkpointId, entry);
				if (content !== null) {
					await writeFile(abs, content, { flag: "w" });
				} else {
					await unlink(abs).catch(() => {});
				}
				if (entry.mode) await chmod(abs, entry.mode).catch(() => {});
				restored.push(abs);
			} else if (entry.type === "missing" && !entry.existed) {
				// Transaction created it; remove it unless user modified afterwards.
				if (current !== null && applied !== null && currentSha !== applied && currentSha !== null) {
					conflicts.push({
						path: abs,
						expectedTransactionSha: applied,
						currentSha,
						checkpointSha: null,
						message: "transaction-created file modified by user; refusing to delete",
					});
					return;
				}
				await rm(abs, { recursive: true, force: true }).catch(() => {});
				restored.push(abs);
			} else if (entry.type === "symlink") {
				await unlink(abs).catch(() => {});
				if (entry.symlinkTarget) await symlink(entry.symlinkTarget, abs).catch(() => {});
				restored.push(abs);
			} else if (entry.type === "directory" && entry.existed) {
				// restore nothing; dirs removed by transaction are recreated
				await mkdir(abs, { recursive: true }).catch(() => {});
			}
		};
		for (const entry of cp.entries) {
			if (targetSet.has(entry.path)) await restoreEntry(entry);
		}
		if (conflicts.length > 0) {
			record.stage = "recovery_required";
			await this.persist(record);
			return { status: "conflict", conflicts, restored };
		}
		record.stage = "rolled_back";
		await this.persist(record);
		if (record.checkpointId) await this.checkpoints.updateStatus(record.checkpointId, "rolled_back");
		return { status: "rolled_back", conflicts, restored };
	}

	/** Classify an interrupted transaction at startup/resume. */
	async classify(id: TransactionId): Promise<RecoveryClass> {
		const rec = await this.read(id);
		if (!rec) return "not_found";
		if (rec.stage === "confirmed") return "already_confirmed";
		if (rec.stage === "rolled_back") return "already_rolled_back";
		if (!rec.checkpointId) return "safe_to_resume_apply";
		const cp = await this.checkpoints.read(rec.checkpointId);
		if (!cp) return "manual_conflict";
		switch (rec.stage) {
			case "checkpointed":
			case "validated":
				return "safe_to_resume_apply";
			case "applied":
			case "validating":
				return "validation_required";
			default:
				return "rollback_required";
		}
	}
}
