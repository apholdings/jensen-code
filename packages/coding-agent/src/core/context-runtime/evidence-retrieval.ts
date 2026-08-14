/**
 * Model-facing evidence retrieval (2.5.0 extension).
 *
 * Bridges a deterministic evidence reference (the id embedded in virtualized
 * tool results and checkpoint preambles) back to its authoritative cold
 * artifact. Retrieval is:
 *   - read-only: it returns DATA, never privileged instructions
 *   - bounded: a hard page cap so a single call can never re-inflate the model
 *     context beyond the Context Governor's budget
 *   - integrity-checked: content is rehashed against the stored contentHash and
 *     fails closed on mismatch (never a synopsis, never fabricated content)
 *   - deterministic: character-range paging so the model can page the same
 *     artifact repeatedly and reconstruct it exactly
 *
 * Retrieval does NOT move completion authority. Merely fetching an archived
 * `node --test` output never means "tests verified"; the Reliability Kernel /
 * Completion Gate remain the sole authority for mission completion.
 */

import { type EvidenceArchive, type EvidenceRecord, hashContent } from "./evidence-archive.js";

/** Default characters returned per page when the model does not specify a limit. */
export const DEFAULT_EVIDENCE_PAGE_CHARS = 4000;

/** Hard maximum characters returned by a single retrieval (provider-independent). */
export const MAX_EVIDENCE_PAGE_CHARS = 8000;

export type EvidenceRetrievalStatus = "ok" | "not-found" | "corrupt" | "invalid-range";

export type EvidenceIntegrity = "verified" | "unverified";

export interface EvidenceRetrievalMetadata {
	evidenceId: string;
	kind: EvidenceRecord["kind"];
	source: string;
	contentHash: string;
	integrity: EvidenceIntegrity;
	totalBytes: number;
	totalChars: number;
	/** Inclusive start character index of the returned page. */
	start: number;
	/** Exclusive end character index of the returned page. */
	end: number;
	/** Number of characters actually returned. */
	retrievedChars: number;
	/** True when more content exists after this page. */
	hasMore: boolean;
	/**
	 * The archive always stores the redacted representation, so retrieval only
	 * ever returns the safe authoritative stored form — never the pre-redaction
	 * secret material that was scrubbed at archive time.
	 */
	redaction: "archive-scrubbed";
}

export interface EvidenceRetrievalResult {
	ok: boolean;
	status: EvidenceRetrievalStatus;
	evidenceId: string;
	/** Present only when status === "ok". */
	content?: string;
	/** Present only when status === "ok". */
	metadata?: EvidenceRetrievalMetadata;
	/** Human/LLM-readable reason for non-ok results. */
	reason?: string;
}

export interface EvidenceRetrievalOptions {
	/** 0-based character offset. Default 0. */
	offset?: number;
	/** Maximum characters to return. Default DEFAULT_EVIDENCE_PAGE_CHARS, hard-capped at MAX_EVIDENCE_PAGE_CHARS. */
	limit?: number;
}

/** Clamp a requested page limit to [1, MAX_EVIDENCE_PAGE_CHARS], defaulting to the bounded default. */
export function clampEvidencePageLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DEFAULT_EVIDENCE_PAGE_CHARS;
	return Math.max(1, Math.min(Math.floor(limit), MAX_EVIDENCE_PAGE_CHARS));
}

/**
 * Retrieve a bounded, integrity-verified page of an archived evidence artifact.
 *
 * Fails closed:
 *   - unknown id      -> status "not-found"
 *   - hash mismatch   -> status "corrupt" (no content returned)
 *   - offset out of   -> status "invalid-range"
 */
export async function retrieveEvidencePage(
	archive: EvidenceArchive,
	evidenceId: string,
	options: EvidenceRetrievalOptions = {},
): Promise<EvidenceRetrievalResult> {
	const record = await archive.load(evidenceId);
	if (!record) {
		return {
			ok: false,
			status: "not-found",
			evidenceId,
			reason: `No archived evidence found for id "${evidenceId}".`,
		};
	}

	const integrity: EvidenceIntegrity = hashContent(record.content) === record.contentHash ? "verified" : "unverified";
	if (integrity !== "verified") {
		return {
			ok: false,
			status: "corrupt",
			evidenceId,
			reason: `Integrity check failed for evidence "${evidenceId}": stored contentHash does not match the artifact.`,
		};
	}

	const totalChars = record.content.length;
	const offset = options.offset !== undefined && Number.isFinite(options.offset) ? Math.floor(options.offset) : 0;
	if (offset < 0 || offset >= totalChars) {
		return {
			ok: false,
			status: "invalid-range",
			evidenceId,
			reason: `Offset ${offset} is outside artifact "${evidenceId}" (${totalChars} chars).`,
		};
	}

	const limit = clampEvidencePageLimit(options.limit);
	const start = offset;
	const end = Math.min(totalChars, start + limit);
	const page = record.content.slice(start, end);

	return {
		ok: true,
		status: "ok",
		evidenceId,
		content: page,
		metadata: {
			evidenceId,
			kind: record.kind,
			source: record.source,
			contentHash: record.contentHash,
			integrity,
			totalBytes: record.contentBytes,
			totalChars,
			start,
			end,
			retrievedChars: page.length,
			hasMore: end < totalChars,
			redaction: "archive-scrubbed",
		},
	};
}
