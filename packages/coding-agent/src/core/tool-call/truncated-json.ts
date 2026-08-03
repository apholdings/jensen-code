import { sha256Hex } from "./canonicalize.js";
import type { TruncatedJsonOutcome } from "./types.js";

/**
 * Bounded, deterministic recovery of truncated JSON tool-call arguments caused
 * by streaming interruption or provider truncation.
 *
 * Invariants:
 *  - Distinguishes incomplete JSON from invalid complete JSON.
 *  - Only closes structural containers / finishes a trailing string token.
 *  - NEVER fabricates missing field values or guessed keys.
 *  - Enforces a maximum repair size, maximum depth, and max continuations.
 */

export const TOOL_CALL_TRUNCATED_UNRECOVERABLE = "TOOL_CALL_TRUNCATED_UNRECOVERABLE";

const MAX_DEPTH = 512;

export interface TruncatedJsonRecoveryResult {
	outcome: TruncatedJsonOutcome;
	/** Recovered JSON value, when recovered. */
	value?: unknown;
}

/**
 * Scan a JSON text and, when it is an INCOMPLETE but coherent prefix (near the
 * end of a stream), produce the shortest deterministic completion by closing
 * open containers / a trailing value string. Returns null when the text is not
 * a recoverable incomplete JSON document.
 *
 * The scanner advances through whitespace-aware tokens and, at end-of-input,
 * verifies we ended in a position that admits a structural close.
 */
export function tryCloseTruncatedJson(raw: string, maxBytes: number): string | null {
	if (raw.length > maxBytes) return null;

	const stack: ("{" | "[")[] = [];
	let i = 0;
	const n = raw.length;

	// Modes:
	//  awaitKey  -> inside object, expecting a key string or `}`
	//  key       -> reading a key string
	//  awaitColon-> just closed a key, expecting `:`
	//  awaitVal  -> expecting a value (root, after `:`, or after `[`/`,`)
	//  stringV   -> reading a string VALUE
	//  awaitSep  -> just completed a value, expecting `,` `}` `]` or whitespace
	let mode: "awaitKey" | "key" | "awaitColon" | "awaitVal" | "stringV" | "awaitSep" = "awaitVal";

	const scanLiteral = (): string | null => {
		if (raw.startsWith("true", i)) return "true";
		if (raw.startsWith("false", i)) return "false";
		if (raw.startsWith("null", i)) return "null";
		return null;
	};

	while (i < n) {
		const ch = raw[i];
		switch (mode) {
			case "awaitVal": {
				if (ch === "{") {
					stack.push("{");
					mode = "awaitKey";
					i++;
				} else if (ch === "[") {
					stack.push("[");
					mode = "awaitVal";
					i++;
				} else if (ch === '"') {
					mode = "stringV";
					i++;
				} else if (ch === "t" || ch === "f" || ch === "n") {
					const lit = scanLiteral();
					if (!lit) return null;
					i += lit.length;
					mode = "awaitSep";
				} else if (ch === "-" || (ch >= "0" && ch <= "9")) {
					const rest = raw.slice(i).match(/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/);
					if (!rest) return null;
					i += rest[0].length;
					mode = "awaitSep";
				} else if (/\s/.test(ch)) {
					i++;
				} else {
					return null; // unexpected char where a value was expected
				}
				break;
			}
			case "awaitKey": {
				if (ch === '"') {
					mode = "key";
					i++;
				} else if (ch === "}") {
					stack.pop();
					mode = "awaitSep";
					i++;
				} else if (/\s/.test(ch)) {
					i++;
				} else {
					return null;
				}
				break;
			}
			case "key": {
				if (ch === '"') {
					mode = "awaitColon";
					i++;
				} else if (ch === "\\") {
					if (i + 1 >= n) return null; // truncated escape within key
					i += 2;
				} else {
					i++;
				}
				break;
			}
			case "awaitColon": {
				if (ch === ":") {
					mode = "awaitVal";
					i++;
				} else if (/\s/.test(ch)) {
					i++;
				} else {
					return null;
				}
				break;
			}
			case "stringV": {
				if (ch === '"') {
					mode = "awaitSep";
					i++;
				} else if (ch === "\\") {
					if (i + 1 >= n) return null; // dangling backslash at eof
					if (raw[i + 1] === "u") {
						if (i + 5 >= n || !/^[0-9a-fA-F]{4}$/.test(raw.slice(i + 2, i + 6))) return null;
						i += 6;
					} else {
						i += 2;
					}
				} else {
					i++;
				}
				break;
			}
			case "awaitSep": {
				if (ch === ",") {
					if (stack.length && stack[stack.length - 1] === "{") mode = "awaitKey";
					else mode = "awaitVal";
					i++;
				} else if (ch === "}" || ch === "]") {
					const expected = ch === "}" ? "{" : "[";
					if (!stack.length || stack[stack.length - 1] !== expected) return null;
					stack.pop();
					mode = "awaitSep";
					i++;
				} else if (/\s/.test(ch)) {
					i++;
				} else {
					return null;
				}
				break;
			}
		}
		if (stack.length > MAX_DEPTH) return null;
	}

	// At end-of-input. Decide whether the last token is a recoverable close.
	let out = raw;
	if (mode === "stringV") {
		// A trailing value string without a closing quote. Only deterministic to
		// close inside an array value position (object values could be truncated
		// mid-value and closing the quote would be a guess about whether it is a
		// key or value is already resolved to value here, so it is safe).
		if (stack.length && stack[stack.length - 1] === "[") {
			out = `${raw}"`;
		} else {
			// root string value or object value: incomplete but the container is
			// still open; final closing quote is a deterministic finishing token.
			out = `${raw}"`;
		}
	} else if (mode === "key" || mode === "awaitColon") {
		// We are mid-key or waiting for colon: cannot fabricate the key.
		return null;
	} else if (out.endsWith(",")) {
		// Trailing comma before a close is invalid JSON; we strip it.
		out = out.replace(/,(\s*)$/, "$1");
	}

	if (stack.length) {
		for (let s = stack.length - 1; s >= 0; s--) {
			out += stack[s] === "{" ? "}" : "]";
		}
	}

	try {
		JSON.parse(out);
	} catch {
		return null;
	}
	return out;
}

