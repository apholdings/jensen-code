import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@apholdings/jensen-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { spawn } from "child_process";
import stripAnsi from "strip-ansi";
import {
	getPowerShellConfig,
	getShellEnv,
	killProcessTree,
	type PowerShellConfig,
	sanitizeBinaryOutput,
} from "../../utils/shell.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateTail } from "./truncate.js";

/**
 * Stateful stream decoder that normalizes PowerShell output to UTF-8.
 *
 * PowerShell may emit UTF-16LE (with or without BOM) or UTF-8 depending on
 * the host version and whether the encoding preamble takes effect.
 * This decoder detects the encoding on the first non-empty chunk and
 * decodes consistently across arbitrary chunk boundaries using TextDecoder.
 *
 * @internal Exported for testing.
 */
export class PowerStreamDecoder {
	private decoder: InstanceType<typeof TextDecoder> | null = null;
	private encoding: "utf-8" | "utf-16le" | null = null;
	private haveReadFirstChunk = false;

	/**
	 * Detect encoding from the first bytes of the stream.
	 * Returns "utf-16le" if a BOM or NUL-alternation pattern is found,
	 * "utf-8" otherwise.
	 */
	private detectEncoding(chunk: Buffer): "utf-8" | "utf-16le" {
		// UTF-16LE BOM
		if (chunk.length >= 2 && chunk[0] === 0xff && chunk[1] === 0xfe) {
			return "utf-16le";
		}
		// NUL-alternation pattern: ASCII text in UTF-16LE has every other byte = 0x00.
		// Check first N bytes where N = min(chunk.length, 32).
		const sampleLen = Math.min(chunk.length, 32);
		let nulCount = 0;
		for (let i = 1; i < sampleLen; i += 2) {
			if (chunk[i] === 0x00) nulCount++;
		}
		// If >70% of odd bytes are NUL, it's likely UTF-16LE.
		const oddBytes = Math.floor(sampleLen / 2);
		if (oddBytes >= 4 && nulCount / oddBytes > 0.7) {
			return "utf-16le";
		}
		return "utf-8";
	}

	/** Feed a chunk. Returns decoded UTF-8 string, or "" if nothing to emit. */
	feed(chunk: Buffer): string {
		if (chunk.length === 0) return "";

		if (!this.haveReadFirstChunk) {
			this.haveReadFirstChunk = true;
			this.encoding = this.detectEncoding(chunk);
			this.decoder = new TextDecoder(this.encoding, { fatal: false });
		}

		// If encoding is UTF-16LE and chunk starts with BOM, skip it.
		// The BOM is only present on the very first chunk.
		if (this.encoding === "utf-16le" && chunk.length >= 2 && chunk[0] === 0xff && chunk[1] === 0xfe) {
			chunk = chunk.subarray(2);
		}

		if (chunk.length === 0) return "";
		return this.decoder!.decode(chunk, { stream: true });
	}

	/** Flush any remaining decoder state. Call once when the stream closes. */
	flush(): string {
		if (!this.decoder) return "";
		return this.decoder.decode(undefined, { stream: false });
	}

	/** Whether any data has been fed to this decoder. */
	get hasData(): boolean {
		return this.haveReadFirstChunk;
	}
}

function getTempFilePath(): string {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `pi-powershell-${id}.log`);
}

/**
 * Encode a PowerShell command as UTF-16LE base64 for use with -EncodedCommand.
 * This avoids all quoting and encoding issues across PowerShell versions.
 */
function encodePowerShellCommand(command: string): string {
	return Buffer.from(command, "utf-16le").toString("base64");
}

/**
 * UTF-8 encoding preamble forced before every user command.
 * On Windows PowerShell 5.1, stdout defaults to the system OEM code page
 * when writing to a pipe, which causes TextDecoder("utf-8") to produce garbled output.
 * This preamble forces UTF-8 output encoding on all PowerShell versions.
 */
const ENCODING_PREAMBLE = "[Console]::OutputEncoding=[Text.Encoding]::UTF8;$OutputEncoding=[Text.Encoding]::UTF8;";

