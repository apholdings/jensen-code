/**
 * Workspace retrieval tools (1.7.0).
 *
 * Provider-independent index-backed search. Search tools are read-only and
 * parallel-safe; the refresh tool writes Jensen-managed runtime state only
 * (never workspace source files).
 */

import type { AgentTool } from "@apholdings/jensen-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { WorkspaceIndex } from "../workspace/index.js";
import type { WorkspaceRetrievalResult } from "../workspace/types.js";

const searchSchema = Type.Object({
	query: Type.String({ description: "Search query (natural language, identifier, or path hint)" }),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results (default 20)" })),
	mode: Type.Optional(
		Type.Union(
			[
				Type.Literal("hybrid"),
				Type.Literal("lexical"),
				Type.Literal("semantic"),
				Type.Literal("symbol"),
				Type.Literal("path"),
			],
			{
				description: "Retrieval mode (default hybrid)",
			},
		),
	),
	language: Type.Optional(Type.String({ description: "Filter by language (e.g. typescript, python)" })),
	fileClass: Type.Optional(
		Type.String({ description: "Filter by file class (source, test, documentation, configuration)" }),
	),
	freshOnly: Type.Optional(
		Type.Boolean({ description: "Only return results whose current file hash matches the index" }),
	),
});

type SearchToolInput = Static<typeof searchSchema>;

function formatResults(results: WorkspaceRetrievalResult[], limit: number): string {
	const bounded = results.slice(0, limit);
	if (bounded.length === 0) {
		return "No matches found. Run `jensen index build` if the workspace has not been indexed yet.";
	}
	const lines: string[] = [];
	for (const r of bounded) {
		const sym = r.symbol?.name ? ` (${r.symbol.name})` : "";
		const linesRange = `${r.location.startLine + 1}-${r.location.endLine + 1}`;
		lines.push(
			`- ${r.file.workspaceRelativePath}:${linesRange}${sym} [${r.score.reasonCodes.join(",")}] fresh=${r.freshness}`,
		);
	}
	lines.push(
		`\n[${bounded.length} result(s); evidence ids ` +
			bounded
				.slice(0, 5)
				.map((r) => r.evidenceId)
				.join(", ") +
			(bounded.length > 5 ? ", …" : "") +
			"]",
	);
	return lines.join("\n");
}

function openIndex(cwd: string): WorkspaceIndex {
	// Semantic-only searches need an enabled embedding backend; others degrade.
	return new WorkspaceIndex(cwd);
}

function makeSearchTool(name: string, mode: string, cwd: string): AgentTool<any> {
	return {
		name,
		label: name,
		description: `${mode} workspace retrieval over the durable workspace index. Returns addressable, evidence-backed code locations with freshness labels. Read-only.`,
		parameters: searchSchema,
		isConcurrencySafe: () => true,
		execute: async (_id: string, input: SearchToolInput) => {
			const index = openIndex(cwd);
			try {
				const { results } = index.search({
					query: input.query,
					mode: mode === "symbol" ? "symbol" : (mode as never),
					limit: input.limit ?? 20,
					languageFilters: input.language ? [input.language] : undefined,
					fileClassFilters: input.fileClass ? [input.fileClass] : undefined,
					freshOnly: input.freshOnly,
				});
				return {
					content: [{ type: "text", text: formatResults(results, input.limit ?? 20) }],
					details: undefined,
				};
			} finally {
				index.close();
			}
		},
	};
}

export function createWorkspaceSearchTools(cwd: string): Record<string, AgentTool<any>> {
	return {
		workspace_search: makeSearchTool("workspace_search", "hybrid", cwd),
		workspace_search_lexical: makeSearchTool("workspace_search_lexical", "lexical", cwd),
		workspace_search_semantic: makeSearchTool("workspace_search_semantic", "semantic", cwd),
		workspace_search_symbols: makeSearchTool("workspace_search_symbols", "symbol", cwd),
		workspace_retrieval_status: makeStatusTool(cwd),
		workspace_index_refresh: makeRefreshTool(cwd),
	};
}

function makeStatusTool(cwd: string): AgentTool<any> {
	return {
		name: "workspace_retrieval_status",
		label: "workspace_retrieval_status",
		description:
			"Report the workspace index status: generation, embed mode, counts. Read-only. Use to decide whether a build/refresh is needed.",
		parameters: Type.Object({}),
		isConcurrencySafe: () => true,
		execute: async () => {
			const index = new WorkspaceIndex(cwd);
			try {
				const s = index.status();
				return {
					content: [
						{
							type: "text",
							text: `generation=${s.currentGeneration ?? "none"} ready=${s.hasReadyGeneration} files=${s.fileCount ?? 0} chunks=${s.chunkCount ?? 0} symbols=${s.symbolCount ?? 0} embeddings=${s.embeddingCount ?? 0} embedMode=${(s.embedding as { mode: string }).mode} workspaceId=${s.workspaceId}`,
						},
					],
					details: undefined,
				};
			} finally {
				index.close();
			}
		},
	};
}

function makeRefreshTool(cwd: string): AgentTool<any> {
	return {
		name: "workspace_index_refresh",
		label: "workspace_index_refresh",
		description:
			"Incrementally refresh the durable workspace index to match current files. Writes Jensen-managed runtime state only; never modifies source files. Not parallel-safe (exclusive index-writer).",
		parameters: Type.Object({}),
		isConcurrencySafe: () => false,
		execute: async () => {
			const index = new WorkspaceIndex(cwd);
			try {
				const report = await index.refresh();
				return {
					content: [
						{
							type: "text",
							text: `refresh complete: added=${report.added} changed=${report.changed} removed=${report.removed} generation=${report.generationId}`,
						},
					],
					details: undefined,
				};
			} finally {
				index.close();
			}
		},
	};
}

/** Store a status tool for validation that the factory is complete. */
export function workspaceSearchToolNames(): string[] {
	return [
		"workspace_search",
		"workspace_search_lexical",
		"workspace_search_semantic",
		"workspace_search_symbols",
		"workspace_retrieval_status",
		"workspace_index_refresh",
	];
}
