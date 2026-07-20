import { existsSync } from "node:fs";
import type { AgentTool } from "@apholdings/jensen-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { spawn } from "child_process";
import { getShellConfig, getShellEnv, killProcessTree } from "../../utils/shell.js";
import type { BashResult, PipelineEvidence } from "../bash-executor.js";
import { executeBashWithOperations } from "../bash-executor.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult, truncateTail } from "./truncate.js";

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	command: string;
	cwd: string;

	stdout: string;
	stderr: string;

	exitCode: number | undefined;

	startedAt: string;
	finishedAt: string;

	timedOut: boolean;
	cancelled: boolean;
	truncated: boolean;

	truncation?: TruncationResult;
	fullOutputPath?: string;
	spawnError?: string;

	pipeline?: PipelineEvidence;
}

/**
 * Pipeline stage exit code metadata captured by the bash executor.
 */
export interface PipelineStageData {
	/** Per-stage exit codes from PIPESTATUS */
	stageExitCodes: number[];
	/** Whether PIPESTATUS was successfully captured */
	stageExitCodesKnown: boolean;
	/** Whether the evidence is authoritative (all stages captured) */
	evidenceAuthoritative: boolean;
}

export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command - The command to execute
	 * @param cwd - Working directory
	 * @param options - Execution options
	 * @returns Promise resolving to exit code (null if killed) and optional pipeline data
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			/** Combined stdout + stderr stream (legacy, always called) */
			onData: (data: Buffer) => void;
			/** Separate stdout stream (optional, called alongside onData) */
			onStdout?: (data: Buffer) => void;
			/** Separate stderr stream (optional, called alongside onData) */
			onStderr?: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null; pipelineData?: PipelineStageData }>;
}

/**
 * Bash trap preamble that captures PIPESTATUS to fd 3 on shell exit.
 * The EXIT trap fires even after `exit N`, so pipeline metadata is
 * always captured. The preamble is prepended before the user command
 * with a newline separator — no semicolon touches the user's source.
 *
 * User stdout/stderr are delivered normally via fd 1 and fd 2.
 * Pipeline metadata arrives on fd 3 only after the trap fires.
 *
 * Note: If the user sets their own `trap ... EXIT`, it overrides this
 * one and pipeline metadata will be missing (non-authoritative).
 */
const PIPESTATUS_CAPTURE_PREAMBLE = `__jensen_stages=()
trap '__jensen_stages=("\${PIPESTATUS[@]}"); printf "%s\\n" "\${__jensen_stages[*]}" >&3' EXIT
`;

/**
 * Parse PIPESTATUS output from fd 3 into structured pipeline data.
 * Input format: space-separated integers like "1 0" or "0".
 * Returns parsed stage exit codes or undefined if parsing fails.
 */
function parsePipelineData(raw: string): PipelineStageData | undefined {
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	const codes = trimmed.split(/\s+/).map(Number);
	if (codes.some(Number.isNaN)) return undefined;
	return {
		stageExitCodes: codes,
		stageExitCodesKnown: true,
		evidenceAuthoritative: true,
	};
}

