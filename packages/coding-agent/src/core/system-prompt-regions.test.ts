import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSystemPrompt, buildSystemPromptRegions } from "./system-prompt.js";

afterEach(() => {
	vi.useRealTimers();
});

describe("system prompt cache regions", () => {
	it("keeps date and host paths outside the stable prefix", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-02T00:00:00Z"));
		const first = buildSystemPromptRegions({ cwd: process.cwd(), selectedTools: ["write", "read"] });
		vi.setSystemTime(new Date("2026-08-03T00:00:00Z"));
		const second = buildSystemPromptRegions({ cwd: process.cwd(), selectedTools: ["read", "write"] });

		expect(first.stablePrefix).toBe(second.stablePrefix);
		expect(first.stablePrefix).not.toContain("Current date:");
		expect(first.dynamicSuffix).toContain("Current date: 2026-08-02");
		expect(second.dynamicSuffix).toContain("Current date: 2026-08-03");
		expect(first.dynamicSuffix).toContain("- working directory:");
	});

	it("preserves the complete compatibility prompt for direct callers", () => {
		const regions = buildSystemPromptRegions({ customPrompt: "stable custom", cwd: "/tmp/project" });
		const complete = buildSystemPrompt({ customPrompt: "stable custom", cwd: "/tmp/project" });

		expect(complete).toBe(`${regions.stablePrefix}\n\n${regions.dynamicSuffix}`);
	});
});
