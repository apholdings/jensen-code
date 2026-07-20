import { describe, expect, it } from "vitest";
import { type BashOperations, createBashTool } from "./bash.js";

describe("createBashTool", () => {
	it("returns structured cancellation instead of rejecting on abort", async () => {
		const controller = new AbortController();
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from("partial output"));
				controller.abort();
				throw new Error("aborted");
			},
		};

		const tool = createBashTool(process.cwd(), { operations });

		// Cancelled results throw as errors so the agent loop marks isError=true.
		// The model sees structured content in the error message.
		try {
			await tool.execute("call_1", { command: "sleep 1" }, controller.signal);
			expect.fail("should have thrown");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("cancelled: true");
			expect(msg).toContain("Command:");
			expect(msg).toContain("exit_code:");
		}
	});

	it("sanitizes streamed and final output with bash-executor parity", async () => {
		const updates: string[] = [];
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData, onStdout }) => {
				const data = Buffer.from("\u001b[31mred\u001b[0m\x00\u0007text\r\nnext\n");
				onData(data);
				onStdout?.(data);
				return { exitCode: 0 };
			},
		};

		const tool = createBashTool(process.cwd(), { operations });
		const result = await tool.execute("call_1", { command: "printf test" }, undefined, (partialResult) => {
			updates.push(partialResult.content[0]?.type === "text" ? partialResult.content[0].text : "");
		});

		// Partial updates stream sanitized content
		expect(updates).toEqual(["redtext\nnext\n"]);
		// Final content includes structured evidence with stdout section
		expect(result.content[0].type).toBe("text");
		const text = result.content[0].type === "text" ? result.content[0].text : "";
		expect(text).toContain("stdout:");
		expect(text).toContain("redtext\nnext");
		expect(text).toContain("exit_code: 0");
		// Details carry structured fields
		expect(result.details).toBeDefined();
		expect(result.details!.exitCode).toBe(0);
		expect(result.details!.stdout).toContain("redtext");
	});

	it("reports non-zero exit code as error with structured content", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onStdout }) => {
				onStdout?.(Buffer.from("SUCCESS-S04\n"));
				return { exitCode: 9 };
			},
		};

		const tool = createBashTool(process.cwd(), { operations });
		try {
			await tool.execute("call_1", { command: "exit 9" });
			expect.fail("should have thrown");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("Command:");
			expect(msg).toContain("stdout:");
			expect(msg).toContain("SUCCESS-S04");
			expect(msg).toContain("exit_code: 9");
		}
	});

	it("reports timed out as error with structured content", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from("partial\n"));
				throw new Error("timeout:5");
			},
		};

		const tool = createBashTool(process.cwd(), { operations });
		try {
			await tool.execute("call_1", { command: "sleep 10", timeout: 5 });
			expect.fail("should have thrown");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("timed_out: true");
		}
	});

	it("keeps stderr separate from stdout in model-facing content", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onStdout, onStderr }) => {
				onStdout?.(Buffer.from("OUT\n"));
				onStderr?.(Buffer.from("ERR\n"));
				return { exitCode: 0 };
			},
		};

		const tool = createBashTool(process.cwd(), { operations });
		const result = await tool.execute("call_1", { command: "both streams" });

		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("stdout:\nOUT");
		expect(text).toContain("stderr:\nERR");
		expect(result.details!.stdout).toBe("OUT\n");
		expect(result.details!.stderr).toBe("ERR\n");
		expect(result.details!.exitCode).toBe(0);
	});

	it("stderr with exit 0 is not classified as failure", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onStderr }) => {
				onStderr?.(Buffer.from("ONLY-STDERR\n"));
				return { exitCode: 0 };
			},
		};

		const tool = createBashTool(process.cwd(), { operations });
		const result = await tool.execute("call_1", { command: "stderr success" });

		// Should resolve (not throw) because exit code is 0
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("stderr:\nONLY-STDERR");
		expect(text).toContain("exit_code: 0");
		expect(result.details!.stderr).toContain("ONLY-STDERR");
		expect(result.details!.exitCode).toBe(0);
	});

	it("positive stdout with non-zero exit is classified as failure", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onStdout }) => {
				onStdout?.(Buffer.from("SUCCESS\n"));
				return { exitCode: 17 };
			},
		};

		const tool = createBashTool(process.cwd(), { operations });
		try {
			await tool.execute("call_1", { command: "stdout fail" });
			expect.fail("should have thrown");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("stdout:\nSUCCESS");
			expect(msg).toContain("exit_code: 17");
		}
	});

	it("stderr with non-zero exit is classified as failure", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onStderr }) => {
				onStderr?.(Buffer.from("FAILURE\n"));
				return { exitCode: 19 };
			},
		};

		const tool = createBashTool(process.cwd(), { operations });
		try {
			await tool.execute("call_1", { command: "stderr fail" });
			expect.fail("should have thrown");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("stderr:\nFAILURE");
			expect(msg).toContain("exit_code: 19");
		}
	});

	it("pipeline metadata reaches model-facing output", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onStderr: _onStderr }) => {
				return {
					exitCode: 1,
					pipelineData: {
						stageExitCodes: [1, 0],
						stageExitCodesKnown: true,
						evidenceAuthoritative: true,
					},
				};
			},
		};

		const tool = createBashTool(process.cwd(), { operations });
		try {
			await tool.execute("call_1", { command: "false | tail" });
			expect.fail("should have thrown for exit code 1");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("pipeline: true");
			expect(msg).toContain("pipeline_authoritative: true");
			expect(msg).toContain("pipeline_stage_exit_codes: [1, 0]");
		}
	});

	it("pipeline real stage exit codes are populated", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd) => {
				return {
					exitCode: 0,
					pipelineData: {
						stageExitCodes: [0, 0],
						stageExitCodesKnown: true,
						evidenceAuthoritative: true,
					},
				};
			},
		};

		const tool = createBashTool(process.cwd(), { operations });
		const result = await tool.execute("call_1", { command: "printf 'ok\n' | grep ok" });

		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("pipeline_stage_exit_codes: [0, 0]");
		expect(result.details!.pipeline).toBeDefined();
		expect(result.details!.pipeline!.stageExitCodes).toEqual([0, 0]);
		expect(result.details!.pipeline!.evidenceAuthoritative).toBe(true);
	});

	it("model-facing content contains all required evidence fields", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onStdout, onStderr }) => {
				onStdout?.(Buffer.from("out\n"));
				onStderr?.(Buffer.from("err\n"));
				return {
					exitCode: 0,
					pipelineData: {
						stageExitCodes: [0],
						stageExitCodesKnown: true,
						evidenceAuthoritative: true,
					},
				};
			},
		};

		const tool = createBashTool(process.cwd(), { operations });
		const result = await tool.execute("call_1", { command: "test" });

		const text = (result.content[0] as { type: "text"; text: string }).text;
		// Required fields
		expect(text).toContain("exit_code:");
		expect(text).toContain("timed_out:");
		expect(text).toContain("cancelled:");
		expect(text).toContain("truncated:");
		expect(text).toContain("stdout:");
		expect(text).toContain("stderr:");

		// Pipeline fields when pipeline data exists
		expect(text).toContain("pipeline_authoritative:");
		expect(text).toContain("pipeline_stage_exit_codes:");
	});

	it("spawn error reaches model-facing output", async () => {
		const operations: BashOperations = {
			exec: async () => {
				throw new Error("ENOENT: no such file or directory");
			},
		};

		const tool = createBashTool(process.cwd(), { operations });
		try {
			await tool.execute("call_1", { command: "nonexistent" });
			expect.fail("should have thrown");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("spawn_error:");
			expect(msg).toContain("ENOENT");
		}
	});
});
