import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import nodePath from "node:path";
import { identityMatches, readProcessIdentity } from "./process-identity.js";
import type {
	AdoptionEvidence,
	BackgroundJobEvent,
	BackgroundJobRecord,
	BackgroundJobState,
	JobLogsRequest,
	JobLogsResult,
	JobStatusClassification,
} from "./types.js";

const DEFAULT_MAX_LOG_BYTES = 2 * 1024 * 1024; // 2 MiB per stream
const SECRET_ARG_RE = /(--[a-z0-9_-]*=?|-[a-z]=?)(.*)/i;
const SECRET_TOKENS = ["token", "secret", "password", "passwd", "api_key", "apikey", "authorization", "auth", "key"];

function sanitizeArgs(args: string[]): string[] {
	return args.map((a) => {
		const m = a.match(SECRET_ARG_RE);
		if (m && SECRET_TOKENS.some((t) => m[1].toLowerCase().includes(t)) && m[2]) {
			return `${m[1]}${m[1].endsWith("=") ? "" : " "}<redacted>`;
		}
		return a;
	});
}

export interface StartJobOptions {
	jobId?: string;
	executable: string;
	args?: string[];
	cwd?: string;
	workspaceId?: string;
	ownerRunId?: string;
	env?: Record<string, string>;
	restartPolicy?: string;
	startupTimeoutMs?: number;
	healthCheck?: () => Promise<boolean> | boolean;
	maxLogBytes?: number;
}

export interface BackgroundJobRegistryOptions {
	storageDir: string;
	workspaceId?: string;
	ownerRunId?: string;
	now?: () => number;
	isWindows?: boolean;
}

/**
 * Durable, authoritative background-job registry. Jobs are recorded before or
 * atomically with launch, owned through process-tree/group primitives, stopped
 * only after identity verification, and never kill unrelated processes.
 */
export class BackgroundJobRegistry {
	private readonly storageDir: string;
	private readonly jobsDir: string;
	private readonly logDir: string;
	private readonly eventsPath: string;
	private readonly workspaceId?: string;
	private readonly ownerRunId?: string;
	private readonly now: () => number;
	private readonly isWindows: boolean;
	private readonly running = new Map<string, { kill: () => void; exited: Promise<void> }>();

	constructor(opts: BackgroundJobRegistryOptions) {
		this.storageDir = opts.storageDir;
		this.workspaceId = opts.workspaceId;
		this.ownerRunId = opts.ownerRunId;
		this.now = opts.now ?? (() => Date.now());
		this.isWindows = opts.isWindows ?? process.platform === "win32";
		this.jobsDir = nodePath.join(this.storageDir, "jobs");
		this.logDir = nodePath.join(this.storageDir, "job-logs");
		this.eventsPath = nodePath.join(this.storageDir, "job-events.jsonl");
	}

	private recordPath(jobId: string): string {
		return nodePath.join(this.jobsDir, `${jobId}.json`);
	}

	private stdoutPath(jobId: string): string {
		return nodePath.join(this.logDir, `${jobId}.stdout.log`);
	}

	private stderrPath(jobId: string): string {
		return nodePath.join(this.logDir, `${jobId}.stderr.log`);
	}

	async init(): Promise<void> {
		await mkdir(this.jobsDir, { recursive: true });
		await mkdir(this.logDir, { recursive: true });
	}

	private async appendEvent(ev: BackgroundJobEvent): Promise<void> {
		await mkdir(nodePath.dirname(this.eventsPath), { recursive: true });
		await writeFile(this.eventsPath, `${JSON.stringify(ev)}\n`, { flag: "a" }).catch(() => {});
	}

	private async persist(record: BackgroundJobRecord): Promise<void> {
		await mkdir(this.jobsDir, { recursive: true });
		await writeFile(this.recordPath(record.jobId), JSON.stringify(record, null, 2), { mode: 0o600 });
	}

