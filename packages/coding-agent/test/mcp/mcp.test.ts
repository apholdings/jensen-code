/**
 * MCP Client Foundation — acceptance tests (2.13.0).
 *
 * These are real process-boundary tests: the fixture MCP server runs as a child
 * process over stdio and is driven through the official SDK adapter. They prove
 * connect, discovery, structured invocation, tool errors, stderr isolation,
 * unexpected exit, timeout, cancellation, clean disconnect, reconnect, tool-list
 * change, and evidence provenance.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EvidenceFileStore } from "../../src/core/context-runtime/evidence-archive.js";
import { McpClientService } from "../../src/core/mcp-foundation/mcp-client-service.js";
import type { McpEvidence, McpServerDefinition } from "../../src/core/mcp-foundation/mcp-types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../../");
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const FIXTURE = path.join(__dirname, "fixtures", "mcp-fixture-server.ts");

function fixtureDefinition(overrides: Partial<McpServerDefinition> = {}): McpServerDefinition {
	return {
		id: "fixture",
		command: process.execPath,
		args: [TSX_CLI, FIXTURE],
		cwd: REPO_ROOT,
		startupTimeoutMs: 20_000,
		requestTimeoutMs: 5_000,
		...overrides,
	};
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

let root: string;
let service: McpClientService;
let archive: EvidenceFileStore;
let sessions: string[];

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "mcp-"));
	archive = new EvidenceFileStore(path.join(root, "evidence"));
	service = new McpClientService({ evidenceArchive: archive });
	sessions = [];
});

afterEach(async () => {
	for (const sessionId of sessions) {
		await service.disconnect(sessionId).catch(() => {});
	}
	rmSync(root, { recursive: true, force: true });
});

async function connect(overrides: Partial<McpServerDefinition> = {}): Promise<string> {
	const session = await service.connect(fixtureDefinition(overrides));
	sessions.push(session.sessionId);
	return session.sessionId;
}

async function loadEvidence(evidenceId: string): Promise<McpEvidence> {
	const record = await archive.load(evidenceId);
	if (!record) throw new Error(`no evidence record for ${evidenceId}`);
	return JSON.parse(record.content) as McpEvidence;
}

describe("TEST A — CONNECT", () => {
	it("establishes a session and captures identity/capabilities/protocol", async () => {
		const sessionId = await connect();
		const session = service.getSession(sessionId);

		expect(session.state).toBe("CONNECTED");
		expect(session.identity).toEqual({ name: "jensen-mcp-fixture", version: "1.0.0" });
		expect(session.protocolVersion).toBeTruthy();
		expect(session.capabilities).toBeDefined();
		expect((session.capabilities as { tools?: { listChanged?: boolean } }).tools?.listChanged).toBe(true);
		expect(session.pid).toBeTypeOf("number");
		expect(session.stderrTail.some((line) => line.includes("boot diagnostic"))).toBe(true);
	});
});

describe("TEST B — TOOL DISCOVERY", () => {
	it("preserves names, descriptions, schemas, and deterministic ordering", async () => {
		const sessionId = await connect();
		const tools = await service.listTools(sessionId);

		const names = tools.map((tool) => tool.name);
		expect(names).toEqual(["crash", "delay", "echo", "fail_tool", "hang", "register_late_tool", "stderr_noise"]);

		const echo = tools.find((tool) => tool.name === "echo")!;
		expect(echo.description).toContain("Echo structured text");
		const inputSchema = echo.inputSchema as { properties?: Record<string, unknown> };
		expect(inputSchema.properties).toHaveProperty("text");
		expect(inputSchema.properties).toHaveProperty("n");
		expect(echo.outputSchema).toBeDefined();
		expect(echo.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
		expect(echo.serverId).toBe("fixture");
	});
});

describe("TEST C — STRUCTURED INVOCATION", () => {
	it("delivers arguments and preserves structured content", async () => {
		const sessionId = await connect();
		const result = await service.callTool(sessionId, {
			toolName: "echo",
			arguments: { text: "hello", n: 3 },
		});

		expect(result.status).toBe("success");
		expect(result.isError).toBe(false);
		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toMatchObject({ type: "text", text: "echo: hello" });
		expect(result.structuredContent).toEqual({ echoed: "hello" });
		expect(result.errorCode).toBeUndefined();
	});
});

describe("TEST D — TOOL ERROR", () => {
	it("distinguishes a tool-level error from transport failure", async () => {
		const sessionId = await connect();
		const result = await service.callTool(sessionId, {
			toolName: "fail_tool",
			arguments: {},
		});

		expect(result.status).toBe("tool-error");
		expect(result.isError).toBe(true);
		expect(result.errorCode).toBe("MCP_TOOL_CALL_FAILED");
		expect(result.content[0]).toMatchObject({ type: "text", text: "intentional tool failure" });
	});
});

describe("TEST E — STDERR ISOLATION", () => {
	it("keeps protocol valid while capturing stderr separately", async () => {
		const sessionId = await connect();
		const result = await service.callTool(sessionId, {
			toolName: "stderr_noise",
			arguments: {},
		});

		expect(result.status).toBe("success");
		const tail = service.getSession(sessionId).stderrTail;
		expect(tail.some((line) => line.includes("diagnostic line one"))).toBe(true);
		expect(tail.some((line) => line.includes("diagnostic line two"))).toBe(true);
	});
});

describe("TEST F — UNEXPECTED SERVER EXIT", () => {
	it("invalidates the session and fails future calls honestly", async () => {
		const sessionId = await connect();
		const result = await service.callTool(sessionId, {
			toolName: "crash",
			arguments: {},
			timeoutMs: 10_000,
		});

		expect(result.status).toBe("connection-lost");
		expect(result.errorCode).toBe("MCP_CONNECTION_LOST");

		const session = service.getSession(sessionId);
		expect(session.state).toBe("FAILED");
		expect(await service.health(sessionId)).toMatchObject({ failed: true, connected: false });

		await expect(service.listTools(sessionId)).rejects.toMatchObject({ code: "MCP_SESSION_INVALID" });
	});
});

describe("TEST G — TIMEOUT", () => {
	it("converges to an honest timeout for a never-answering server", async () => {
		const sessionId = await connect();
		const started = Date.now();
		const result = await service.callTool(sessionId, {
			toolName: "hang",
			arguments: {},
			timeoutMs: 300,
		});

		expect(result.status).toBe("timeout");
		expect(result.errorCode).toBe("MCP_REQUEST_TIMEOUT");
		expect(Date.now() - started).toBeLessThan(3_000);
	});
});

describe("TEST H — CANCELLATION", () => {
	it("represents an explicit abort distinctly without success", async () => {
		const sessionId = await connect();
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 100);

		const result = await service.callTool(sessionId, {
			toolName: "delay",
			arguments: { ms: 5_000 },
			timeoutMs: 10_000,
			signal: controller.signal,
		});

		clearTimeout(timer);
		expect(result.status).toBe("cancelled");
		expect(result.errorCode).toBe("MCP_REQUEST_CANCELLED");
		expect(result.isError).toBe(false);
	});
});

describe("TEST I — CLEAN DISCONNECT", () => {
	it("releases the process and remains idempotent", async () => {
		const sessionId = await connect();
		const healthBefore = await service.health(sessionId);
		const pid = healthBefore.pid!;

		await service.disconnect(sessionId);
		await service.disconnect(sessionId); // idempotent

		expect(service.getSession(sessionId).state).toBe("DISCONNECTED");
		await waitFor(() => !isAlive(pid));
		expect(await service.health(sessionId)).toMatchObject({ state: "DISCONNECTED", connected: false });
	});
});

describe("TEST J — RECONNECT", () => {
	it("creates a new healthy session and never reuses a dead one", async () => {
		const first = await connect();
		await service.disconnect(first);

		const second = await connect();
		expect(second).not.toBe(first);
		expect(service.getSession(first).state).toBe("DISCONNECTED");
		expect(service.getSession(second).state).toBe("CONNECTED");

		const result = await service.callTool(second, { toolName: "echo", arguments: { text: "again" } });
		expect(result.status).toBe("success");
	});
});

describe("TEST K — TOOL LIST INVALIDATION", () => {
	it("detects an announced tool-list change and refreshes", async () => {
		const sessionId = await connect();
		const before = await service.listTools(sessionId);
		expect(before.some((tool) => tool.name === "late_tool")).toBe(false);

		const result = await service.callTool(sessionId, {
			toolName: "register_late_tool",
			arguments: {},
		});
		expect(result.status).toBe("success");

		await waitFor(() => service.getSession(sessionId).toolListChanged);

		const after = await service.listTools(sessionId);
		expect(after.some((tool) => tool.name === "late_tool")).toBe(true);
	});
});

describe("TEST L — EVIDENCE", () => {
	it("records success evidence with provenance and no fabricated failure", async () => {
		const sessionId = await connect();
		const result = await service.callTool(sessionId, {
			toolName: "echo",
			arguments: { text: "hello", secret: "sk-abcdefghijklmnop123456" },
		});

		expect(result.evidenceId).toBeTypeOf("string");
		const evidence = await loadEvidence(result.evidenceId!);
		expect(evidence).toMatchObject({
			kind: "mcp-tool-call",
			version: 1,
			serverId: "fixture",
			sessionId,
			toolName: "echo",
			status: "success",
		});
		expect(evidence.invokedAtMs).toBeTypeOf("number");
		expect(evidence.completedAtMs).toBeTypeOf("number");
		expect(evidence.resultSummary).toBeDefined();
		expect(evidence.failure).toBeUndefined();

		// Secret-safe serialization: the raw argument value never reaches evidence.
		const serialized = JSON.stringify(evidence);
		expect(serialized).not.toContain("sk-abcdefghijklmnop123456");
		expect(serialized).toContain("[REDACTED_API_KEY]");
	});

	it("records failure evidence without claiming success", async () => {
		const sessionId = await connect();
		const result = await service.callTool(sessionId, {
			toolName: "fail_tool",
			arguments: {},
		});

		expect(result.status).toBe("tool-error");
		expect(result.evidenceId).toBeTypeOf("string");
		const evidence = await loadEvidence(result.evidenceId!);
		expect(evidence.status).toBe("tool-error");
		expect(evidence.failure).toMatchObject({ code: "MCP_TOOL_CALL_FAILED" });
		expect(evidence.resultSummary).toBeDefined();
	});
});

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
