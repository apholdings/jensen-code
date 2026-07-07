import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@apholdings/jensen-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { createLocalPowerShellOperations } from "./powershell.js";

// ---------------------------------------------------------------------------
// Registry: tracks started processes on disk so they survive tool restarts
// ---------------------------------------------------------------------------

const REGISTRY_DIR = join(tmpdir(), "jensen-process-registry");

export interface ProcessRecord {
	/** Unique run ID generated at start time */
	runId: string;
	/** Root PID of the spawned process tree */
	rootPid: number;
	/** PID of the process actually listening on the port (when available) */
	listenerPid?: number;
	/** The command that was executed */
	command: string;
	/** Working directory */
	cwd: string;
	/** Path to stdout log file */
	stdoutPath: string;
	/** Path to stderr log file */
	stderrPath: string;
	/** Port the process is expected to listen on (optional) */
	expectedPort?: number;
	/** ISO 8601 timestamp when started */
	startedAt: string;
	/** Current state */
	status: "starting" | "running" | "stopped" | "failed";
	/** Last N lines of stderr on failure */
	lastErrorLines?: string;
}

function ensureRegistry(): void {
	if (!existsSync(REGISTRY_DIR)) {
		mkdirSync(REGISTRY_DIR, { recursive: true });
	}
}

function getRecordPath(runId: string): string {
	return join(REGISTRY_DIR, `${runId}.json`);
}

function readRecord(runId: string): ProcessRecord | null {
	const path = getRecordPath(runId);
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as ProcessRecord;
	} catch {
		return null;
	}
}

function writeRecord(record: ProcessRecord): void {
	ensureRegistry();
	writeFileSync(getRecordPath(record.runId), JSON.stringify(record, null, 2), "utf-8");
}

function deleteRecord(runId: string): void {
	const path = getRecordPath(runId);
	if (existsSync(path)) {
		rmSync(path);
	}
}

function listRecords(): ProcessRecord[] {
	ensureRegistry();
	const entries: ProcessRecord[] = [];
	try {
		for (const entry of readdirSync(REGISTRY_DIR)) {
			if (entry.endsWith(".json")) {
				const record = readRecord(entry.replace(".json", ""));
				if (record) entries.push(record);
			}
		}
	} catch {
		// Directory may not exist yet
	}
	return entries;
}

function readLastLines(filePath: string, count: number): string {
	try {
		if (!existsSync(filePath)) return "";
		const content = readFileSync(filePath, "utf-8");
		const lines = content.split("\n");
		return lines.slice(-count).join("\n");
	} catch {
		return "";
	}
}

function generateRunId(): string {
	return randomBytes(6).toString("hex");
}

// ---------------------------------------------------------------------------
// PowerShell script fragments for process management
// ---------------------------------------------------------------------------

const GET_PORT_OWNER_PS = `
$port = {PORT};
$conn = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1;
if ($conn) {
  Write-Output "PID:$($conn.OwningProcess)"
} else {
  $netstat = netstat -ano 2>$null | Select-String ":$port ";
  if ($netstat) {
    $parts = $netstat -split '\\s+';
    $pid = $parts[$parts.Length - 1];
    Write-Output "PID:$pid"
  } else {
    Write-Output "NONE"
  }
}`;

const VERIFY_PROCESS_TREE_PS = `
$targetPid = {TARGET_PID};
$rootPid = {ROOT_PID};
$current = $targetPid;
$maxDepth = 20;
$found = $false;
for ($i = 0; $i -lt $maxDepth; $i++) {
  if ($current -eq $rootPid) {
    $found = $true;
    break;
  }
  $parent = (Get-CimInstance Win32_Process -Filter "ProcessId = $current" -ErrorAction SilentlyContinue | Select-Object -First 1).ParentProcessId;
  if (-not $parent -or $parent -eq 0) { break }
  $current = $parent;
}
if ($found) {
  Write-Output 'TREE_OK'
} else {
  Write-Output 'TREE_NOT_FOUND'
}`;

const START_PROCESS_PS = `
$cmd = '{COMMAND}';
$cwd = '{CWD}';
$stdoutPath = '{STDOUT_PATH}';
$stderrPath = '{STDERR_PATH}';
$proc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $cmd -WorkingDirectory $cwd -NoNewWindow -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath;
Write-Output "PID:$($proc.Id)"`;

const STOP_PROCESS_PS = `
$pidToStop = {PID};
try {
  Stop-Process -Id $pidToStop -Force -ErrorAction Stop;
  Write-Output 'STOP_OK'
} catch {
  Write-Output "STOP_ERR:$($_.Exception.Message)"
}`;

