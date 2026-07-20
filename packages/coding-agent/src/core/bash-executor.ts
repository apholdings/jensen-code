/**
 * Bash command execution with streaming support and cancellation.
 *
 * This module provides a unified bash execution implementation used by:
 * - AgentSession.executeBash() for interactive and RPC modes
 * - Direct calls from modes that need bash execution
 */

import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import stripAnsi from "strip-ansi";
import { sanitizeBinaryOutput } from "../utils/shell.js";
import { type BashOperations, createLocalBashOperations } from "./tools/bash.js";
import { DEFAULT_MAX_BYTES, truncateTail } from "./tools/truncate.js";

// ============================================================================
// Types
// ============================================================================

export interface BashExecutorOptions {
	/** Callback for streaming output chunks (already sanitized) */
	onChunk?: (chunk: string) => void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
}

/**
 * Pipeline evidence metadata for commands executed as pipelines.
 * When a command uses pipes (|), the primary command's exit code may be
 * hidden by the last pipeline stage. This metadata preserves full pipeline
 * state so the agent can distinguish authoritative from non-authoritative results.
 */
export interface PipelineEvidence {
	/** Whether the command was a pipeline (contains | outside of quoting) */
	isPipeline: boolean;
	/** Exit code of the last pipeline stage (from the shell) */
	lastStageExitCode: number | null;
	/** Whether PIPESTATUS or equivalent was successfully captured */
	stageExitCodesKnown: boolean;
	/** Array of per-stage exit codes (empty if stageExitCodesKnown is false) */
	stageExitCodes: number[];
	/** Whether the overall exit code is authoritative for the primary command */
	evidenceAuthoritative: boolean;
}

export interface BashResult {
	/** Combined stdout + stderr output (sanitized, possibly truncated) */
	output: string;
	/** Separate stdout stream (empty string if no stdout was produced) */
	stdout: string;
	/** Separate stderr stream (empty string if no stderr was produced) */
	stderr: string;
	/** Process exit code (undefined if killed/cancelled/timedOut/spawnError) */
	exitCode: number | undefined;
	/** Whether the command was cancelled via signal */
	cancelled: boolean;
	/** Whether the command timed out */
	timedOut: boolean;
	/** Whether the output was truncated */
	truncated: boolean;
	/** Path to temp file containing full output (if output exceeded truncation threshold) */
	fullOutputPath?: string;
	/** ISO timestamp when command execution started */
	startedAt: string;
	/** ISO timestamp when command execution finished */
	finishedAt: string;
	/** Spawn error message if the process failed to start (e.g., executable not found) */
	spawnError?: string;
	/** Pipeline evidence metadata (set when the command is a pipeline) */
	pipeline?: PipelineEvidence;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Execute a bash command with optional streaming and cancellation support.
 *
 * Uses the same local BashOperations backend as createBashTool() so interactive
 * user bash and tool-invoked bash share the same process spawning behavior.
 * Sanitization, newline normalization, temp-file capture, and truncation still
 * happen in executeBashWithOperations(), so reusing the local backend does not
 * change output processing behavior.
 *
 * @param command - The bash command to execute
 * @param options - Optional streaming callback and abort signal
 * @returns Promise resolving to execution result
 */
export function executeBash(command: string, options?: BashExecutorOptions): Promise<BashResult> {
	return executeBashWithOperations(command, process.cwd(), createLocalBashOperations(), options);
}

/**
 * Detect whether a command string is a pipeline (contains | outside of quoting).
 * This is a best-effort check; shell escaping can defeat it, but for the
 * overwhelming majority of tool-invoked commands it is accurate.
 */
function detectPipeline(command: string): boolean {
	// Simple heuristic: count | characters not inside single or double quotes.
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		const prev = i > 0 ? command[i - 1] : null;
		if (ch === "'" && !inDouble && prev !== "\\") {
			inSingle = !inSingle;
		} else if (ch === '"' && !inSingle && prev !== "\\") {
			inDouble = !inDouble;
		} else if (ch === "|" && !inSingle && !inDouble) {
			return true;
		}
	}
	return false;
}

/**
 * Execute a bash command using custom BashOperations.
 * Used for remote execution (SSH, containers, etc.).
 */
