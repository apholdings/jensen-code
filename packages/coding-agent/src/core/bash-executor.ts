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
	/** Timeout in seconds (optional). When exceeded, the process tree is killed. */
	timeout?: number;
}

/**
 * Evidence metadata for every shell command execution.
 *
 * All commands receive this evidence block, not just pipelines. The exit code
 * returned by Bash represents the final status of the supplied source, but for
 * compound commands (sequences, functions, subshells, recovery operators) it
 * does not prove that every internal command succeeded.
 *
 * Stage exit codes are never captured from shared file descriptors because
 * those channels are observable and writable by the executed command itself.
 */
export interface BashEvidence {
	/** Whether the exit status is known. False for timeout, cancellation, and spawn errors. */
	exitStatusKnown: boolean;
	/** Whether the reported exit status faithfully reflects what Bash returned for the supplied source. */
	exitStatusAuthoritative: boolean;
	/**
	 * Authority scope for the exit code.
	 * - "final_shell_exit_status": command completed — exit code represents the final Bash status.
	 * - "final_pipeline_stage_only": pipeline suspected — exit code may represent only the last stage.
	 * - "no_exit_status": no exit code produced (timeout/cancellation).
	 * - "no_process_started": shell never spawned (spawn error).
	 */
	authorityScope: "final_shell_exit_status" | "final_pipeline_stage_only" | "no_exit_status" | "no_process_started";
	/** Always false: the internal status of each command within compound source is not tracked. */
	internalCommandStatusesKnown: false;
	/**
	 * Whether the evidence can be used for validation decisions.
	 * False for pipelines (stage exit codes unknown) and error states.
	 */
	validationEvidenceAuthoritative: boolean;
	/** Whether the command is suspected to contain a pipeline (contains | outside of quoting) */
	pipelineSuspected: boolean;
	/** Always false: stage exit codes are never known from untrusted channels */
	stageExitCodesKnown: false;
	/** The final shell exit code */
	finalShellExitCode: number | undefined;
	/** Warning message for the model when evidence is non-authoritative */
	warning?: string;
}

/**
 * Public result of a bash command execution.
 *
 * All fields added after 1.1.6 are optional in the public type for backward
 * compatibility with consumers that construct mocks, adapters, or fixtures
 * using the 1.1.6 shape. The runtime always produces every field.
 */
export interface BashResult {
	/** Combined stdout + stderr output (sanitized, possibly truncated) */
	output: string;
	/** Process exit code (undefined if killed/cancelled/timedOut/spawnError) */
	exitCode: number | undefined;
	/** Whether the command was cancelled via signal */
	cancelled: boolean;
	/** Whether the output was truncated */
	truncated: boolean;
	/** Path to temp file containing full output (if output exceeded truncation threshold) */
	fullOutputPath?: string;

	// --- Added in 1.1.7 (optional in public type; always present at runtime) ---

	/** Separate stdout stream (empty string if no stdout was produced) */
	stdout?: string;
	/** Separate stderr stream (empty string if no stderr was produced) */
	stderr?: string;
	/** Whether the command timed out */
	timedOut?: boolean;
	/** ISO timestamp when command execution started */
	startedAt?: string;
	/** ISO timestamp when command execution finished */
	finishedAt?: string;
	/** Spawn error message if the process failed to start (e.g., executable not found) */
	spawnError?: string;
	/** Evidence metadata for every execution (exit status, authority scope, pipeline flag) */
	evidence?: BashEvidence;
}

/**
 * Internal resolved type: every runtime-produced BashResult satisfies this
 * contract. The formatter and other internal consumers use this type so they
 * can rely on the fields being present without optional chaining, while the
 * public BashResult remains backward-compatible with the 1.1.6 surface.
 */
