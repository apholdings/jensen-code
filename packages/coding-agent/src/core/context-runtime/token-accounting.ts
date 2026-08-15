/**
 * Tiered token accounting for context virtualization (2.6.0 hardening).
 *
 * The governor must never under-count against a model's REAL context limit.
 * Before this module, the sole safety basis was `chars / 4`, which is a good
 * approximation for English prose but dangerously under-counts content that a
 * real tokenizer expands:
 *
 *   - CJK / non-ASCII text (≈1 token per code point, not 1 per 4 chars)
 *   - emoji / astral-plane code points (≥1 token each, often more)
 *   - minified JSON / dense punctuation (≈1 token per symbol)
 *   - code (symbols and identifiers tokenize finer than prose)
 *
 * Tiering (best to worst):
 *
 *   exact                 -> provider/model tokenizer when available (not yet wired)
 *   tokenizer             -> local deterministic tokenizer (not yet wired)
 *   calibrated            -> bounded uplift derived from provider-reported usage
 *   conservative-estimate -> content-class aware fallback (always biased safe)
 *
 * No exact tokenizer dependency is added: the fallback is deterministic,
 * content-class aware, and biased toward over-estimation.
 */

export type TokenAccountingMode = "exact" | "tokenizer" | "calibrated" | "conservative-estimate";

/**
 * Content class used to pick the conservative divisor. Lower divisor = more
 * conservative (more tokens per character).
 */
export type ContentClass = "prose" | "code" | "json" | "tool-schema" | "tool-result" | "system-prompt" | "log";

export interface TextTokenAnalysis {
	/** ASCII characters (code points < 0x80). */
	asciiChars: number;
	/** ASCII punctuation/symbol characters (not alphanumeric, not whitespace). */
	asciiSymbols: number;
	/** Non-ASCII BMP code points (CJK, accented Latin, etc.). */
	nonAsciiBmpChars: number;
	/** Astral-plane code points (surrogate pairs — emoji, rare scripts). */
	astralChars: number;
	/** Ratio of ASCII symbols to total ASCII (0..1). */
	symbolRatio: number;
}

export interface TokenAccountingOptions {
	/**
	 * Bounded conservative uplift multiplier from provider-usage calibration.
	 * Must be >= 1; only ever makes estimates larger, never smaller.
	 */
	calibratedMultiplier?: number;
}

const DIVISORS: Record<ContentClass, number> = {
	prose: 4,
	code: 3,
	json: 2.5,
	"tool-schema": 3,
	"tool-result": 3,
	"system-prompt": 4,
	log: 3,
};

/** Above this ASCII symbol density the estimator switches to symbol 1:1 accounting. */
const DENSE_SYMBOL_RATIO = 0.15;

/** Bound the calibrated uplift so one outlier cannot cripple the budget. */
export const MAX_CALIBRATED_MULTIPLIER = 1.5;

function isAsciiSymbol(ch: string): boolean {
	const cp = ch.codePointAt(0)!;
	if (cp < 0x21 || cp > 0x7e) return false;
	if ((cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) return false;
	return true;
}

/**
 * Analyze a string into the token-relevant character classes. Iterates by code
 * point (not UTF-16 code unit) so surrogate pairs are counted as one astral char.
 */
export function analyzeText(text: string): TextTokenAnalysis {
	let asciiChars = 0;
	let asciiSymbols = 0;
	let nonAsciiBmpChars = 0;
	let astralChars = 0;

	for (const ch of text) {
		const cp = ch.codePointAt(0)!;
		if (cp < 0x80) {
			asciiChars += 1;
			if (isAsciiSymbol(ch)) asciiSymbols += 1;
		} else if (cp <= 0xffff) {
			nonAsciiBmpChars += 1;
		} else {
			astralChars += 1;
		}
	}

	return {
		asciiChars,
		asciiSymbols,
		nonAsciiBmpChars,
		astralChars,
		symbolRatio: asciiChars > 0 ? asciiSymbols / asciiChars : 0,
	};
}

function applyCalibratedUplift(tokens: number, multiplier: number | undefined): number {
	if (multiplier === undefined || multiplier <= 1) return tokens;
	const bounded = Math.min(Math.max(multiplier, 1), MAX_CALIBRATED_MULTIPLIER);
	return Math.ceil(tokens * bounded);
}

/**
 * Conservative token estimate for a single text payload.
 *
 * Guarantees (bias):
 *   - ASCII prose: ~1 token / 4 chars (matches the historical heuristic).
 *   - Code / JSON / logs: ~1 token / 3 chars or finer.
 *   - Dense punctuation (minified JSON): symbols counted 1:1, remaining /4.
 *   - Non-ASCII BMP (CJK): 1 token per code point.
 *   - Astral (emoji): 2 tokens per code point.
 *
 * These are deliberately upper-biased for the content classes a coding agent
 * actually encounters.
 */
export function estimateTextTokens(
	text: string,
	contentClass: ContentClass = "prose",
	options: TokenAccountingOptions = {},
): number {
	if (!text) return 0;
	const a = analyzeText(text);
	const asciiNonSymbols = Math.max(0, a.asciiChars - a.asciiSymbols);

	let tokens: number;
	if (a.symbolRatio >= DENSE_SYMBOL_RATIO) {
		// Dense punctuation: every symbol is roughly its own token.
		tokens = Math.ceil(asciiNonSymbols / 4) + a.asciiSymbols + a.nonAsciiBmpChars + a.astralChars * 2;
	} else {
		const divisor = DIVISORS[contentClass] ?? DIVISORS.prose;
		tokens = Math.ceil(a.asciiChars / divisor) + a.nonAsciiBmpChars + a.astralChars * 2;
	}

	return applyCalibratedUplift(tokens, options.calibratedMultiplier);
}

/** Resolve the effective accounting mode from the current calibration state. */
export function resolveAccountingMode(calibratedMultiplier: number | undefined): TokenAccountingMode {
	if (calibratedMultiplier !== undefined && calibratedMultiplier > 1) return "calibrated";
	return "conservative-estimate";
}
