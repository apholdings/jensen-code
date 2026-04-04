import { describe, expect, it } from "vitest";
import type { MemoryHistorySnapshot } from "../core/memory.js";
import { resolveSnapshotSelector } from "../core/snapshot-selector-resolver.js";
import type { TodoItem } from "../core/tools/todo-write.js";
import type { UltraplanArtifact, UltraplanRunResult } from "../core/ultraplan.js";
import { getPrintModeLocalCommandOutput } from "./print-mode.js";

function makeSnapshot(
	entryId: string,
	items: Array<{ key: string; value: string }>,
	recordedAt = "2026-04-01T12:00:00.000Z",
	isCurrent = false,
): MemoryHistorySnapshot {
	return {
		entryId,
		parentId: null,
		recordedAt,
		items: items.map((item) => ({ ...item, timestamp: recordedAt })),
		isCurrent,
	};
}

function makeUltraplanArtifact(overrides?: Partial<UltraplanArtifact>): UltraplanArtifact {
	return {
		version: 1,
		plannerMode: "local_subagent",
		plannerAgent: "planner",
		executionState: "plan_only",
		objective: "Ship local-first Ultraplan",
		assumptions: ["Planner subagent is available"],
		constraints: ["No auto-execution"],
		phases: [{ title: "Planning", steps: ["Generate plan", "Persist artifact"] }],
		risks: ["Malformed planner output"],
		recommendedExecutionOrder: ["Plan", "Review", "Execute later"],
		actionableNextSteps: ["Inspect the stored plan"],
		createdAt: "2026-04-02T12:00:00.000Z",
		...overrides,
	};
}

function makeSession(
	snapshots: readonly MemoryHistorySnapshot[],
	artifact?: UltraplanArtifact,
	applyFn?: () => { applied: TodoItem[]; displayText: string },
	reviseFn?: (instruction: string) => Promise<UltraplanRunResult>,
	briefOnly = false,
) {
	let briefOnlyState = briefOnly;

	const btwNotes: string[] = [];

	return {
		get briefOnly() {
			return briefOnlyState;
		},
		setBriefOnly: (enabled: boolean) => {
			briefOnlyState = enabled;
		},
		queueByTheWay: (note: string) => {
			btwNotes.push(note);
		},
		getPendingByTheWayNotes: () => btwNotes,
		getMemoryHistory: () => snapshots,
		resolveMemorySnapshotSelector: (input: string) => resolveSnapshotSelector(input, snapshots),
		getLatestUltraplanPlan: () => artifact,
		runUltraplan: async (objective: string): Promise<UltraplanRunResult> => ({
			artifact: makeUltraplanArtifact({ objective }),
			displayText: `planned: ${objective}`,
			rawPlannerOutput: "{}",
		}),
		runUltraplanRevise:
			reviseFn ??
			(async (instruction: string): Promise<UltraplanRunResult> => ({
				artifact: makeUltraplanArtifact({ objective: `Revised: ${instruction}` }),
				displayText: `revised: ${instruction}`,
				rawPlannerOutput: "{}",
			})),
		applyUltraplan: applyFn ?? (() => ({ applied: [] as TodoItem[], displayText: "no plan" })),
	};
}

