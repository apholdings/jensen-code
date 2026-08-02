import { describe, expect, it } from "vitest";
import { deriveSourceConfidence } from "./confidence.js";

function record(overrides: Record<string, unknown> = {}) {
	return {
		publishedAt: undefined as string | undefined,
		author: undefined as string | undefined,
		title: "",
		canonicalUrl: "https://example.com/page",
		truncated: false,
		relevantPassages: [] as Array<{ id: string; text: string; startLine?: number; endLine?: number; page?: number }>,
		contentSha256: "abc",
		...overrides,
	};
}

describe("source confidence", () => {
	it("marks an unfetched source (search snippet only) as low, never high", () => {
		expect(deriveSourceConfidence({ fetched: false })).toBe("low");
	});

	it("does not treat a successfully loaded wiki as high without dates/authority", () => {
		expect(
			deriveSourceConfidence({ fetched: true, record: record({ canonicalUrl: "https://wiki.example/x" }) }),
		).not.toBe("high");
	});

	it("treats a securely fetched dated official source as high", () => {
		const level = deriveSourceConfidence({
			fetched: true,
			record: record({
				publishedAt: "2026-01-01",
				canonicalUrl: "https://docs.example.com/a",
				title: "Guide",
				author: "Vendor",
				relevantPassages: [{ id: "p1", text: "guide" }],
			}),
		});
		expect(level).toBe("high");
	});
});
