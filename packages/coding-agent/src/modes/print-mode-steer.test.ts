import { describe, expect, it, vi } from "vitest";
import type { UltraplanArtifact, UltraplanRunResult } from "../core/ultraplan.js";
import { getPrintModeLocalCommandOutput } from "./print-mode.js";

function makeUltraplanArtifact(): UltraplanArtifact {
	return {
		version: 1,
		plannerMode: "local_subagent",
		plannerAgent: "planner",
		executionState: "plan_only",
		objective: "unused",
		assumptions: [],
		constraints: [],
		phases: [],
		risks: [],
		recommendedExecutionOrder: [],
		actionableNextSteps: [],
		createdAt: "2026-04-03T00:00:00.000Z",
	};
}

function makeUltraplanRunResult(): UltraplanRunResult {
	return {
		artifact: makeUltraplanArtifact(),
		displayText: "unused",
		rawPlannerOutput: "",
	};
}

function makeSession() {
	const steeringMessages: string[] = [];
	const continueCurrentWork = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

	return {
		get briefOnly() {
			return false;
		},
		setBriefOnly: () => {},
		queueByTheWay: () => {},
		getPendingByTheWayNotes: () => [],
		isStreaming: false,
		state: { messages: [{ role: "assistant" }] },
		steer: async (message: string) => {
			steeringMessages.push(message);
		},
		getSteeringMessages: () => steeringMessages,
		agent: {
			continue: continueCurrentWork,
		},
		getMemoryHistory: () => [],
		resolveMemorySnapshotSelector: () => ({
			snapshot: undefined,
			matchedInput: "",
			resolvedId: undefined,
			error: "empty" as const,
			candidates: [],
		}),
		getLatestUltraplanPlan: () => undefined,
		runUltraplan: async () => makeUltraplanRunResult(),
		runUltraplanRevise: async () => makeUltraplanRunResult(),
		applyUltraplan: () => ({ applied: [], displayText: "unused" }),
		continueCurrentWork,
		steeringMessages,
	};
}

describe("getPrintModeLocalCommandOutput /steer", () => {
	it("routes /steer through print mode and resumes the active workstream", async () => {
		const session = makeSession();

		const output = await getPrintModeLocalCommandOutput(session, "/steer keep the fix narrow");

		expect(output).toContain(
			"Submitted steering for the active workstream and resumed from the latest assistant turn.",
		);
		expect(session.steeringMessages).toEqual(["keep the fix narrow"]);
		expect(session.continueCurrentWork).toHaveBeenCalledTimes(1);
	});

	it("returns usage for invalid /steer commands in print mode", async () => {
		expect(await getPrintModeLocalCommandOutput(makeSession(), "/steer")).toBe("Usage: /steer <message>");
		expect(await getPrintModeLocalCommandOutput(makeSession(), "/steer    ")).toBe("Usage: /steer <message>");
	});
});
