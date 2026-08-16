/**
 * Unity MCP Vertical Slice — read-only inspection tests (2.13.0).
 *
 * Deterministic process-boundary tests against a fixture that mirrors the real
 * LOTG Unity MCP surface (legacy 2025-03-26, unity-mcp-server@1.0.0, 7 tools).
 * Proves honest normalization, read-only invocation, Evidence provenance, and
 * the structured failure path with no fabricated Unity result.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EvidenceFileStore } from "../../src/core/context-runtime/evidence-archive.js";
import { McpClientService } from "../../src/core/mcp-foundation/mcp-client-service.js";
import type { McpServerDefinition } from "../../src/core/mcp-foundation/mcp-types.js";
import { inspectUnityDefinition } from "../../src/core/unity-mcp/unity-inspect.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../../");
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const FIXTURE = path.join(__dirname, "fixtures", "unity-mcp-fixture-server.ts");

function fixtureDefinition(): McpServerDefinition {
	return {
		id: "unity-lotg-blackpearl",
		command: process.execPath,
		args: [TSX_CLI, FIXTURE],
		cwd: REPO_ROOT,
		startupTimeoutMs: 20_000,
		requestTimeoutMs: 5_000,
	};
}

function failingDefinition(): McpServerDefinition {
	return {
		id: "unity-unreachable",
		command: process.execPath,
		args: ["-e", "process.exit(3)"],
		cwd: REPO_ROOT,
		startupTimeoutMs: 20_000,
		requestTimeoutMs: 5_000,
	};
}

let root: string;
let service: McpClientService;

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "unity-mcp-"));
	service = new McpClientService({ evidenceArchive: new EvidenceFileStore(path.join(root, "evidence")) });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("Unity inspection (happy path)", () => {
	it("connects, discovers the 7-tool surface, reads Console read-only, and classifies honestly", async () => {
		const result = await inspectUnityDefinition({
			definition: fixtureDefinition(),
			serverId: "unity-lotg-blackpearl",
			machine: "sparrow@blackpearl",
			service,
			projectPath: "D:\\Documents\\software\\light-of-the-galaxy\\mmo-client",
		});

		expect(result.connection).toBe("PASS");
		expect(result.protocolEra).toBe("legacy");
		expect(result.protocolVersion).toMatch(/^2025-/);
		expect(result.serverIdentity).toEqual({ name: "unity-mcp-server", version: "1.0.0" });
		expect(result.sessionId).toBeTruthy();

		const names = result.tools.map((tool) => tool.name);
		expect(names).toContain("Unity_GetConsoleLogs");
		expect(names).toContain("Unity_RunCommand");
		expect(names).toContain("Unity_AssetGeneration_GenerateAsset");
		expect(names).toHaveLength(7);

		const mutating = result.tools.filter((tool) => tool.mutating).map((tool) => tool.name);
		expect(mutating).toContain("Unity_RunCommand");
		expect(mutating).toContain("Unity_AssetGeneration_GenerateAsset");
		expect(mutating).not.toContain("Unity_GetConsoleLogs");

		const consoleObs = result.observations.find((obs) => obs.category === "console");
		expect(consoleObs?.status).toBe("OBSERVED");
		expect(consoleObs?.value).toEqual({ logs: [], totalCount: 0, errorCount: 0, warningCount: 0 });

		const projectObs = result.observations.find((obs) => obs.category === "project-path");
		expect(projectObs?.status).toBe("OBSERVED");
		expect(projectObs?.value).toBe("D:\\Documents\\software\\light-of-the-galaxy\\mmo-client");

		for (const category of ["scene", "player", "project-identity"]) {
			const obs = result.observations.find((entry) => entry.category === category);
			expect(obs?.status).toBe("NOT_EXPOSED");
		}

		// The read-only Console call must produce first-class Evidence.
		expect(result.evidenceIds.length).toBe(1);
	});
});

describe("Unity inspection (failure handling)", () => {
	it("returns a structured FAIL result with no fabricated Unity state", async () => {
		const result = await inspectUnityDefinition({
			definition: failingDefinition(),
			serverId: "unity-unreachable",
			machine: "sparrow@blackpearl",
			service,
		});

		expect(result.connection).toBe("FAIL");
		expect(result.connectionReason).toBeTruthy();
		expect(result.tools).toEqual([]);
		expect(result.observations).toEqual([]);
		expect(result.evidenceIds).toEqual([]);
		expect(result.serverIdentity).toBeUndefined();
	});
});

describe("Unity inspection (missing console capability)", () => {
	it("classifies console as NOT_ENABLED when Unity_GetConsoleLogs is absent", async () => {
		// A minimal legacy server without the Console tool exercises the honest
		// "capability not enabled" classification.
		const minimal: McpServerDefinition = {
			id: "unity-no-console",
			command: process.execPath,
			args: [TSX_CLI, path.join(__dirname, "fixtures", "unity-mcp-no-console-server.ts")],
			cwd: REPO_ROOT,
			startupTimeoutMs: 20_000,
			requestTimeoutMs: 5_000,
		};

		const result = await inspectUnityDefinition({
			definition: minimal,
			serverId: "unity-no-console",
			machine: "test",
			service,
		});

		expect(result.connection).toBe("PASS");
		const consoleObs = result.observations.find((obs) => obs.category === "console");
		expect(consoleObs?.status).toBe("NOT_ENABLED");
		expect(consoleObs?.missingTool).toBe("Unity_GetConsoleLogs");
	});
});
