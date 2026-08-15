/**
 * File Assignment Store (2.11.0).
 *
 * Local durable implementation of the AssignmentStore port. One small record
 * file per assignment, schema-validated on load, written atomically
 * (unique temp + fsync + rename). The "current assignment" flag lives on the
 * record itself, so there is no separate mutable pointer file to drift.
 *
 * Cross-process model:
 *   - All mutations for a mission serialize on a per-mission proper-lockfile
 *     lock. Two processes racing `assign M→A` vs `assign M→B` therefore have
 *     exactly one winner; the loser sees the winner's current assignment and
 *     returns a structured conflict instead of writing a second current.
 *   - Unrelated missions lock different paths, so they never globally
 *     serialize.
 *   - Record writes are atomic per file. The service transitions old→non-current
 *     BEFORE writing new→current, so a crash can leave zero current records for
 *     a mission, but never two.
 */

import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import lockfile from "proper-lockfile";
import { isSafeMissionId } from "../mission-domain/durable-store.js";
import {
	type AssignmentLoadResult,
	type AssignmentMutateResult,
	type AssignmentMutation,
	type AssignmentStore,
	type MissionAssignmentIndex,
	parseAssignmentRecord,
} from "./assignment-store.js";
import { AssignmentError, type AssignmentRecord, isSafeAssignmentId } from "./assignment-types.js";

const RECORD_SUFFIX = ".assignment.json";
const ATOMIC_SUFFIX = ".tmp";

const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_RETRIES = 8;
const DEFAULT_LOCK_MIN_TIMEOUT_MS = 20;
const DEFAULT_LOCK_MAX_TIMEOUT_MS = 250;

export interface FileAssignmentStoreOptions {
	root: string;
	storeId?: string;
	lockStaleMs?: number;
	lockRetries?: number;
	lockMinTimeoutMs?: number;
	lockMaxTimeoutMs?: number;
}

export function defaultAssignmentRoot(): string {
	const env = process.env.JENSEN_ASSIGNMENT_REGISTRY_DIR;
	if (env?.trim()) return env.trim();
	return path.join(os.homedir(), ".jensen", "agent", "assignment-registry");
}

export class FileAssignmentStore implements AssignmentStore {
	readonly storeId: string;
	private readonly root: string;
	private readonly lockStaleMs: number;
	private readonly lockRetries: number;
	private readonly lockMinTimeoutMs: number;
	private readonly lockMaxTimeoutMs: number;

	constructor(options: FileAssignmentStoreOptions) {
		this.root = path.resolve(options.root);
		this.storeId = options.storeId ?? "file";
		this.lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
		this.lockRetries = options.lockRetries ?? DEFAULT_LOCK_RETRIES;
		this.lockMinTimeoutMs = options.lockMinTimeoutMs ?? DEFAULT_LOCK_MIN_TIMEOUT_MS;
		this.lockMaxTimeoutMs = options.lockMaxTimeoutMs ?? DEFAULT_LOCK_MAX_TIMEOUT_MS;
	}

	private resolve(assignmentId: string): string {
		return path.join(this.root, `${assignmentId}${RECORD_SUFFIX}`);
	}

	private assertAssignmentId(assignmentId: string): void {
		if (!isSafeAssignmentId(assignmentId)) {
			throw new AssignmentError("ASSIGNMENT_CORRUPT", `Unsafe assignment id: ${assignmentId}`, { assignmentId });
		}
	}

	private assertMissionId(missionId: string): void {
		if (!isSafeMissionId(missionId)) {
			throw new AssignmentError("MISSION_NOT_ASSIGNABLE", `Unsafe mission id: ${missionId}`, { missionId });
		}
	}

