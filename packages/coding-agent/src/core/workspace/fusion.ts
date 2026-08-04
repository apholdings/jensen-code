/**
 * Candidate fusion (reciprocal rank fusion) and deterministic heuristic
 * reranking. Duplicate chunks are merged, per-file diversity is enforced, exact
 * matches stay strong, and every result exposes its contributing signals.
 */

import type { HybridCandidateScore } from "./types.js";

export interface FusionCandidate {
	chunkId: string;
	file: string;
	ranking: number;
	generator: string;
	reasonCode: string;
	bonus?: number;
}

export interface FusedResult {
	chunkId: string;
	file: string;
	score: HybridCandidateScore;
	rank: number;
}

const RRF_K = 60;

/** Fuse ranked candidate lists from multiple generators via RRF. */
export function fuseCandidates(
	generatorLists: FusionCandidate[][],
	opts: { maxPerFile?: number; maximumResults?: number } = {},
): FusedResult[] {
	const maxPerFile = opts.maxPerFile ?? 4;
	const maximumResults = opts.maximumResults ?? 50;

	const perChunk = new Map<string, FusionCandidate[]>();
	for (const list of generatorLists) {
		for (const c of list) {
			const prev = perChunk.get(c.chunkId) ?? [];
			prev.push(c);
			perChunk.set(c.chunkId, prev);
		}
	}

	const fused: Array<{ chunkId: string; file: string; fused: number; gens: string[]; score: HybridCandidateScore }> =
		[];

	for (const [chunkId, candidates] of perChunk) {
		let fusedScore = 0;
		const gens = new Set<string>();
		let lexical: number | undefined;
		let semantic: number | undefined;
		let symbol: number | undefined;
		let lsp: number | undefined;
		let path: number | undefined;
		let git: number | undefined;
		let bonus = 0;

		for (const c of candidates) {
			fusedScore += 1 / (RRF_K + c.ranking);
			gens.add(c.generator);
			bonus += c.bonus ?? 0;
			switch (c.generator) {
				case "lexical":
					lexical = (lexical ?? 0) + 1 / (RRF_K + c.ranking);
					break;
				case "semantic":
					semantic = (semantic ?? 0) + 1 / (RRF_K + c.ranking);
					break;
				case "symbol":
					symbol = (symbol ?? 0) + 1 / (RRF_K + c.ranking);
					break;
				case "lsp":
					lsp = (lsp ?? 0) + 1 / (RRF_K + c.ranking);
					break;
				case "path":
					path = (path ?? 0) + 1 / (RRF_K + c.ranking);
					break;
				case "git":
					git = (git ?? 0) + 1 / (RRF_K + c.ranking);
					break;
			}
		}

		const order = significantOrder(candidates);
		fused.push({
			chunkId,
			file: candidates[0].file,
			fused: fusedScore + bonus,
			gens: order,
			score: {
				lexical: round(lexical),
				semantic: round(semantic),
				symbol: round(symbol),
				lsp: round(lsp),
				path: round(path),
				git: round(git),
				fused: round(fusedScore + bonus) ?? 0,
				reasonCodes: order,
			},
		});
	}

	fused.sort((a, b) => b.fused - a.fused || a.chunkId.localeCompare(b.chunkId));

	// Per-file diversity + bounded results.
	const perFileSeen = new Map<string, number>();
	const output: FusedResult[] = [];
	let rank = 1;
	for (const f of fused) {
		const count = perFileSeen.get(f.file) ?? 0;
		if (count >= maxPerFile) continue;
		perFileSeen.set(f.file, count + 1);
		output.push({
			chunkId: f.chunkId,
			file: f.file,
			rank: rank++,
			score: f.score,
		});
		if (output.length >= maximumResults) break;
	}
	return output;
}

/** Order of generators by their contribution strength (for reason codes). */
function significantOrder(candidates: FusionCandidate[]): string[] {
	const byGen = new Map<string, number>();
	for (const c of candidates) byGen.set(c.generator, (byGen.get(c.generator) ?? 0) + 1 / (RRF_K + c.ranking));
	return [...byGen.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g);
}

function round(n: number | undefined): number | undefined {
	return n === undefined ? undefined : Number(n.toFixed(4));
}

/** Deterministic heuristic reranker over fused results (no separate model). */
export function rerankHeuristic(
	results: FusedResult[],
	opts: { exactTerm?: string; symbolMatch?: Set<string> } = {},
): FusedResult[] {
	const exactTerm = opts.exactTerm?.toLowerCase();
	return [...results]
		.map((r, _i) => {
			let delta = 0;
			let reason = "";
			// Exact identifier match on file basename.
			if (exactTerm && r.file.toLowerCase().includes(exactTerm)) {
				delta += 2;
				reason = "exact_file_match";
			}
			// Symbol match bonus.
			if (opts.symbolMatch?.has(r.chunkId)) {
				delta += 1.5;
				reason = reason ? `${reason},symbol_match` : "symbol_match";
			}
			return { ...r, score: { ...r.score, fused: round((r.score.fused ?? 0) + delta) ?? 0 }, _deltaReason: reason };
		})
		.sort((a, b) => (b.score.fused ?? 0) - (a.score.fused ?? 0) || a.chunkId.localeCompare(b.chunkId))
		.map((r, i) => {
			// rebuild final
			return {
				chunkId: r.chunkId,
				file: r.file,
				rank: i + 1,
				score: r.score,
			};
		});
}
