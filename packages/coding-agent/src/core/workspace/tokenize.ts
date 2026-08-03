/**
 * Identifier-aware tokenization for code.
 *
 * Splits identifiers on camelCase, snake_case, kebab-case, and separators while
 * preserving the exact original token. Produces both the original token and its
 * normalized search tokens.
 */

const SPLIT_RE = /[^A-Za-z0-9_]+/g;

function camelSplit(word: string): string[] {
	const tokens: string[] = [];
	// Split on case transitions / digits boundaries and underscores.
	const parts = word
		.replace(/([a-z0-9])([A-Z])/g, "$1\u0000$2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1\u0000$2")
		.split(/[\u0000_]+/)
		.filter(Boolean);
	for (const p of parts) tokens.push(p.toLowerCase());
	return tokens;
}

export interface TokenizedIdentifier {
	original: string;
	lower: string;
	searchTokens: string[];
}

/** Tokenize a full query into normalized search tokens. */
export function tokenizeQuery(query: string): string[] {
	const tokens = new Set<string>();
	const cleaned = query.replace(SPLIT_RE, " ");
	for (const word of cleaned.trim().split(/\s+/)) {
		if (!word) continue;
		for (const t of camelSplit(word)) if (t.length >= 1) tokens.add(t);
		const lowered = word.toLowerCase();
		if (lowered.length >= 2) tokens.add(lowered);
	}
	return [...tokens];
}

/** Tokenize a single code identifier (preserving the original). */
export function tokenizeIdentifier(identifier: string): TokenizedIdentifier {
	return {
		original: identifier,
		lower: identifier.toLowerCase(),
		searchTokens: camelSplit(identifier),
	};
}

/** Produce the document text used for lexical indexing of a chunk. */
export function lexicalChunkText(options: {
	path: string;
	text: string;
	symbolName?: string;
	qualifiedName?: string;
}): string {
	const pathTokens = tokenizeQuery(options.path.replace(/[./\\]+/g, " "));
	const nameTokens = options.symbolName
		? [...tokenizeIdentifier(options.symbolName).searchTokens, options.symbolName.toLowerCase()]
		: [];
	const qTokens = options.qualifiedName ? tokenizeIdentifier(options.qualifiedName).searchTokens : [];
	return [...pathTokens, ...nameTokens, ...qTokens, options.text].join(" ");
}