const powershellSchema = Type.Object({
	command: Type.String({ description: "PowerShell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export type PowerShellToolInput = Static<typeof powershellSchema>;

export interface PowerShellToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
	cancelled?: boolean;
}

export interface PowerShellValidateResult {
	valid: boolean;
	error?: string;
}

export interface PowerShellOperations {
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;

	/**
	 * Validate that the PowerShell transport works correctly.
	 * Runs a probe command and verifies stdout is properly captured.
	 * If the probe returns exit 0 but no stdout marker, the transport is broken
	 * (likely encoding mismatch on Windows PowerShell 5.1).
	 */
	validate?: (cwd: string, options: { signal?: AbortSignal; timeout?: number }) => Promise<PowerShellValidateResult>;
}

export interface CreateLocalPowerShellOperationsOptions {
	resolveConfig?: () => PowerShellConfig;
}

/**
 * Low-level PowerShell spawn helper. Used by both exec and validate.
 */
function spawnRawPowerShell(
	resolveConfig: () => PowerShellConfig,
	wrappedCommand: string,
	cwd: string,
	spawnEnv: NodeJS.ProcessEnv | undefined,
): ReturnType<typeof spawn> {
	const shellConfig = resolveConfig();
	// Strip -Command from args (last element) and replace with -EncodedCommand + base64
	const baseArgs = shellConfig.args.slice(0, -1);
	const encoded = encodePowerShellCommand(wrappedCommand);
	const spawnArgs = [...baseArgs, "-EncodedCommand", encoded];

	// NOTE: detached: true breaks stdout/stderr capture on pwsh 7.x (streams
	// are disconnected from the parent process). killProcessTree uses taskkill /T
	// on Windows, which terminates the entire tree without requiring detached.
	// Evidence from byte-probe: detached=false → clean UTF-8 output; detached=true → empty.
	return spawn(shellConfig.shell, spawnArgs, {
		cwd,
		shell: false,
		detached: false,
		windowsHide: shellConfig.windowsHide,
		env: spawnEnv ?? getShellEnv(),
		stdio: ["ignore", "pipe", "pipe"],
	});
}

/**
 * Generic exec helper: spawns PowerShell and resolves/rejects based on lifecycle.
 */
function execPowerShell(
	resolveConfig: () => PowerShellConfig,
	command: string,
	cwd: string,
	options: {
		onData: (data: Buffer) => void;
		signal?: AbortSignal;
		timeout?: number;
		env?: NodeJS.ProcessEnv;
	},
): Promise<{ exitCode: number | null }> {
	return new Promise((resolve, reject) => {
		if (!existsSync(cwd)) {
			reject(new Error(`Working directory does not exist: ${cwd}\nCannot execute PowerShell commands.`));
			return;
		}

		// Pre-validate config resolution (spawnRawPowerShell also validates, but we want
		// a clear error before spawning)
		try {
			resolveConfig();
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
			return;
		}

		const wrappedCommand = `${ENCODING_PREAMBLE}${command}`;
		const child = spawnRawPowerShell(resolveConfig, wrappedCommand, cwd, options.env);

		let timedOut = false;
		let timeoutHandle: NodeJS.Timeout | undefined;
		if (options.timeout !== undefined && options.timeout > 0) {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				if (child.pid) {
					killProcessTree(child.pid);
				}
			}, options.timeout * 1000);
		}

		// Use separate stateful decoders per stream to normalize PowerShell
		// output to UTF-8 regardless of whether the host emits UTF-8 or UTF-16LE.
		// Both streams emit to the same onData callback but are decoded independently.
		const stdoutDecoder = new PowerStreamDecoder();
		const stderrDecoder = new PowerStreamDecoder();

		if (child.stdout) {
			child.stdout.on("data", (chunk: Buffer) => {
				const text = stdoutDecoder.feed(chunk);
				if (text.length > 0) {
					options.onData(Buffer.from(text, "utf-8"));
				}
			});
		}
		if (child.stderr) {
			child.stderr.on("data", (chunk: Buffer) => {
				const text = stderrDecoder.feed(chunk);
				if (text.length > 0) {
					options.onData(Buffer.from(text, "utf-8"));
				}
			});
		}

		// Flush decoders on close to emit any remaining buffered bytes
		child.on("close", () => {
			const stdoutFlush = stdoutDecoder.flush();
			if (stdoutFlush.length > 0) {
				options.onData(Buffer.from(stdoutFlush, "utf-8"));
			}
			const stderrFlush = stderrDecoder.flush();
			if (stderrFlush.length > 0) {
				options.onData(Buffer.from(stderrFlush, "utf-8"));
			}
		});

		child.on("error", (err) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (options.signal) options.signal.removeEventListener("abort", onAbort);
			reject(err);
		});

		const onAbort = () => {
			if (child.pid) {
				killProcessTree(child.pid);
			}
		};

		if (options.signal) {
			if (options.signal.aborted) {
				onAbort();
			} else {
				options.signal.addEventListener("abort", onAbort, { once: true });
			}
		}

		child.on("close", (code) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (options.signal) options.signal.removeEventListener("abort", onAbort);

			if (options.signal?.aborted) {
				reject(new Error("aborted"));
				return;
			}

			if (timedOut) {
				reject(new Error(`timeout:${options.timeout}`));
				return;
			}

			resolve({ exitCode: code });
		});
	});
}

