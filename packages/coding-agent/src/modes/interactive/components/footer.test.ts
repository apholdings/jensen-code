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
