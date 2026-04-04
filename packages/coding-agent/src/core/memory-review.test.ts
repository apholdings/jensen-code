import { describe, expect, it } from "vitest";
import { formatMemoryAgeLabel, getMemoryAgeDays, reviewMemoryItems } from "./memory-review.js";

describe("memory review", () => {
	it("formats recent ages clearly", () => {
		expect(formatMemoryAgeLabel(0)).toBe("today");
		expect(formatMemoryAgeLabel(1)).toBe("yesterday");
		expect(formatMemoryAgeLabel(3)).toBe("3 days ago");
		expect(formatMemoryAgeLabel(null)).toBe("unknown age");
	});

	it("computes age in whole days", () => {
		const now = new Date("2026-01-10T00:00:00.000Z").getTime();
		expect(getMemoryAgeDays("2026-01-10T00:00:00.000Z", now)).toBe(0);
		expect(getMemoryAgeDays("2026-01-09T00:00:00.000Z", now)).toBe(1);
	});

	it("flags stale entries conservatively", () => {
		const now = new Date("2026-01-20T00:00:00.000Z").getTime();
		const reviewed = reviewMemoryItems(
			[
				{ key: "fresh", value: "value", timestamp: "2026-01-18T00:00:00.000Z" },
				{ key: "stale", value: "value", timestamp: "2026-01-01T00:00:00.000Z" },
			],
			now,
		);
		expect(reviewed[0]?.reviewRecommended).toBe(false);
		expect(reviewed[1]?.reviewRecommended).toBe(true);
		expect(reviewed[1]?.note).toContain("Verify before relying on it.");
	});
});
