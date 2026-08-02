import { describe, expect, it } from "vitest";
import type { WebEvidenceRecord } from "./types.js";

describe("web evidence context composition measurement", () => {
	it("keeps the model-visible passage bounded relative to complete durable evidence", () => {
		const completeContent = "evidence paragraph with source detail\n".repeat(10_000);
		const visiblePassage = completeContent.slice(0, 12_000);
		const evidence = {
			evidenceId: "web-measurement",
			sourceType: "web",
			requestedUrl: "https://example.com",
			finalUrl: "https://example.com",
			canonicalUrl: "https://example.com",
			retrievedAt: "2026-08-02T00:00:00.000Z",
			contentType: "text/plain",
			extractor: "text",
			contentSha256: "a".repeat(64),
			completeContentLocation: "session:tool-result:web-measurement",
			completeContent,
			relevantPassages: [{ id: "passage-1-300", text: visiblePassage, startLine: 1, endLine: 300 }],
			outboundLinks: [],
			bytesDownloaded: Buffer.byteLength(completeContent),
			bytesExtracted: Buffer.byteLength(completeContent),
			truncated: true,
			untrusted: true,
		} satisfies WebEvidenceRecord;
		const durableBytes = Buffer.byteLength(evidence.completeContent);
		const visibleBytes = Buffer.byteLength(evidence.relevantPassages[0].text);
		expect(durableBytes).toBe(380_000);
		expect(visibleBytes).toBe(12_000);
		expect(visibleBytes).toBeLessThan(durableBytes);
	});
});
