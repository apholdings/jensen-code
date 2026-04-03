import { describe, expect, it } from "vitest";
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
	const btwNotes: string[] = [];

	return {
		get briefOnly() {
			return false;
		},
		setBriefOnly: () => {},
		queueByTheWay: (note: string) => {
			btwNotes.push(note);
		},
		getPendingByTheWayNotes: () => btwNotes,
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
	};
}

describe("getPrintModeLocalCommandOutput /btw", () => {
	it("queues /btw guidance for the next turn in print mode", async () => {
		const session = makeSession();

		expect(await getPrintModeLocalCommandOutput(session, "/btw tighten the acceptance criteria")).toContain(
			"Queued by-the-way guidance for the next turn only (runtime-only).",
		);
		expect(session.getPendingByTheWayNotes()).toEqual(["tighten the acceptance criteria"]);

		expect(await getPrintModeLocalCommandOutput(session, "/btw keep the patch narrow")).toContain(
			"Pending BTW notes: 2.",
		);
		expect(session.getPendingByTheWayNotes()).toEqual(["tighten the acceptance criteria", "keep the patch narrow"]);
	});

	it("returns usage for invalid /btw commands in print mode", async () => {
		expect(await getPrintModeLocalCommandOutput(makeSession(), "/btw")).toBe("Usage: /btw <note>");
		expect(await getPrintModeLocalCommandOutput(makeSession(), "/btw    ")).toBe("Usage: /btw <note>");
	});
});
