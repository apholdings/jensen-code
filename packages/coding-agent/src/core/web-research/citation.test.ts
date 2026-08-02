import { describe, expect, it } from "vitest";
import { buildClaimSupport, exactClaimLocatorError } from "./citation.js";

const RECORD = {
	evidenceId: "web-1",
	canonicalUrl: "https://docs.example.com/weapon",
	title: "Weapon data",
	retrievedAt: "2026-08-02T00:00:00.000Z",
	publishedAt: "2026-07-01T00:00:00.000Z",
	contentSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	relevantPassages: [{ id: "passage-1", text: "damage 225", startLine: 12, endLine: 12 }],
};

describe("addressable citations", () => {
	it("builds a direct support with coordinates and evidence identity", () => {
		const support = buildClaimSupport("claim-1", RECORD, { supportType: "direct" });
		expect(support.evidenceId).toBe("web-1");
		expect(support.sourceUrl).toBe("https://docs.example.com/weapon");
		expect(support.contentSha256).toBe(RECORD.contentSha256);
		expect(support.locator.kind).toBe("lines");
		expect(support.locator.start).toBe(12);
		expect(support.locator.end).toBe(12);
		expect(exactClaimLocatorError(support)).toBeUndefined();
	});

	it("rejects an exact claim whose line locator has no coordinates", () => {
		const support = buildClaimSupport("claim-2", RECORD, {
			supportType: "direct",
			locatorOverride: { kind: "lines" },
		});
		expect(support.locator.start).toBeUndefined();
		const error = exactClaimLocatorError(support);
		expect(error).toBeDefined();
		expect(error).toContain("locator");
	});

	it("renders a page locator for PDF evidence", () => {
		const support = buildClaimSupport("claim-3", RECORD, {
			supportType: "direct",
			locatorOverride: { kind: "page", page: 4 },
		});
		expect(support.locator.kind).toBe("page");
		expect(support.locator.page).toBe(4);
		expect(exactClaimLocatorError(support)).toBeUndefined();
	});

	it("labels snippet-only support and does not require coordinates", () => {
		const support = buildClaimSupport("claim-4", RECORD, { supportType: "snippet_only" });
		expect(support.supportType).toBe("snippet_only");
		expect(exactClaimLocatorError(support)).toBeUndefined();
	});
});
