/**
 * MCP Client Foundation — CLI output tests (2.13.0).
 *
 * Proves `jensen mcp inspect|tools|call|health` human and `--json` output are
 * stable and machine-readable, using a real stdio fixture server and a temp
 * evidence directory (never the operator's real ~/.jensen).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleMcpCommand } from "../../src/core/mcp-foundation/cli.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../../");
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const FIXTURE = path.join(__dirname, "fixtures", "mcp-fixture-server.ts");

let root: string;
let configPath: string;
let captured: string[];

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "mcp-cli-"));
	process.env.JENSEN_CODING_AGENT_DIR = root;
	process.exitCode = 0;
	captured = [];
	vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		captured.push(String(chunk));
		return true;
	});

	configPath = path.join(root, "server.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			id: "fixture",
			command: process.execPath,
			args: [TSX_CLI, FIXTURE],
			cwd: REPO_ROOT,
			requestTimeoutMs: 5_000,
		}),
		"utf8",
	);
});

afterEach(() => {
	delete process.env.JENSEN_CODING_AGENT_DIR;
	process.exitCode = 0;
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

function text(): string {
	return captured.join("");
}

function json<T>(): T {
	return JSON.parse(text()) as T;
}

describe("TEST M — CLI JSON output is stable and machine-readable", () => {
	it("inspect, tools, and call emit structured DTOs", async () => {
		expect(await handleMcpCommand(["mcp", "inspect", configPath, "--json"])).toBe(true);
		const inspect = json<{ state: string; identity: { name: string; version: string }; protocolVersion: string }>();
		expect(inspect.state).toBe("CONNECTED");
		expect(inspect.identity).toEqual({ name: "jensen-mcp-fixture", version: "1.0.0" });
		expect(inspect.protocolVersion).toBeTruthy();

		captured = [];
		expect(await handleMcpCommand(["mcp", "tools", configPath, "--json"])).toBe(true);
		const tools = json<{ serverId: string; tools: { name: string }[] }>();
		expect(tools.serverId).toBe("fixture");
		expect(tools.tools.map((tool) => tool.name)).toEqual([
			"crash",
			"delay",
			"echo",
			"fail_tool",
			"hang",
			"register_late_tool",
			"stderr_noise",
		]);

		captured = [];
		expect(await handleMcpCommand(["mcp", "call", configPath, "echo", "--arg", "text=cli-hello", "--json"])).toBe(
			true,
		);
		const call = json<{ status: string; toolName: string; content: { text: string }[]; evidenceId: string }>();
		expect(call.status).toBe("success");
		expect(call.toolName).toBe("echo");
		expect(call.content[0].text).toBe("echo: cli-hello");
		expect(call.evidenceId).toBeTypeOf("string");
		expect(process.exitCode).toBe(0);
	});
});

describe("TEST N — CLI human output explains state without noise", () => {
	it("inspect, tools, and call render clear operator output", async () => {
		expect(await handleMcpCommand(["mcp", "inspect", configPath])).toBe(true);
		const inspectOut = text();
		expect(inspectOut).toContain("server: fixture");
		expect(inspectOut).toContain("state: CONNECTED");
		expect(inspectOut).toContain("identity: jensen-mcp-fixture@1.0.0");

		captured = [];
		expect(await handleMcpCommand(["mcp", "tools", configPath])).toBe(true);
		const toolsOut = text();
		expect(toolsOut).toContain("echo");
		expect(toolsOut).toContain("Echo structured text");

		captured = [];
		expect(await handleMcpCommand(["mcp", "call", configPath, "echo", "--arg", "text=human"])).toBe(true);
		const callOut = text();
		expect(callOut).toContain("tool: echo");
		expect(callOut).toContain("status: success");
	});
});
