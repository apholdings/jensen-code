import type { AgentTool } from "@apholdings/jensen-agent-core";
import { Type } from "@sinclair/typebox";
import { getDefaultWebResearchEngine, type WebResearchEngine } from "../web-research/engine.js";

const webResearchStatusSchema = Type.Object({});

export function createWebResearchStatusTool(
	options: { engine?: WebResearchEngine } = {},
): AgentTool<typeof webResearchStatusSchema> {
	const engine = options.engine ?? getDefaultWebResearchEngine();
	return {
		name: "web_research_status",
		label: "web_research_status",
		description:
			"Show privacy-safe web research configuration, provider health, capability availability, budgets, and aggregate counters. Does not expose queries, page contents, credentials, cookies, or headers.",
		parameters: webResearchStatusSchema,
		isConcurrencySafe: () => true,
		execute: async (_toolCallId, _input, signal) => {
			const diagnostics = await engine.diagnostics(signal);
			const lines = [
				`Configured search provider: ${diagnostics.configuredProvider}`,
				`SearXNG endpoint: ${diagnostics.searxngEndpoint}`,
				`Fallback provider: ${diagnostics.fallbackProvider}`,
				`Provider health: ${diagnostics.providers.map((provider) => `${provider.provider}=${provider.status}`).join(", ")}`,
				`Browser rendering: ${diagnostics.browserRenderingAvailable ? "available" : "unavailable"}`,
				`PDF extraction: ${diagnostics.pdfExtractionAvailable ? "available" : "unavailable"}`,
				`Research budgets: queries=${diagnostics.budgets.maxQueries}, sources=${diagnostics.budgets.maxSources}, bytes=${diagnostics.budgets.maxBytes}, renders=${diagnostics.budgets.maxBrowserRenders}, elapsed_ms=${diagnostics.budgets.maxElapsedMs}, parallel_fetches=${diagnostics.budgets.maxParallelFetches}`,
				`Recent counters: ${Object.entries(diagnostics.telemetry)
					.map(([name, value]) => `${name}=${value}`)
					.join(", ")}`,
			];
			return { content: [{ type: "text", text: lines.join("\n") }], details: diagnostics };
		},
	};
}

export const webResearchStatusTool = createWebResearchStatusTool();
