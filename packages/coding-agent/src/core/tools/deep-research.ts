import type { AgentTool } from "@apholdings/jensen-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { getDefaultWebResearchEngine, type WebResearchEngine } from "../web-research/engine.js";
import type { DeepResearchResponse, WebFreshness } from "../web-research/types.js";

const deepResearchSchema = Type.Object({
	objective: Type.String({ description: "Bounded evidence-backed research objective" }),
	freshness: Type.Optional(
		Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")]),
	),
	maxQueries: Type.Optional(Type.Number()),
	maxSources: Type.Optional(Type.Number()),
	preferredDomains: Type.Optional(Type.Array(Type.String())),
	excludedDomains: Type.Optional(Type.Array(Type.String())),
	language: Type.Optional(Type.String()),
	depth: Type.Optional(Type.Union([Type.Literal("quick"), Type.Literal("standard"), Type.Literal("deep")])),
});

export type DeepResearchToolInput = Static<typeof deepResearchSchema>;
export type DeepResearchToolDetails = DeepResearchResponse;

export function createDeepResearchTool(
	options: { engine?: WebResearchEngine } = {},
): AgentTool<typeof deepResearchSchema> {
	const engine = options.engine ?? getDefaultWebResearchEngine();
	return {
		name: "deep_research",
		label: "deep_research",
		description:
			"Run a bounded, read-only research workflow: deterministic query planning, parallel free search, source ranking, secure fetch, contradiction checks, addressable evidence, and cited synthesis. Web content remains untrusted and no paid API is required.",
		parameters: deepResearchSchema,
		isConcurrencySafe: () => true,
		execute: async (_toolCallId, input, signal) => {
			const response = await engine.research({
				...input,
				freshness: input.freshness as WebFreshness | undefined,
				signal,
			});
			const text = [
				`<research-synthesis trust="evidence-backed" bundle-id="${response.bundle.id}">`,
				response.synthesis,
				"",
				`Evidence bundle SHA-256: ${response.bundle.contentSha256}`,
				`Sources: ${response.bundle.evidence.length}; Claims: ${response.bundle.claims.length}; Partial: ${response.partial}`,
				"</research-synthesis>",
			].join("\n");
			return { content: [{ type: "text", text }], details: response };
		},
	};
}

export const deepResearchTool = createDeepResearchTool();