	async read(jobId: string): Promise<BackgroundJobRecord | null> {
		try {
			const raw = await readFile(this.recordPath(jobId), "utf-8");
			return JSON.parse(raw) as BackgroundJobRecord;
		} catch {
			return null;
		}
	}

	async list(): Promise<BackgroundJobRecord[]> {
		const { readdir } = await import("node:fs/promises");
		let files: string[] = [];
		try {
			files = await readdir(this.jobsDir);
		} catch {
			return [];
		}
		const out: BackgroundJobRecord[] = [];
		for (const f of files) {
			if (!f.endsWith(".json")) continue;
			const rec = await this.read(f.slice(0, -5));
			if (rec) out.push(rec);
		}
		out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
		return out;
	}

	/** Durable registration before launch. Returns the new record. */
	private async register(options: StartJobOptions): Promise<BackgroundJobRecord> {
		const jobId = options.jobId ?? `job-${randomUUID().slice(0, 12)}`;
		const nowIso = new Date(this.now()).toISOString();
		const record: BackgroundJobRecord = {
			jobId,
			ownerRunId: options.ownerRunId ?? this.ownerRunId,
			workspaceId: options.workspaceId ?? this.workspaceId,
			commandIdentity: [options.executable, ...(options.args ?? [])].join(" "),
			executable: options.executable,
			sanitizedArguments: sanitizeArgs(options.args ?? []),
			cwd: options.cwd ?? process.cwd(),
			processIdentity: "starting",
			startedAt: nowIso,
			state: "starting",
			health: "unknown",
			restartPolicy: options.restartPolicy,
			logArtifactId: jobId,
			restartCount: 0,
		};
		await this.persist(record);
		await this.appendEvent({ event: "BACKGROUND_JOB_REGISTERED", jobId, at: this.now() });
		return record;
	}

	/**
	 * Start a new durable background job. The record is written before launch,
	 * then the process tree is spawned and its identity captured. Returns only
	 * after authoritative startup status is known.
	 */
	async start(options: StartJobOptions): Promise<BackgroundJobRecord> {
		const record = await this.register(options);
		const stdoutPath = this.stdoutPath(record.jobId);
		const stderrPath = this.stderrPath(record.jobId);
		const maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;

		const proc = spawn(options.executable, options.args ?? [], {
			cwd: options.cwd ?? process.cwd(),
			env: options.env ?? process.env,
			detached: !this.isWindows,
			windowsHide: this.isWindows,
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
		});

		const stdout = createWriteStream(stdoutPath, { flags: "a" });
		const stderr = createWriteStream(stderrPath, { flags: "a" });
		let stdoutBytes = 0;
		let stderrBytes = 0;
		proc.stdout?.on("data", (d: Buffer) => {
			if (stdoutBytes < maxLogBytes) {
				stdoutBytes += Math.min(d.length, maxLogBytes - stdoutBytes);
				stdout.write(d.subarray(0, maxLogBytes - (stdoutBytes - d.length)));
			}
		});
		proc.stderr?.on("data", (d: Buffer) => {
			if (stderrBytes < maxLogBytes) {
				stderrBytes += Math.min(d.length, maxLogBytes - stderrBytes);
				stderr.write(d.subarray(0, maxLogBytes - (stderrBytes - d.length)));
			}
		});

		let _settledExit: { code: number | null } | null = null;
		const exited = new Promise<void>((resolve) => {
			proc.once("exit", (code) => {
				_settledExit = { code };
				void this.onExit(record.jobId, code, stdout, stderr).then(resolve);
			});
			proc.once("error", (err) => {
				void this.onError(record.jobId, err, stdout, stderr).then(() => resolve());
			});
		});

		// Capture authoritative identity after spawn.
		const identity = await readProcessIdentity(proc.pid ?? 0).catch(() => null);
		const updated: BackgroundJobRecord = {
			...record,
			processIdentity: String(proc.pid),
			processTreeIdentity: this.isWindows ? undefined : `pgid:${proc.pid}`,
			processStartIdentity: identity?.startIdentity,
			state: "running",
			health: "healthy",
		};
		await this.persist(updated);
		await this.appendEvent({
			event: "BACKGROUND_JOB_STARTED",
			jobId: record.jobId,
			processIdentity: String(proc.pid),
			at: this.now(),
		});

		this.running.set(record.jobId, {
			kill: () => this.killProcess(proc.pid ?? 0, record.jobId),
			exited,
		});

		return updated;
	}

