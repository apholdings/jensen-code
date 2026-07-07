import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProcessManagerTool, type ProcessManagerOperations } from "./process-manager.js";

const TEST_REGISTRY_DIR = join(tmpdir(), "jensen-process-registry");

function cleanRegistry(): void {
	if (existsSync(TEST_REGISTRY_DIR)) {
		rmSync(TEST_REGISTRY_DIR, { recursive: true, force: true });
	}
	mkdirSync(TEST_REGISTRY_DIR, { recursive: true });
}

describe("process manager tool", () => {
	beforeEach(() => {
		cleanRegistry();
	});

	afterEach(() => {
		cleanRegistry();
	});

	function mockOps(stdoutResponses: string[]): ProcessManagerOperations {
		let callIndex = 0;
		return {
			execPowerShell: async (_command, _cwd, _opts) => {
				const stdout = stdoutResponses[callIndex] ?? "";
				callIndex++;
				return { exitCode: 0, stdout, stderr: "" };
			},
		};
	}

	it("list returns empty when no processes", async () => {
		const ops = mockOps([]);
		const tool = createProcessManagerTool(process.cwd(), { operations: ops });
		const result = await tool.execute("call_1", { action: "list" as const });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toBe("No managed processes.");
	});

	it("start fails when missing command", async () => {
		const ops = mockOps([]);
		const tool = createProcessManagerTool(process.cwd(), { operations: ops });
		await expect(
			tool.execute("call_2", { action: "start" as const, command: undefined as unknown as string }),
		).rejects.toThrow("command is required");
	});

	it("start registers a process and returns run ID and PID", async () => {
		// Responses: start script, alive check, port check, tree verify
		const ops = mockOps(["PID:4242\n", "ALIVE\n", "PID:4242\n", "TREE_OK\n"]);

		const tool = createProcessManagerTool(process.cwd(), { operations: ops });
		const result = await tool.execute("call_3", {
			action: "start" as const,
			command: "node -e \"require('http').createServer((_,r)=>r.end('ok')).listen(0)\"",
			expectedPort: 3000,
			readyTimeout: 5,
		});

		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("Process started successfully");
		expect(text).toContain("Root PID: 4242");
		expect(text).toContain("Run ID:");
		expect(text).toContain("Listener PID: 4242");
		expect(text).toContain("Port: 3000");
	});

	it("start fails when process does not bind the expected port within timeout", async () => {
		const responses: string[] = ["PID:9999\n"];
		for (let i = 0; i < 20; i++) {
			responses.push("ALIVE\n");
			responses.push("NONE\n");
		}
		const ops = mockOps(responses);

		const tool = createProcessManagerTool(process.cwd(), { operations: ops });
		await expect(
			tool.execute("call_4", {
				action: "start" as const,
				command: "some-slow-server.exe",
				expectedPort: 9999,
				readyTimeout: 0.5,
			}),
		).rejects.toThrow("did not become ready");
	});

	it("start fails when port is owned by a foreign process (conflict)", async () => {
		const ops = mockOps(["PID:1000\n", "ALIVE\n", "PID:5555\n", "TREE_NOT_FOUND\n"]);

		const tool = createProcessManagerTool(process.cwd(), { operations: ops });
		await expect(
			tool.execute("call_5", {
				action: "start" as const,
				command: "my-server.exe",
				expectedPort: 8080,
				readyTimeout: 5,
			}),
		).rejects.toThrow("conflict");
	});

	it("status reports process info", async () => {
		const startOps = mockOps(["PID:7777\n", "ALIVE\n"]);
		const tool = createProcessManagerTool(process.cwd(), { operations: startOps });
		const startResult = await tool.execute("call_6", {
			action: "start" as const,
			command: "test-server.exe",
		});

		const startText = startResult.content[0]?.type === "text" ? startResult.content[0].text : "";
		const runIdMatch = startText.match(/Run ID: ([a-f0-9]+)/);
		expect(runIdMatch).not.toBeNull();
		const runId = runIdMatch![1];

		const statusOps = mockOps(["ALIVE\n"]);
		const statusTool = createProcessManagerTool(process.cwd(), { operations: statusOps });
		const statusResult = await statusTool.execute("call_7", {
			action: "status" as const,
			runId,
		});

		const statusText = statusResult.content[0]?.type === "text" ? statusResult.content[0].text : "";
		expect(statusText).toContain(`Run ID: ${runId}`);
		expect(statusText).toContain("Status: running");
		expect(statusText).toContain("Root PID: 7777");
	});

	it("status reports stopped when process is dead", async () => {
		const startOps = mockOps(["PID:8888\n", "ALIVE\n"]);
		const tool = createProcessManagerTool(process.cwd(), { operations: startOps });
		const startResult = await tool.execute("call_8", {
			action: "start" as const,
			command: "ephemeral.exe",
		});

		const startText = startResult.content[0]?.type === "text" ? startResult.content[0].text : "";
		const runIdMatch = startText.match(/Run ID: ([a-f0-9]+)/);
		const runId = runIdMatch![1];

		const statusOps = mockOps(["DEAD\n"]);
		const statusTool = createProcessManagerTool(process.cwd(), { operations: statusOps });
		const statusResult = await statusTool.execute("call_9", {
			action: "status" as const,
			runId,
		});

		const statusText = statusResult.content[0]?.type === "text" ? statusResult.content[0].text : "";
		expect(statusText).toContain("Status: stopped");
	});

	it("stop kills a running process", async () => {
		const startOps = mockOps(["PID:4444\n", "ALIVE\n"]);
		const tool = createProcessManagerTool(process.cwd(), { operations: startOps });
		const startResult = await tool.execute("call_10", {
			action: "start" as const,
			command: "killable.exe",
		});

		const startText = startResult.content[0]?.type === "text" ? startResult.content[0].text : "";
		const runIdMatch = startText.match(/Run ID: ([a-f0-9]+)/);
		const runId = runIdMatch![1];

		const stopOps = mockOps(["ALIVE\n", "STOP_OK\n"]);
		const stopTool = createProcessManagerTool(process.cwd(), { operations: stopOps });
		const stopResult = await stopTool.execute("call_11", {
			action: "stop" as const,
			runId,
		});

		const stopText = stopResult.content[0]?.type === "text" ? stopResult.content[0].text : "";
		expect(stopText).toContain("stopped successfully");
	});

	it("stop reports already stopped for dead process", async () => {
		const startOps = mockOps(["PID:3333\n", "ALIVE\n"]);
		const tool = createProcessManagerTool(process.cwd(), { operations: startOps });
		const startResult = await tool.execute("call_12", {
			action: "start" as const,
			command: "short-lived.exe",
		});

		const startText = startResult.content[0]?.type === "text" ? startResult.content[0].text : "";
		const runIdMatch = startText.match(/Run ID: ([a-f0-9]+)/);
		const runId = runIdMatch![1];

		const stopOps = mockOps(["DEAD\n"]);
		const stopTool = createProcessManagerTool(process.cwd(), { operations: stopOps });
		const stopResult = await stopTool.execute("call_13", {
			action: "stop" as const,
			runId,
		});

		const stopText = stopResult.content[0]?.type === "text" ? stopResult.content[0].text : "";
		expect(stopText).toContain("already stopped");
	});

	it("fails for unknown runId", async () => {
		const ops = mockOps([]);
		const tool = createProcessManagerTool(process.cwd(), { operations: ops });
		await expect(tool.execute("call_14", { action: "status" as const, runId: "nonexistent" })).rejects.toThrow(
			"No process found",
		);
	});

	it("rejects unknown action", async () => {
		const ops = mockOps([]);
		const tool = createProcessManagerTool(process.cwd(), { operations: ops });
		await expect(tool.execute("call_15", { action: "invalid" as unknown as "start" })).rejects.toThrow(
			"Unknown action",
		);
	});
});
