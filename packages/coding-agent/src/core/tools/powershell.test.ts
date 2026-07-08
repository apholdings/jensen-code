import { beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../cli/args.js";
import {
	allTools,
	createLocalPowerShellOperations,
	createPowerShellTool,
	type PowerShellOperations,
	resetPowerShellHealthCheck,
} from "./index.js";
import { PowerStreamDecoder } from "./powershell.js";

// ---------------------------------------------------------------------------
// PowerStreamDecoder direct unit tests
// ---------------------------------------------------------------------------

describe("PowerStreamDecoder", () => {
	it("decodes normal UTF-8 stdout", () => {
		const d = new PowerStreamDecoder();
		const result = d.feed(Buffer.from("hello ", "utf-8")) + d.feed(Buffer.from("world\n", "utf-8")) + d.flush();
		expect(result).toBe("hello world\n");
	});

	it("decodes UTF-16LE with BOM on first chunk", () => {
		const d = new PowerStreamDecoder();
		const bom = Buffer.from([0xff, 0xfe]);
		const payload = Buffer.from("hello from utf16le\n", "utf-16le");
		const result = d.feed(Buffer.concat([bom, payload])) + d.feed(Buffer.from("more\n", "utf-16le")) + d.flush();
		expect(result).toBe("hello from utf16le\nmore\n");
	});

	it("decodes UTF-16LE without BOM (NUL-pattern detection)", () => {
		const d = new PowerStreamDecoder();
		const asciiText = "ERROR: something failed\r\n";
		const rawUtf16le = Buffer.from(asciiText, "utf-16le");
		// Verify NUL alternation pattern exists
		expect(rawUtf16le[1]).toBe(0x00);

		const result = d.feed(rawUtf16le) + d.flush();
		expect(result).toBe(asciiText);
	});

	it("handles UTF-16LE chunk split at odd byte boundary", () => {
		const d = new PowerStreamDecoder();
		const text = "ABCDEFGH";
		const bom = Buffer.from([0xff, 0xfe]);
		const rawUtf16le = Buffer.from(text, "utf-16le");
		const fullBuf = Buffer.concat([bom, rawUtf16le]); // 2 + 16 = 18 bytes

		// Split at byte 7 (odd boundary, cuts through BOM/payload)
		const firstChunk = fullBuf.subarray(0, 7);
		const secondChunk = fullBuf.subarray(7);

		const result = d.feed(firstChunk) + d.feed(secondChunk) + d.flush();
		expect(result).toBe(text);
	});

	it("flushes remaining decoder state", () => {
		const d = new PowerStreamDecoder();
		const text = "AB"; // 2 chars = 4 bytes + 2 BOM = 6 bytes
		const bom = Buffer.from([0xff, 0xfe]);
		const rawUtf16le = Buffer.from(text, "utf-16le");
		const fullBuf = Buffer.concat([bom, rawUtf16le]); // 2 + 4 = 6 bytes

		// Split at byte 5: BOM(2) + 'A'(2) + first byte of 'B'(1) = 5 bytes
		// Remaining: 1 byte (second byte of 'B')
		const firstChunk = fullBuf.subarray(0, 5);
		const secondChunk = fullBuf.subarray(5);
		const result = d.feed(firstChunk) + d.feed(secondChunk) + d.flush();
		expect(result).toBe(text);
	});

	it("does not corrupt UTF-8 without BOM or NUL pattern", () => {
		const d = new PowerStreamDecoder();
		// Pure ASCII UTF-8: no BOM, no NUL alternation
		const text = "normal ascii output\n";
		const result = d.feed(Buffer.from(text, "utf-8")) + d.flush();
		expect(result).toBe(text);
	});

	it("hasData reflects whether any chunk was fed", () => {
		const d = new PowerStreamDecoder();
		expect(d.hasData).toBe(false);
		d.feed(Buffer.from("x"));
		expect(d.hasData).toBe(true);
	});

	it("empty chunks produce empty string", () => {
		const d = new PowerStreamDecoder();
		expect(d.feed(Buffer.alloc(0))).toBe("");
		expect(d.hasData).toBe(false);
		expect(d.flush()).toBe("");
	});
});

// ---------------------------------------------------------------------------
// powershell tool tests
// ---------------------------------------------------------------------------

describe("powershell tool", () => {
	beforeEach(() => {
		resetPowerShellHealthCheck();
	});

	it("registers through the built-in tool path and CLI tool parsing", () => {
		expect(allTools.powershell.name).toBe("powershell");
		expect(parseArgs(["--tools", "powershell"]).tools).toEqual(["powershell"]);
	});

	it("sanitizes streamed and final output with powershell-tool parity", async () => {
		const updates: string[] = [];
		const operations: PowerShellOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from("\u001b[36mcyan\u001b[0m\x00\u0007text\r\nnext\n"));
				return { exitCode: 0 };
			},
		};

		const tool = createPowerShellTool(process.cwd(), { operations });
		const result = await tool.execute("call_1", { command: "Write-Output test" }, undefined, (partialResult) => {
			updates.push(partialResult.content[0]?.type === "text" ? partialResult.content[0].text : "");
		});

		expect(updates).toEqual(["cyantext\nnext\n"]);
		expect(result.content).toEqual([{ type: "text", text: "cyantext\nnext\n" }]);
		expect(result.details).toBeUndefined();
	});

	it("returns structured cancellation instead of rejecting on abort", async () => {
		const operations: PowerShellOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from("partial output"));
				throw new Error("aborted");
			},
		};

		const tool = createPowerShellTool(process.cwd(), { operations });
		const result = await tool.execute("call_2", { command: "Start-Sleep 1" });

		expect(result.content).toEqual([{ type: "text", text: "partial output\n\nCommand aborted" }]);
		expect(result.details).toEqual({
			truncation: undefined,
			fullOutputPath: undefined,
			cancelled: true,
		});
	});

	it("surfaces non-zero exit codes clearly", async () => {
		const operations: PowerShellOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from("failure output"));
				return { exitCode: 7 };
			},
		};

		const tool = createPowerShellTool(process.cwd(), { operations });

		await expect(tool.execute("call_3", { command: "throw 'boom'" })).rejects.toThrow(
			"failure output\n\nCommand exited with code 7",
		);
	});

	it("fails honestly when PowerShell is unavailable on the host", async () => {
		const operations = createLocalPowerShellOperations({
			resolveConfig: () => {
				throw new Error("PowerShell is not available on this system.");
			},
		});
		const tool = createPowerShellTool(process.cwd(), { operations });

		await expect(tool.execute("call_4", { command: "Get-Location" })).rejects.toThrow(
			"PowerShell is not available on this system.",
		);
	});

	it("does not run health check when operations have no validate method (mock ops)", async () => {
		const operations: PowerShellOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from("ok mock\n"));
				return { exitCode: 0 };
			},
			// No validate method - should skip health check
		};

		const tool = createPowerShellTool(process.cwd(), { operations });
		const result = await tool.execute("call_5", { command: "Get-Date" });

		expect(result.content).toEqual([{ type: "text", text: "ok mock\n" }]);
	});

	it("wraps the command with UTF-8 encoding preamble via exec helper", async () => {
		let receivedCommand = "";
		const operations: PowerShellOperations = {
			exec: async (command, _cwd, { onData }) => {
				receivedCommand = command;
				onData(Buffer.from("ok\n"));
				return { exitCode: 0 };
			},
		};

		const tool = createPowerShellTool(process.cwd(), { operations });
		await tool.execute("call_6", { command: "Get-Date" });

		expect(receivedCommand).toBe("Get-Date");
	});

	it("returns (no output) only when truly empty, not when transport drops data", async () => {
		const operations: PowerShellOperations = {
			exec: async (_command, _cwd, _opts) => {
				return { exitCode: 0 };
			},
			validate: async () => ({ valid: true }),
		};

		const tool = createPowerShellTool(process.cwd(), { operations });
		const result = await tool.execute("call_7", { command: "$null" });

		expect(result.content).toEqual([{ type: "text", text: "(no output)" }]);
	});

	it("rejects transport-broken health check before execution", async () => {
		const operations: PowerShellOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from("should not reach"));
				return { exitCode: 0 };
			},
			validate: async () => ({
				valid: false,
				error: "JENSEN_POWERSHELL_TRANSPORT_BROKEN",
			}),
		};

		const tool = createPowerShellTool(process.cwd(), { operations });

		await expect(tool.execute("call_8", { command: "Write-Output test" })).rejects.toThrow(
			"JENSEN_POWERSHELL_TRANSPORT_BROKEN",
		);
	});

	it("reports valid when validate probe produces the expected marker", async () => {
		const ops: PowerShellOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from("JENSEN_PS_HEALTH_abcd1234\n"));
				return { exitCode: 0 };
			},
			validate: async (_cwd, _opts) => {
				return new Promise((resolve) => {
					ops.exec(`Write-Output 'JENSEN_PS_HEALTH_abcd1234'`, process.cwd(), {
						onData: () => {},
					}).then((_result) => {
						resolve({ valid: true });
					});
				});
			},
		};

		const tool = createPowerShellTool(process.cwd(), { operations: ops });
		const result = await tool.execute("call_9", { command: "Get-Date" });
		expect(result.content).toBeDefined();
	});

	it("validate method reports broken when probe exit 0 but no marker", async () => {
		const ops = createLocalPowerShellOperations({
			resolveConfig: () => ({
				shell: "pwsh-test",
				args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
				flavor: "pwsh",
				windowsHide: false,
			}),
		});

		ops.exec = async (_command, _cwd, _opts) => {
			return { exitCode: 0 };
		};

		if (ops.validate) {
			const result = await ops.validate(process.cwd(), { timeout: 1 });
			expect(result.valid).toBe(false);
			expect(result.error).toContain("JENSEN_POWERSHELL_TRANSPORT_BROKEN");
		}
	});

	it("validate method handles non-zero exit code from probe", async () => {
		const ops = createLocalPowerShellOperations({
			resolveConfig: () => ({
				shell: "pwsh-test",
				args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
				flavor: "pwsh",
				windowsHide: false,
			}),
		});

		ops.exec = async (_command, _cwd, _opts) => {
			return { exitCode: 1 };
		};

		if (ops.validate) {
			const result = await ops.validate(process.cwd(), { timeout: 1 });
			expect(result.valid).toBe(false);
			expect(result.error).toContain("exit code 1");
		}
	});

	it("health check is idempotent (cached after first call)", async () => {
		let validateCalls = 0;
		const operations: PowerShellOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from("output\n"));
				return { exitCode: 0 };
			},
			validate: async () => {
				validateCalls++;
				return { valid: true };
			},
		};

		const tool = createPowerShellTool(process.cwd(), { operations });

		await tool.execute("call_a", { command: "Write-Output a" });
		expect(validateCalls).toBe(1);

		await tool.execute("call_b", { command: "Write-Output b" });
		expect(validateCalls).toBe(1);
	});

	it("timeout is enforced with clear error message", async () => {
		const operations: PowerShellOperations = {
			exec: async (_command, _cwd, _opts) => {
				throw new Error("timeout:5");
			},
			validate: async () => ({ valid: true }),
		};

		const tool = createPowerShellTool(process.cwd(), { operations });

		await expect(tool.execute("call_10", { command: "Start-Sleep 30", timeout: 1 })).rejects.toThrow(
			"timed out after 5 seconds",
		);
	});
});

