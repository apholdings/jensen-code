// ============================================================================
// Robust extraction of the publish result JSON block from the publish script's
// stdout.  The block is delimited by the marker line:
//
//   --- PUBLISH RESULT ---
//
// and extends until the next blank-line / marker pair, or EOF.
//
// This module provides:
//   1. A pure exported function `extractPublishResult(text)` for testing.
//   2. A CLI entry point that reads `publish-output.txt`, extracts the
//      releaseTag, and writes it to `$GITHUB_OUTPUT` when available.
// ============================================================================

import { appendFileSync, readFileSync } from "node:fs";

// ============================================================================
// Tag validation
// ============================================================================

const TAG_RE = /^v\d+\.\d+\.\d+(-[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)*)?(\+[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)*)?$/;

/**
 * Validate that a string is a safe Git tag of the form expected by this repo.
 * Returns the string unchanged, or throws.
 */
function validateTag(tag) {
	if (typeof tag !== "string" || tag.length === 0) {
		throw new Error(`Invalid release tag: ${JSON.stringify(tag)} (must be a non-empty string)`);
	}

	if (tag.length > 80) {
		throw new Error(`Invalid release tag: ${JSON.stringify(tag)} (exceeds 80 characters)`);
	}

	if (!TAG_RE.test(tag)) {
		throw new Error(
			`Invalid release tag: ${JSON.stringify(tag)} (must match v<semver>, e.g. v1.1.8)`,
		);
	}

	return tag;
}

// ============================================================================
// Extraction
// ============================================================================

/**
 * Extract the releaseTag from a publish script's stdout text.
 *
 * @param {string} text  Raw combined stdout+stderr from the publish script.
 * @returns {{ releaseTag: string }}  releaseTag is the validated tag or "".
 * @throws {Error}  When the marker is missing, the JSON block is absent or
 *                  malformed, or the extracted tag fails validation.
 */
export function extractPublishResult(text) {
	// 1. Locate the marker
	const marker = /^--- PUBLISH RESULT ---$/m;
	const markerMatch = marker.exec(text);

	if (!markerMatch) {
		throw new Error("PUBLISH RESULT marker not found in publish output");
	}

	// 2. Slice from after the marker to EOF
	const afterMarker = text.slice(markerMatch.index + markerMatch[0].length);

	// 3. Find the end of the JSON block.
	//    The block runs until a blank line followed by a dash (next log section
	//    like "--- …") or until EOF.  We trim trailing whitespace before
	//    determining the boundary.
	const nextSection = afterMarker.search(/\n\n---/);
	const jsonText = (nextSection >= 0 ? afterMarker.slice(0, nextSection) : afterMarker).trim();

	if (jsonText.length === 0) {
		throw new Error("PUBLISH RESULT marker found but no JSON content follows");
	}

	// 4. Parse the JSON
	/** @type {Record<string, unknown>} */
	let result;
	try {
		result = JSON.parse(jsonText);
	} catch (parseError) {
		const message = parseError instanceof Error ? parseError.message : String(parseError);
		throw new Error(`Malformed publish result JSON: ${message}`);
	}

	// 5. Extract and validate the release tag
	const rawTag = typeof result.releaseTag === "string" ? result.releaseTag : "";

	// Empty tag is acceptable (no tag was created)
	if (rawTag.length === 0) {
		return { releaseTag: "" };
	}

	return { releaseTag: validateTag(rawTag) };
}

// ============================================================================
// CLI entry point
// ============================================================================

const entrypoint = `file://${process.argv[1] ?? ""}`;

if (entrypoint === import.meta.url) {
	try {
		const text = readFileSync("publish-output.txt", "utf8");
		const { releaseTag } = extractPublishResult(text);

		if (process.env.GITHUB_OUTPUT) {
			appendFileSync(process.env.GITHUB_OUTPUT, `release_tag=${releaseTag}\n`);
		}

		// Also print for workflow log visibility
		console.log(`Extracted release_tag=${releaseTag || "(empty)"}`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}