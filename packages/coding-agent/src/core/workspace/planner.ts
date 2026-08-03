/**
 * Deterministic query planner.
 *
 * Classifies a retrieval query into a mode and selects bounded candidate
 * generators. Model assistance is optional and never required; the default is a
 * deterministic rule-based planner. The planner cannot expand workspace scope.
 */

import { searchSymbolName } from "./lexical.js";
import type { WorkspaceDb } from "./storage.js";
import type { RetrievalPlan } from "./types.js";

export interface PlannerInput {
	query: string;
	languageFilters?: string[];
	fileClassFilters?: string[];
	pathFilter?: string;
	currentFile?: string;
	currentSymbol?: string;
	taskRole?: string;
	maximumResults?: number;
	maximumContextTokens?: number;
	embeddingAvailable?: boolean;
}

export interface PlanningContext {
	embeddingAvailable: boolean;
}

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const FLOW_WORDS = /(how|flow|sequence|call|relationship|depends|between|and|involves)/i;
const DOC_WORDS = /(document|readme|explain|usage|guide|doc)/i;
const TEST_WORDS = /(test|spec|verify|protect|regression)/i;
const CONFIG_WORDS = /(config|setting|option|environment|enable|disable)/i;
const HISTORY_WORDS = /(change|history|recent|regress|commit|modified|changed)/i;

function classifyMode(q: string): RetrievalPlan["mode"] {
	if (IDENTIFIER_RE.test(q.trim())) return "exact_identifier";
	if (CONFIG_WORDS.test(q)) return "configuration";
	if (HISTORY_WORDS.test(q)) return "historical_change";
	if (TEST_WORDS.test(q)) return "test_discovery";
	if (DOC_WORDS.test(q)) return "documentation";
	if (FLOW_WORDS.test(q)) return "flow_investigation";
	if (/\bsymbol|class|function|method|interface|typedef/.test(q)) return "symbol_lookup";
	return "semantic_concept";
}

export function planQuery(input: PlannerInput, ctx: PlanningContext): RetrievalPlan {
	const query = input.query.trim();
	const mode = classifyMode(query);
	const maxResults = Math.max(1, input.maximumResults ?? 50);
	const embeddingAvailable = ctx.embeddingAvailable && mode !== "exact_identifier";

	const generators: Array<{ kind: string; limit: number; filters: Record<string, unknown> }> = [];

	switch (mode) {
		case "exact_identifier":
			generators.push({ kind: "symbol", limit: maxResults, filters: { name: query } });
			generators.push({ kind: "lexical", limit: maxResults, filters: { exact: true } });
			generators.push({ kind: "path", limit: 10, filters: { path: query } });
			break;
		case "symbol_lookup":
			generators.push({ kind: "symbol", limit: maxResults, filters: { name: query } });
			generators.push({ kind: "lexical", limit: maxResults, filters: {} });
			if (embeddingAvailable) generators.push({ kind: "semantic", limit: maxResults, filters: {} });
			break;
		case "flow_investigation":
			generators.push({ kind: "lexical", limit: maxResults, filters: {} });
			generators.push({ kind: "symbol", limit: maxResults, filters: {} });
			if (embeddingAvailable) generators.push({ kind: "semantic", limit: maxResults, filters: {} });
			break;
		case "documentation":
		case "test_discovery":
		case "configuration":
		case "historical_change":
			generators.push({
				kind: "lexical",
				limit: maxResults,
				filters: {
					fileClass: mode === "documentation" ? "documentation" : mode === "test_discovery" ? "test" : undefined,
				},
			});
			if (mode === "test_discovery") generators.push({ kind: "symbol", limit: maxResults, filters: {} });
			if (embeddingAvailable) generators.push({ kind: "semantic", limit: maxResults, filters: {} });
			break;
		default:
			// semantic_concept / mixed
			generators.push({ kind: "lexical", limit: maxResults, filters: {} });
			if (embeddingAvailable) generators.push({ kind: "semantic", limit: maxResults, filters: {} });
			generators.push({ kind: "path", limit: 10, filters: {} });
			break;
	}

	return {
		queryId: `q_${Math.random().toString(36).slice(2, 12)}`,
		mode,
		normalizedQuery: query.toLowerCase(),
		generators,
		reranker: "deterministic_heuristic",
		maximumResults: maxResults,
		maximumContextTokens: input.maximumContextTokens,
	};
}

/** Quick symbol-existence probe to inform mode decisions in downstream code. */
export function probeSymbol(db: WorkspaceDb, generationId: string, name: string): boolean {
	return searchSymbolName(db, generationId, name, 5).length > 0;
}