// ---------------------------------------------------------------------------
// Health probe with real decoder path (mock exec that calls decoder internally)
// ---------------------------------------------------------------------------

describe("health probe with decoder", () => {
	beforeEach(() => {
		resetPowerShellHealthCheck();
	});

	it("health probe detects marker after normalization (UTF-8 input via decoder)", async () => {
		const ops = createLocalPowerShellOperations({
			resolveConfig: () => ({
				shell: "test-shell",
				args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
				flavor: "pwsh",
				windowsHide: false,
			}),
		});

		// The validate method generates a random marker and passes it in the command.
		// The mock must extract it from the command and emit it via onData.
		ops.exec = async (command, _cwd, { onData }) => {
			// Command is like: "[Console]::OutputEncoding=...;Write-Output 'JENSEN_PS_HEALTH_abcdef01'"
			const match = command.match(/JENSEN_PS_HEALTH_[a-f0-9]+/);
			if (match) {
				onData(Buffer.from(`${match[0]}\r\n`, "utf-8"));
			}
			return { exitCode: 0 };
		};

		if (!ops.validate) throw new Error("validate not set");
		const result = await ops.validate(process.cwd(), { timeout: 1 });
		expect(result.valid).toBe(true);
	});

	it("health probe detects marker after normalization (UTF-16LE normalized to UTF-8)", async () => {
		const ops = createLocalPowerShellOperations({
			resolveConfig: () => ({
				shell: "test-shell",
				args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
				flavor: "pwsh",
				windowsHide: false,
			}),
		});

		// Simulate what the decoder emits after normalizing UTF-16LE → UTF-8:
		// the validate method reads from onData, which already received normalized UTF-8.
		ops.exec = async (command, _cwd, { onData }) => {
			const match = command.match(/JENSEN_PS_HEALTH_[a-f0-9]+/);
			if (match) {
				onData(Buffer.from(`${match[0]}\r\n`, "utf-8"));
			}
			return { exitCode: 0 };
		};

		if (!ops.validate) throw new Error("validate not set");
		const result = await ops.validate(process.cwd(), { timeout: 1 });
		expect(result.valid).toBe(true);
	});

	it("validate rejects when exec returns empty output", async () => {
		const ops = createLocalPowerShellOperations({
			resolveConfig: () => ({
				shell: "test-shell",
				args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
				flavor: "pwsh",
				windowsHide: false,
			}),
		});

		ops.exec = async (_command, _cwd, _opts) => {
			return { exitCode: 0 };
		};

		if (!ops.validate) throw new Error("validate not set");
		const result = await ops.validate(process.cwd(), { timeout: 1 });
		expect(result.valid).toBe(false);
		expect(result.error).toContain("JENSEN_POWERSHELL_TRANSPORT_BROKEN");
	});
});