export function createLocalBashOperations(): BashOperations {
	return {
		exec: (command, cwd, { onData, onStdout, onStderr, signal, timeout, env }) => {
			return new Promise((resolve, reject) => {
				const { shell, args } = getShellConfig();

				if (!existsSync(cwd)) {
					reject(new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`));
					return;
				}

				// Prepend trap preamble for PIPESTATUS capture on shell exit.
				// The EXIT trap fires after the user command completes (even after
				// `exit N`), capturing PIPESTATUS and writing to fd 3.
				// No semicolon or operator touches the user's source — the preamble
				// and command are separated only by a newline.
				const wrappedCommand = `${PIPESTATUS_CAPTURE_PREAMBLE}\n${command}`;
				const pipelineChunks: Buffer[] = [];

				const child = spawn(shell, [...args, wrappedCommand], {
					cwd,
					detached: true,
					env: env ?? getShellEnv(),
					stdio: ["ignore", "pipe", "pipe", "pipe"],
				});

				let timedOut = false;

				// Set timeout if provided
				let timeoutHandle: NodeJS.Timeout | undefined;
				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) {
							killProcessTree(child.pid);
						}
					}, timeout * 1000);
				}

				// Stream stdout and stderr — both go to onData for backward compat,
				// and separately to onStdout/onStderr for consumers that need separation.
				if (child.stdout) {
					child.stdout.on("data", (data: Buffer) => {
						onData(data);
						onStdout?.(data);
					});
				}
				if (child.stderr) {
					child.stderr.on("data", (data: Buffer) => {
						onData(data);
						onStderr?.(data);
					});
				}

				// Collect pipeline metadata from fd 3 (PIPESTATUS)
				if (child.stdio?.[3]) {
					(child.stdio[3] as NodeJS.ReadableStream).on("data", (data: Buffer) => {
						pipelineChunks.push(data);
					});
				}

				// Handle shell spawn errors
				child.on("error", (err) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					if (signal) signal.removeEventListener("abort", onAbort);
					reject(err);
				});

				// Handle abort signal - kill entire process tree
				const onAbort = () => {
					if (child.pid) {
						killProcessTree(child.pid);
					}
				};

				if (signal) {
					if (signal.aborted) {
						onAbort();
					} else {
						signal.addEventListener("abort", onAbort, { once: true });
					}
				}

				// Handle process exit
				child.on("close", (code) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					if (signal) signal.removeEventListener("abort", onAbort);

					if (signal?.aborted) {
						reject(new Error("aborted"));
						return;
					}

					if (timedOut) {
						reject(new Error(`timeout:${timeout}`));
						return;
					}

					const pipelineRaw = Buffer.concat(pipelineChunks).toString("utf-8");
					const pipelineData = parsePipelineData(pipelineRaw);

					resolve({ exitCode: code, pipelineData });
				});
			});
		},
	};
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(command: string, cwd: string, spawnHook?: BashSpawnHook): BashSpawnContext {
	const baseContext: BashSpawnContext = {
		command,
		cwd,
		env: { ...getShellEnv() },
	};

	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (e.g., "shopt -s expand_aliases" for alias support) */
	commandPrefix?: string;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
}

/**
 * Format BashResult into model-facing text content with structured evidence section.
 * The model sees: command, exit code, stdout, stderr, timing, and pipeline metadata.
 * TUI details carry the full BashResult for rendering.
 */
function formatBashResultForModel(
	result: BashResult,
	command: string,
	cwd: string,
): { contentText: string; details: BashToolDetails } {
	const lines: string[] = [];

	// Structured evidence header
	lines.push(`Command: \`${command}\``);
	lines.push(`CWD: ${cwd}`);

	const trimmedStdout = result.stdout.trimEnd();
	const trimmedStderr = result.stderr.trimEnd();

	if (trimmedStdout) {
		lines.push("");
		lines.push("stdout:");
		lines.push(trimmedStdout);
	}

	if (trimmedStderr) {
		lines.push("");
		lines.push("stderr:");
		lines.push(trimmedStderr);
	}

	if (!trimmedStdout && !trimmedStderr) {
		lines.push("");
		lines.push("(no output)");
	}

	const evidenceLines: string[] = [];
	evidenceLines.push(`exit_code: ${result.exitCode !== undefined ? result.exitCode : "undefined"}`);
	evidenceLines.push(`timed_out: ${result.timedOut}`);
	evidenceLines.push(`cancelled: ${result.cancelled}`);
	evidenceLines.push(`truncated: ${result.truncated}`);

	if (result.spawnError) {
		evidenceLines.push(`spawn_error: ${result.spawnError}`);
	}

	if (result.pipeline?.isPipeline) {
		evidenceLines.push(`pipeline: true`);
		evidenceLines.push(`pipeline_last_exit_code: ${result.pipeline.lastStageExitCode ?? "null"}`);
		evidenceLines.push(`pipeline_authoritative: ${result.pipeline.evidenceAuthoritative}`);
		if (result.pipeline.stageExitCodesKnown && result.pipeline.stageExitCodes.length > 0) {
			evidenceLines.push(`pipeline_stage_exit_codes: [${result.pipeline.stageExitCodes.join(", ")}]`);
		}
	}

	if (result.fullOutputPath && result.truncated) {
		evidenceLines.push(`full_output: ${result.fullOutputPath}`);
	}

	lines.push("");
	lines.push("--- Evidence ---");
	lines.push(evidenceLines.join("\n"));

	const details: BashToolDetails = {
		command,
		cwd,
		stdout: result.stdout,
		stderr: result.stderr,
		exitCode: result.exitCode,
		startedAt: result.startedAt,
		finishedAt: result.finishedAt,
		timedOut: result.timedOut,
		cancelled: result.cancelled,
		truncated: result.truncated,
		fullOutputPath: result.fullOutputPath,
		spawnError: result.spawnError,
		pipeline: result.pipeline,
	};

	return { contentText: lines.join("\n"), details };
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	const ops = options?.operations ?? createLocalBashOperations();
	const commandPrefix = options?.commandPrefix;
	const spawnHook = options?.spawnHook;

	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		parameters: bashSchema,
		execute: async (
			_toolCallId: string,
			{ command, timeout: _timeout }: { command: string; timeout?: number },
			signal?: AbortSignal,
			onUpdate?,
		) => {
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook);

			// Stream partial updates via the executor's onChunk callback
			const onChunk = (chunk: string) => {
				if (onUpdate) {
					const truncated = truncateTail(chunk);
					const details: BashToolDetails = {
						command: resolvedCommand,
						cwd: spawnContext.cwd,
						stdout: chunk,
						stderr: "",
						exitCode: undefined,
						startedAt: "",
						finishedAt: "",
						timedOut: false,
						cancelled: false,
						truncated: truncated.truncated,
						truncation: truncated.truncated ? truncated : undefined,
					};
					onUpdate({
						content: [{ type: "text", text: truncated.content || "" }],
						details,
					});
				}
			};

			const result = await executeBashWithOperations(spawnContext.command, spawnContext.cwd, ops, {
				onChunk,
				signal,
				timeout: _timeout,
			});

			const { contentText, details } = formatBashResultForModel(result, resolvedCommand, spawnContext.cwd);

			// Non-zero exit code, cancelled, timed out, or spawn error: reject so the
			// agent loop marks it isError=true. The error message carries the full
			// structured content so the model sees everything.
			const isError =
				(result.exitCode !== undefined && result.exitCode !== 0 && result.exitCode !== null) ||
				result.cancelled ||
				result.timedOut ||
				result.spawnError !== undefined;

			if (isError) {
				throw new Error(contentText);
			}

			return { content: [{ type: "text", text: contentText }], details };
		},
	};
}

/** Default bash tool using process.cwd() - for backwards compatibility */
export const bashTool = createBashTool(process.cwd());
