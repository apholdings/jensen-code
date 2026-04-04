import { describe, expect, it } from "vitest";
import { parseArgs } from "../../cli/args.js";
import { allTools, createLocalPowerShellOperations, createPowerShellTool, type PowerShellOperations } from "./index.js";

describe("powershell tool", () => {
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
});
