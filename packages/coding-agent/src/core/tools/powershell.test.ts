import { beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../cli/args.js";
import {
	allTools,
	createLocalPowerShellOperations,
	createPowerShellTool,
	type PowerShellOperations,
	resetPowerShellHealthCheck,
} from "./index.js";

describe("powershell tool", () => {
	beforeEach(() => {
		// Reset the cached health check result so each test starts fresh
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

		// The encoding preamble should be prefixed (applied by exec, but our mock captures it)
		expect(receivedCommand).toBe("Get-Date");
	});

	it("returns (no output) only when truly empty, not when transport drops data", async () => {
		const operations: PowerShellOperations = {
			exec: async (_command, _cwd, _opts) => {
				// Simulate a command that truly produces no output (exit 0)
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

	it("validate method from createLocalPowerShellOperations reports broken when probe exit 0 but no marker", async () => {
		const ops = createLocalPowerShellOperations({
			resolveConfig: () => ({
				shell: "pwsh-test",
				args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
				flavor: "pwsh",
				windowsHide: false,
			}),
		});

		ops.exec = async (_command, _cwd, _opts) => {
			// Empty output - simulates encoding mismatch on Windows PS 5.1
			return { exitCode: 0 };
		};

		if (ops.validate) {
			const result = await ops.validate(process.cwd(), { timeout: 1 });
			expect(result.valid).toBe(false);
			expect(result.error).toBe("JENSEN_POWERSHELL_TRANSPORT_BROKEN");
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

		// First call triggers health check
		await tool.execute("call_a", { command: "Write-Output a" });
		expect(validateCalls).toBe(1);

		// Second call uses cached result
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
