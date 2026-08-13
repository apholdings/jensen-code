/**
 * Reliability Session Bridge + durable store tests.
 *
 * Proves the live integration adapters (tool schema validator, action policy,
 * session bridge) and the atomic durable store behave correctly and safely.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MissionFileStore } from "../../src/core/reliability/durable-store.js";
import {
	createActionPolicyAdapter,
	createToolSchemaValidator,
	ReliabilitySessionBridge,
} from "../../src/core/reliability/integration.js";
import { MissionRuntime } from "../../src/core/reliability/mission-runtime.js";
import type { VerificationSpec } from "../../src/core/reliability/types.js";

function makeRuntime() {
	return MissionRuntime.create(
		{
			missionId: "mission_bridge",
			goal: "Implement a change",
			criteria: [
				{
					id: "AC-1",
					description: "tests pass",
					source: "system",
					verification: { kind: "test", command: "npm test" } as VerificationSpec,
				},
			],
		},
		{ now: 1700000000000 },
	);
}

describe("integration adapters", () => {
	it("tool schema validator enforces schema via validateToolArguments", () => {
		// A minimal TypeBox-less fake tool; the real validator uses AgentTool.
		const tools = [
			{ name: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
		] as never[];
		const schema = createToolSchemaValidator(tools as never);
		expect(schema.exists("read")).toBe(true);
		expect(schema.exists("nope")).toBe(false);
		const missing = schema.validateArgs("read", {});
		expect(missing.ok).toBe(false);
	});

	it("action policy adapter blocks absolute paths and forbidden tools", () => {
		const policy = createActionPolicyAdapter({ workspaceRoot: "/tmp/ws", forbiddenTools: ["rm"] });
		expect(policy.forbiddenReason({ type: "tool_call", tool: "rm", toolCallId: "c", arguments: {} })).toBeDefined();
		expect(
			policy.boundaryViolationReason({
				type: "tool_call",
				tool: "read",
				toolCallId: "c",
				arguments: { path: "/etc/passwd" },
			}),
		).toBeDefined();
	});

	it("session bridge blocks invalid tool calls before execution", async () => {
		const runtime = makeRuntime();
		const tools = [
			{ name: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
		] as never[];
		const bridge = new ReliabilitySessionBridge(
			runtime,
			createToolSchemaValidator(tools as never),
			createActionPolicyAdapter(),
		);

		const blocked = await bridge.beforeToolCall({ type: "tool_call", tool: "read", toolCallId: "c", arguments: {} });
		expect(blocked.block).toBe(true);

		const unknown = await bridge.beforeToolCall({ type: "tool_call", tool: "magic", toolCallId: "c", arguments: {} });
		expect(unknown.block).toBe(true);

		const ok = await bridge.beforeToolCall({
			type: "tool_call",
			tool: "read",
			toolCallId: "c",
			arguments: { path: "x.ts" },
		});
		expect(ok.block).toBe(false);
	});

	it("session bridge records evidence and gates completion", () => {
		const runtime = makeRuntime();
		const bridge = new ReliabilitySessionBridge(
			runtime,
			{ exists: () => true, validateArgs: (_n, a) => ({ ok: true, normalized: a }) },
			createActionPolicyAdapter(),
		);
		bridge.afterToolCall(
			{ type: "tool_call", tool: "read", toolCallId: "c1", arguments: {} },
			false,
			"read executed",
		);
		const gate = bridge.onAgentEnd();
		// No authoritative verification yet — completion must be rejected.
		expect(gate.decision).toBe("reject");
	});
});

describe("durable store", () => {
	it("persists and loads a mission document atomically", async () => {
		const root = await mkdtemp(join(tmpdir(), "jensen-mission-store-"));
		const store = new MissionFileStore(root);
		const runtime = makeRuntime();
		await store.save(runtime.serialize());

		const loaded = await store.load("mission_bridge");
		expect(loaded?.missionId).toBe("mission_bridge");

		const revived = MissionRuntime.deserialize(loaded);
		expect(revived.missionId).toBe("mission_bridge");
	});

	it("never leaves a partial document on disk", async () => {
		const root = await mkdtemp(join(tmpdir(), "jensen-mission-store-"));
		const store = new MissionFileStore(root);
		// A pre-existing temp file must not be surfaced as a valid document.
		await writeFile(join(root, "mission_bridge.mission.json.tmp"), "{partial", "utf8");
		const loaded = await store.load("mission_bridge");
		expect(loaded).toBeUndefined();
		expect(store.exists("mission_bridge")).toBe(false);
	});
});
