import type { Tool } from "@apholdings/jensen-ai";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
	estimateAssemblyInputTokens,
	estimateContextRegionCosts,
	estimateStablePrefixTokens,
} from "../../src/core/context-runtime/context-token.js";
import {
	analyzeText,
	estimateTextTokens,
	MAX_CALIBRATED_MULTIPLIER,
	resolveAccountingMode,
} from "../../src/core/context-runtime/token-accounting.js";

// Legacy heuristic reference (the former sole safety basis).
function legacyCharsPerFour(text: string): number {
	return Math.ceil(text.length / 4);
}

describe("token accounting estimator (TEST E/F/S)", () => {
	it("TEST E — ASCII prose is never under the legacy chars/4 heuristic", () => {
		const samples = [
			"The quick brown fox jumps over the lazy dog",
			"Refactor the authentication module while preserving the public API surface.",
			"a".repeat(1000),
		];
		for (const text of samples) {
			expect(estimateTextTokens(text, "prose")).toBeGreaterThanOrEqual(legacyCharsPerFour(text));
		}
	});

	it("TEST E — code with dense symbols is counted more conservatively than chars/4", () => {
		const code = "const x = foo(bar); if (x) return x + 1;";
		expect(estimateTextTokens(code, "code")).toBeGreaterThan(legacyCharsPerFour(code));
	});

	it("TEST E — minified JSON is counted symbol-wise, never collapsed to chars/4", () => {
		const json = '{"a":1,"b":2,"c":[3,4,5]}';
		expect(estimateTextTokens(json, "json")).toBeGreaterThan(legacyCharsPerFour(json));
	});

	it("TEST F — CJK text is counted ~1 token per code point, not chars/4", () => {
		const cjk = "你好世界，这是中文测试";
		const estimate = estimateTextTokens(cjk, "prose");
		expect(estimate).toBeGreaterThanOrEqual(cjk.length);
		// chars/4 would be a fraction of the true cost; the estimator must exceed it.
		expect(estimate).toBeGreaterThan(legacyCharsPerFour(cjk));
	});

	it("TEST F — emoji (astral code points) are never underestimated", () => {
		const emoji = "👍👍👍";
		const estimate = estimateTextTokens(emoji, "prose");
		// Each astral code point is counted as 2 tokens.
		expect(estimate).toBeGreaterThanOrEqual(6);
		expect(estimate).toBeGreaterThan(legacyCharsPerFour(emoji));
	});

	it("TEST S — adversarial content stays safely conservative", () => {
		const adversarial: Array<[string, Parameters<typeof estimateTextTokens>[1]]> = [
			[" ".repeat(1000), "prose"],
			["(){[]}<>,.;:".repeat(200), "code"],
			[`${"{"}${'"'}${"k"}${'"'}:${"0"}${","}${"}"}`.repeat(200), "json"],
			["你好世界你好世界".repeat(50), "prose"],
			["👍👨‍👩‍👧‍👦🚀🎯".repeat(20), "prose"],
			["/a/very/long/path/to/a/source/file.ts".repeat(30), "code"],
			["....!!!!????".repeat(100), "log"],
			["at main.ts:120:34 in call stack frame".repeat(40), "log"],
		];
		for (const [text, cls] of adversarial) {
			const estimate = estimateTextTokens(text, cls ?? "prose");
			expect(estimate).toBeGreaterThanOrEqual(0);
			// Safety floor: never below the legacy chars/4 for any content class.
			expect(estimate).toBeGreaterThanOrEqual(legacyCharsPerFour(text));
		}
	});

	it("analyzeText classifies ASCII/non-ASCII/astral correctly", () => {
		const analysis = analyzeText("ab👍中");
		expect(analysis.asciiChars).toBe(2);
		expect(analysis.nonAsciiBmpChars).toBe(1);
		expect(analysis.astralChars).toBe(1);
	});

	it("calibrated multiplier is bounded and only ever raises", () => {
		expect(resolveAccountingMode(undefined)).toBe("conservative-estimate");
		expect(resolveAccountingMode(1)).toBe("conservative-estimate");
		expect(resolveAccountingMode(1.2)).toBe("calibrated");
		expect(resolveAccountingMode(99)).toBe("calibrated");
		const base = estimateTextTokens("hello world", "prose");
		const raised = estimateTextTokens("hello world", "prose", { calibratedMultiplier: 99 });
		expect(raised).toBeGreaterThanOrEqual(base);
		expect(raised).toBeLessThanOrEqual(Math.ceil(base * MAX_CALIBRATED_MULTIPLIER));
	});

	it("TEST G — tool schemas are included in the total input estimate", () => {
		const tools: Tool[] = [
			{ name: "read_file", description: "Read a file from disk", parameters: Type.Object({}) },
			{ name: "bash", description: "Run a shell command", parameters: Type.Object({}) },
		];
		const prefix = estimateStablePrefixTokens("system prompt", tools);
		expect(prefix).toBeGreaterThan(estimateStablePrefixTokens("system prompt", []));

		const regions = estimateContextRegionCosts({ systemPrompt: "system prompt", messages: [], tools });
		expect(regions.toolSchemaTokens).toBeGreaterThan(0);
		expect(regions.fixedPrefixTokens).toBeGreaterThanOrEqual(regions.systemPromptTokens + regions.toolSchemaTokens);

		const total = estimateAssemblyInputTokens({ systemPrompt: "system prompt", messages: [], tools });
		expect(total).toBeGreaterThanOrEqual(regions.fixedPrefixTokens);
	});
});
