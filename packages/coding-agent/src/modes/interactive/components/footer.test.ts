import type { Api, Model } from "@apholdings/jensen-ai";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../../../core/agent-session.js";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.js";
import { initTheme } from "../theme/theme.js";
import { FooterComponent } from "./footer.js";

beforeAll(() => {
	initTheme("dark");
});

function createSession(options?: {
	messages?: Array<Record<string, unknown>>;
	model?: Model<Api> | null;
	contextUsage?: { tokens: number | null; contextWindow: number | null; percent: number | null };
}): AgentSession {
	return {
		state: {
			messages: options?.messages ?? [],
			model: options?.model ?? null,
		},
		getContextUsage: () => options?.contextUsage ?? { tokens: 1200, contextWindow: 128000, percent: 0.9375 },
	} as unknown as AgentSession;
}

function createFooterData(): ReadonlyFooterDataProvider {
	return {
		getGitRepoName: () => "jensen-code",
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map(),
		onBranchChange: () => () => {},
		getAvailableProviderCount: () => 0,
	};
}

describe("FooterComponent cost display", () => {
	it("labels priced assistant-only usage as a session total when no turn boundary exists locally", () => {
		const component = new FooterComponent(
			createSession({
				messages: [
					{
						role: "assistant",
						provider: "openrouter",
						model: "ai21/jamba-large-1.7",
						usage: {
							input: 1000,
							output: 500,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 1500,
						},
					},
				],
			}),
			createFooterData(),
		);

		const line = stripAnsi(component.render(160)[0] ?? "");
		expect(line).toContain("cost session $0.006000");
	});

	it("shows turn and session totals when a local user-turn boundary exists", () => {
		const component = new FooterComponent(
			createSession({
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: "first turn" }],
					},
					{
						role: "assistant",
						provider: "openrouter",
						model: "ai21/jamba-large-1.7",
						usage: {
							input: 1000,
							output: 500,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 1500,
						},
					},
					{
						role: "user",
						content: [{ type: "text", text: "second turn" }],
					},
					{
						role: "assistant",
						provider: "openrouter",
						model: "ai21/jamba-large-1.7",
						usage: {
							input: 500,
							output: 250,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 750,
						},
					},
				],
			}),
			createFooterData(),
		);

		const line = stripAnsi(component.render(160)[0] ?? "");
		expect(line).toContain("cost turn $0.003000 · session $0.009000");
	});

	it("marks the session total as partial when some assistant usage cannot be priced from local metadata", () => {
		const component = new FooterComponent(
			createSession({
				messages: [
					{
						role: "assistant",
						provider: "openrouter",
						model: "ai21/jamba-large-1.7",
						usage: {
							input: 1000,
							output: 500,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 1500,
						},
					},
					{
						role: "assistant",
						provider: "unknown-provider",
						model: "custom-model",
						usage: {
							input: 250,
							output: 125,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 375,
						},
					},
				],
			}),
			createFooterData(),
		);

		const line = stripAnsi(component.render(160)[0] ?? "");
		expect(line).toContain("cost session $0.006000+");
	});

	it("shows unknown only when there is assistant usage but no resolvable pricing metadata", () => {
		const component = new FooterComponent(
			createSession({
				messages: [
					{
						role: "assistant",
						provider: "unknown-provider",
						model: "custom-model",
						usage: {
							input: 250,
							output: 125,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 375,
						},
					},
				],
			}),
			createFooterData(),
		);

		const line = stripAnsi(component.render(160)[0] ?? "");
		expect(line).toContain("cost session ?");
	});

	it("shows no cost yet before any assistant usage exists", () => {
		const component = new FooterComponent(createSession({ messages: [] }), createFooterData());
		const line = stripAnsi(component.render(160)[0] ?? "");
		expect(line).toContain("cost session --");
	});
});