export function createLocalPowerShellOperations(
	options: CreateLocalPowerShellOperationsOptions = {},
): PowerShellOperations {
	const resolveConfig = options.resolveConfig ?? getPowerShellConfig;

	const ops: PowerShellOperations = {
		exec: (command, cwd, execOptions) => execPowerShell(resolveConfig, command, cwd, execOptions),

		validate: (cwd, { signal, timeout }) => {
			return new Promise((resolve) => {
				const marker = `JENSEN_PS_HEALTH_${randomBytes(4).toString("hex")}`;
				const probeCommand = `Write-Output '${marker}'`;
				let rawOutput = "";

				ops.exec(probeCommand, cwd, {
					// onData already receives normalized UTF-8 buffers from the decoders
					onData: (data) => {
						rawOutput += data.toString("utf-8");
					},
					signal,
					timeout: timeout ?? 10,
					env: getShellEnv(),
				})
					.then(({ exitCode }) => {
						if (exitCode === 0 && rawOutput.includes(marker)) {
							resolve({ valid: true });
						} else if (exitCode === 0 && !rawOutput.includes(marker)) {
							resolve({
								valid: false,
								error:
									"JENSEN_POWERSHELL_TRANSPORT_BROKEN. " +
									"The PowerShell host ran successfully but did not produce the expected health probe marker. " +
									`Output length: ${rawOutput.length} bytes. ` +
									"Likely causes: detached process disconnecting streams, encoding mismatch that survived normalization, " +
									"or PowerShell host producing output on a channel not captured by stdout/stderr pipes.",
							});
						} else {
							resolve({
								valid: false,
								error: `Health probe failed with exit code ${exitCode}. Output: ${rawOutput.slice(0, 200)}`,
							});
						}
					})
					.catch((err: Error) => {
						resolve({
							valid: false,
							error: `Health probe error: ${err.message}`,
						});
					});
			});
		},
	};

	return ops;
}

export interface PowerShellToolOptions {
	operations?: PowerShellOperations;
}

/**
 * Lazily-tracked health check: only runs once per process lifetime.
 * Reset via resetPowerShellHealthCheck() for testing.
 */
let healthCheckResult: PowerShellValidateResult | undefined;

export function resetPowerShellHealthCheck(): void {
	healthCheckResult = undefined;
}

function ensureHealthCheck(ops: PowerShellOperations, cwd: string): Promise<PowerShellValidateResult | undefined> {
	// If already validated, skip
	if (healthCheckResult !== undefined) {
		return Promise.resolve(healthCheckResult);
	}

	// If no validate method, skip (mock operations)
	if (!ops.validate) {
		return Promise.resolve(undefined);
	}

	return ops.validate(cwd, { timeout: 10 }).then((result) => {
		healthCheckResult = result;
		return result;
	});
}

