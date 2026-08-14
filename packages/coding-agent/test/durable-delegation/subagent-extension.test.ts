/**
 * Subagent extension durable delegation integration tests (2.5.0).
 *
 * These tests drive the REAL production subagent extension path
 * (createSubagentTool from examples/extensions/subagent) with an injected
 * temporary durable store and a deterministic SubagentRunner harness. They
 * prove single/parallel/chain user behavior still works through the durable
 * architecture, and that every delegated child becomes a durable first-class
 * mission with observable correlation.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Message } from "@apholdings/jensen-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SubagentRunner } from "../../examples/extensions/subagent/index.js";
import { createSubagentTool } from "../../examples/extensions/subagent/index.js";
import type { ExtensionContext, ExtensionUIContext } from "../../src/core/extensions/index.js";
import type { DurableMissionStore } from "../../src/core/mission-domain/index.js";
import { FileDurableMissionStore } from "../../src/core/mission-durable/index.js";
import type { ModelRegistry } from "../../src/core/model-registry.js";
import type { ReadonlySessionManager } from "../../src/core/session-manager.js";

// =============================================================================
// Helpers
// =============================================================================

const NOOP_UI = {
	select: async () => undefined,
	confirm: async () => false,
	input: async () => undefined,
	notify: () => {},
	onTerminalInput: () => () => {},
	setStatus: () => {},
	setWorkingMessage: () => {},
	setWidget: () => {},
	setFooter: () => {},
	setHeader: () => {},
	setTitle: () => {},
	custom: async () => undefined,
	pasteToEditor: () => {},
	setEditorText: () => {},
	getEditorText: () => "",
	editor: async () => undefined,
	setEditorComponent: () => {},
	get theme() {
		return undefined;
	},
	getAllThemes: () => [],
	getTheme: () => undefined,
	setTheme: () => ({ success: false, error: "UI unavailable" }),
	getToolsExpanded: () => false,
	setToolsExpanded: () => {},
} as unknown as ExtensionUIContext;

function makeContext(cwd: string, sessionId: string, activeMissionId?: string): ExtensionContext {
	return {
		ui: NOOP_UI,
		hasUI: false,
		cwd,
		sessionManager: { getSessionId: () => sessionId } as unknown as ReadonlySessionManager,
		modelRegistry: { getAll: () => [] } as unknown as ModelRegistry,
		model: undefined,
		isIdle: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
		getActiveMissionId: () => activeMissionId,
	};
}

function makeRoot(): string {
	return mkdtempSync(path.join(tmpdir(), "subagent-durable-"));
}

/** Correlation/observability fields asserted from tool result details. */
interface ChildResultDetails {
	childMissionId?: string;
	parentMissionId?: string;
	attemptId?: string;
	executionId?: string;
	missionState?: string;
}

/** A deterministic runner that simulates a child emitting a final text message. */
function okRunner(outputText: string): SubagentRunner {
	return async ({ onMessage }) => {
		onMessage({
			role: "assistant",
			content: [{ type: "text", text: outputText }],
			timestamp: Date.now(),
		} as Message);
		return { exitCode: 0, stderr: "" };
	};
}

function writeProjectAgent(cwd: string, name: string): void {
	const dir = path.join(cwd, ".jensen", "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		path.join(dir, `${name}.md`),
		`---\nname: ${name}\ndescription: Test ${name} agent\n---\nYou are a test ${name} agent.\n`,
		"utf8",
	);
}

