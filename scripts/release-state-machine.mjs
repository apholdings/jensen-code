#!/usr/bin/env node
/**
 * Idempotent release lifecycle state machine.
 *
 * Addresses the recurring npm "read-after-write" release failure: all seven
 * versions publish, dist-tags are written, an immediate read returns one stale
 * `latest`, the workflow is marked failed, and the tag step is skipped — forcing
 * manual tag recovery.
 *
 * This module encodes the lifecycle explicitly:
 *
 *   NOT_PUBLISHED
 *     -> PUBLISHED_TAGS_PROPAGATING  (versions visible, tags still converging)
 *     -> PUBLISHED_TAGS_CONVERGED    (stable consecutive reads, tags converge)
 *     -> TAGGED                       (lockstep git tag created, idempotent)
 *     -> GITHUB_RELEASED              (GitHub Release created, idempotent)
 *     -> COMPLETE                     (final verification passed)
 *
 * A stale dist-tag after a confirmed package publication is represented as
 * PUBLISHED_TAGS_PROPAGATING — never as a publication failure. Recovery never
 * republishes an existing version, never moves an existing tag, and resumes
 * from whatever stage is already complete.
 */

export const RELEASE_STATE = Object.freeze({
	NOT_PUBLISHED: "NOT_PUBLISHED",
	PUBLISHED_TAGS_PROPAGATING: "PUBLISHED_TAGS_PROPAGATING",
	PUBLISHED_TAGS_CONVERGED: "PUBLISHED_TAGS_CONVERGED",
	TAGGED: "TAGGED",
	GITHUB_RELEASED: "GITHUB_RELEASED",
	COMPLETE: "COMPLETE",
});

export const RELEASE_STATE_ORDER = Object.freeze([
	RELEASE_STATE.NOT_PUBLISHED,
	RELEASE_STATE.PUBLISHED_TAGS_PROPAGATING,
	RELEASE_STATE.PUBLISHED_TAGS_CONVERGED,
	RELEASE_STATE.TAGGED,
	RELEASE_STATE.GITHUB_RELEASED,
	RELEASE_STATE.COMPLETE,
]);

/**
 * Classify the overall release lifecycle state from independent facts.
 * Facts are authoritative; a stale dist-tag is never a publication failure.
 *
 * @param {object} facts
 * @param {boolean} facts.anyUnpublished - any package version not yet visible
 * @param {boolean} facts.tagsConverged - all stable tags converged across stable reads
 * @param {boolean} facts.tagExists - lockstep git tag exists
 * @param {boolean} facts.githubReleaseExists - GitHub Release object exists
 * @param {boolean} facts.finalVerified - final explicit version+integrity+tag verification passed
 */
export function classifyReleaseState(facts) {
	if (facts.anyUnpublished) return RELEASE_STATE.NOT_PUBLISHED;
	if (!facts.tagsConverged) return RELEASE_STATE.PUBLISHED_TAGS_PROPAGATING;
	if (!facts.tagExists) return RELEASE_STATE.PUBLISHED_TAGS_CONVERGED;
	if (!facts.githubReleaseExists) return RELEASE_STATE.TAGGED;
	if (!facts.finalVerified) return RELEASE_STATE.GITHUB_RELEASED;
	return RELEASE_STATE.COMPLETE;
}

/**
 * Determine whether a read series has converged: all packages' dist-tags
 * resolve to the target across at least `requiredStableReads` consecutive
 * reads.
 *
 * @param {Array<Array<boolean>>} packageReadsByRead - for each read, for each package, converged?
 * @param {number} requiredStableReads
 */
export function hasStableConvergence(packageReadsByRead, requiredStableReads = 2) {
	if (packageReadsByRead.length < requiredStableReads) return false;
	for (let read = packageReadsByRead.length - requiredStableReads; read < packageReadsByRead.length; read += 1) {
		const readRow = packageReadsByRead[read];
		if (!readRow.every(Boolean)) return false;
	}
	return true;
}

/**
 * Per-package convergence classification. Each package independently reports
 * whether its stable tags have converged. Different packages may converge at
 * different times (staggered convergence).
 *
 * @param {Array<{name: string, latest: boolean, fork: boolean}>} packages
 */
export function assessPerPackagePropagation(packages) {
	return packages.map((p) => ({
		name: p.name,
		latestConverged: Boolean(p.latest),
		forkConverged: Boolean(p.fork),
		state: p.latest && p.fork ? "converged" : "propagating",
	}));
}

/**
 * Idempotent recovery decision. Given already-completed facts, returns the
 * exact set of remaining actions. Never republishes an existing version and
 * never moves an existing tag; only *missing* artifacts are created.
 *
 * @param {object} facts
 * @param {string[]} facts.publishedVersions - package@version pairs already on the registry
 * @param {boolean} facts.tagsConverged
 * @param {boolean} facts.tagExists
 * @param {boolean} facts.githubReleaseExists
 * @returns {{
 *   publish: string[],
 *   pollDistTags: boolean,
 *   createTag: boolean,
 *   createGitHubRelease: boolean,
 *   finalVerify: boolean,
 * }}
 */
export function recoveryDecision(facts) {
	const publishCandidates = (facts.expectedVersions ?? []).filter(
		(v) => !facts.publishedVersions.includes(v),
	);
	// All expected versions present -> never publish again.
	const anyUnpublished = publishCandidates.length > 0;

	return {
		publish: anyUnpublished ? publishCandidates : [],
		pollDistTags: !facts.tagsConverged,
		createTag: !facts.tagExists,
		createGitHubRelease: !facts.githubReleaseExists,
		finalVerify: true,
	};
}

/**
 * A single read of a dist-tag is authoritative only for that read. Classify a
 * per-package read result with full context so callers never treat a stale tag
 * as a publication failure.
 */
export function classifyDistTagRead({ versionVerified, latestConverged }) {
	if (!versionVerified) return "NOT_PUBLISHED";
	if (!latestConverged) return "PROPAGATING";
	return "CONVERGED";
}