export interface ResolvedBashResult extends BashResult {
	stdout: string;
	stderr: string;
	timedOut: boolean;
	startedAt: string;
	finishedAt: string;
	evidence: BashEvidence;
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
 * Detect whether a command string is suspected to contain a pipeline.
 * This is a conservative heuristic prioritizing recall over precision.
 *
 * A false positive (flagging a non-pipeline as a pipeline) only causes
 * the model to see a non-authoritative warning — safe. A false negative
 * (missing a real pipeline) would incorrectly present an authoritative
 * exit code — dangerous.
 *
 * The detector checks for unquoted | characters, skipping || (OR operator).
 * Known false positives: quoted pipe-like patterns in complex bash constructs.
 * These are acceptable because they only produce non-authoritative warnings,
 * never false authoritative results.
 */
function suspectPipeline(command: string): boolean {
	// Two-pass detection:
	// Pass 1: Quick check — does the command contain | at all?
	// Pass 2: If yes, do quoting-aware scan to exclude quoted pipes.
	// Both passes are conservative: pass 1 may catch edge cases that
	// pass 2 would miss, so we run pass 1 first for recall.

	// Scan for unquoted | not part of ||, &&, or within quotes
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		const prev = i > 0 ? command[i - 1] : null;
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
		} else if (ch === '"' && !inSingle && prev !== "\\") {
			inDouble = !inDouble;
		} else if (ch === "|" && !inSingle && !inDouble) {
			// Skip || (OR operator) — two consecutive pipes
			if (i + 1 < command.length && command[i + 1] === "|") {
				i++;
				continue;
			}
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
	const pipelineSuspected = suspectPipeline(command);

	const WARNING_TEXT =
		"This command appears to contain a shell pipeline. The reported shell exit code may represent only the final pipeline stage. Do not use this result as authoritative validation. Re-run the validation command without a pipeline.";

	const COMPOUND_WARNING_TEXT =
		"The final Bash exit status is authoritative for its stated scope. It does not verify every internal command. For compound shell source (sequences, functions, subshells), exit code 0 does not prove all internal commands succeeded. Prefer direct single-command validation.";

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
			timeout: options?.timeout,
		});

		if (tempFileStream) {
			tempFileStream.end();
		}

		const fullOutput = outputChunks.join("");
		const truncationResult = truncateTail(fullOutput);
		const cancelled = options?.signal?.aborted ?? false;
		const finishedAt = new Date().toISOString();

		const exitCode = result.exitCode ?? undefined;

		const evidence: BashEvidence = pipelineSuspected
			? {
					exitStatusKnown: true,
					exitStatusAuthoritative: true,
					authorityScope: "final_pipeline_stage_only",
					internalCommandStatusesKnown: false,
					validationEvidenceAuthoritative: false,
					pipelineSuspected: true,
					stageExitCodesKnown: false,
					finalShellExitCode: exitCode,
					warning: WARNING_TEXT,
				}
			: {
					exitStatusKnown: true,
					exitStatusAuthoritative: true,
					authorityScope: "final_shell_exit_status",
					internalCommandStatusesKnown: false,
					validationEvidenceAuthoritative: true,
					pipelineSuspected: false,
					stageExitCodesKnown: false,
					finalShellExitCode: exitCode,
					warning: COMPOUND_WARNING_TEXT,
				};

		return {
			output: truncationResult.truncated ? truncationResult.content : fullOutput,
			stdout: stdoutChunks.join(""),
			stderr: stderrChunks.join(""),
			exitCode: cancelled || timedOut ? undefined : exitCode,
			cancelled,
			timedOut,
			truncated: truncationResult.truncated,
			fullOutputPath: tempFilePath,
			startedAt,
			finishedAt,
			spawnError: spawnErr,
			evidence,
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
			const evidence: BashEvidence = {
				exitStatusKnown: false,
				exitStatusAuthoritative: false,
				authorityScope: "no_exit_status",
				internalCommandStatusesKnown: false,
				validationEvidenceAuthoritative: false,
				pipelineSuspected,
				stageExitCodesKnown: false,
				finalShellExitCode: undefined,
			};

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
				evidence,
			};
		}

		// Check if it was a timeout
		if (err instanceof Error && err.message.startsWith("timeout:")) {
			const fullOutput = outputChunks.join("");
			const truncationResult = truncateTail(fullOutput);
			const finishedAt = new Date().toISOString();
			const evidence: BashEvidence = {
				exitStatusKnown: false,
				exitStatusAuthoritative: false,
				authorityScope: "no_exit_status",
				internalCommandStatusesKnown: false,
				validationEvidenceAuthoritative: false,
				pipelineSuspected,
				stageExitCodesKnown: false,
				finalShellExitCode: undefined,
			};

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
				evidence,
			};
		}

		// Spawn error or other failure — propagate
		const finishedAt = new Date().toISOString();
		const fullOutput = outputChunks.join("");
		const truncationResult = truncateTail(fullOutput);
		const spawnError = err instanceof Error ? err.message : String(err);
		const evidence: BashEvidence = {
			exitStatusKnown: false,
			exitStatusAuthoritative: false,
			authorityScope: "no_process_started",
			internalCommandStatusesKnown: false,
			validationEvidenceAuthoritative: false,
			pipelineSuspected: false,
			stageExitCodesKnown: false,
			finalShellExitCode: undefined,
		};

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
			spawnError,
			evidence,
		};
	}
}