	private async onExit(
		jobId: string,
		code: number | null,
		stdout: NodeJS.WritableStream,
		stderr: NodeJS.WritableStream,
	): Promise<void> {
		stdout.end();
		stderr.end();
		const record = await this.read(jobId);
		if (!record) return;
		const state: BackgroundJobState = code === 0 ? "exited" : "failed";
		const updated: BackgroundJobRecord = { ...record, state, exitCode: code ?? undefined, health: "unknown" };
		await this.persist(updated);
		await this.appendEvent(
			code === 0
				? { event: "BACKGROUND_JOB_EXITED", jobId, exitCode: code ?? 0, at: this.now() }
				: { event: "BACKGROUND_JOB_FAILED", jobId, reason: `exit_code_${code}`, at: this.now() },
		);
		this.running.delete(jobId);
	}

	private async onError(
		jobId: string,
		err: Error,
		stdout: NodeJS.WritableStream,
		stderr: NodeJS.WritableStream,
	): Promise<void> {
		stdout.end();
		stderr.end();
		const record = await this.read(jobId);
		if (!record) return;
		const updated: BackgroundJobRecord = { ...record, state: "failed", health: "unknown" };
		await this.persist(updated);
		await this.appendEvent({ event: "BACKGROUND_JOB_FAILED", jobId, reason: err.message, at: this.now() });
		this.running.delete(jobId);
	}

