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

function getTempFilePath(): string {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `pi-powershell-${id}.log`);
}

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
}

export interface CreateLocalPowerShellOperationsOptions {
	resolveConfig?: () => PowerShellConfig;
}

export function createLocalPowerShellOperations(
	options: CreateLocalPowerShellOperationsOptions = {},
): PowerShellOperations {
	const resolveConfig = options.resolveConfig ?? getPowerShellConfig;

	return {
		exec: (command, cwd, { onData, signal, timeout, env }) => {
			return new Promise((resolve, reject) => {
				if (!existsSync(cwd)) {
					reject(new Error(`Working directory does not exist: ${cwd}\nCannot execute PowerShell commands.`));
					return;
				}

				let shellConfig: PowerShellConfig;
				try {
					shellConfig = resolveConfig();
				} catch (error) {
					reject(error instanceof Error ? error : new Error(String(error)));
					return;
				}

				const child = spawn(shellConfig.shell, [...shellConfig.args, command], {
					cwd,
					detached: true,
					env: env ?? getShellEnv(),
					stdio: ["ignore", "pipe", "pipe"],
				});

				let timedOut = false;
				let timeoutHandle: NodeJS.Timeout | undefined;
				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) {
							killProcessTree(child.pid);
						}
					}, timeout * 1000);
				}

				if (child.stdout) {
					child.stdout.on("data", onData);
				}
				if (child.stderr) {
					child.stderr.on("data", onData);
				}

				child.on("error", (err) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					if (signal) signal.removeEventListener("abort", onAbort);
					reject(err);
				});

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

					resolve({ exitCode: code });
				});
			});
		},
	};
}

export interface PowerShellToolOptions {
	operations?: PowerShellOperations;
}

export function createPowerShellTool(cwd: string, options?: PowerShellToolOptions): AgentTool<typeof powershellSchema> {
	const ops = options?.operations ?? createLocalPowerShellOperations();

	return {
		name: "powershell",
		label: "powershell",
		description: `Execute a PowerShell command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds. Windows-first: on non-Windows hosts this requires PowerShell 7+ (pwsh).`,
		parameters: powershellSchema,
		execute: async (
			_toolCallId: string,
			{ command, timeout }: PowerShellToolInput,
			signal?: AbortSignal,
			onUpdate?,
		) => {
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
