import type { SourceConfidence, WebEvidenceRecord } from "./types.js";

/**
 * Derives a machine-readable source confidence from structured source
 * properties. Confidence is never an arbitrary model label: it falls out of
 * whether a page was successfully and securely fetched, whether it exposes
 * dates/authority signals, and whether it can support exact claims.
 *
 * Policy (search snippets are discovery-only):
 * - A fetched page may reach `high` only when securely fetched and dated.
 * - An unfetched source (search snippet only) can never exceed `low`.
 * - A successful fetch alone is not enough to be `high` (a wiki is not high
 *   merely because it loaded).
 */

const AUTHORITY_DOMAINS = [/\.(gov|edu)$/, /^docs\./, /^developer\./, /^learn\./, /github\.com$/];

function domainAuthority(url: string): boolean {
	try {
		const { hostname } = new URL(url);
		return AUTHORITY_DOMAINS.some((re) => re.test(hostname));
	} catch {
		return false;
	}
}

export interface ConfidenceInput {
	fetched: boolean;
	record?: Pick<
		WebEvidenceRecord,
		"publishedAt" | "author" | "title" | "canonicalUrl" | "truncated" | "relevantPassages" | "contentSha256"
	>;
}

export function deriveSourceConfidence(input: ConfidenceInput): SourceConfidence {
	if (!input.fetched || !input.record) {
		// Unfetched: search snippet only. Never high confidence.
		return "low";
	}
	const record = input.record;
	let score = 0;
	if (record.publishedAt) score += 3;
	if (record.author) score += 2;
	if (domainAuthority(record.canonicalUrl)) score += 2;
	if (record.title && record.title.length > 4) score += 1;
	if (record.relevantPassages && record.relevantPassages.length > 0) score += 1;
	if (record.truncated) score -= 2;
	// "High" requires an authority signal (official/authoritative domain or a
	// named author) AND a publication date. A community wiki that merely loaded
	// successfully is never high, even if it carries a date.
	const hasAuthoritySignal = domainAuthority(record.canonicalUrl) || Boolean(record.author);
	if (hasAuthoritySignal && record.publishedAt && score >= 5) return "high";
	if (score >= 3 && hasAuthoritySignal) return "medium";
	if (score >= 3) return "low";
	return "low";
}

export function describeConfidence(confidence: SourceConfidence): string {
	switch (confidence) {
		case "high":
			return "securely fetched, dated/authoritative, supports exact claims";
		case "medium":
			return "securely fetched but lacks dating or authority signals; supports general claims";
		case "low":
			return "discovery-only or unfetched; cannot independently support exact numbers";
		case "unverified":
			return "no addressable evidence";
	}
}

/** A search snippet may be used only for discovery; it cannot establish exact claims. */
export const SEARCH_SNIPPETS_ARE_DISCOVERY_ONLY = true;
