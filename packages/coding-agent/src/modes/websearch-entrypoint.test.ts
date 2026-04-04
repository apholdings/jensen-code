import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../core/slash-commands.js";
import type { UltraplanArtifact, UltraplanRunResult } from "../core/ultraplan.js";
import { getPrintModeLocalCommandOutput } from "./print-mode.js";

vi.mock("../core/tools/web-search.js", () => ({
	searchDuckDuckGoLite: vi.fn(),
}));

const { searchDuckDuckGoLite } = await import("../core/tools/web-search.js");

function createPrintModeSessionStub() {
	const artifact: UltraplanArtifact = {
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

	const makeRunResult = (): UltraplanRunResult => ({
		artifact,
		displayText: "",
		rawPlannerOutput: "",
	});

	return {
		briefOnly: false,
		setBriefOnly: () => {},
		queueByTheWay: () => {},
		getPendingByTheWayNotes: () => [],
		getMemoryHistory: () => [],
		resolveMemorySnapshotSelector: () => ({
			snapshot: undefined,
			matchedInput: "",
			resolvedId: undefined,
			error: "empty" as const,
			candidates: [],
		}),
		getLatestUltraplanPlan: () => undefined,
		runUltraplan: async () => makeRunResult(),
		runUltraplanRevise: async () => makeRunResult(),
		applyUltraplan: () => ({ applied: [], displayText: "" }),
		resourceLoader: {
			getAgentsFiles: () => ({ agentsFiles: [] }),
		},
	};
}

describe("/websearch command entrypoint", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("registers a built-in /websearch slash command", () => {
		const command = BUILTIN_SLASH_COMMANDS.find((entry) => entry.name === "websearch");
		expect(command).toBeDefined();
		expect(command?.description).toContain("DuckDuckGo");
	});

	it("routes interactive mode submissions through the explicit websearch handler", async () => {
		const { readFileSync } = await import("node:fs");
		const { fileURLToPath } = await import("node:url");
		const { dirname, join } = await import("node:path");

		const __dirname = dirname(fileURLToPath(import.meta.url));
		const source = readFileSync(join(__dirname, "interactive/interactive-mode.ts"), "utf8");

		expect(source).toContain('if (text === "/websearch" || text.startsWith("/websearch ")');
		expect(source).toContain("this.handleWebsearchCommand(text);");
	});

	it("reports web search results through print mode", async () => {
		const mockResults = [
			{ title: "Test Result 1", url: "https://example.com/1", snippet: "First result snippet" },
			{ title: "Test Result 2", url: "https://example.com/2", snippet: "Second result snippet" },
		];
		vi.mocked(searchDuckDuckGoLite).mockResolvedValue(mockResults);

		const output = await getPrintModeLocalCommandOutput(createPrintModeSessionStub(), "/websearch test query");

		expect(searchDuckDuckGoLite).toHaveBeenCalledWith("test query");
		expect(output).toContain("Web Search: test query");
		expect(output).toContain("1. Test Result 1");
		expect(output).toContain("https://example.com/1");
		expect(output).toContain("First result snippet");
		expect(output).toContain("2. Test Result 2");
		expect(output).toContain("https://example.com/2");
	});

	it("handles empty search results through print mode", async () => {
		vi.mocked(searchDuckDuckGoLite).mockResolvedValue([]);

		const output = await getPrintModeLocalCommandOutput(createPrintModeSessionStub(), "/websearch empty query");

		expect(output).toContain("No web results found for");
		expect(output).toContain("empty query");
	});

	it("handles missing query through print mode", async () => {
		const output = await getPrintModeLocalCommandOutput(createPrintModeSessionStub(), "/websearch");

		expect(output).toBe("Usage: /websearch <query>");
		expect(searchDuckDuckGoLite).not.toHaveBeenCalled();
	});

	it("handles search errors through print mode", async () => {
		vi.mocked(searchDuckDuckGoLite).mockRejectedValue(new Error("Network error"));

		const output = await getPrintModeLocalCommandOutput(createPrintModeSessionStub(), "/websearch failing query");

		expect(output).toContain("Search failed:");
		expect(output).toContain("Network error");
	});

	it("reports web search results with results that have no snippet", async () => {
		const mockResults = [{ title: "No Snippet Result", url: "https://example.com/no-snippet", snippet: "" }];
		vi.mocked(searchDuckDuckGoLite).mockResolvedValue(mockResults);

		const output = await getPrintModeLocalCommandOutput(createPrintModeSessionStub(), "/websearch no snippet");

		expect(output).toContain("Web Search: no snippet");
		expect(output).toContain("1. No Snippet Result");
		expect(output).toContain("https://example.com/no-snippet");
	});
});
