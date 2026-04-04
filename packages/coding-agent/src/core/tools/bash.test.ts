import { describe, expect, it } from "vitest";
import { type BashOperations, createBashTool } from "./bash.js";

describe("createBashTool", () => {
	it("returns structured cancellation instead of rejecting on abort", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from("partial output"));
				throw new Error("aborted");
			},
		};

		const tool = createBashTool(process.cwd(), { operations });
		const result = await tool.execute("call_1", { command: "sleep 1" });

		expect(result.content).toEqual([{ type: "text", text: "partial output\n\nCommand aborted" }]);
		expect(result.details).toEqual({
			truncation: undefined,
			fullOutputPath: undefined,
			cancelled: true,
		});
	});

	it("sanitizes streamed and final output with bash-executor parity", async () => {
		const updates: string[] = [];
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from("\u001b[31mred\u001b[0m\x00\u0007text\r\nnext\n"));
				return { exitCode: 0 };
			},
		};

		const tool = createBashTool(process.cwd(), { operations });
		const result = await tool.execute("call_1", { command: "printf test" }, undefined, (partialResult) => {
			updates.push(partialResult.content[0]?.type === "text" ? partialResult.content[0].text : "");
		});

		expect(updates).toEqual(["redtext\nnext\n"]);
		expect(result.content).toEqual([{ type: "text", text: "redtext\nnext\n" }]);
		expect(result.details).toBeUndefined();
	});
});
