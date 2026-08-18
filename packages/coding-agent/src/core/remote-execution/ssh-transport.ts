/**
 * Remote Execution — SSH transport (2.14.0).
 *
 * The first real transport. It runs remote commands via non-interactive
 * OpenSSH (`BatchMode=yes`, bounded `ConnectTimeout`, no password prompts) and
 * uses PowerShell `-EncodedCommand` (UTF-16LE base64) for Windows command
 * payloads so no shell interpolation of untrusted data ever occurs.
 *
 * Materialisation + launch happen in a single SSH process: a PowerShell
 * preamble reads a JSON payload from stdin, writes base64-decoded files into an
 * execution-scoped temp directory (guarded against duplicate launch), then
 * execs the remote protocol runner. The runner's JSONL frames stream back over
 * the same channel.
 */

import { spawn } from "node:child_process";
import type { RemoteExecutionErrorCode } from "./remote-execution-error.js";
import { RemoteExecutionError } from "./remote-execution-error.js";
import { parseRemoteFrame, REMOTE_PROTOCOL_VERSION, type RemoteProtocolFrameType } from "./remote-protocol.js";
import { REMOTE_RUNNER_SOURCE } from "./remote-runner-source.js";
import type { RemoteExecutionTarget, RemoteTargetHealth } from "./remote-target-types.js";
import type {
	RemoteCommandRunner,
	RemoteExecutionHandle,
	RemoteExecutionTransport,
	RemoteLaunchSpec,
	RemoteTransportOutcome,
} from "./remote-transport.js";

// =============================================================================
// Bounded ssh command runner (injectable for tests)
// =============================================================================

export interface SshCommandResult {
	exitCode: number | null;
	signal?: string;
	stdout: string;
	stderr: string;
	timedOut?: boolean;
	launchError?: string;
}

export type SshCommandRunner = (
	target: RemoteExecutionTarget,
	args: readonly string[],
	input: string | Buffer | undefined,
	options: { timeoutMs?: number; signal?: AbortSignal; sshOptions?: readonly string[] },
) => Promise<SshCommandResult>;

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 120_000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 600_000;

function defaultSshCommandRunner(
	target: RemoteExecutionTarget,
	args: readonly string[],
	input: string | Buffer | undefined,
	options: { timeoutMs?: number; signal?: AbortSignal; sshOptions?: readonly string[] },
): Promise<SshCommandResult> {
	const connectTimeoutMs = target.connection?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
	const commandArgs = [
		"-T",
		"-o",
		"BatchMode=yes",
		"-o",
		`ConnectTimeout=${Math.max(1, Math.floor(connectTimeoutMs / 1000))}`,
		...(options.sshOptions ?? []),
		`${target.user}@${target.host}`,
		...args,
	];

	return new Promise<SshCommandResult>((resolve) => {
		const child = spawn("ssh", commandArgs, {
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env },
		});

		let stdout = "";
		let stderr = "";
		let launchError: string | undefined;
		let timedOut = false;
		let settled = false;
		let forceTimer: NodeJS.Timeout | undefined;

		const finish = (result: SshCommandResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (forceTimer) clearTimeout(forceTimer);
			resolve(result);
		};

		const timeout = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGTERM");
			} catch {
				// already gone
			}
			forceTimer = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) {
					try {
						child.kill("SIGKILL");
					} catch {
						// already gone
					}
				}
			}, 5000);
		}, options.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS);

		if (options.signal) {
			if (options.signal.aborted) {
				try {
					child.kill("SIGTERM");
				} catch {
					// already gone
				}
			} else {
				options.signal.addEventListener(
					"abort",
					() => {
						try {
							child.kill("SIGTERM");
						} catch {
							// already gone
						}
					},
					{ once: true },
				);
			}
		}

		child.stdout.on("data", (data: Buffer) => {
			stdout += data.toString();
		});
		child.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});
		child.on("error", (error) => {
			launchError = error.message;
		});
		child.on("close", (code, signal) => {
			if (options.signal) options.signal.removeEventListener("abort", () => undefined);
			finish({
				exitCode: code,
				signal: signal ?? undefined,
				stdout,
				stderr,
				timedOut,
				launchError,
			});
		});

		if (input !== undefined) {
			child.stdin.on("error", () => undefined);
			child.stdin.end(input);
		} else {
			child.stdin.end();
		}
	});
}

// =============================================================================
// PowerShell encoding
// =============================================================================