describe("getPrintModeLocalCommandOutput", () => {
	it("handles /brief status and toggle commands in print mode", async () => {
		const session = makeSession([]);

		expect(await getPrintModeLocalCommandOutput(session, "/brief status")).toContain(
			"Brief-only mode is disabled for this session only (runtime-only).",
		);
		expect(session.briefOnly).toBe(false);

		expect(await getPrintModeLocalCommandOutput(session, "/brief on")).toContain(
			"Enabled brief-only mode for this session only (runtime-only).",
		);
		expect(session.briefOnly).toBe(true);

		expect(await getPrintModeLocalCommandOutput(session, "/brief status")).toContain(
			"Brief-only mode is enabled for this session only (runtime-only).",
		);

		expect(await getPrintModeLocalCommandOutput(session, "/brief off")).toContain(
			"Disabled brief-only mode for this session only (runtime-only).",
		);
		expect(session.briefOnly).toBe(false);
	});

	it("returns usage for invalid /brief commands in print mode", async () => {
		expect(await getPrintModeLocalCommandOutput(makeSession([]), "/brief")).toBe("Usage: /brief <on|off|status>");
		expect(await getPrintModeLocalCommandOutput(makeSession([]), "/brief maybe")).toBe(
			"Usage: /brief <on|off|status>",
		);
	});

	it("queues /btw guidance for the next turn in print mode", async () => {
		const session = makeSession([]);

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
		expect(await getPrintModeLocalCommandOutput(makeSession([]), "/btw")).toBe("Usage: /btw <note>");
		expect(await getPrintModeLocalCommandOutput(makeSession([]), "/btw    ")).toBe("Usage: /btw <note>");
	});

	it("handles /memory history in print mode", async () => {
		const snapshots = [
			makeSnapshot("baseline01-1111", [{ key: "alpha", value: "first value" }], "2026-04-01T10:00:00.000Z"),
			makeSnapshot("target001-2222", [{ key: "beta", value: "second value" }], "2026-04-01T12:00:00.000Z", true),
		];

		const output = await getPrintModeLocalCommandOutput(makeSession(snapshots), "/memory history");

		expect(output).toContain("Use /memory diff <baselineId> <targetId> to compare any two snapshots.");
		expect(output).toContain("[target00]");
	});

	it("handles explicit /memory diff selectors in print mode", async () => {
		const snapshots = [
			makeSnapshot("baseline01-1111", [{ key: "alpha", value: "first" }], "2026-04-01T10:00:00.000Z"),
			makeSnapshot("target001-2222", [{ key: "alpha", value: "second" }], "2026-04-01T12:00:00.000Z", true),
		];

		const output = await getPrintModeLocalCommandOutput(makeSession(snapshots), "/memory diff [baseline] [target00]");

		expect(output).toContain("Baseline: ");
		expect(output).toContain("ID: [baseline] baseline01-1111");
		expect(output).toContain("~ Changed (1)");
	});

	it("handles adjacent /memory diff in print mode", async () => {
		const snapshots = [
			makeSnapshot("baseline01-1111", [{ key: "alpha", value: "first" }], "2026-04-01T10:00:00.000Z"),
			makeSnapshot("target001-2222", [{ key: "alpha", value: "second" }], "2026-04-01T12:00:00.000Z", true),
		];

		const output = await getPrintModeLocalCommandOutput(makeSession(snapshots), "/memory diff");

		expect(output).toContain("Comparing: ");
		expect(output).toContain("(snapshot comparison · not an event log)");
		expect(output).toContain("~ Changed (1)");
	});

	it("handles initial-snapshot /memory diff in print mode", async () => {
		const output = await getPrintModeLocalCommandOutput(
			makeSession([
				makeSnapshot("baseline01-1111", [{ key: "alpha", value: "first" }], "2026-04-01T10:00:00.000Z", true),
			]),
			"/memory diff",
		);

		expect(output).toContain("Initial snapshot — 1 item(s)");
		expect(output).toContain("(snapshot comparison · not an event log)");
	});

	it("handles selector resolution failures in print mode", async () => {
		const snapshots = [
			makeSnapshot("baseline01-1111", [{ key: "alpha", value: "first" }], "2026-04-01T10:00:00.000Z", true),
		];

		const output = await getPrintModeLocalCommandOutput(makeSession(snapshots), "/memory diff [] missing");

		expect(output).toContain("Snapshot resolution failed in current branch history.");
		expect(output).toContain("Baseline selector is empty.");
		expect(output).toContain("Target ID not found: missing");
	});

	it("handles empty diff history in print mode", async () => {
		const output = await getPrintModeLocalCommandOutput(makeSession([]), "/memory diff");
		expect(output).toBe("No memory snapshots found. Nothing to diff against.");
	});

	it("shows the persisted Ultraplan artifact honestly in print mode", async () => {
		const output = await getPrintModeLocalCommandOutput(makeSession([], makeUltraplanArtifact()), "/ultraplan show");

		expect(output).toContain("Ultraplan");
		expect(output).toContain("Planner mode: local planner subagent (planner)");
		expect(output).toContain("Execution: planning only; no execution has started");
		expect(output).toContain("Persisted as session-owned Ultraplan state on the current branch.");
	});

	it("runs the local Ultraplan entrypoint in print mode", async () => {
		const output = await getPrintModeLocalCommandOutput(makeSession([]), "/ultraplan map the next slice");
		expect(output).toBe("planned: map the next slice");
	});

	it("ignores unrelated prompts", async () => {
		expect(await getPrintModeLocalCommandOutput(makeSession([]), "hello")).toBeUndefined();
		expect(await getPrintModeLocalCommandOutput(makeSession([]), "/memory list")).toBeUndefined();
	});

	it("applies the persisted Ultraplan plan to todo state in print mode", async () => {
		const artifact = makeUltraplanArtifact({
			actionableNextSteps: ["Step one", "Step two"],
		});
		const output = await getPrintModeLocalCommandOutput(
			makeSession([], artifact, () => ({
				applied: [
					{ content: "Step one", activeForm: "Step one", status: "pending" },
					{ content: "Step two", activeForm: "Step two", status: "pending" },
				],
				displayText:
					"Applied 2 Ultraplan step(s) from the latest persisted plan into session todo state.\n" +
					"Source: actionable next steps. Todo total: 2.\n\n" +
					"The Ultraplan artifact remains preserved separately as plan state. Apply did not start execution.",
			})),
			"/ultraplan apply",
		);

		expect(output).toContain("Applied 2 Ultraplan step(s)");
		expect(output).toContain("session todo state");
		expect(output).toContain("Apply did not start execution");
	});

	it("throws when /ultraplan apply is called without a plan", async () => {
		await expect(
			getPrintModeLocalCommandOutput(
				makeSession([], undefined, () => {
					throw new Error("No persisted Ultraplan plan found. Run /ultraplan <objective> first.");
				}),
				"/ultraplan apply",
			),
		).rejects.toThrow("No persisted Ultraplan plan found");
	});

	it("handles /ultraplan revise with instruction in print mode", async () => {
		let capturedInstruction: string | undefined;
		const artifact = makeUltraplanArtifact();
		const output = await getPrintModeLocalCommandOutput(
			makeSession([], artifact, undefined, async (instruction: string) => {
				capturedInstruction = instruction;
				return {
					artifact: makeUltraplanArtifact({ objective: `Revised: ${instruction}` }),
					displayText: `revised: ${instruction}`,
					rawPlannerOutput: "{}",
				};
			}),
			"/ultraplan revise Add a third step to Phase 1",
		);

		expect(capturedInstruction).toBe("Add a third step to Phase 1");
		expect(output).toBe("revised: Add a third step to Phase 1");
	});

	it("handles /ultraplan regenerate with instruction in print mode", async () => {
		let capturedInstruction: string | undefined;
		const artifact = makeUltraplanArtifact();
		const output = await getPrintModeLocalCommandOutput(
			makeSession([], artifact, undefined, async (instruction: string) => {
				capturedInstruction = instruction;
				return {
					artifact: makeUltraplanArtifact({ objective: "Regenerated plan" }),
					displayText: `revised: ${instruction}`,
					rawPlannerOutput: "{}",
				};
			}),
			"/ultraplan regenerate tighten the next steps",
		);

		expect(capturedInstruction).toBe("tighten the next steps");
		expect(output).toBe("revised: tighten the next steps");
	});

	it("returns usage when /ultraplan revise is called without instruction in print mode", async () => {
		const output = await getPrintModeLocalCommandOutput(
			makeSession([], makeUltraplanArtifact()),
			"/ultraplan revise",
		);
		expect(output).toContain("Usage:");
		expect(output).toContain("revise <instruction>");
	});

	it("returns usage when /ultraplan regenerate is called without instruction in print mode", async () => {
		const output = await getPrintModeLocalCommandOutput(
			makeSession([], makeUltraplanArtifact()),
			"/ultraplan regenerate",
		);
		expect(output).toContain("Usage:");
		expect(output).toContain("regenerate <instruction>");
	});

	it("throws when /ultraplan revise is called without an existing plan", async () => {
		await expect(
			getPrintModeLocalCommandOutput(
				makeSession([], undefined, undefined, async () => {
					throw new Error("No persisted Ultraplan plan found. Run /ultraplan <objective> first.");
				}),
				"/ultraplan revise update the phases",
			),
		).rejects.toThrow("No persisted Ultraplan plan found");
	});

	it("provides updated usage message when /ultraplan is called without arguments", async () => {
		const output = await getPrintModeLocalCommandOutput(makeSession([]), "/ultraplan");
		expect(output).toContain("Usage:");
		expect(output).toContain("revise <instruction>");
		expect(output).toContain("regenerate <instruction>");
	});
});
