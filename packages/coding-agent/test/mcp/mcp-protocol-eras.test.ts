/**
 * MCP Client Foundation — protocol-era acceptance tests (2.13.0).
 *
 * These prove the single Jensen client configuration interoperates with BOTH
 * protocol generations without the caller knowing which era is in use:
 *
 *   MODERN-A  modern 2026-07-28 connect → era "modern", version "2026-07-28"
 *   MODERN-B  modern tool discovery + structured invocation + evidence
 *   LEGACY-A  automatic fallback to a legacy initialize-based server
 *   LEGACY-B  legacy tool discovery + structured invocation + evidence
 *
 * Both fixtures run as real child processes over stdio. The modern fixture
 * refuses legacy openings (`serveStdio({ legacy: "reject" })`), so a fallback
 * would fail loudly; the legacy fixture serves only `initialize`, so a forced
 * modern path would also fail. The same `McpClientService` connects to both.
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
const LEGACY_FIXTURE = path.join(__dirname, "fixtures", "mcp-fixture-server.ts");
const MODERN_FIXTURE = path.join(__dirname, "fixtures", "mcp-modern-fixture-server.ts");

function fixtureDefinition(fixture: string, id: string): McpServerDefinition {
	return {
		id,
		command: process.execPath,
		args: [TSX_CLI, fixture],
		cwd: REPO_ROOT,
		startupTimeoutMs: 20_000,
		requestTimeoutMs: 5_000,
	};
}

let root: string;
let service: McpClientService;
let archive: EvidenceFileStore;
let sessions: string[];

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "mcp-era-"));
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

async function connect(fixture: string, id: string): Promise<string> {
	const session = await service.connect(fixtureDefinition(fixture, id));
	sessions.push(session.sessionId);
	return session.sessionId;
}

async function loadEvidence(evidenceId: string): Promise<McpEvidence> {
	const record = await archive.load(evidenceId);
	if (!record) throw new Error(`no evidence record for ${evidenceId}`);
	return JSON.parse(record.content) as McpEvidence;
}

describe("TEST MODERN-A — MODERN NEGOTIATION", () => {
	it("negotiates the 2026-07-28 era against a modern-only server", async () => {
		const sessionId = await connect(MODERN_FIXTURE, "modern");
		const session = service.getSession(sessionId);

		expect(session.state).toBe("CONNECTED");
		expect(session.protocolEra).toBe("modern");
		expect(session.protocolVersion).toBe("2026-07-28");
	});
});

describe("TEST MODERN-B — MODERN TOOL ROUNDTRIP", () => {
	it("discovers and invokes a structured tool with modern evidence provenance", async () => {
		const sessionId = await connect(MODERN_FIXTURE, "modern");
		const tools = await service.listTools(sessionId);
		expect(tools.map((tool) => tool.name)).toEqual(["echo", "fail_tool"]);

		const echo = tools.find((tool) => tool.name === "echo")!;
		expect(echo.description).toContain("modern protocol era");
		expect(echo.inputSchema).toMatchObject({ type: "object" });
		expect(echo.outputSchema).toBeDefined();
		expect(echo.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });

		const result = await service.callTool(sessionId, { toolName: "echo", arguments: { text: "modern" } });
		expect(result.status).toBe("success");
		expect(result.isError).toBe(false);
		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toMatchObject({ type: "text", text: "echo: modern" });
		expect(result.structuredContent).toEqual({ echoed: "modern" });

		const evidence = await loadEvidence(result.evidenceId!);
		expect(evidence.protocolEra).toBe("modern");
		expect(evidence.protocolVersion).toBe("2026-07-28");
	});
});

describe("TEST LEGACY-A — AUTOMATIC FALLBACK", () => {
	it("falls back to the initialize handshake with the same client configuration", async () => {
		const sessionId = await connect(LEGACY_FIXTURE, "legacy");
		const session = service.getSession(sessionId);

		expect(session.state).toBe("CONNECTED");
		expect(session.protocolEra).toBe("legacy");
		expect(session.protocolVersion).toMatch(/^2025-/);
	});
});

describe("TEST LEGACY-B — LEGACY TOOL ROUNDTRIP", () => {
	it("presents the same descriptor/result architecture with legacy evidence provenance", async () => {
		const sessionId = await connect(LEGACY_FIXTURE, "legacy");
		const tools = await service.listTools(sessionId);
		expect(tools.map((tool) => tool.name)).toContain("echo");

		const echo = tools.find((tool) => tool.name === "echo")!;
		expect(echo.description).toContain("Echo structured text");
		expect(echo.inputSchema).toBeDefined();
		expect(echo.outputSchema).toBeDefined();

		const result = await service.callTool(sessionId, { toolName: "echo", arguments: { text: "legacy" } });
		expect(result.status).toBe("success");
		expect(result.isError).toBe(false);
		expect(result.content[0]).toMatchObject({ type: "text", text: "echo: legacy" });
		expect(result.structuredContent).toEqual({ echoed: "legacy" });

		const evidence = await loadEvidence(result.evidenceId!);
		expect(evidence.protocolEra).toBe("legacy");
		expect(evidence.protocolVersion).toMatch(/^2025-/);
	});
});