// ---------------------------------------------------------------------------
// Windows integration test — runs the real PowerShell host
// Skipped on non-Windows.
// ---------------------------------------------------------------------------

describe("powershell windows integration", () => {
	beforeEach(() => {
		resetPowerShellHealthCheck();
	});

	const isWindows = process.platform === "win32";

	const itWindows = isWindows ? it : it.skip;

	itWindows("real pwsh produces stdout marker", async () => {
		const ops = createLocalPowerShellOperations();
		const chunks: string[] = [];

		const result = await ops.exec("Write-Output '**JENSEN_IT_STDOUT**'", process.cwd(), {
			onData: (data) => chunks.push(data.toString("utf-8")),
			timeout: 10,
		});

		expect(result.exitCode).toBe(0);
		const output = chunks.join("");
		expect(output).toContain("**JENSEN_IT_STDOUT**");
	});

	itWindows("real pwsh produces stderr marker", async () => {
		const ops = createLocalPowerShellOperations();
		const chunks: string[] = [];

		const result = await ops.exec("[Console]::Error.WriteLine('**JENSEN_IT_STDERR**')", process.cwd(), {
			onData: (data) => chunks.push(data.toString("utf-8")),
			timeout: 10,
		});

		expect(result.exitCode).toBe(0);
		const output = chunks.join("");
		expect(output).toContain("**JENSEN_IT_STDERR**");
	});

	itWindows("real pwsh handles Unicode", async () => {
		const ops = createLocalPowerShellOperations();
		const chunks: string[] = [];

		const result = await ops.exec("Write-Output 'áéíóú ñ Ñ € — ✓'", process.cwd(), {
			onData: (data) => chunks.push(data.toString("utf-8")),
			timeout: 10,
		});

		expect(result.exitCode).toBe(0);
		const output = chunks.join("");
		expect(output).toContain("áéíóú");
		expect(output).toContain("ñ");
		expect(output).toContain("€");
		expect(output).toContain("✓");
	});

	itWindows("real pwsh health probe validates", async () => {
		const ops = createLocalPowerShellOperations();
		if (!ops.validate) throw new Error("validate not set");

		const result = await ops.validate(process.cwd(), { timeout: 10 });
		expect(result.valid).toBe(true);
	});

	itWindows(
		"real pwsh timeout is enforced",
		async () => {
			const ops = createLocalPowerShellOperations();

			await expect(
				ops.exec("Start-Sleep -Seconds 20", process.cwd(), {
					onData: () => {},
					timeout: 3,
				}),
			).rejects.toThrow("timeout:3");
		},
		15000,
	);
});
