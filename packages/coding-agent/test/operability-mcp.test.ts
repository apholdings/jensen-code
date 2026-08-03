import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	classifyMcpToolEffects,
	createMcpCapabilitySnapshot,
	detectCapabilityDrift,
	redactMcpDiagnostics,
	validateMcpConfig,
	validateMcpResourceUri,
	validateMcpToolSchemas,
} from "../src/core/mcp.js";
import {
	collectDiagnostics,
	diffRuns,
	envelopeForEntry,
	projectionReplay,
	projectRun,
	readSessionEvents,
	renderReplay,
	sanitize,
	supportBundlePreview,
} from "../src/core/operability.js";
import { reexecuteRun, simulateReplay, storagePrune } from "../src/core/operability-runtime.js";

describe("operability projections and replay", () => {
	it("reads a session into deterministic envelopes and renders without effects", () => {
		const root = mkdtempSync(join(tmpdir(), "jensen-operability-"));
		const path = join(root, "run.jsonl");
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "run-1", timestamp: "2026-08-03T00:00:00.000Z", cwd: root }),
			JSON.stringify({
				type: "message",
				id: "a",
				parentId: null,
				timestamp: "2026-08-03T00:00:01.000Z",
				message: { role: "user", content: "inspect" },
			}),
			JSON.stringify({
				type: "message",
				id: "b",
				parentId: "a",
				timestamp: "2026-08-03T00:00:02.000Z",
				message: { role: "assistant", provider: "test", model: "model", content: [{ type: "text", text: "done" }] },
			}),
		];
		writeFileSync(path, `${lines.join("\n")}\n`);
		const result = readSessionEvents(path);
		expect(result.issues).toEqual([]);
		expect(result.events.map((event) => event.sequence)).toEqual([0, 1, 2]);
		expect(result.events[1]?.payloadSha256).toBe(
			envelopeForEntry(result.events[1]!.payload, "run-1", 1).payloadSha256,
		);
		const replay = renderReplay(result);
		expect(replay.lines).toEqual(["user: inspect", "assistant: done"]);
		expect(replay.externalEffects).toEqual({ modelCalls: 0, toolCalls: 0, networkCalls: 0, mutations: 0 });
		const projection = projectRun(result);
		expect(projection.objective).toBe("[recorded user objective]");
		expect(projection.models).toEqual([{ provider: "test", modelId: "model" }]);
		expect(projectionReplay(result, projection).snapshotMatches).toBe(true);
	});

	it("surfaces malformed middle records and truncated tails", () => {
		const root = mkdtempSync(join(tmpdir(), "jensen-corrupt-"));
		const path = join(root, "run.jsonl");
		writeFileSync(
			path,
			'{"type":"session","id":"run-1","cwd":"/tmp","timestamp":"2026-01-01T00:00:00.000Z"}\nnot-json\n{"type":"message"',
		);
		const result = readSessionEvents(path);
		expect(result.issues.map((issue) => issue.class)).toEqual([
			"manual_recovery_required",
			"recoverable_tail_corruption",
		]);
	});

	it("returns stable run differences and redacted read-only doctor output", () => {
		const left = {
			runId: "a",
			sessionId: "a",
			cwd: "/tmp",
			entryCount: 1,
			messageCount: 1,
			toolCallCount: 1,
			toolResultCount: 1,
			models: [],
			toolNames: ["read"],
			mutations: 0,
			evidenceIds: [],
			warnings: [],
			unknownEventTypes: [],
		};
		const right = { ...left, runId: "b", entryCount: 2, toolCallCount: 2 };
		expect(diffRuns(left, right).fields.find((field) => field.path === "toolCallCount")?.category).toBe("regressed");
		const report = collectDiagnostics({ cwd: "/tmp" });
		expect(report.readOnly).toBe(true);
		expect(report.exitCode).toBe(1);
		expect(sanitize({ apiKey: "secret", nested: { password: "hidden" } })).toEqual({
			apiKey: "[REDACTED]",
			nested: { password: "[REDACTED]" },
		});
		expect(supportBundlePreview(report, left).files["doctor.json"]).not.toContain("API_KEY");
		expect(sanitize({ data: "Bearer secret-value" })).toEqual({ data: "[REDACTED]" });
	});
});

describe("MCP boundary", () => {
	it("rejects insecure remote config, protects URIs, and accepts stdio references", () => {
		expect(
			validateMcpConfig({ serverId: "x", transport: "sse", url: "http://example.test" }).map((issue) => issue.code),
		).toContain("https_required");
		expect(
			validateMcpConfig({ serverId: "x", transport: "stdio", command: "fixture", envRefs: { TOKEN: "TOKEN" } }),
		).toEqual([]);
		expect(validateMcpResourceUri("https://example.test/resource")).toBe(true);
		expect(validateMcpResourceUri("https://user:password@example.test/resource")).toBe(false);
		expect(validateMcpResourceUri("file:///etc/passwd")).toBe(false);
		expect(redactMcpDiagnostics({ data: "Bearer secret-value" })).toEqual({ data: "[REDACTED]" });
		expect(redactMcpDiagnostics({ authorization: "secret", keyboard: "visible" })).toEqual({
			authorization: "[REDACTED]",
			keyboard: "visible",
		});
	});

	it("rejects invalid schemas and unknown effects conservatively", () => {
		const result = validateMcpToolSchemas([
			{ name: "read", inputSchema: { type: "object" } },
			{ name: "read", inputSchema: { type: "object" } },
			{ name: "bad name", inputSchema: { type: "object" } },
		]);
		expect(result.tools).toHaveLength(1);
		expect(result.rejected.map((issue) => issue.code)).toEqual(["tool_name_collision", "invalid_tool_name"]);
		expect(classifyMcpToolEffects({ name: "budget", inputSchema: {} })).toMatchObject({
			classification: "unknown",
			parallelSafe: false,
			requiresApproval: true,
		});
	});

	it("simulates without effects and reexecution creates a new plan run", () => {
		const result = readSessionEvents(join(mkdtempSync(join(tmpdir(), "jensen-runtime-")), "missing.jsonl"));
		const simulation = simulateReplay(result);
		expect(simulation.simulationId).not.toBe(simulation.runId);
		expect(simulation.externalEffects).toEqual({ modelCalls: 0, toolCalls: 0, networkCalls: 0, mutations: 0 });
		const reexecution = reexecuteRun(result, { cwd: "/tmp", plan: true });
		expect(reexecution.newRunId).not.toBe(reexecution.historicalRunId);
		expect(reexecution.mode).toBe("plan");
		expect(reexecution.mutations).toBe(0);
	});

	it("detects capability drift by stable snapshot hashes", () => {
		const base = createMcpCapabilitySnapshot({
			serverId: "x",
			tools: [{ name: "read", inputSchema: {} }],
			resources: [],
			resourceTemplates: [],
			prompts: [],
			capabilities: {},
		});
		const next = createMcpCapabilitySnapshot({
			serverId: "x",
			tools: [{ name: "write", inputSchema: {} }],
			resources: [],
			resourceTemplates: [],
			prompts: [],
			capabilities: {},
		});
		expect(detectCapabilityDrift(base, next)).toEqual(["tool_added:write", "tool_removed:read"]);
	});

	it("returns a zero-mutation retention preview", () => {
		const root = mkdtempSync(join(tmpdir(), "jensen-retention-"));
		const result = storagePrune(root, { preview: true });
		expect(result.preview).toBe(true);
		expect(result.entries).toEqual([]);
	});
});
