import { Agent } from "@apholdings/jensen-agent-core";
import { describe, expect, it } from "vitest";
import { AgentSession } from "./agent-session.js";
import { AuthStorage } from "./auth-storage.js";
import { SESSION_MEMORY_CUSTOM_TYPE } from "./memory.js";
import { buildStructuredMemoryCompareData, buildStructuredMemoryHistoryData } from "./memory-snapshot-contract.js";
import { ModelRegistry } from "./model-registry.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

function createSession(sessionManager = SessionManager.inMemory("/tmp/project")): AgentSession {
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd: "/tmp/project",
		agentDir: "/tmp/agent",
		settingsManager,
	});
	const authStorage = AuthStorage.create("/tmp/agent/auth.json");
	const modelRegistry = new ModelRegistry(authStorage);
	const agent = new Agent({
		initialState: {
			systemPrompt: "",
			thinkingLevel: "off",
			tools: [],
		},
	});

	return new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: "/tmp/project",
		resourceLoader,
		modelRegistry,
	});
}

describe("AgentSession structured memory snapshot consumer", () => {
	it("reuses the shared structured history payload for SDK callers", () => {
		const sessionManager = SessionManager.inMemory("/tmp/project");
		sessionManager.appendCustomEntry(SESSION_MEMORY_CUSTOM_TYPE, [
			{ key: "alpha", value: "first", timestamp: "2026-04-01T10:00:00.000Z" },
		]);
		sessionManager.appendCustomEntry(SESSION_MEMORY_CUSTOM_TYPE, [
			{ key: "alpha", value: "second", timestamp: "2026-04-01T12:00:00.000Z" },
		]);
		const session = createSession(sessionManager);

		expect(session.getStructuredMemoryHistory()).toEqual(buildStructuredMemoryHistoryData(session));
	});

	it("reuses the shared compare payload for explicit same-snapshot SDK comparisons", () => {
		const sessionManager = SessionManager.inMemory("/tmp/project");
		const snapshotId = sessionManager.appendCustomEntry(SESSION_MEMORY_CUSTOM_TYPE, [
			{ key: "alpha", value: "first", timestamp: "2026-04-01T10:00:00.000Z" },
		]);
		const session = createSession(sessionManager);

		const data = session.compareMemorySnapshots({
			baseline: snapshotId,
			target: `[${snapshotId.slice(0, 8)}]`,
		});

		expect(data).toEqual(
			buildStructuredMemoryCompareData(session, {
				baseline: snapshotId,
				target: `[${snapshotId.slice(0, 8)}]`,
			}),
		);
		expect(data.status).toBe("ok");
		if (data.status === "ok") {
			expect(data.compareMode).toBe("explicit");
			expect(data.sameSnapshot).toBe(true);
		}
	});

	it("returns empty_history and initial_snapshot through the AgentSession API", () => {
		const session = createSession();

		expect(session.compareMemorySnapshots()).toEqual({
			branchScope: "current",
			historyModel: "snapshot",
			status: "empty_history",
			snapshotCount: 0,
		});

		session.setMemoryItem("project.goal", "document same-process memory automation");
		const initial = session.compareMemorySnapshots();
		expect(initial.status).toBe("initial_snapshot");
		if (initial.status === "initial_snapshot") {
			expect(initial.target.itemCount).toBe(1);
			expect(initial.diff.isInitialSnapshot).toBe(true);
		}
	});

	it("surfaces selector_resolution_failed through the AgentSession API", () => {
		const session = createSession();
		session.setMemoryItem("project.goal", "first");
		session.setMemoryItem("project.goal", "second");

		const history = session.getStructuredMemoryHistory();
		const target = history.snapshots[history.snapshots.length - 1]!.entryId;
		const failed = session.compareMemorySnapshots({
			baseline: "missing-selector",
			target,
		});

		expect(failed.status).toBe("selector_resolution_failed");
		if (failed.status === "selector_resolution_failed") {
			expect(failed.issues).toEqual([
				{
					label: "baseline",
					input: "missing-selector",
					matchedInput: "missing-selector",
					error: "not_found",
					candidates: [],
				},
			]);
		}
	});

	it("rejects partial explicit selector input like the RPC command contract", () => {
		const session = createSession();
		expect(() => session.compareMemorySnapshots({ baseline: "only-one" })).toThrow(
			"Provide both baseline and target selectors, or neither for adjacent comparison.",
		);
	});
});
