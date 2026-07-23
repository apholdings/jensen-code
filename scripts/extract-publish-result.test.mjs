// ============================================================================
// Regression tests for publish-result extraction.
// Covers cases R01–R10 from the release-tag-output-propagation defect.
// ============================================================================

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractPublishResult } from "./extract-publish-result.mjs";

// ============================================================================
// Helpers
// ============================================================================

function fixture(payload) {
	const json = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
	return `\n--- PUBLISH RESULT ---\n${json}`;
}

function fixtureWithTrailing(payload, suffix) {
	const json = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
	return `\n--- PUBLISH RESULT ---\n${json}${suffix}`;
}

// ============================================================================
// R01 — Valid pretty-printed JSON ending at EOF, without a blank line
// ============================================================================

it("R01: valid JSON ending at EOF without trailing blank line", () => {
	const text = fixture({
		releaseVersion: "1.1.8",
		releaseTag: "v1.1.8",
		publishedPackages: [],
		alreadyPublishedPackages: [],
		allPackagesVerified: true,
		tagCreated: true,
	});

	const result = extractPublishResult(text);
	assert.equal(result.releaseTag, "v1.1.8");
});

// ============================================================================
// R02 — Valid JSON followed by a blank line
// ============================================================================

it("R02: valid JSON followed by a blank line", () => {
	const text = fixtureWithTrailing(
		{
			releaseVersion: "1.1.8",
			releaseTag: "v1.1.8",
			publishedPackages: [],
			alreadyPublishedPackages: [],
			allPackagesVerified: true,
			tagCreated: true,
		},
		"\n",
	);

	const result = extractPublishResult(text);
	assert.equal(result.releaseTag, "v1.1.8");
});

// ============================================================================
// R03 — Valid JSON followed by another marker or log section
// ============================================================================

it("R03: valid JSON followed by another marker section — only PUBLISH RESULT parsed", () => {
	const text = fixtureWithTrailing(
		{
			releaseVersion: "1.1.8",
			releaseTag: "v1.1.8",
			publishedPackages: [],
			alreadyPublishedPackages: [],
			allPackagesVerified: true,
			tagCreated: true,
		},
		"\n\n--- SOME OTHER SECTION ---\n{ \"other\": true }\n",
	);

	const result = extractPublishResult(text);
	assert.equal(result.releaseTag, "v1.1.8");
});

// ============================================================================
// R04 — No release tag in result
// ============================================================================

it("R04: no release tag — returns empty string", () => {
	// This happens when allPackagesVerified is false and no tag was created
	const text = fixture({
		releaseVersion: "1.1.8",
		releaseTag: null,
		publishedPackages: [],
		alreadyPublishedPackages: [],
		allPackagesVerified: false,
		tagCreated: false,
	});

	const result = extractPublishResult(text);
	assert.equal(result.releaseTag, "");
});

// ============================================================================
// R05 — Malformed JSON
// ============================================================================

it("R05: malformed JSON — extraction fails visibly", () => {
	const text = `\n--- PUBLISH RESULT ---\n{ not valid json }\n`;

	assert.throws(
		() => extractPublishResult(text),
		/Malformed publish result JSON/,
	);
});

// ============================================================================
// R06 — Missing PUBLISH RESULT marker
// ============================================================================

it("R06: missing PUBLISH RESULT marker — fails visibly", () => {
	const text = `some random log output\nbut no marker at all\n`;

	assert.throws(
		() => extractPublishResult(text),
		/PUBLISH RESULT marker not found/,
	);
});

// ============================================================================
// R07 — Tag containing unexpected characters
// ============================================================================

it("R07a: tag with spaces — rejected", () => {
	const text = fixture({
		releaseVersion: "1.1.8",
		releaseTag: "v1.1.8 malicious",
	});

	assert.throws(
		() => extractPublishResult(text),
		/Invalid release tag/,
	);
});

