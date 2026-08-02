import type {
	EvidenceLocator,
	ResearchClaimSupport,
	ResearchSupportType,
	SourceConfidence,
	WebEvidenceRecord,
} from "./types.js";

/**
 * Addressable citation builder.
 *
 * Policy:
 * - Exact numeric/mechanical claims require a locator; a claim without
 *   coordinates on its source is rejected (`unverified`) unless it is an
 *   inference.
 * - snippet_only support is visibly labeled and never `high` confidence.
 * - A support object must expose evidenceId, sourceUrl, retrievedAt,
 *   contentSha256 and coordinates to satisfy the traceability contract.
 */

export interface BuildSupportOptions {
	supportType?: ResearchSupportType;
	effectiveAt?: string;
	confidence?: SourceConfidence;
	locatorOverride?: EvidenceLocator;
}

function locatorFor(
	record: Pick<WebEvidenceRecord, "relevantPassages">,
	locatorOverride?: EvidenceLocator,
): EvidenceLocator | undefined {
	if (locatorOverride) return locatorOverride;
	const passage = record.relevantPassages[0];
	if (passage) {
		if (passage.page !== undefined) {
			return { kind: "page", page: passage.page, passageId: passage.id };
		}
		return {
			kind: "lines",
			start: passage.startLine,
			end: passage.endLine,
			passageId: passage.id,
		};
	}
	return undefined;
}

export function buildClaimSupport(
	claimId: string,
	record: Pick<
		WebEvidenceRecord,
		"evidenceId" | "canonicalUrl" | "title" | "retrievedAt" | "publishedAt" | "contentSha256" | "relevantPassages"
	>,
	options: BuildSupportOptions = {},
): ResearchClaimSupport {
	const locator = locatorFor(record, options.locatorOverride);
	let supportType: ResearchSupportType = options.supportType ?? "direct";
	const effectiveAt = options.effectiveAt;

	// Missing coordinates on an exact claim => unverified (or inference).
	if (!locator && supportType !== "inference" && supportType !== "snippet_only") {
		supportType = "unverified";
	}

	return {
		claimId,
		evidenceId: record.evidenceId,
		supportType,
		sourceUrl: record.canonicalUrl,
		sourceTitle: record.title,
		retrievedAt: record.retrievedAt,
		publishedAt: record.publishedAt,
		effectiveAt,
		contentSha256: record.contentSha256,
		locator: locator ?? { kind: "lines" },
	};
}

/** Renders a support object as human-usable citation text. */
export function formatSupport(support: ResearchClaimSupport): string {
	const coords =
		support.locator.kind === "page"
			? `page ${support.locator.page}`
			: support.locator.kind === "json_pointer"
				? `json ${support.locator.jsonPointer}`
				: `lines ${support.locator.start ?? "?"}-${support.locator.end ?? "?"}`;
	const date = support.effectiveAt
		? `eff ${support.effectiveAt}`
		: support.publishedAt
			? `pub ${support.publishedAt}`
			: "";
	return `[${support.evidenceId}:${coords}${date ? `, ${date}` : ""}] ${support.sourceUrl}`;
}

/** Rejects an exact claim whose support lacks coordinates. */
export function exactClaimLocatorError(support: ResearchClaimSupport): string | undefined {
	if (support.supportType === "inference" || support.supportType === "snippet_only") return undefined;
	const locator = support.locator;
	if (!locator) return `Claim ${support.claimId} lacks a locator; exact claims require coordinates.`;
	if (locator.kind === "lines" && (locator.start === undefined || locator.end === undefined)) {
		return `Claim ${support.claimId} line locator is missing start/end coordinates.`;
	}
	if (locator.kind === "page" && locator.page === undefined) {
		return `Claim ${support.claimId} page locator is missing a page number.`;
	}
	if (!support.evidenceId || !support.sourceUrl || !support.contentSha256) {
		return `Claim ${support.claimId} is missing evidence identity (evidenceId/sourceUrl/contentSha256).`;
	}
	return undefined;
}
