import { readdir, readFile } from "node:fs/promises";
import { cpus, freemem, hostname, loadavg, totalmem } from "node:os";
import type { BackgroundJobOwnership, BackgroundJobRecord, BackgroundJobRegistry } from "../jobs/index.js";

export type ProcessStewardshipClassification =
	| "owned_alive"
	| "stale_owned"
	| "unknown_ownership"
	| "not_owned"
	| "identity_mismatch"
	| "terminal";

export interface ProcessStewardshipOwner {
	ownerKind: string;
	ownerId: string;
}

export interface ProcessStewardshipResult {
	jobId: string;
	classification: ProcessStewardshipClassification;
	record: BackgroundJobRecord;
	reason?: string;
}

export interface HostResourceSnapshot {
	capturedAtMs: number;
	host: string;
	platform: NodeJS.Platform;
	cpuCount: number;
	loadAverage: readonly [number, number, number];
	totalMemoryBytes: number;
	freeMemoryBytes: number;
	availableMemoryBytes?: number;
	memoryPressureRatio?: number;
	processCount?: number;
	jensenOwnedProcessCount?: number;
	staleJensenOwnedProcessCount?: number;
}

export type HostPressureClassification = "NORMAL" | "ELEVATED" | "CRITICAL" | "LEAK_SUSPECTED" | "UNKNOWN";

export interface CleanupResult {
	action: "stopped" | "skipped";
	reason: string;
	record?: BackgroundJobRecord;
}

function sameOwner(ownership: BackgroundJobOwnership | undefined, owner: ProcessStewardshipOwner): boolean {
	return ownership?.ownerKind === owner.ownerKind && ownership.ownerId === owner.ownerId;
}

/**
 * Reconcile only jobs belonging to the supplied authority. Missing ownership
 * metadata is deliberately unknown, not implicitly owned by the caller.
 */
export async function reconcileOwnedProcesses(
	registry: BackgroundJobRegistry,
	owner: ProcessStewardshipOwner,
): Promise<ProcessStewardshipResult[]> {
	const records = await registry.list();
	const results: ProcessStewardshipResult[] = [];
	for (const record of records) {
		if (!record.ownership) {
			results.push({ jobId: record.jobId, classification: "unknown_ownership", record });
			continue;
		}
		if (!sameOwner(record.ownership, owner)) {
			results.push({ jobId: record.jobId, classification: "not_owned", record });
			continue;
		}
		if (["stopped", "exited", "failed"].includes(record.state)) {
			results.push({ jobId: record.jobId, classification: "terminal", record });
			continue;
		}
		const status = await registry.status(record.jobId);
		if (status?.kind === "recorded_running_and_alive") {
			results.push({ jobId: record.jobId, classification: "owned_alive", record: status.record });
		} else if (status?.kind === "recorded_running_but_missing") {
			results.push({ jobId: record.jobId, classification: "stale_owned", record: status.record });
		} else {
			results.push({
				jobId: record.jobId,
				classification: "identity_mismatch",
				record: status?.record ?? record,
				reason: status?.kind ?? "status_unavailable",
			});
		}
	}
	return results;
}

/**
 * Cleanup seam for a future supervisor. It is intentionally narrow and
 * fail-closed: ownership must match exactly before the registry can stop a job.
 */
export async function cleanupOwnedProcess(
	registry: BackgroundJobRegistry,
	jobId: string,
	owner: ProcessStewardshipOwner,
): Promise<CleanupResult> {
	const record = await registry.read(jobId);
	if (!record) return { action: "skipped", reason: "job_not_found" };
	if (!record.ownership) return { action: "skipped", reason: "unknown_ownership" };
	if (!sameOwner(record.ownership, owner)) return { action: "skipped", reason: "not_owned" };
	const stopped = await registry.stop(jobId);
	return stopped
		? { action: "stopped", reason: "owned_process_cleanup_requested", record: stopped }
		: { action: "skipped", reason: "job_not_found" };
}

export interface HostResourceSnapshotOptions {
	/** Linux proc fixture root; defaults to /proc. */
	procRoot?: string;
	/** Platform override for deterministic fixture tests. */
	platform?: NodeJS.Platform;
	/** Directory reader seam; no process or command execution is performed. */
	readDirectory?: (path: string) => Promise<string[]>;
	/** UTF-8 file reader seam for deterministic /proc/meminfo fixtures. */
	readFile?: (path: string) => Promise<string>;
}

/** Count numeric Linux /proc entries without invoking ps or another process. */
export async function countLinuxProcesses(
	procRoot = "/proc",
	readDirectory: (path: string) => Promise<string[]> = readdir,
	platform: NodeJS.Platform = process.platform,
): Promise<number | undefined> {
	if (platform !== "linux") return undefined;
	try {
		const entries = await readDirectory(procRoot);
		return entries.filter((entry) => /^\d+$/u.test(entry)).length;
	} catch {
		return undefined;
	}
}

async function availableMemoryBytes(
	procRoot = "/proc",
	readFileUtf8: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
	platform: NodeJS.Platform = process.platform,
): Promise<number | undefined> {
	if (platform !== "linux") return undefined;
	try {
		const content = await readFileUtf8(`${procRoot}/meminfo`);
		const match = content.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
		return match ? Number(match[1]) * 1024 : undefined;
	} catch {
		return undefined;
	}
}

/** Capture host-only resource facts; no process or command execution occurs. */
export async function captureHostResourceSnapshot(
	now = Date.now(),
	options: HostResourceSnapshotOptions = {},
): Promise<HostResourceSnapshot> {
	const platform = options.platform ?? process.platform;
	const totalMemoryBytes = totalmem();
	const freeMemoryBytes = freemem();
	const available = await availableMemoryBytes(options.procRoot, options.readFile, platform);
	const processCount = await countLinuxProcesses(options.procRoot, options.readDirectory, platform);
	const memoryPressureRatio =
		available !== undefined && totalMemoryBytes > 0
			? Math.min(1, Math.max(0, 1 - available / totalMemoryBytes))
			: undefined;
	const averages = loadavg();
	return {
		capturedAtMs: now,
		host: hostname(),
		platform,
		cpuCount: Math.max(1, cpus().length),
		loadAverage: [averages[0] ?? 0, averages[1] ?? 0, averages[2] ?? 0],
		totalMemoryBytes,
		freeMemoryBytes,
		availableMemoryBytes: available,
		memoryPressureRatio,
		processCount,
	};
}

/**
 * Classify only measured memory pressure. Missing telemetry is UNKNOWN; it is
 * never converted into permission to clean up processes.
 */
export function classifyHostPressure(
	snapshot: HostResourceSnapshot,
	thresholds: { elevatedMemoryPressureRatio?: number; criticalMemoryPressureRatio?: number; leakCount?: number } = {},
): HostPressureClassification {
	const ratio = snapshot.memoryPressureRatio;
	if (ratio === undefined || !Number.isFinite(ratio)) return "UNKNOWN";
	if ((thresholds.leakCount ?? 1) <= (snapshot.staleJensenOwnedProcessCount ?? 0)) return "LEAK_SUSPECTED";
	if (ratio >= (thresholds.criticalMemoryPressureRatio ?? 0.95)) return "CRITICAL";
	if (ratio >= (thresholds.elevatedMemoryPressureRatio ?? 0.8)) return "ELEVATED";
	return "NORMAL";
}