const CHECK_PROCESS_ALIVE_PS = `
$pid = {PID};
$proc = Get-Process -Id $pid -ErrorAction SilentlyContinue;
if ($proc) {
  Write-Output 'ALIVE'
} else {
  Write-Output 'DEAD'
}`;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const processManagerSchema = Type.Object({
	action: Type.Enum(
		{
			TODO: "TODO",
			START: "start",
			STATUS: "status",
			STOP: "stop",
			LIST: "list",
		},
		{ description: "Action: start, status, stop, or list" },
	),
	command: Type.Optional(
		Type.String({ description: "Command to run (required for start). Must be a single executable with args." }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the process (default: current)" })),
	runId: Type.Optional(Type.String({ description: "Run ID returned by start. Required for status and stop." })),
	expectedPort: Type.Optional(Type.Number({ description: "TCP port the process should listen on" })),
	readyTimeout: Type.Optional(
		Type.Number({ description: "Maximum seconds to wait for the process to become ready (max 45)" }),
	),
});

export type ProcessManagerInput = Static<typeof processManagerSchema>;

// ---------------------------------------------------------------------------
// Pluggable operations
// ---------------------------------------------------------------------------

export interface ProcessManagerOperations {
	execPowerShell(
		command: string,
		cwd: string,
		options: {
			signal?: AbortSignal;
			timeout?: number;
		},
	): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
}

export interface ProcessManagerToolOptions {
	operations?: ProcessManagerOperations;
}

// ---------------------------------------------------------------------------
// Polling helper
// ---------------------------------------------------------------------------

async function pollForReadiness(
	runId: string,
	rootPid: number,
	port: number,
	timeoutSecs: number,
	ops: ProcessManagerOperations,
	signal?: AbortSignal,
): Promise<{ ready: boolean; listenerPid?: number; error?: string }> {
	const deadline = Date.now() + timeoutSecs * 1000;
	const pollInterval = 500;

	while (Date.now() < deadline) {
		if (signal?.aborted) {
			return { ready: false, error: "Aborted" };
		}

		const aliveScript = CHECK_PROCESS_ALIVE_PS.replace("{PID}", String(rootPid));
		const aliveResult = await ops.execPowerShell(aliveScript, process.cwd(), { timeout: 5 });
		if (!aliveResult.stdout.includes("ALIVE")) {
			const record = readRecord(runId);
			const errorLines = record ? readLastLines(record.stderrPath, 20) : "";
			return { ready: false, error: `Process died (PID ${rootPid}).\nStderr:\n${errorLines}` };
		}

		const portScript = GET_PORT_OWNER_PS.replace("{PORT}", String(port));
		const portResult = await ops.execPowerShell(portScript, process.cwd(), { timeout: 5 });
		const portPidMatch = portResult.stdout.match(/PID:(\d+)/);

		if (portPidMatch) {
			const portPid = Number.parseInt(portPidMatch[1], 10);

			const treeScript = VERIFY_PROCESS_TREE_PS.replace("{TARGET_PID}", String(portPid)).replace(
				"{ROOT_PID}",
				String(rootPid),
			);
			const treeResult = await ops.execPowerShell(treeScript, process.cwd(), { timeout: 5 });

			if (treeResult.stdout.includes("TREE_OK")) {
				return { ready: true, listenerPid: portPid };
			}

			return {
				ready: false,
				error: `Port ${port} is occupied by PID ${portPid} which does not belong to the process tree of root PID ${rootPid}. This is a conflict.`,
			};
		}

		await new Promise((r) => setTimeout(r, pollInterval));
	}

	return { ready: false, error: `Timed out after ${timeoutSecs}s waiting for port ${port}` };
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createProcessManagerTool(
	cwd: string,
	options?: ProcessManagerToolOptions,
): AgentTool<typeof processManagerSchema> {
	return {
		name: "process_manager",
		label: "process_manager",
		description:
			`Manage persistent background processes on Windows via PowerShell. ` +
			`Use this instead of nohup or Git Bash backgrounding. ` +
			`Actions: start (launch background process), status (check process state), ` +
			`stop (terminate a managed process), list (show all managed processes). ` +
			`For start, provides readiness polling with port-ownership verification. ` +
			`Never kills unknown processes. Only stops processes registered by this tool.`,
		parameters: processManagerSchema,
		execute: async (
			_toolCallId: string,
			input: ProcessManagerInput,
			signal?: AbortSignal,
			onUpdate?: AgentToolUpdateCallback,
		): Promise<AgentToolResult<any>> => {
			// Create operations from local PowerShell (no inline import)
			const psOps = options?.operations ?? createOpsFromLocal();
			const resolvedOps = psOps;

			switch (input.action) {
				case "list": {
					const records = listRecords();
					if (records.length === 0) {
						return { content: [{ type: "text", text: "No managed processes." }], details: { records: [] } };
					}
					const lines = records.map(
						(r) =>
							`[${r.runId}] ${r.status.toUpperCase()} | PID:${r.rootPid} | listener:${r.listenerPid ?? "N/A"} | port:${r.expectedPort ?? "N/A"} | ${r.command.slice(0, 80)}`,
					);
					return {
						content: [{ type: "text", text: lines.join("\n") }],
						details: { records },
					};
				}

				case "start": {
					if (!input.command) {
						throw new Error("command is required for start action");
					}

					const runId = generateRunId();
					const workDir = input.cwd ?? cwd;
					const stdoutPath = join(tmpdir(), `jensen-proc-${runId}-stdout.log`);
					const stderrPath = join(tmpdir(), `jensen-proc-${runId}-stderr.log`);
					const readyTimeout = Math.min(input.readyTimeout ?? 30, 45);
					const expectedPort = input.expectedPort;

					writeFileSync(stdoutPath, "", "utf-8");
					writeFileSync(stderrPath, "", "utf-8");

					const escapedCommand = input.command.replace(/'/g, "''");
					const escapedCwd = workDir.replace(/'/g, "''");

					const startScript = START_PROCESS_PS.replace("{COMMAND}", escapedCommand)
						.replace("{CWD}", escapedCwd)
						.replace("{STDOUT_PATH}", stdoutPath.replace(/\\/g, "\\\\"))
						.replace("{STDERR_PATH}", stderrPath.replace(/\\/g, "\\\\"));

					if (onUpdate) {
						onUpdate({ content: [{ type: "text", text: `Starting process: ${input.command}` }], details: {} });
					}

					let startResult: { exitCode: number | null; stdout: string; stderr: string };
					try {
						startResult = await resolvedOps.execPowerShell(startScript, workDir, {
							signal,
							timeout: 10,
						});
					} catch (err) {
						const record: ProcessRecord = {
							runId,
							rootPid: 0,
							command: input.command,
							cwd: workDir,
							stdoutPath,
							stderrPath,
							expectedPort,
							startedAt: new Date().toISOString(),
							status: "failed",
							lastErrorLines: (err as Error).message,
						};
						writeRecord(record);
						throw new Error(`Failed to start process: ${(err as Error).message}`);
					}

					const pidMatch = startResult.stdout.match(/PID:(\d+)/);
					if (!pidMatch) {
						const record: ProcessRecord = {
							runId,
							rootPid: 0,
							command: input.command,
							cwd: workDir,
							stdoutPath,
							stderrPath,
							expectedPort,
							startedAt: new Date().toISOString(),
							status: "failed",
							lastErrorLines: readLastLines(stderrPath, 20) || "Could not extract PID from PowerShell output",
						};
						writeRecord(record);
						throw new Error(`Could not determine PID. PowerShell output: ${startResult.stdout.slice(0, 500)}`);
					}

					const rootPid = Number.parseInt(pidMatch[1], 10);
					const record: ProcessRecord = {
						runId,
						rootPid,
						command: input.command,
						cwd: workDir,
						stdoutPath,
						stderrPath,
						expectedPort,
						startedAt: new Date().toISOString(),
						status: "starting",
					};
					writeRecord(record);

					if (onUpdate) {
						onUpdate({
							content: [
								{
									type: "text",
									text: `Process started. PID: ${rootPid}. Polling for readiness...`,
								},
							],
							details: {},
						});
					}

					if (expectedPort) {
						const readyResult = await pollForReadiness(
							runId,
							rootPid,
							expectedPort,
							readyTimeout,
							resolvedOps,
							signal,
						);
						if (!readyResult.ready) {
							record.status = "failed";
							record.lastErrorLines =
								readLastLines(stderrPath, 20) || readyResult.error || "Process did not become ready";
							writeRecord(record);
							throw new Error(
								`Process started (PID ${rootPid}) but did not become ready on port ${expectedPort} within ${readyTimeout}s. ` +
									`${readyResult.error ?? ""}\nLast stderr lines:\n${record.lastErrorLines}`,
							);
						}
						record.listenerPid = readyResult.listenerPid;
					}

					record.status = "running";
					writeRecord(record);

					const resultText = [
						"Process started successfully.",
						`  Run ID: ${runId}`,
						`  Root PID: ${rootPid}`,
						record.listenerPid ? `  Listener PID: ${record.listenerPid}` : null,
						expectedPort ? `  Port: ${expectedPort}` : null,
						`  Stdout: ${stdoutPath}`,
						`  Stderr: ${stderrPath}`,
					]
						.filter(Boolean)
						.join("\n");

					return {
						content: [{ type: "text", text: resultText }],
						details: { record },
					};
				}

				case "status": {
					if (!input.runId) {
						throw new Error("runId is required for status action");
					}

					const record = readRecord(input.runId);
					if (!record) {
						throw new Error(`No process found with runId: ${input.runId}`);
					}

					const aliveScript = CHECK_PROCESS_ALIVE_PS.replace("{PID}", String(record.rootPid));
					const aliveResult = await resolvedOps.execPowerShell(aliveScript, cwd, {
						signal,
						timeout: 5,
					});
					const isAlive = aliveResult.stdout.includes("ALIVE");

					const updatedStatus = isAlive ? record.status : "stopped";
					if (!isAlive && record.status !== "stopped") {
						record.status = "stopped";
						writeRecord(record);
					}

					const lines = [
						`Run ID: ${record.runId}`,
						`Status: ${updatedStatus}`,
						`Root PID: ${record.rootPid}`,
						`Listener PID: ${record.listenerPid ?? "N/A"}`,
						`Port: ${record.expectedPort ?? "N/A"}`,
						`Command: ${record.command}`,
						`CWD: ${record.cwd}`,
						`Stdout: ${record.stdoutPath}`,
						`Stderr: ${record.stderrPath}`,
						`Started: ${record.startedAt}`,
					];

					if (!isAlive) {
						lines.push("", readLastLines(record.stderrPath, 20));
					}

					return {
						content: [{ type: "text", text: lines.join("\n") }],
						details: { record: { ...record, status: updatedStatus } },
					};
				}

				case "stop": {
					if (!input.runId) {
						throw new Error("runId is required for stop action");
					}

					const record = readRecord(input.runId);
					if (!record) {
						throw new Error(`No process found with runId: ${input.runId}`);
					}

					if (record.rootPid === 0) {
						deleteRecord(input.runId);
						return {
							content: [
								{
									type: "text",
									text: `Process ${input.runId} was never started (PID 0). Record removed.`,
								},
							],
							details: {} as Record<string, never>,
						};
					}

					const aliveScript = CHECK_PROCESS_ALIVE_PS.replace("{PID}", String(record.rootPid));
					const aliveResult = await resolvedOps.execPowerShell(aliveScript, cwd, {
						signal,
						timeout: 5,
					});

					if (!aliveResult.stdout.includes("ALIVE")) {
						record.status = "stopped";
						writeRecord(record);
						return {
							content: [
								{
									type: "text",
									text: `Process ${input.runId} (PID ${record.rootPid}) was already stopped.`,
								},
							],
							details: { record },
						};
					}

					const stopScript = STOP_PROCESS_PS.replace("{PID}", String(record.rootPid));
					const stopResult = await resolvedOps.execPowerShell(stopScript, cwd, {
						signal,
						timeout: 10,
					});

					if (stopResult.stdout.includes("STOP_OK")) {
						record.status = "stopped";
						writeRecord(record);
						return {
							content: [
								{
									type: "text",
									text:
										`Process ${input.runId} (PID ${record.rootPid}) stopped successfully.\n` +
										`Stdout log: ${record.stdoutPath}\n` +
										`Stderr log: ${record.stderrPath}`,
								},
							],
							details: { record },
						};
					}

					return {
						content: [
							{
								type: "text",
								text: `Failed to stop process ${input.runId} (PID ${record.rootPid}): ${stopResult.stdout}`,
							},
						],
						details: { record },
					};
				}

				default:
					throw new Error(`Unknown action: ${input.action}`);
			}
		},
	};
}

/**
 * Create default operations using the local PowerShell backend.
 * This is a synchronous factory - no inline imports.
 */
function createOpsFromLocal(): ProcessManagerOperations {
	const psOps = createLocalPowerShellOperations();
	return {
		execPowerShell: (command, execCwd, opts) => {
			return new Promise((resolve, reject) => {
				let stdout = "";
				psOps
					.exec(command, execCwd, {
						...opts,
						onData: (data) => {
							stdout += data.toString("utf-8");
						},
						env: undefined,
					})
					.then((r) => resolve({ ...r, stdout, stderr: "" }))
					.catch(reject);
			});
		},
	};
}

/** Default process manager tool */
export const processManagerTool = createProcessManagerTool(process.cwd());
