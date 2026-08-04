export interface RetrievalLabel {
	resultId: string;
	relevance: number;
	current: boolean;
}

export interface RetrievalMetrics {
	recallAtK: number;
	precisionAtK: number;
	mrr: number;
	ndcg: number;
	exactSymbolHitRate: number;
	relevantFileHitRate: number;
	staleResultRate: number;
	duplicateResultRate: number;
	contextTokenEfficiency: number;
	revalidationSuccessRate: number;
}

function unique<T>(values: T[]): T[] {
	return [...new Set(values)];
}

export function calculateRetrievalMetrics(input: {
	results: RetrievalLabel[];
	relevantResultIds: string[];
	relevantSymbolIds?: string[];
	returnedSymbolIds?: string[];
	relevantFileIds?: string[];
	returnedFileIds?: string[];
	contextTokens?: number;
	revalidatedResultIds?: string[];
	k: number;
}): RetrievalMetrics {
	if (!Number.isInteger(input.k) || input.k <= 0) throw new Error("retrieval k must be a positive integer");
	const top = input.results.slice(0, input.k);
	const relevant = new Set(input.relevantResultIds);
	const topIds = top.map((result) => result.resultId);
	const uniqueTopIds = unique(topIds);
	const hits = uniqueTopIds.filter((id) => relevant.has(id)).length;
	const rankedHit = top.findIndex((result) => relevant.has(result.resultId) && result.current);
	const ideal = [...input.results]
		.filter((result) => result.current)
		.sort((left, right) => right.relevance - left.relevance)
		.slice(0, input.k)
		.map((result) => result.relevance);
	const dcg = top.reduce((sum, result, index) => sum + (2 ** result.relevance - 1) / Math.log2(index + 2), 0);
	const idcg = ideal.reduce((sum, relevance, index) => sum + (2 ** relevance - 1) / Math.log2(index + 2), 0);
	const relevantSymbols = unique(input.relevantSymbolIds ?? []);
	const returnedSymbols = unique(input.returnedSymbolIds ?? []);
	const relevantFiles = unique(input.relevantFileIds ?? []);
	const returnedFiles = unique(input.returnedFileIds ?? []);
	const revalidated = new Set(input.revalidatedResultIds ?? []);
	const currentRelevant = input.results.filter((result) => relevant.has(result.resultId) && result.current).length;
	return {
		recallAtK: relevant.size === 0 ? 0 : hits / relevant.size,
		precisionAtK: input.k === 0 ? 0 : hits / input.k,
		mrr: rankedHit === -1 ? 0 : 1 / (rankedHit + 1),
		ndcg: idcg === 0 ? 0 : dcg / idcg,
		exactSymbolHitRate:
			relevantSymbols.length === 0
				? 0
				: returnedSymbols.filter((id) => relevantSymbols.includes(id)).length / relevantSymbols.length,
		relevantFileHitRate:
			relevantFiles.length === 0
				? 0
				: returnedFiles.filter((id) => relevantFiles.includes(id)).length / relevantFiles.length,
		staleResultRate: top.length === 0 ? 0 : top.filter((result) => !result.current).length / top.length,
		duplicateResultRate: topIds.length === 0 ? 0 : (topIds.length - uniqueTopIds.length) / topIds.length,
		contextTokenEfficiency:
			input.contextTokens && input.contextTokens > 0 ? currentRelevant / input.contextTokens : 0,
		revalidationSuccessRate:
			top.length === 0 ? 0 : top.filter((result) => revalidated.has(result.resultId)).length / top.length,
	};
}
