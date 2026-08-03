import test from "node:test";
import assert from "node:assert/strict";

import {
	RELEASE_STATE,
	classifyReleaseState,
	hasStableConvergence,
	assessPerPackagePropagation,
	recoveryDecision,
	classifyDistTagRead,
	RELEASE_STATE_ORDER,
} from "./release-state-machine.mjs";

test("classifyReleaseState: not published when a version is missing", () => {
	assert.equal(
		classifyReleaseState({ anyUnpublished: true, tagsConverged: false, tagExists: false, githubReleaseExists: false, finalVerified: false }),
		RELEASE_STATE.NOT_PUBLISHED,
	);
});

test("a stale dist-tag after confirmed publication is PROPAGATING, not a publication failure", () => {
	assert.equal(
		classifyReleaseState({ anyUnpublished: false, tagsConverged: false, tagExists: false, githubReleaseExists: false, finalVerified: false }),
		RELEASE_STATE.PUBLISHED_TAGS_PROPAGATING,
	);
});

test("staggged convergence: different packages converge at different times is supported", () => {
	const packages = [
		{ name: "a", latest: true, fork: true },
		{ name: "b", latest: false, fork: true },
	];
	const assessed = assessPerPackagePropagation(packages);
	assert.equal(assessed[0].state, "converged");
	assert.equal(assessed[1].state, "propagating");
});

test("stable convergence requires consecutive reads (stale latest for one package)", () => {
	// Read 1: package c latest stale. Read 2-3: all converged.
	const reads = [
		[true, true, false],
		[true, true, true],
		[true, true, true],
	];
	// First stable window is reads 2-3.
	assert.equal(hasStableConvergence(reads, 2), true);
	// Only one converged read -> not stable.
	assert.equal(hasStableConvergence([[true, true, true]], 2), false);
});

test("no republish during recovery: all versions present -> publish list empty", () => {
	const decision = recoveryDecision({
		expectedVersions: ["a@1.5.0", "b@1.5.0"],
		publishedVersions: ["a@1.5.0", "b@1.5.0"],
		tagsConverged: false,
		tagExists: true,
		githubReleaseExists: false,
	});
	assert.deepEqual(decision.publish, []);
	assert.equal(decision.pollDistTags, true);
	assert.equal(decision.createTag, false);
	assert.equal(decision.createGitHubRelease, true);
});

test("resume after publication: creates only missing tag and release, never republish", () => {
	const decision = recoveryDecision({
		expectedVersions: ["a@1.5.0"],
		publishedVersions: ["a@1.5.0"],
		tagsConverged: true,
		tagExists: false,
		githubReleaseExists: false,
	});
	assert.deepEqual(decision.publish, []);
	assert.equal(decision.pollDistTags, false);
	assert.equal(decision.createTag, true); // missing tag created (idempotent)
	assert.equal(decision.createGitHubRelease, true);
});

test("resume after tag: only GitHub Release remains missing", () => {
	const decision = recoveryDecision({
		expectedVersions: ["a@1.5.0"],
		publishedVersions: ["a@1.5.0"],
		tagsConverged: true,
		tagExists: true,
		githubReleaseExists: false,
	});
	assert.equal(decision.createTag, false);
	assert.equal(decision.createGitHubRelease, true);
});

test("complete idempotent rerun: nothing to create", () => {
	const decision = recoveryDecision({
		expectedVersions: ["a@1.5.0"],
		publishedVersions: ["a@1.5.0"],
		tagsConverged: true,
		tagExists: true,
		githubReleaseExists: true,
	});
	assert.deepEqual(decision.publish, []);
	assert.equal(decision.pollDistTags, false);
	assert.equal(decision.createTag, false);
	assert.equal(decision.createGitHubRelease, false);
	assert.equal(decision.finalVerify, true);
	assert.equal(
		classifyReleaseState({ anyUnpublished: false, tagsConverged: true, tagExists: true, githubReleaseExists: true, finalVerified: true }),
		RELEASE_STATE.COMPLETE,
	);
});

test("true publication failure is still detected", () => {
	const decision = recoveryDecision({
		expectedVersions: ["a@1.5.0"],
		publishedVersions: [],
		tagsConverged: false,
		tagExists: false,
		githubReleaseExists: false,
	});
	assert.deepEqual(decision.publish, ["a@1.5.0"]); // only genuinely missing packages
});

test("classifyDistTagRead: a stale tag read with verified version is PROPAGATING", () => {
	assert.equal(classifyDistTagRead({ versionVerified: true, latestConverged: false }), "PROPAGATING");
	assert.equal(classifyDistTagRead({ versionVerified: true, latestConverged: true }), "CONVERGED");
	assert.equal(classifyDistTagRead({ versionVerified: false, latestConverged: false }), "NOT_PUBLISHED");
});

test("state order is monotonic and complete", () => {
	assert.deepEqual(RELEASE_STATE_ORDER, [
		"NOT_PUBLISHED",
		"PUBLISHED_TAGS_PROPAGATING",
		"PUBLISHED_TAGS_CONVERGED",
		"TAGGED",
		"GITHUB_RELEASED",
		"COMPLETE",
	]);
});