	private assertRecordMission(record: AssignmentRecord, missionId: string): void {
		if (record.missionId !== missionId) {
			throw new Error(`Assignment ${record.assignmentId} belongs to mission ${record.missionId}, not ${missionId}`);
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

	private async readRaw(assignmentId: string): Promise<string | undefined> {
		try {
			return await fsp.readFile(this.resolve(assignmentId), "utf8");
		} catch {
			return undefined;
		}
	}

	private async withMissionLock<T>(missionId: string, fn: () => Promise<T>): Promise<T> {
		this.assertMissionId(missionId);
		await fsp.mkdir(this.root, { recursive: true });
		const target = path.join(this.root, missionId);

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
				throw new AssignmentError(
					"ASSIGNMENT_LOCK_TIMEOUT",
					`Timed out acquiring assignment mutation lock for mission ${missionId}`,
					{ missionId },
				);
			}
			if (code === "ENOTEMPTY" || code === "ENOTDIR") {
				throw new AssignmentError(
					"ASSIGNMENT_CORRUPT",
					`Corrupt assignment mutation lock metadata for mission ${missionId}`,
					{ missionId },
				);
			}
			throw error;
		}

		try {
			if (compromised) {
				throw new AssignmentError(
					"ASSIGNMENT_CORRUPT",
					`Assignment mutation lock for mission ${missionId} was compromised`,
					{ missionId },
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
		assignmentId: string,
	): Promise<{ status: "ok"; record: AssignmentRecord } | { status: "missing" } | { status: "corrupt" }> {
		const raw = await this.readRaw(assignmentId);
		if (raw === undefined) return { status: "missing" };
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return { status: "corrupt" };
		}
		const result = parseAssignmentRecord(parsed);
		if (!result.ok) return { status: "corrupt" };
		return { status: "ok", record: result.record };
	}

	private async readIndexForMission(
		missionId: string,
	): Promise<{ status: "ok"; index: MissionAssignmentIndex } | { status: "corrupt"; diagnostic: string }> {
		const ids = await this.listAssignments();
		const records: AssignmentRecord[] = [];
		for (const id of ids) {
			const loaded = await this.readParsed(id);
			if (loaded.status === "corrupt") {
				return { status: "corrupt", diagnostic: `assignment ${id} is corrupt` };
			}
			if (loaded.status === "ok" && loaded.record.missionId === missionId) {
				records.push(loaded.record);
			}
		}
		records.sort((a, b) => a.createdAtMs - b.createdAtMs || (a.assignmentId < b.assignmentId ? -1 : 1));
		const current = records.find((record) => record.current);
		return { status: "ok", index: { missionId, records, current } };
	}

	private async writeRecords(missionId: string, records: AssignmentRecord[]): Promise<void> {
		for (const record of records) {
			this.assertRecordMission(record, missionId);
			this.assertAssignmentId(record.assignmentId);
			const validation = parseAssignmentRecord(record);
			if (!validation.ok) {
				throw new Error(`Mutation produced an invalid record for ${record.assignmentId}: ${validation.diagnostic}`);
			}
			await this.writeAtomic(this.resolve(record.assignmentId), JSON.stringify(record, null, 2));
		}
	}

	// =========================================================================
	// AssignmentStore
	// =========================================================================

	async load(assignmentId: string): Promise<AssignmentLoadResult> {
		this.assertAssignmentId(assignmentId);
		const raw = await this.readRaw(assignmentId);
		if (raw === undefined) return { status: "missing" };

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return { status: "corrupt", assignmentId, diagnostic: "record is not valid JSON" };
		}
		const result = parseAssignmentRecord(parsed);
		if (!result.ok) {
			return { status: "corrupt", assignmentId, diagnostic: result.diagnostic };
		}
		return { status: "ok", record: result.record };
	}

	async listAssignments(): Promise<string[]> {
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
			if (isSafeAssignmentId(id)) ids.push(id);
		}
		return ids.sort();
	}

	async listRecords(): Promise<{
		records: AssignmentRecord[];
		corrupt: { assignmentId: string; diagnostic: string }[];
	}> {
		const ids = await this.listAssignments();
		const records: AssignmentRecord[] = [];
		const corrupt: { assignmentId: string; diagnostic: string }[] = [];
		for (const id of ids) {
			const loaded = await this.load(id);
			if (loaded.status === "ok") records.push(loaded.record);
			else if (loaded.status === "corrupt") corrupt.push({ assignmentId: id, diagnostic: loaded.diagnostic });
		}
		return { records, corrupt };
	}

	async mutate<T>(
		missionId: string,
		mutation: (index: MissionAssignmentIndex) => AssignmentMutation<T>,
	): Promise<AssignmentMutateResult<T>> {
		this.assertMissionId(missionId);

		return this.withMissionLock(missionId, async () => {
			const read = await this.readIndexForMission(missionId);
			if (read.status === "corrupt") {
				return { status: "corrupt", diagnostic: read.diagnostic };
			}

			const output = mutation(read.index);
			if (output.kind === "noop") return { status: "ok", value: output.value };

			// History is never deleted: every previously-persisted record must still
			// be present in the replacement set. New records may be appended.
			const existingIds = new Set(read.index.records.map((r) => r.assignmentId));
			for (const record of output.records) {
				existingIds.delete(record.assignmentId);
			}
			if (existingIds.size > 0) {
				throw new Error(
					`Mutation for mission ${missionId} dropped historical assignments: ${[...existingIds].join(", ")}`,
				);
			}

			// Defense in depth: exactly one current assignment for the mission.
			const currentRecords = output.records.filter((record) => record.current);
			if (currentRecords.length > 1) {
				throw new Error(`Mutation for mission ${missionId} produced ${currentRecords.length} current assignments`);
			}

			await this.writeRecords(missionId, output.records);
			return { status: "ok", value: output.value };
		});
	}
}

/** Convenience factory using the default Jensen assignment registry directory. */
export function createFileAssignmentStore(root: string = defaultAssignmentRoot()): FileAssignmentStore {
	return new FileAssignmentStore({ root });
}
