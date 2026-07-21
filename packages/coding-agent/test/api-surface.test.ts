import { describe, expect, it } from "vitest";

// ============================================================================
// API-surface regression test: internal types must not leak into public exports.
//
// Uses @ts-expect-error on import() type expressions. If the type IS exported,
// the expression succeeds and TypeScript emits "Unused @ts-expect-error directive",
// causing tsgo --noEmit to fail.
// ============================================================================

import type { BashOperations, BashToolDetails } from "../src/index.js";

// @ts-expect-error: ResolvedBashResult must not be exported from package root.
type _AssertResolvedBashResultPrivate = typeof import("../src/index.js").ResolvedBashResult;

// @ts-expect-error: ResolvedBashToolDetails must not be exported from tools barrel.
type _AssertResolvedDetailsPrivate = typeof import("../src/core/tools/index.js").ResolvedBashToolDetails;

describe("api-surface public exports", () => {
	it("intentional public symbols are importable from package root", () => {
		// BashToolDetails — importable and constructible with 1.1.6 shape.
		const details: BashToolDetails = {
			truncation: undefined,
			fullOutputPath: undefined,
		};
		expect(details.truncation).toBeUndefined();

		// BashOperations — importable structural interface for extensions SDK.
		void ({} as BashOperations);
	});

	it("ResolvedBashResult is not importable from package root", () => {
		// Verified by @ts-expect-error on the type expression above.
		expect(true).toBe(true);
	});

	it("ResolvedBashToolDetails is not importable from tools barrel", () => {
		// Verified by @ts-expect-error on the type expression above.
		expect(true).toBe(true);
	});
});