/**
 * Deterministic recovery driver. Bounded by content size and continuation
 * attempts.
 */
export function recoverTruncatedJson(
	raw: string,
	opts: {
		maxBytes?: number;
		maxContinuations?: number;
		continuation?: (fragment: string) => Promise<string | null>;
	} = {},
): TruncatedJsonRecoveryResult {
	const maxBytes = opts.maxBytes ?? 256 * 1024;
	const maxContinuations = opts.maxContinuations ?? 3;
	const beforeHash = sha256Hex(raw);

	if (raw.length > maxBytes) {
		return { outcome: { status: "unrecoverable", reason: "exceeds_max_repair_size", beforeHash } };
	}

	try {
		JSON.parse(raw);
		return { outcome: { status: "not_truncated" }, value: JSON.parse(raw) };
	} catch {
		// fall through
	}

	let candidate = tryCloseTruncatedJson(raw, maxBytes);
	let continuationAttempts = 0;
	if (candidate === null && opts.continuation) {
		while (candidate === null && continuationAttempts < maxContinuations) {
			const fragment = opts.continuation(raw).catch(() => null);
			if (fragment === null) {
				continuationAttempts++;
				break;
			}
			const combined = raw + fragment;
			candidate = tryCloseTruncatedJson(combined, maxBytes);
			continuationAttempts++;
		}
	}
	if (candidate === null) {
		return { outcome: { status: "unrecoverable", reason: "structural_close_impossible", beforeHash } };
	}
	try {
		const value = JSON.parse(candidate);
		return {
			outcome: { status: "recovered", continuationAttempts, beforeHash, afterHash: sha256Hex(candidate) },
			value,
		};
	} catch {
		return { outcome: { status: "unrecoverable", reason: "recovered_but_invalid", beforeHash } };
	}
}

/** Escape helper reused by diagnostics so raw fragments are hashed, not logged. */
export { sha256Hex as fragmentHash };