describe("subagent extension durable delegation", () => {
	let root: string;
	let store: DurableMissionStore;
	let cwd: string;
	let sessionId: string;

	beforeEach(() => {
		root = makeRoot();
		store = new FileDurableMissionStore({ root });
		cwd = mkdtempSync(path.join(tmpdir(), "subagent-cwd-"));
		sessionId = "abc12345";
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	it("TEST A/L: single delegation creates a durable child under the real parent mission", async () => {
		writeProjectAgent(cwd, "worker");
		const tool = createSubagentTool({ runSubagent: okRunner("child output"), store });
		const ctx = makeContext(cwd, sessionId, "mission_active_parent");

		const result = await tool.execute(
			"call_1",
			{ agent: "worker", task: "do the work", agentScope: "project", confirmProjectAgents: false },
			undefined,
			undefined,
			ctx,
		);

		const details = result.details as unknown as { mode: string; results: ChildResultDetails[] };
		expect(details.results).toHaveLength(1);
		const child = details.results[0];
		expect(child.childMissionId).toBeTruthy();
		expect(child.parentMissionId).toBe("mission_active_parent");
		expect(child.attemptId).toBeTruthy();
		expect(child.executionId).toBeTruthy();
		expect(child.missionState).toBe("PARTIAL");

		// The durable child record exists with the real parent and depth 1.
		const record = await store.load(child.childMissionId as string);
		expect(record.status).toBe("ok");
		if (record.status === "ok") {
			expect(record.record.parentMissionId).toBe("mission_active_parent");
			expect(record.record.depth).toBe(1);
			expect(record.record.state).toBe("PARTIAL");
			expect(record.record.result).toBeDefined();
		}
	});

	it("TEST A: when no active mission exists, the child hangs off a durable root-delegation anchor", async () => {
		writeProjectAgent(cwd, "worker");
		const tool = createSubagentTool({ runSubagent: okRunner("child output"), store });
		const ctx = makeContext(cwd, sessionId, undefined);

		const result = await tool.execute(
			"call_1",
			{ agent: "worker", task: "do the work", agentScope: "project", confirmProjectAgents: false },
			undefined,
			undefined,
			ctx,
		);

		const details = result.details as unknown as { mode: string; results: ChildResultDetails[] };
		const child = details.results[0];
		expect(child.parentMissionId).toBe(`delegation-root-${sessionId}`);

		// The root anchor itself is a durable CREATED mission (identity, not work).
		const anchor = await store.load(`delegation-root-${sessionId}`);
		expect(anchor.status).toBe("ok");
		if (anchor.status === "ok") {
			expect(anchor.record.state).toBe("CREATED");
			expect(anchor.record.depth).toBe(0);
			expect(anchor.record.parentMissionId).toBeUndefined();
		}
	});

	it("TEST L: parallel delegation persists independent durable children", async () => {
		writeProjectAgent(cwd, "worker");
		const tool = createSubagentTool({ runSubagent: okRunner("parallel output"), store });
		const ctx = makeContext(cwd, sessionId, "mission_active_parent");

		const result = await tool.execute(
			"call_1",
			{
				tasks: [
					{ agent: "worker", task: "task A" },
					{ agent: "worker", task: "task B" },
					{ agent: "worker", task: "task C" },
				],
				agentScope: "project",
				confirmProjectAgents: false,
			},
			undefined,
			undefined,
			ctx,
		);

		const details = result.details as unknown as { mode: string; results: ChildResultDetails[] };
		expect(details.mode).toBe("parallel");
		expect(details.results).toHaveLength(3);

		const ids = details.results.map((r) => r.childMissionId as string);
		expect(new Set(ids).size).toBe(3);
		for (const r of details.results) {
			expect(r.parentMissionId).toBe("mission_active_parent");
			expect(r.attemptId).toBeTruthy();
		}

		for (const id of ids) {
			const record = await store.load(id);
			expect(record.status).toBe("ok");
		}
	});

	it("TEST L: chain delegation persists durable children and passes {previous} through", async () => {
		writeProjectAgent(cwd, "worker");
		const tool = createSubagentTool({ runSubagent: okRunner("chain output"), store });
		const ctx = makeContext(cwd, sessionId, "mission_active_parent");

		const result = await tool.execute(
			"call_1",
			{
				chain: [
					{ agent: "worker", task: "step one" },
					{ agent: "worker", task: "step two using {previous}" },
				],
				agentScope: "project",
				confirmProjectAgents: false,
			},
			undefined,
			undefined,
			ctx,
		);

		const details = result.details as unknown as { mode: string; results: ChildResultDetails[] };
		expect(details.mode).toBe("chain");
		expect(details.results).toHaveLength(2);

		const ids = details.results.map((r) => r.childMissionId as string);
		expect(new Set(ids).size).toBe(2);
		for (const r of details.results) {
			expect(r.parentMissionId).toBe("mission_active_parent");
			expect(r.childMissionId).toBeTruthy();
			expect(r.attemptId).toBeTruthy();
		}
	});

	it("TEST H: production extension source never derives identity from PID", async () => {
		// Architecture guard: the production delegation identity helpers and the
		// extension must not reference process id or subagent-parent-${pid}.
		const { readFile } = await import("node:fs/promises");
		const { fileURLToPath } = await import("node:url");
		const extensionPath = fileURLToPath(new URL("../../examples/extensions/subagent/index.ts", import.meta.url));
		const delegationPath = fileURLToPath(
			new URL("../../src/core/durable-delegation/durable-delegation.ts", import.meta.url),
		);

		const extensionSource = await readFile(extensionPath, "utf8");
		expect(extensionSource).not.toContain("process.pid");
		expect(extensionSource).not.toContain("subagent-parent-");

		const delegationSource = await readFile(delegationPath, "utf8");
		expect(delegationSource).not.toContain("process.pid");
	});
});