export async function executeBashWithOperations(
	command: string,
	cwd: string,
	operations: BashOperations,
	options?: BashExecutorOptions,
): Promise<BashResult> {
	const startedAt = new Date().toISOString();
	const outputChunks: string[] = [];
	const stdoutChunks: string[] = [];
	const stderrChunks: string[] = [];
	let outputBytes = 0;
	const maxOutputBytes = DEFAULT_MAX_BYTES * 2;

	let tempFilePath: string | undefined;
	let tempFileStream: WriteStream | undefined;
	let totalBytes = 0;

	let spawnErr: string | undefined;
	const timedOut = false;
	const isPipeline = detectPipeline(command);

	const decoder = new TextDecoder();

	const onData = (data: Buffer) => {
		totalBytes += data.length;

		// Sanitize: strip ANSI, replace binary garbage, normalize newlines
		const text = sanitizeBinaryOutput(stripAnsi(decoder.decode(data, { stream: true }))).replace(/\r/g, "");

		// Start writing to temp file if exceeds threshold
		if (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
			const id = randomBytes(8).toString("hex");
			tempFilePath = join(tmpdir(), `pi-bash-${id}.log`);
			tempFileStream = createWriteStream(tempFilePath);
			for (const chunk of outputChunks) {
				tempFileStream.write(chunk);
			}
		}

		if (tempFileStream) {
			tempFileStream.write(text);
		}

		// Keep rolling buffer
		outputChunks.push(text);
		outputBytes += text.length;
		while (outputBytes > maxOutputBytes && outputChunks.length > 1) {
			const removed = outputChunks.shift()!;
			outputBytes -= removed.length;
		}

		// Stream to callback
		if (options?.onChunk) {
			options.onChunk(text);
		}
	};

	const onStdout = (data: Buffer) => {
		const text = sanitizeBinaryOutput(stripAnsi(decoder.decode(data, { stream: true }))).replace(/\r/g, "");
		stdoutChunks.push(text);
	};

	const onStderr = (data: Buffer) => {
		const text = sanitizeBinaryOutput(stripAnsi(decoder.decode(data, { stream: true }))).replace(/\r/g, "");
		stderrChunks.push(text);
	};

	try {
		const result = await operations.exec(command, cwd, {
			onData,
			onStdout,
			onStderr,
			signal: options?.signal,
		});

		if (tempFileStream) {
			tempFileStream.end();
		}

		const fullOutput = outputChunks.join("");
		const truncationResult = truncateTail(fullOutput);
		const cancelled = options?.signal?.aborted ?? false;
		const finishedAt = new Date().toISOString();

		// Build pipeline evidence from real PIPESTATUS data when available.
		// The backend (createLocalBashOperations) always captures PIPESTATUS
		// via fd 3. When pipelineData is present, it is authoritative.
		// When absent (e.g., remote operations), fall back to best-effort detection.
		const pipelineMeta: PipelineEvidence | undefined = (() => {
			if (result.pipelineData) {
				return {
					isPipeline: isPipeline,
					lastStageExitCode: result.exitCode,
					stageExitCodesKnown: result.pipelineData.stageExitCodesKnown,
					stageExitCodes: result.pipelineData.stageExitCodes,
					evidenceAuthoritative: result.pipelineData.evidenceAuthoritative,
				};
			}
			if (!isPipeline) return undefined;
			return {
				isPipeline: true,
				lastStageExitCode: result.exitCode,
				stageExitCodesKnown: false,
				stageExitCodes: [],
				evidenceAuthoritative: false,
			};
		})();

		return {
			output: truncationResult.truncated ? truncationResult.content : fullOutput,
			stdout: stdoutChunks.join(""),
			stderr: stderrChunks.join(""),
			exitCode: cancelled || timedOut ? undefined : (result.exitCode ?? undefined),
			cancelled,
			timedOut,
			truncated: truncationResult.truncated,
			fullOutputPath: tempFilePath,
			startedAt,
			finishedAt,
			spawnError: spawnErr,
			pipeline: pipelineMeta,
		};
	} catch (err) {
		if (tempFileStream) {
			tempFileStream.end();
		}

		// Check if it was an abort
		if (options?.signal?.aborted) {
			const fullOutput = outputChunks.join("");
			const truncationResult = truncateTail(fullOutput);
			const finishedAt = new Date().toISOString();
			const pipelineMeta: PipelineEvidence | undefined = isPipeline
				? {
						isPipeline: true,
						lastStageExitCode: null,
						stageExitCodesKnown: false,
						stageExitCodes: [],
						evidenceAuthoritative: false,
					}
				: undefined;

			return {
				output: truncationResult.truncated ? truncationResult.content : fullOutput,
				stdout: stdoutChunks.join(""),
				stderr: stderrChunks.join(""),
				exitCode: undefined,
				cancelled: true,
				timedOut: false,
				truncated: truncationResult.truncated,
				fullOutputPath: tempFilePath,
				startedAt,
				finishedAt,
				spawnError: undefined,
				pipeline: pipelineMeta,
			};
		}

		// Check if it was a timeout
		if (err instanceof Error && err.message.startsWith("timeout:")) {
			const fullOutput = outputChunks.join("");
			const truncationResult = truncateTail(fullOutput);
			const finishedAt = new Date().toISOString();
			const pipelineMeta: PipelineEvidence | undefined = isPipeline
				? {
						isPipeline: true,
						lastStageExitCode: null,
						stageExitCodesKnown: false,
						stageExitCodes: [],
						evidenceAuthoritative: false,
					}
				: undefined;

			return {
				output: truncationResult.truncated ? truncationResult.content : fullOutput,
				stdout: stdoutChunks.join(""),
				stderr: stderrChunks.join(""),
				exitCode: undefined,
				cancelled: false,
				timedOut: true,
				truncated: truncationResult.truncated,
				fullOutputPath: tempFilePath,
				startedAt,
				finishedAt,
				spawnError: undefined,
				pipeline: pipelineMeta,
			};
		}

		// Spawn error or other failure — propagate
		const finishedAt = new Date().toISOString();
		const fullOutput = outputChunks.join("");
		const truncationResult = truncateTail(fullOutput);

		return {
			output: truncationResult.truncated ? truncationResult.content : fullOutput,
			stdout: stdoutChunks.join(""),
			stderr: stderrChunks.join(""),
			exitCode: undefined,
			cancelled: false,
			timedOut: false,
			truncated: truncationResult.truncated,
			fullOutputPath: tempFilePath,
			startedAt,
			finishedAt,
			spawnError: err instanceof Error ? err.message : String(err),
			pipeline: undefined,
		};
	}
}