it("R07b: tag with shell metacharacters — rejected", () => {
	const text = fixture({
		releaseVersion: "1.1.8",
		releaseTag: "v1.1.8;rm -rf /",
	});

	assert.throws(
		() => extractPublishResult(text),
		/Invalid release tag/,
	);
});

it("R07c: tag with newline — rejected", () => {
	const text = fixture({
		releaseVersion: "1.1.8",
		releaseTag: "v1.1.8\nmalicious",
	});

	assert.throws(
		() => extractPublishResult(text),
		/Invalid release tag/,
	);
});

it("R07d: overly long tag — rejected", () => {
	const long = "v1." + "0".repeat(80);
	const text = fixture({
		releaseTag: long,
	});

	assert.throws(
		() => extractPublishResult(text),
		/exceeds 80 characters/,
	);
});

// ============================================================================
// R08 — Normal expected tag accepted
// ============================================================================

it("R08a: v1.1.9 accepted unchanged", () => {
	const text = fixture({
		releaseVersion: "1.1.9",
		releaseTag: "v1.1.9",
	});

	const result = extractPublishResult(text);
	assert.equal(result.releaseTag, "v1.1.9");
});

it("R08b: v0.1.0 accepted", () => {
	const text = fixture({ releaseTag: "v0.1.0" });
	assert.equal(extractPublishResult(text).releaseTag, "v0.1.0");
});

it("R08c: v10.20.30 accepted", () => {
	const text = fixture({ releaseTag: "v10.20.30" });
	assert.equal(extractPublishResult(text).releaseTag, "v10.20.30");
});

// ============================================================================
// R09 — No GitHub Actions environment (local behavior)
// ============================================================================

it("R09: extraction works without GITHUB_OUTPUT set", () => {
	// The pure function doesn't care about env vars.
	// This test confirms the export works regardless.
	const text = fixture({
		releaseVersion: "1.1.9",
		releaseTag: "v1.1.9",
		publishedPackages: [],
		alreadyPublishedPackages: [],
		allPackagesVerified: true,
		tagCreated: true,
	});

	const result = extractPublishResult(text);
	assert.equal(result.releaseTag, "v1.1.9");
});

// ============================================================================
// R10 — GitHub output file behavior (safety)
// ============================================================================

it("R10a: extraction is idempotent (pure function, no side effects)", () => {
	const text = fixture({ releaseTag: "v1.1.8" });

	// Call twice — identical results
	const first = extractPublishResult(text);
	const second = extractPublishResult(text);

	assert.equal(first.releaseTag, "v1.1.8");
	assert.equal(second.releaseTag, "v1.1.8");
	// Output is not mutated by the pure function
	assert.notStrictEqual(first, second); // different object references
});

it("R10b: releaseTag is a non-empty string for valid tag", () => {
	const text = fixture({
		releaseVersion: "1.1.8",
		releaseTag: "v1.1.8",
	});

	const result = extractPublishResult(text);
	assert.equal(typeof result.releaseTag, "string");
	assert.ok(result.releaseTag.length > 0);
});

// ============================================================================
// Edge cases
// ============================================================================

it("empty content after marker — fails visibly", () => {
	const text = "\n--- PUBLISH RESULT ---\n\n";

	assert.throws(
		() => extractPublishResult(text),
		/no JSON content follows/,
	);
});

it("only whitespace after marker — fails visibly", () => {
	const text = "\n--- PUBLISH RESULT ---\n   \n  \n";

	assert.throws(
		() => extractPublishResult(text),
		/no JSON content follows/,
	);
});

it("JSON block is truncated in the middle — fails with parse error", () => {
	const text = `\n--- PUBLISH RESULT ---\n{ "releaseTag": "v1.1.8",\n`;

	assert.throws(
		() => extractPublishResult(text),
		/Malformed publish result JSON/,
	);
});

it("single-line JSON works too", () => {
	const text = `\n--- PUBLISH RESULT ---\n{"releaseVersion":"1.1.8","releaseTag":"v1.1.8","tagCreated":true}\n`;

	const result = extractPublishResult(text);
	assert.equal(result.releaseTag, "v1.1.8");
});