export function createPowerShellTool(cwd: string, options?: PowerShellToolOptions): AgentTool<typeof powershellSchema> {
	const ops = options?.operations ?? createLocalPowerShellOperations();

	return {
		name: "powershell",
		label: "powershell",
		description: `Execute a PowerShell command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds. On Windows, prefers PowerShell 7 (pwsh) and falls back to Windows PowerShell when needed. On non-Windows hosts, this requires PowerShell 7+ (pwsh).`,
		parameters: powershellSchema,
		execute: async (
			_toolCallId: string,
			{ command, timeout }: PowerShellToolInput,
			signal?: AbortSignal,
			onUpdate?,
		) => {
			// Run health check on first invocation
			const health = await ensureHealthCheck(ops, cwd);
			if (health && !health.valid) {
				throw new Error(`PowerShell transport validation failed: ${health.error}`);
			}

			return new Promise((resolve, reject) => {
				let tempFilePath: string | undefined;
				let tempFileStream: ReturnType<typeof createWriteStream> | undefined;
				let totalBytes = 0;
				const chunks: string[] = [];
				let chunksBytes = 0;
				const maxChunksBytes = DEFAULT_MAX_BYTES * 2;
				const decoder = new TextDecoder();

				const handleData = (data: Buffer) => {
					totalBytes += data.length;

					const text = sanitizeBinaryOutput(stripAnsi(decoder.decode(data, { stream: true }))).replace(/\r/g, "");

					if (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
						tempFilePath = getTempFilePath();
						tempFileStream = createWriteStream(tempFilePath);
						for (const chunk of chunks) {
							tempFileStream.write(chunk);
						}
					}

					if (tempFileStream) {
						tempFileStream.write(text);
					}

					chunks.push(text);
					chunksBytes += text.length;

					while (chunksBytes > maxChunksBytes && chunks.length > 1) {
						const removed = chunks.shift();
						if (removed) {
							chunksBytes -= removed.length;
						}
					}

					if (onUpdate) {
						const fullText = chunks.join("");
						const truncation = truncateTail(fullText);
						onUpdate({
							content: [{ type: "text", text: truncation.content || "" }],
							details: {
								truncation: truncation.truncated ? truncation : undefined,
								fullOutputPath: tempFilePath,
							},
						});
					}
				};

				ops.exec(command, cwd, {
					onData: handleData,
					signal,
					timeout,
					env: getShellEnv(),
				})
					.then(({ exitCode }) => {
						if (tempFileStream) {
							tempFileStream.end();
						}

						const fullOutput = chunks.join("");
						const truncation = truncateTail(fullOutput);
						let outputText = truncation.content || "(no output)";
						let details: PowerShellToolDetails | undefined;

						if (truncation.truncated) {
							details = {
								truncation,
								fullOutputPath: tempFilePath,
							};

							const startLine = truncation.totalLines - truncation.outputLines + 1;
							const endLine = truncation.totalLines;

							if (truncation.lastLinePartial) {
								const lastLineSize = formatSize(Buffer.byteLength(fullOutput.split("\n").pop() || "", "utf-8"));
								outputText += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${tempFilePath}]`;
							} else if (truncation.truncatedBy === "lines") {
								outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${tempFilePath}]`;
							} else {
								outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${tempFilePath}]`;
							}
						}

						if (exitCode !== 0 && exitCode !== null) {
							outputText += `\n\nCommand exited with code ${exitCode}`;
							reject(new Error(outputText));
						} else {
							resolve({ content: [{ type: "text", text: outputText }], details });
						}
					})
					.catch((err: Error) => {
						if (tempFileStream) {
							tempFileStream.end();
						}

						let output = chunks.join("");

						if (err.message === "aborted") {
							if (output) output += "\n\n";
							output += "Command aborted";
							const truncation = truncateTail(output);
							resolve({
								content: [{ type: "text", text: truncation.content || "Command aborted" }],
								details: {
									truncation: truncation.truncated ? truncation : undefined,
									fullOutputPath: tempFilePath,
									cancelled: true,
								},
							});
						} else if (err.message.startsWith("timeout:")) {
							const timeoutSecs = err.message.split(":")[1];
							if (output) output += "\n\n";
							output += `Command timed out after ${timeoutSecs} seconds`;
							reject(new Error(output));
						} else {
							reject(err);
						}
					});
			});
		},
	};
}

export const powershellTool = createPowerShellTool(process.cwd());