/** Encode a PowerShell script as UTF-16LE base64 for `-EncodedCommand`. */
export function encodePowerShellCommand(script: string): string {
	const utf16le = Buffer.from(script, "utf16le");
	return utf16le.toString("base64");
}

/** Build a PowerShell single-quoted literal (escapes embedded single quotes). */
export function psLiteral(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

/** Build the ssh argv for running a PowerShell encoded command. */
export function sshPowerShellArgs(encoded: string): string[] {
	return ["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];
}

// =============================================================================
// Materialisation payload
// =============================================================================

interface MaterializeFile {
	path: string;
	contentB64: string;
}

interface MaterializePayload {
	workspaceDir: string;
	runnerPath: string;
	envelopePath: string;
	files: MaterializeFile[];
}

/** PowerShell preamble that reads stdin JSON, writes files, then execs the runner. */
const MATERIALIZE_PREAMBLE = [
	"$ErrorActionPreference = 'Stop'",
	"$ProgressPreference = 'SilentlyContinue'",
	"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()",
	"$payload = [Console]::In.ReadToEnd()",
	"$data = $payload | ConvertFrom-Json",
	"if (Test-Path -LiteralPath $data.workspaceDir) {",
	"  Write-Output 'JENSEN_REMOTE_DUPLICATE_LAUNCH'",
	"  exit 70",
	"}",
	"New-Item -ItemType Directory -Path $data.workspaceDir -Force | Out-Null",
	"foreach ($f in $data.files) {",
	"  $dir = Split-Path -Parent $f.path",
	"  if (!(Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }",
	"  [IO.File]::WriteAllText($f.path, [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($f.contentB64)))",
	"}",
	"& node $data.runnerPath $data.envelopePath",
	"exit $LASTEXITCODE",
].join("\r\n");

const DUPLICATE_LAUNCH_MARKER = "JENSEN_REMOTE_DUPLICATE_LAUNCH";

// =============================================================================
// Transport
// =============================================================================

export interface SshRemoteExecutionTransportOptions {
	/** Injectable command runner (tests). Defaults to real OpenSSH spawn. */
	runner?: SshCommandRunner;
	launchTimeoutMs?: number;
	heartbeatTimeoutMs?: number;
	executionTimeoutMs?: number;
}

export class SshRemoteExecutionTransport implements RemoteExecutionTransport, RemoteCommandRunner {
	readonly transportId = "ssh";
	private readonly _runner: SshCommandRunner;
	private readonly _launchTimeoutMs: number;
	private readonly _heartbeatTimeoutMs: number;
	private readonly _executionTimeoutMs: number;

	constructor(options: SshRemoteExecutionTransportOptions = {}) {
		this._runner = options.runner ?? defaultSshCommandRunner;
		this._launchTimeoutMs = options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
		this._heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
		this._executionTimeoutMs = options.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
	}

	async probe(target: RemoteExecutionTarget): Promise<RemoteTargetHealth> {
		const commandTimeoutMs = target.connection?.commandTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
		const script = [
			"$ErrorActionPreference = 'Stop'",
			"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()",
			"$node = (Get-Command node -ErrorAction SilentlyContinue).Source",
			"$arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }",
			"$h = @{ host = [Environment]::MachineName; user = [Environment]::UserName; platform = [Environment]::OSVersion.VersionString; arch = $arch; node = $node }",
			"$h | ConvertTo-Json -Compress",
		].join("\r\n");

		const result = await this._runner(target, sshPowerShellArgs(encodePowerShellCommand(script)), undefined, {
			timeoutMs: commandTimeoutMs,
		});

		const observedAtMs = Date.now();
		if (result.launchError) {
			return {
				targetId: target.targetId,
				status: "unreachable",
				errorCode: "REMOTE_TARGET_UNAVAILABLE",
				summary: result.launchError,
				observedAtMs,
			};
		}
		if (result.timedOut) {
			return {
				targetId: target.targetId,
				status: "timeout",
				errorCode: "REMOTE_CONNECT_TIMEOUT",
				summary: "remote probe timed out",
				observedAtMs,
			};
		}
		if (result.exitCode !== 0) {
			const status = /permission denied|auth|publickey|authentication/i.test(result.stderr)
				? "auth_failed"
				: result.stderr.includes("Could not resolve") || result.stderr.includes("Connection timed out")
					? "timeout"
					: "unreachable";
			return {
				targetId: target.targetId,
				status,
				errorCode:
					status === "auth_failed"
						? "REMOTE_AUTH_FAILED"
						: status === "timeout"
							? "REMOTE_CONNECT_TIMEOUT"
							: "REMOTE_TARGET_UNAVAILABLE",
				summary: (result.stderr || result.stdout).trim().slice(0, 400),
				observedAtMs,
			};
		}

		let identity: Record<string, unknown> | undefined;
		try {
			identity = JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}");
		} catch {
			identity = undefined;
		}

		const platform = String(identity?.platform ?? "");
		const nodeRuntime = identity?.node ? String(identity.node) : undefined;
		const status: RemoteTargetHealth["status"] = nodeRuntime ? "reachable" : "runtime_unavailable";
		return {
			targetId: target.targetId,
			status,
			errorCode: status === "reachable" ? undefined : "REMOTE_RUNTIME_UNAVAILABLE",
			summary: status === "reachable" ? `reachable (${platform})` : "remote Node runtime unavailable",
			observedAtMs,
			remoteHost: identity?.host ? String(identity.host) : undefined,
			remoteUser: identity?.user ? String(identity.user) : undefined,
			remotePlatform: platform,
			remoteRuntime: nodeRuntime,
		};
	}

	/**
	 * Run a single bounded remote command with an explicit remote working
	 * directory. The command + cwd are passed via stdin JSON (never shell
	 * interpolation) to a fixed PowerShell preamble that sets location and runs
	 * `cmd.exe /d /s /c`. Used for probe/verification operations.
	 */
	async runCommand(
		target: RemoteExecutionTarget,
		command: string,
		cwd: string,
		options: { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut?: boolean; launchError?: string }> {
		const script = [
			"$ErrorActionPreference = 'Stop'",
			"$ProgressPreference = 'SilentlyContinue'",
			"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()",
			"$payload = [Console]::In.ReadToEnd()",
			"$data = $payload | ConvertFrom-Json",
			"Set-Location -LiteralPath $data.cwd",
			"& cmd.exe /d /s /c $data.command",
			"exit $LASTEXITCODE",
		].join("\r\n");

		const input = JSON.stringify({ cwd, command });
		const result = await this._runner(target, sshPowerShellArgs(encodePowerShellCommand(script)), input, {
			timeoutMs: options.timeoutMs ?? this._executionTimeoutMs,
			signal: options.signal,
		});
		return {
			exitCode: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr,
			timedOut: result.timedOut,
			launchError: result.launchError,
		};
	}

	/**
	 * Run an arbitrary encoded PowerShell script with no stdin. Used for
	 * runtime-sync operations (hash, directory checks, atomic swap) that are not
	 * mission child launches.
	 */
	async runPowerShell(
		target: RemoteExecutionTarget,
		script: string,
		options: { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut?: boolean; launchError?: string }> {
		const result = await this._runner(
			target,
			sshPowerShellArgs(encodePowerShellCommand(`$ProgressPreference = 'SilentlyContinue'\r\n${script}`)),
			undefined,
			{
				timeoutMs: options.timeoutMs ?? this._executionTimeoutMs,
				signal: options.signal,
			},
		);
		return {
			exitCode: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr,
			timedOut: result.timedOut,
			launchError: result.launchError,
		};
	}

	/**
	 * Save binary bytes to a remote file. Reads raw stdin (never JSON), so the
	 * payload is byte-exact; used to transfer the runtime bundle tarball.
	 */
	async saveFile(
		target: RemoteExecutionTarget,
		remotePath: string,
		bytes: Buffer,
		options: { timeoutMs?: number } = {},
	): Promise<{ exitCode: number | null; stdout: string; stderr: string; launchError?: string }> {
		const script = [
			"$ErrorActionPreference = 'Stop'",
			"$ProgressPreference = 'SilentlyContinue'",
			"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()",
			`$path = ${psLiteral(remotePath)}`,
			"$dir = Split-Path -Parent $path",
			"if (!(Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }",
			"$in = [Console]::OpenStandardInput()",
			"$out = [System.IO.File]::Create($path)",
			"try { $in.CopyTo($out) } finally { $out.Close() }",
			"Write-Output 'JENSEN_FILE_SAVED'",
		].join("\r\n");

		const result = await this._runner(target, sshPowerShellArgs(encodePowerShellCommand(script)), bytes, {
			timeoutMs: options.timeoutMs ?? this._executionTimeoutMs,
		});
		return {
			exitCode: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr,
			launchError: result.launchError,
		};
	}

	/** Compute the SHA-256 of a remote file (hex). Throws on failure. */
	async computeFileSha256(target: RemoteExecutionTarget, remotePath: string): Promise<string> {
		const result = await this.runPowerShell(
			target,
			[
				"$ErrorActionPreference = 'Stop'",
				"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()",
				`(Get-FileHash -Algorithm SHA256 -LiteralPath ${psLiteral(remotePath)}).Hash.ToLowerInvariant()`,
			].join("\r\n"),
			{ timeoutMs: 120_000 },
		);
		if (result.exitCode !== 0) {
			throw new Error(`remote hash failed: ${result.stderr || result.launchError || "unknown"}`);
		}
		const hash = result.stdout.trim().split(/\r?\n/).pop()?.trim() ?? "";
		if (!/^[0-9a-f]{64}$/u.test(hash)) {
			throw new Error(`remote hash returned unexpected output: ${result.stdout.slice(0, 200)}`);
		}
		return hash;
	}

	/**
	 * Stream-extract a gzipped tarball on the target via `tar -xzf -` (binary
	 * stdin). This is the proven reliable path for large binary transfers; tar's
	 * gzip CRC32 + tar checksums provide integrity, and the caller verifies the
	 * sidecar manifest identity afterwards.
	 */
	async extractTarballFromStdin(
		target: RemoteExecutionTarget,
		destDir: string,
		bytes: Buffer,
		options: { timeoutMs?: number } = {},
	): Promise<{ exitCode: number | null; stdout: string; stderr: string; launchError?: string }> {
		const args = ["cmd.exe", "/d", "/s", "/c", `tar -xzf - -C ${destDir.replace(/\\/g, "/")}`];
		const result = await this._runner(target, args, bytes, { timeoutMs: options.timeoutMs ?? 600_000 });
		return {
			exitCode: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr,
			launchError: result.launchError,
		};
	}

	async launch(
		target: RemoteExecutionTarget,
		spec: RemoteLaunchSpec,
		options: { signal?: AbortSignal } = {},
	): Promise<RemoteExecutionHandle> {
		const workspaceDir = spec.workspaceDir;
		const runnerPath = `${workspaceDir}\\remote-runner.js`;
		const envelopePath = `${workspaceDir}\\envelope.json`;

		// Build the runner envelope (materialised as a file, not re-serialised by
		// PowerShell, so its JSON is byte-exact).
		const envelope = {
			protocolVersion: REMOTE_PROTOCOL_VERSION,
			executionId: spec.executionId,
			launchId: spec.launchId,
			remoteTargetId: spec.remoteTargetId,
			fencing: spec.fencing,
			heartbeatMs: spec.heartbeatMs ?? 3000,
			launch: {
				command: spec.launch.command,
				args: spec.launch.args,
				cwd: spec.launch.cwd,
				env: spec.launch.env,
			},
			evidenceFiles: spec.evidenceFiles ?? [],
		};

		const files: MaterializeFile[] = [
			{ path: runnerPath, contentB64: Buffer.from(REMOTE_RUNNER_SOURCE, "utf8").toString("base64") },
			{ path: envelopePath, contentB64: Buffer.from(JSON.stringify(envelope), "utf8").toString("base64") },
		];
		if (spec.modelsJson) {
			files.push({
				path: `${spec.agentDir}\\models.json`,
				contentB64: Buffer.from(spec.modelsJson, "utf8").toString("base64"),
			});
		}
		if (spec.childSessionId && spec.sessionFileContent !== undefined) {
			files.push({
				path: `${spec.agentDir}\\child-sessions\\${spec.childSessionId}.jsonl`,
				contentB64: Buffer.from(spec.sessionFileContent, "utf8").toString("base64"),
			});
		}
		for (const file of spec.workspaceFiles ?? []) {
			const relative = file.path.replace(/\//g, "\\");
			files.push({
				path: `${workspaceDir}\\${relative}`,
				contentB64: file.contentB64,
			});
		}

		const payload: MaterializePayload = { workspaceDir, runnerPath, envelopePath, files };
		const preamble = MATERIALIZE_PREAMBLE;
		const encoded = encodePowerShellCommand(preamble);
		const input = JSON.stringify(payload);

		const controller = new AbortController();
		const abortListener = () => controller.abort();
		if (options.signal) {
			if (options.signal.aborted) controller.abort();
			else options.signal.addEventListener("abort", abortListener, { once: true });
		}

		const start = Date.now();
		spec.callbacks?.onEvent?.({
			eventId: `${spec.executionId}:${spec.launchId}:launch_started`,
			type: "connected",
			atMs: start,
			payload: { correlation: spec.correlation },
		});
		const sshOptions = spec.admissionTunnel
			? ["-R", `${spec.admissionTunnel.remotePort}:127.0.0.1:${spec.admissionTunnel.localPort}`]
			: undefined;

		const sshPromise = this._runner(target, sshPowerShellArgs(encoded), input, {
			timeoutMs: spec.timeoutMs ?? this._executionTimeoutMs,
			signal: controller.signal,
			sshOptions,
		});

		const outcomePromise = this._consume(spec, sshPromise, start);

		return {
			executionId: spec.executionId,
			launchId: spec.launchId,
			outcomePromise,
			cancel: async (reason?: string) => {
				controller.abort(reason);
			},
		};
	}

	private async _consume(
		spec: RemoteLaunchSpec,
		sshPromise: Promise<SshCommandResult>,
		start: number,
	): Promise<RemoteTransportOutcome> {
		let started = false;
		let lastFrameAtMs = start;
		let stdout = "";
		let stderr = "";
		let exitCode: number | null = null;
		let signal: string | undefined;
		let cancelled = false;
		const timedOut = false;
		let launchError: string | undefined;
		let errorCode: string | undefined;
		let location: RemoteTransportOutcome["location"];
		let evidence: unknown[] | undefined;
		let remoteResult: { success: boolean; summary?: string } | undefined;

		const launchTimeout = setTimeout(() => {
			// Launch acknowledgement never arrived.
			if (!started) {
				errorCode = "REMOTE_LAUNCH_FAILED";
			}
		}, this._launchTimeoutMs);

		const heartbeatTimeout = setInterval(
			() => {
				if (started && Date.now() - lastFrameAtMs > this._heartbeatTimeoutMs) {
					errorCode = errorCode ?? "REMOTE_HEARTBEAT_TIMEOUT";
				}
			},
			Math.min(this._heartbeatTimeoutMs / 2, 5000),
		);

		const ssh = await sshPromise;
		clearTimeout(launchTimeout);
		clearInterval(heartbeatTimeout);

		// Parse the raw ssh stdout for protocol frames. ssh may carry no frames if
		// materialisation failed (e.g. duplicate launch), which maps to a
		// structured launch error below.
		const lines = ssh.stdout.split("\n");
		const seenTypes = new Set<string>();
		for (const line of lines) {
			const frame = parseRemoteFrame(line);
			if (!frame) continue;
			seenTypes.add(frame.type);
			lastFrameAtMs = Date.now();
			spec.callbacks?.onEvent?.({
				eventId: `${spec.executionId}:${spec.launchId}:frame:${frame.type}`,
				type: "frame",
				atMs: lastFrameAtMs,
				payload: { correlation: spec.correlation, frame: { type: frame.type, payload: frame.payload } },
			});
			this._applyFrame(frame.type, frame.payload, {
				onStarted: (p) => {
					started = true;
					location = p.location;
				},
				onStream: (which, chunk) => {
					if (which === "stdout") stdout += chunk;
					else stderr += chunk;
				},
				onEvidence: (items) => {
					evidence = items;
				},
				onResult: (r) => {
					remoteResult = r;
				},
				onExit: (p) => {
					exitCode = p.exitCode;
					signal = p.signal;
					cancelled = p.cancelled ?? false;
				},
				onError: (p) => {
					errorCode = errorCode ?? p.code;
				},
			});
			spec.callbacks?.onFrame?.({ type: frame.type, payload: frame.payload });
		}

		// Materialisation/launch failure paths.
		if (ssh.stdout.includes(DUPLICATE_LAUNCH_MARKER)) {
			throw new RemoteExecutionError("REMOTE_DUPLICATE_LAUNCH", `Duplicate remote launch for ${spec.executionId}`, {
				executionId: spec.executionId,
			});
		}
		if (ssh.launchError) {
			spec.callbacks?.onEvent?.({
				eventId: `${spec.executionId}:${spec.launchId}:transport_error`,
				type: "transport_error",
				atMs: Date.now(),
				payload: { correlation: spec.correlation, errorCode: "REMOTE_TARGET_UNAVAILABLE" },
			});
			throw new RemoteExecutionError("REMOTE_TARGET_UNAVAILABLE", ssh.launchError, {
				executionId: spec.executionId,
			});
		}
		if (!started && !seenTypes.has("REMOTE_STARTED")) {
			throw new RemoteExecutionError(
				ssh.timedOut ? "REMOTE_CONNECT_TIMEOUT" : "REMOTE_LAUNCH_FAILED",
				ssh.timedOut ? "remote launch timed out" : "remote launch never acknowledged",
				{ executionId: spec.executionId, stderr: ssh.stderr.slice(0, 1000) },
			);
		}
		if (ssh.timedOut && !seenTypes.has("REMOTE_EXIT")) {
			throw new RemoteExecutionError("REMOTE_EXECUTION_LOST", "remote execution lost before terminal result", {
				executionId: spec.executionId,
			});
		}
		if (!seenTypes.has("REMOTE_EXIT")) {
			// Transport closed without a terminal result: not success.
			spec.callbacks?.onEvent?.({
				eventId: `${spec.executionId}:${spec.launchId}:remote_retry:1`,
				type: "transport_error",
				atMs: Date.now(),
				payload: {
					correlation: spec.correlation,
					retryClass: "remote_execution",
					retryIndex: 1,
					reason: "transport closed without terminal result",
				},
			});
			throw new RemoteExecutionError("REMOTE_EXECUTION_LOST", "transport closed without terminal result", {
				executionId: spec.executionId,
			});
		}

		if (errorCode) {
			// A structured error was observed (heartbeat loss, remote error, ...).
			return {
				exitCode: exitCode,
				signal,
				cancelled,
				timedOut,
				launchError,
				stdout: stdout.slice(0, 128_000),
				stderr: stderr.slice(0, 64_000),
				location,
				evidence,
				remoteResult,
				errorCode,
			};
		}

		return {
			exitCode,
			signal,
			cancelled,
			timedOut,
			launchError,
			stdout: stdout.slice(0, 128_000),
			stderr: stderr.slice(0, 64_000),
			location,
			evidence,
			remoteResult,
			errorCode,
		};
	}

	private _applyFrame(
		type: RemoteProtocolFrameType,
		payload: Record<string, unknown>,
		handlers: {
			onStarted: (p: { location: NonNullable<RemoteTransportOutcome["location"]> }) => void;
			onStream: (which: "stdout" | "stderr", chunk: string) => void;
			onEvidence: (items: unknown[]) => void;
			onResult: (r: { success: boolean; summary?: string }) => void;
			onExit: (p: { exitCode: number | null; signal?: string; cancelled?: boolean }) => void;
			onError: (p: { code: string }) => void;
		},
	): void {
		switch (type) {
			case "REMOTE_STARTED": {
				const loc = payload.location as Record<string, unknown> | undefined;
				handlers.onStarted({
					location: {
						host: String(loc?.host ?? ""),
						user: String(loc?.user ?? ""),
						cwd: String(loc?.cwd ?? ""),
						pid: Number(loc?.pid ?? 0),
						platform: String(loc?.platform ?? ""),
					},
				});
				break;
			}
			case "REMOTE_STDOUT":
				handlers.onStream("stdout", String(payload.chunk ?? ""));
				break;
			case "REMOTE_STDERR":
				handlers.onStream("stderr", String(payload.chunk ?? ""));
				break;
			case "REMOTE_EVIDENCE":
				handlers.onEvidence(Array.isArray(payload.items) ? payload.items : []);
				break;
			case "REMOTE_RESULT":
				handlers.onResult({
					success: payload.success === true,
					summary: payload.summary !== undefined ? String(payload.summary) : undefined,
				});
				break;
			case "REMOTE_EXIT":
				handlers.onExit({
					exitCode: typeof payload.exitCode === "number" ? payload.exitCode : null,
					signal: payload.signal !== undefined ? String(payload.signal) : undefined,
					cancelled: payload.cancelled === true,
				});
				break;
			case "REMOTE_ERROR":
				handlers.onError({ code: String(payload.code ?? "REMOTE_PROTOCOL_ERROR") });
				break;
			case "REMOTE_HEARTBEAT":
				break;
		}
	}
}

// =============================================================================
// Public error-code re-export (kept narrow: only codes the transport surfaces)
// =============================================================================

export type { RemoteExecutionErrorCode };