describe("FooterComponent delegated cost aggregation", () => {
	function makeSubagentToolResult(cost: number, toolCallId = "tc1"): Record<string, unknown> {
		return {
			role: "toolResult",
			toolCallId,
			toolName: "subagent",
			isError: false,
			timestamp: Date.now(),
			content: [],
			details: {
				mode: "single",
				agentScope: "user",
				projectAgentsDir: null,
				discoveryErrors: [],
				results: [
					{
						agent: "coder",
						agentSource: "user",
						task: "do something",
						exitCode: 0,
						messages: [],
						stderr: "",
						stopReason: "end_turn",
						usage: { input: 500, output: 250, cacheRead: 0, cacheWrite: 0, cost, contextTokens: 750, turns: 1 },
					},
				],
			},
		};
	}

	it("adds one subagent cost to turn and session totals", () => {
		// Parent assistant: $0.006000, subagent: $0.0025 → total $0.008500
		const component = new FooterComponent(
			createSession({
				messages: [
					{ role: "user", content: [{ type: "text", text: "go" }] },
					{
						role: "assistant",
						provider: "openrouter",
						model: "ai21/jamba-large-1.7",
						usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 1500 },
					},
					makeSubagentToolResult(0.0025),
				],
			}),
			createFooterData(),
		);

		const line = stripAnsi(component.render(160)[0] ?? "");
		expect(line).toContain("cost turn $0.008500 · session $0.008500");
	});

	it("aggregates multiple subagent costs in the same turn", () => {
		// Parent: $0.006000, subagent1: $0.0015, subagent2: $0.0020 → total $0.009500
		const component = new FooterComponent(
			createSession({
				messages: [
					{ role: "user", content: [{ type: "text", text: "go" }] },
					{
						role: "assistant",
						provider: "openrouter",
						model: "ai21/jamba-large-1.7",
						usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 1500 },
					},
					makeSubagentToolResult(0.0015, "tc1"),
					makeSubagentToolResult(0.002, "tc2"),
				],
			}),
			createFooterData(),
		);

		const line = stripAnsi(component.render(160)[0] ?? "");
		expect(line).toContain("cost turn $0.009500 · session $0.009500");
	});

	it("does not count subagent from prior turn in current turn cost", () => {
		// Turn 1: parent $0.006000 + subagent $0.0025 = $0.008500
		// Turn 2: parent $0.003000
		// Session total = $0.011500, turn total = $0.003000
		const component = new FooterComponent(
			createSession({
				messages: [
					{ role: "user", content: [{ type: "text", text: "first" }] },
					{
						role: "assistant",
						provider: "openrouter",
						model: "ai21/jamba-large-1.7",
						usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 1500 },
					},
					makeSubagentToolResult(0.0025),
					{ role: "user", content: [{ type: "text", text: "second" }] },
					{
						role: "assistant",
						provider: "openrouter",
						model: "ai21/jamba-large-1.7",
						usage: { input: 500, output: 250, cacheRead: 0, cacheWrite: 0, totalTokens: 750 },
					},
				],
			}),
			createFooterData(),
		);

		// Use extra-wide render so the full cost string is not truncated.
		// $0.003000 + $0.006000 + $0.0025 = $0.0115 (>= 0.01 → toFixed(4))
		const line = stripAnsi(component.render(300)[0] ?? "");
		expect(line).toContain("turn $0.003000");
		expect(line).toContain("session $0.0115");
	});

	it("does not double-count costs on repeated renders", () => {
		const component = new FooterComponent(
			createSession({
				messages: [
					{ role: "user", content: [{ type: "text", text: "go" }] },
					{
						role: "assistant",
						provider: "openrouter",
						model: "ai21/jamba-large-1.7",
						usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 1500 },
					},
					makeSubagentToolResult(0.0025),
				],
			}),
			createFooterData(),
		);

		const line1 = stripAnsi(component.render(160)[0] ?? "");
		const line2 = stripAnsi(component.render(160)[0] ?? "");
		const line3 = stripAnsi(component.render(160)[0] ?? "");
		expect(line1).toContain("cost turn $0.008500 · session $0.008500");
		expect(line2).toBe(line1);
		expect(line3).toBe(line1);
	});

	it("shows delegated-only cost when there are no parent assistant messages in the turn", () => {
		// Only a subagent result, no parent assistant message → delegated cost only
		const component = new FooterComponent(
			createSession({
				messages: [{ role: "user", content: [{ type: "text", text: "go" }] }, makeSubagentToolResult(0.005)],
			}),
			createFooterData(),
		);

		const line = stripAnsi(component.render(160)[0] ?? "");
		expect(line).toContain("cost turn $0.005000 · session $0.005000");
	});
});