	private killProcess(pid: number, _jobId: string): void {
		if (this.isWindows) {
			const { execFile } = require("node:child_process") as typeof import("node:child_process");
			execFile("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true }, () => {});
			return;
		}
		try {
			// Kill the process group (negative pid) so owned descendants are
			// terminated, never unrelated processes outside the group.
			process.kill(-pid, "SIGTERM");
		} catch {
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				// already gone
			}
		}
		// Force kill fallback.
		setTimeout(() => {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				/* noop */
			}
		}, 2000);
	}

	/** Classify verified live status of a job, checking real process identity. */
	async status(jobId: string): Promise<JobStatusClassification | null> {
		const record = await this.read(jobId);
		if (!record) return null;
		if (record.state === "stopped" || record.state === "exited" || record.state === "failed") {
			return { kind: "exited_with_code", record, exitCode: record.exitCode ?? 0 };
		}
		const pid = Number(record.processIdentity);
		if (!Number.isFinite(pid) || pid <= 0) return { kind: "adoption_required", record };
		const live = await readProcessIdentity(pid);
		if (!live.alive) {
			return { kind: "recorded_running_but_missing", record };
		}
		const check = identityMatches(live, {
			commandIdentity: record.commandIdentity,
			processStartIdentity: record.processStartIdentity,
		});
		if (!check.match) {
			const updated: BackgroundJobRecord = { ...record, state: "adoption_required", health: "degraded" };
			await this.persist(updated);
			return {
				kind: "process_identity_mismatch",
				record: updated,
				reason: check.reason ?? "identity_mismatch",
				adoptionRequired: true,
			};
		}
		return { kind: "recorded_running_and_alive", record };
	}

	/** Bounded log retrieval. Logs are untrusted content. */
	async logs(req: JobLogsRequest): Promise<JobLogsResult> {
		const tailLines = req.tailLines ?? 200;
		const maxBytes = req.maxBytes ?? 64 * 1024;
		const readTail = async (path: string): Promise<string> => {
			try {
				const content = await readFile(path, "utf-8");
				const sinceSlice = req.since
					? content
							.split("\n")
							.filter((l) => l.length > 0)
							.slice(0)
							.join("\n")
					: content;
				// No timestamp filtering available; cap by bytes then lines.
				const byBytes = sinceSlice.length > maxBytes ? sinceSlice.slice(-maxBytes) : sinceSlice;
				const lines = byBytes.split("\n");
				return lines.slice(-tailLines).join("\n");
			} catch {
				return "";
			}
		};
		const stdoutStream = req.stream === "stderr" ? "" : await readTail(this.stdoutPath(req.jobId));
		const stderrStream = req.stream === "stdout" ? "" : await readTail(this.stderrPath(req.jobId));
		const truncated = stdoutStream.length >= maxBytes || stderrStream.length >= maxBytes;
		return { jobId: req.jobId, stdout: stdoutStream, stderr: stderrStream, truncated };
	}

	/**
	 * Stop an owned job. Verifies ownership identity before terminating the
	 * owned process tree; never kills an unrelated process that merely shares a
	 * name.
	 */
	async stop(jobId: string): Promise<BackgroundJobRecord | null> {
		const record = await this.read(jobId);
		if (!record) return null;
		if (["stopped", "exited", "failed"].includes(record.state)) return record;
		await this.appendEvent({ event: "BACKGROUND_JOB_STOP_REQUESTED", jobId, at: this.now() });

		const pid = Number(record.processIdentity);
		if (Number.isFinite(pid) && pid > 0) {
			const live = await readProcessIdentity(pid);
			const check = identityMatches(live, {
				commandIdentity: record.commandIdentity,
				processStartIdentity: record.processStartIdentity,
			});
			if (live.alive && !check.match) {
				// PID belongs to a different process now: never kill it.
				const updated: BackgroundJobRecord = { ...record, state: "adoption_required", health: "degraded" };
				await this.persist(updated);
				return updated;
			}
			if (live.alive) {
				this.killProcess(pid, jobId);
				// Wait for terminal state (bounded).
				const running = this.running.get(jobId);
				if (running) {
					await Promise.race([running.exited, sleep(5000)]);
				} else {
					await sleep(1500);
				}
			}
		}
		const updated: BackgroundJobRecord = { ...record, state: "stopped", health: "unknown" };
		await this.persist(updated);
		await this.appendEvent({ event: "BACKGROUND_JOB_STOPPED", jobId, at: this.now() });
		return updated;
	}

	/** Restart a job: new process identity, lineage preserved. */
	async restart(jobId: string, cause = "manual_restart"): Promise<BackgroundJobRecord | null> {
		const record = await this.read(jobId);
		if (!record) return null;
		await this.stop(jobId);
		const restarts = record.restarts ?? [];
		const newRecord = await this.start({
			jobId,
			executable: record.executable,
			args: record.sanitizedArguments,
			cwd: record.cwd,
			workspaceId: record.workspaceId,
			ownerRunId: record.ownerRunId,
			restartPolicy: record.restartPolicy,
		});
		newRecord.restarts = [
			...restarts,
			{
				previousProcessIdentity: record.processIdentity,
				cause,
				at: new Date(this.now()).toISOString(),
				newProcessIdentity: newRecord.processIdentity,
			},
		];
		newRecord.restartCount = (record.restartCount ?? 0) + 1;
		newRecord.state = "running";
		await this.persist(newRecord);
		await this.appendEvent({
			event: "BACKGROUND_JOB_RESTARTED",
			jobId,
			previousProcessIdentity: record.processIdentity,
			newProcessIdentity: newRecord.processIdentity,
			at: this.now(),
		});
		return newRecord;
	}

	/**
	 * Conservative adoption. Adopts a process only with strong identity
	 * evidence (executable, command line, cwd, start time). Never adopts by PID
	 * or name alone. Refuses without matching evidence.
	 */
	async adopt(jobId: string, evidence: AdoptionEvidence): Promise<BackgroundJobRecord | null> {
		const record = await this.read(jobId);
		if (!record) return null;
		const pid = Number(record.processIdentity);
		if (!Number.isFinite(pid) || pid <= 0) return null;
		const live = await readProcessIdentity(pid);
		if (!live.alive) return null;

		const cmdlineMatches = evidence.commandLine
			? live.commandLine.trim() === evidence.commandLine.trim() ||
				(evidence.commandLine &&
					live.commandLine.includes(evidence.executable.split(/[\\/]/).pop() ?? evidence.executable))
			: evidence.executable &&
				live.commandLine &&
				live.commandLine.split(/\s+/)[0]?.includes(evidence.executable.split(/[\\/]/).pop() ?? evidence.executable);
		if (!cmdlineMatches) return null;

		const startMatch =
			evidence.startTimeMs === undefined ||
			live.startIdentity === undefined ||
			Math.abs(live.startIdentity - evidence.startTimeMs / 1000) < 30;
		if (!startMatch) return null;

		const updated: BackgroundJobRecord = {
			...record,
			state: "running",
			health: "healthy",
			processStartIdentity: live.startIdentity,
			commandIdentity: live.commandLine || record.commandIdentity,
		};
		await this.persist(updated);
		await this.appendEvent({ event: "BACKGROUND_JOB_ADOPTED", jobId, processIdentity: String(pid), at: this.now() });
		return updated;
	}

	/** Refuse adoption for a process lacking matching identity evidence. */
	async refuseAdoption(jobId: string): Promise<BackgroundJobRecord | null> {
		const record = await this.read(jobId);
		if (!record) return null;
		const updated: BackgroundJobRecord = { ...record, state: "adoption_required" };
		await this.persist(updated);
		return updated;
	}

	/**
	 * Long-horizon completion gate. A step requiring a running/healthy job
	 * cannot be considered complete while the required job state is unresolved.
	 */
	async gateStepCompletion(
		requireJobId?: string,
		requireState?: "running" | "healthy" | "exited" | "stopped",
	): Promise<{
		canComplete: boolean;
		blockingReason?: string;
	}> {
		if (!requireJobId) return { canComplete: true };
		const record = await this.read(requireJobId);
		if (!record) return { canComplete: false, blockingReason: `job ${requireJobId} not found` };
		if (requireState === "running" || requireState === "healthy") {
			const status = await this.status(requireJobId);
			if (status?.kind === "recorded_running_and_alive") return { canComplete: true };
			return {
				canComplete: false,
				blockingReason: `job ${requireJobId} is ${record.state} (${status?.kind ?? record.state})`,
			};
		}
		if (record.state !== requireState) {
			return {
				canComplete: false,
				blockingReason: `job ${requireJobId} is ${record.state}, expected ${requireState}`,
			};
		}
		return { canComplete: true };
	}

	/** Shutdown: stop all owned jobs; no leaks. */
	async shutdown(): Promise<void> {
		const records = await this.list();
		for (const r of records) {
			if (["stopped", "exited", "failed"].includes(r.state)) continue;
			await this.stop(r.jobId).catch(() => {});
		}
		this.running.clear();
	}

	async readEvents(): Promise<BackgroundJobEvent[]> {
		try {
			const raw = await readFile(this.eventsPath, "utf-8");
			return raw
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l) as BackgroundJobEvent);
		} catch {
			return [];
		}
	}

	async remove(jobId: string): Promise<void> {
		await this.stop(jobId).catch(() => {});
		await rm(this.recordPath(jobId), { force: true }).catch(() => {});
		await rm(this.stdoutPath(jobId), { force: true }).catch(() => {});
		await rm(this.stderrPath(jobId), { force: true }).catch(() => {});
	}

	/** Move durable state files (survives restarts across sessions). */
	async relocate(_storageDir: string): Promise<void> {
		throw new Error("relocate is not implemented; durable state stays in the original storageDir");
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
