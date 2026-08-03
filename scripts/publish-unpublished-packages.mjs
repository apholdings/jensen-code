#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { classifyReleaseState, RELEASE_STATE } from "./release-state-machine.mjs";

// ============================================================================
// Dependency-ordered package directories (dependents after their dependencies).
// tui and ai have no internal deps, agent depends on ai,
// coding-agent depends on agent+ai+tui, mom depends on coding-agent+ai+agent,
// pods depends on agent, web-ui depends on tui+ai.
// ============================================================================

const packageDirs = [
	"packages/tui",
	"packages/ai",
	"packages/agent",
	"packages/coding-agent",
	"packages/mom",
	"packages/pods",
	"packages/web-ui",
];

const EXPECTED_PACKAGE_COUNT = 7;
const EXPECTED_PACKAGE_NAMES = [
	"@apholdings/jensen-tui",
	"@apholdings/jensen-ai",
	"@apholdings/jensen-agent-core",
	"@apholdings/jensen-code",
	"@apholdings/jensen-mom",
	"@apholdings/jensen-pods",
	"@apholdings/jensen-web-ui",
];
const STABLE_DIST_TAGS = ["fork", "latest"];

export { EXPECTED_PACKAGE_COUNT, STABLE_DIST_TAGS };

function readPackage(dir) {
	const packageJsonPath = path.join(dir, "package.json");
	if (!existsSync(packageJsonPath)) {
		return null;
	}

	return JSON.parse(readFileSync(packageJsonPath, "utf8"));
}

function parseVersion(version) {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (!match) {
		throw new Error(`Unsupported version format: ${version}`);
	}

	return match.slice(1).map((part) => Number(part));
}

function compareVersions(left, right) {
	const leftParts = parseVersion(left);
	const rightParts = parseVersion(right);

	for (let index = 0; index < leftParts.length; index += 1) {
		const delta = leftParts[index] - rightParts[index];
		if (delta !== 0) {
			return delta;
		}
	}

	return 0;
}

function getPublishedVersions(name) {
	try {
		const output = execFileSync("npm", ["view", name, "versions", "--json"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (!output) {
			return [];
		}

		const parsed = JSON.parse(output);
		if (Array.isArray(parsed)) {
			return parsed;
		}

		return typeof parsed === "string" ? [parsed] : [];
	} catch {
		return [];
	}
}

function getHighestPublishedVersion(name) {
	const versions = getPublishedVersions(name);
	if (versions.length === 0) {
		return null;
	}

	return versions.sort(compareVersions).at(-1) ?? null;
}

function run(command, args, options = {}) {
	console.log(`$ ${command} ${args.join(" ")}`);
	execFileSync(command, args, {
		stdio: "inherit",
		...options,
	});
}

function runWithOutput(command, args, options = {}) {
	console.log(`$ ${command} ${args.join(" ")}`);
	return spawnSync(command, args, {
		encoding: "utf8",
		stdio: "pipe",
		...options,
	});
}

function addDistTag(name, version, tag) {
	run("npm", ["dist-tag", "add", `${name}@${version}`, tag]);
}

function checkDistTag(name, version, tag) {
	const result = runWithOutput("npm", ["view", `${name}@${tag}`, "version", "--json"]);
	const stdout = (result.stdout ?? "").trim();
	const stderr = (result.stderr ?? "").trim();
	if (result.error) {
		return { matches: false, summary: `spawn error: ${result.error.message}` };
	}
	if (result.status !== 0) {
		return {
			matches: false,
			summary: `exit=${result.status ?? "unknown"} stdout=${summarizeRegistryResponse(stdout)} stderr=${summarizeRegistryResponse(stderr)}`,
		};
	}
	if (!stdout) {
		return { matches: false, summary: "npm view returned success with empty stdout" };
	}

	try {
		const resolvedVersion = JSON.parse(stdout);
		return {
			matches: resolvedVersion === version,
			summary: `resolved ${name}@${tag} to ${JSON.stringify(resolvedVersion)}`,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { matches: false, summary: `invalid JSON from npm view: ${message}` };
	}
}

/**
 * Retry dist-tag verification with bounded exponential backoff.
 *
 * npm is eventually consistent after a dist-tag write: a freshly promoted tag
 * can briefly still resolve to the previous version. This treats such reads as
 * propagation state and fails only after the documented retry budget.
 */
export function waitForDistTag(name, version, tag, options = {}) {
	const {
		maxAttempts = 6,
		initialDelayMs = 1000,
		maxDelayMs = 10000,
		checkTag = checkDistTag,
		sleep = delay,
	} = options;

	let lastSummary = "no registry response";

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		const result = checkTag(name, version, tag);
		const matches = typeof result === "boolean" ? result : result.matches;
		lastSummary = typeof result === "boolean" ? "verification returned false" : result.summary;

		if (matches) {
			console.log(`[dist-tag] ${name}@${tag} resolved to ${version} (${lastSummary})`);
			return;
		}

		console.log(`[dist-tag] ${name}@${tag} not propagated yet: ${lastSummary}`);

		if (attempt < maxAttempts) {
			const waitMs = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
			console.log(`[dist-tag] waiting ${waitMs}ms before retrying ${name}@${tag}`);
			sleep(waitMs);
		}
	}

	throw new Error(
		`Dist-tag verification failed: ${name}@${tag} does not resolve to ${version} after ${maxAttempts} attempts. Last: ${lastSummary}`,
	);
}

export function promoteStableDistTags(packages, releaseVersion, options = {}) {
	const { addTag = addDistTag, verifyTag, verifyWithRetry = waitForDistTag } = options;
	let converged = true;
	const staleTags = [];

	if (packages.length !== EXPECTED_PACKAGE_COUNT) {
		throw new Error(
			`Expected ${EXPECTED_PACKAGE_COUNT} packages before dist-tag promotion but found ${packages.length}.`,
		);
	}
	const packageNames = new Set(packages.map((pkg) => pkg.name));
	for (const expectedName of EXPECTED_PACKAGE_NAMES) {
		if (!packageNames.has(expectedName)) {
			throw new Error(`Refusing dist-tag promotion: fixed-group package ${expectedName} is missing.`);
		}
	}

	for (const pkg of packages) {
		if (pkg.version !== releaseVersion) {
			throw new Error(
				`Refusing dist-tag promotion for mixed versions: ${pkg.name} is ${pkg.version}, expected ${releaseVersion}.`,
			);
		}
	}

	for (const tag of STABLE_DIST_TAGS) {
		for (const pkg of packages) {
			addTag(pkg.name, releaseVersion, tag);
		}
	}

	for (const tag of STABLE_DIST_TAGS) {
		for (const pkg of packages) {
			if (verifyTag) {
				// Single-shot injection path (used by deterministic tests).
				const verification = verifyTag(pkg.name, releaseVersion, tag);
				const matches = typeof verification === "boolean" ? verification : verification.matches;
				if (!matches) {
					const details = typeof verification === "boolean" ? "verification returned false" : verification.summary;
					throw new Error(
						`Dist-tag verification failed: ${pkg.name}@${tag} does not resolve to ${releaseVersion}. ${details}`,
					);
				}
			} else {
				// Default path: bounded-backoff retry to absorb npm propagation
				// delays. A stale tag after a confirmed version is PROPAGATION
				// state (never a publication failure) and must not throw here —
				// tag/release creation proceeds and recovery converges later.
				try {
					verifyWithRetry(pkg.name, releaseVersion, tag);
				} catch {
					converged = false;
					staleTags.push(`${pkg.name}@${tag}`);
				}
			}
		}
	}

	console.log(`[dist-tag] fork/latest propagated: ${converged ? "yes" : "no"}${staleTags.length > 0 ? ` (stale: ${staleTags.join(", ")})` : ""}`);
	if (!converged) {
		console.log("[dist-tag] PUBLISHED_TAGS_PROPAGATING — versions verified; tag/release creation proceeds; convergence is recovered in the final verification phase.");
	}
	return { converged, staleTags, propagationState: converged ? RELEASE_STATE.PUBLISHED_TAGS_CONVERGED : RELEASE_STATE.PUBLISHED_TAGS_PROPAGATING };
}

function hasLocalNpmAuth() {
	const result = runWithOutput("npm", ["whoami"]);
	return result.status === 0 && Boolean((result.stdout ?? "").trim());
}

function summarizeRegistryResponse(output) {
	const trimmed = output.trim();
	if (!trimmed) {
		return "<empty>";
	}

	return trimmed.replace(/\s+/gu, " ").slice(0, 500);
}

export function checkPublishedVersion(name, version) {
	const result = runWithOutput("npm", ["view", `${name}@${version}`, "version", "--json"]);
	const stdout = (result.stdout ?? "").trim();
	const stderr = (result.stderr ?? "").trim();

	if (result.error) {
		return {
			published: false,
			status: null,
			stdout,
			stderr,
			summary: `spawn error: ${result.error.message}`,
		};
	}

	if (result.status !== 0) {
		return {
			published: false,
			status: result.status ?? null,
			stdout,
			stderr,
			summary: `exit=${result.status ?? "unknown"} stdout=${summarizeRegistryResponse(stdout)} stderr=${summarizeRegistryResponse(stderr)}`,
		};
	}

	if (!stdout) {
		return {
			published: false,
			status: result.status ?? 0,
			stdout,
			stderr,
			summary: "npm view returned success with empty stdout",
		};
	}

	try {
		const parsed = JSON.parse(stdout);
		const published = Array.isArray(parsed) ? parsed.includes(version) : parsed === version;
		return {
			published,
			status: result.status ?? 0,
			stdout,
			stderr,
			summary: published
				? `confirmed version ${version}`
				: `unexpected npm view payload: ${summarizeRegistryResponse(stdout)}`,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			published: false,
			status: result.status ?? 0,
			stdout,
			stderr,
			summary: `invalid JSON from npm view: ${message}; stdout=${summarizeRegistryResponse(stdout)}`,
		};
	}
}

export async function waitForPublishedVersion(name, version, options = {}) {
	const {
		maxAttempts = 6,
		initialDelayMs = 1000,
		maxDelayMs = 10000,
		checkVersion = checkPublishedVersion,
		sleep = delay,
	} = options;

	let lastSummary = "no registry response";

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		console.log(`[verify] ${name}@${version} attempt ${attempt}/${maxAttempts}`);
		const result = await checkVersion(name, version);
		lastSummary = result.summary;

		if (result.published) {
			console.log(`[verify] ${name}@${version} is available on npm (${lastSummary})`);
			return;
		}

		console.log(`[verify] ${name}@${version} not visible yet: ${lastSummary}`);

		if (attempt < maxAttempts) {
			const waitMs = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
			console.log(`[verify] waiting ${waitMs}ms before retrying ${name}@${version}`);
			await sleep(waitMs);
		}
	}

	throw new Error(
		`Published version verification failed for ${name}@${version} after ${maxAttempts} attempts. Last registry response: ${lastSummary}`,
	);
}

function getPublishAuthMode() {
	const requestedMode = process.env.JENSEN_NPM_PUBLISH_AUTH_MODE ?? "auto";
	if (!["auto", "oidc", "token"].includes(requestedMode)) {
		throw new Error(
			`Invalid JENSEN_NPM_PUBLISH_AUTH_MODE: ${requestedMode}. Expected one of: auto, oidc, token.`,
		);
	}

	const hasToken = Boolean(process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN);
	if (requestedMode === "auto") {
		return hasToken || hasLocalNpmAuth() ? "token" : "oidc";
	}

	return requestedMode;
}

function getPublishTag() {
	return process.env.JENSEN_NPM_DIST_TAG ?? "latest";
}

function isAuthPublishFailure(output) {
	const normalized = output.toLowerCase();
	return (
		normalized.includes("e404") ||
		normalized.includes("not found or you do not have permission") ||
		normalized.includes("could not be found or you do not have permission") ||
		normalized.includes("trusted publisher") ||
		normalized.includes("trusted publishing") ||
		normalized.includes("you do not have permission to publish") ||
		normalized.includes("authentication token") ||
		normalized.includes("requires authentication") ||
		normalized.includes("must be logged in to publish packages")
	);
}

function publishPackage(pkg, authMode, publishTag) {
	console.log(`Publishing ${pkg.name}@${pkg.version} from ${pkg.dir} with dist-tag "${publishTag}"`);
	const publishArgs = ["publish", "--access", "public", "--tag", publishTag];
	if (authMode === "oidc") {
		publishArgs.push("--provenance");
	} else {
		publishArgs.push("--provenance=false");
	}
	const result = runWithOutput(
		"npm",
		publishArgs,
		{ cwd: pkg.dir },
	);

	if (result.stdout) {
		process.stdout.write(result.stdout);
	}
	if (result.stderr) {
		process.stderr.write(result.stderr);
	}
	if (result.status === 0) {
		return;
	}

	const combinedOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
	if (isAuthPublishFailure(combinedOutput)) {
		const failureLines = combinedOutput
			.split(/\r?\n/u)
			.map((line) => line.trim())
			.filter(Boolean)
			.filter(
				(line) =>
					line.includes("E404") ||
					line.toLowerCase().includes("not found or you do not have permission") ||
					line.toLowerCase().includes("could not be found or you do not have permission") ||
					line.toLowerCase().includes("trusted publish") ||
					line.toLowerCase().includes("permission") ||
					line.toLowerCase().includes("authentication"),
			);
		const details = failureLines.length > 0 ? `\nRelevant npm output:\n${failureLines.join("\n")}` : "";
		const tokenHint =
			authMode === "token"
				? "Token mode was selected, so verify NODE_AUTH_TOKEN or NPM_TOKEN has publish access for the npm scope/package."
				: "If npm token publishing is configured in CI, rerun with JENSEN_NPM_PUBLISH_AUTH_MODE=token or let auto mode pick it when NODE_AUTH_TOKEN / NPM_TOKEN is present.";

		throw new Error(
			[
				`npm publish failed for ${pkg.name}@${pkg.version}.`,
				"Publish failed before tagging, so no release tags were created.",
				"Likely causes: missing npm trusted-publisher configuration for this package/repo, or insufficient npm organization/package publish permissions.",
				tokenHint,
				details,
			]
				.filter(Boolean)
				.join("\n"),
		);
	}

	throw new Error(
		`npm publish failed for ${pkg.name}@${pkg.version} with exit code ${result.status ?? "unknown"}.`,
	);
}

// ============================================================================
// Lockstep Git tag
// ============================================================================

/**
 * Check whether the lightweight tag `tagName` exists.
 */
function hasTag(tagName) {
	try {
		execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tagName}`], {
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Retrieve the commit SHA that `tagName` points to.
 * Returns null if the tag does not exist.
 */
function getTagCommit(tagName) {
	try {
		return execFileSync("git", ["rev-parse", "--verify", "--quiet", `${tagName}^{commit}`], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

/**
 * Get the HEAD commit SHA.
 */
function getHeadCommit() {
	return execFileSync("git", ["rev-parse", "HEAD"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
}

/**
 * Create a single lockstep lightweight tag `v<version>`.
 *
 * If the tag already exists at the expected commit, it is left in place.
 * If the tag exists at a different commit, the function throws unless the
 * registry release was already complete before this run. In that case the
 * existing immutable release tag is preserved.
 */
function createLockstepTag(version, options = {}) {
	const { allowExistingRelease = false } = options;
	const tagName = `v${version}`;

	if (hasTag(tagName)) {
		const tagCommit = getTagCommit(tagName);
		const headCommit = getHeadCommit();
		if (tagCommit === headCommit) {
			console.log(`[tag] ${tagName} already exists at expected commit ${headCommit.slice(0, 7)}`);
			return false; // not newly created
		}
		if (allowExistingRelease) {
			console.log(
				`[tag] ${tagName} already identifies the completed release at ${tagCommit.slice(0, 7)}; preserving it while HEAD is ${headCommit.slice(0, 7)}`,
			);
			return false;
		}
		throw new Error(
			`Tag ${tagName} already exists at commit ${tagCommit.slice(0, 7)} but HEAD is ${headCommit.slice(0, 7)}. ` +
			`Will not move the existing tag.`,
		);
	}

	run("git", ["tag", tagName]);
	console.log(`[tag] Created lockstep tag ${tagName}`);
	return true; // newly created
}

// ============================================================================
// Idempotent GitHub Release
// ============================================================================

/**
 * Create the GitHub Release idempotently. If it already exists, it is left in
 * place (never moved or recreated). Returns true when the release exists after
 * this call. Uses the `gh` CLI; safe to run repeatedly across recovery.
 */
export function createGitHubReleaseIdempotent(tagName, options = {}) {
	const { releaseExists = ghReleaseExists, create = ghReleaseCreate } = options;
	if (releaseExists(tagName)) {
		console.log(`[release] GitHub Release ${tagName} already exists; preserving it`);
		return true;
	}
	create(tagName);
	console.log(`[release] Created GitHub Release ${tagName}`);
	return true;
}

function ghReleaseExists(tagName) {
	return runWithOutput("gh", ["release", "view", tagName, "--json", "tagName"]).status === 0;
}

function ghReleaseCreate(tagName) {
	run("gh", ["release", "create", tagName, "--title", `v${tagName.replace(/^v/, "")}`, "--notes", `Jensen ${tagName} lockstep release.`]);
}

// ============================================================================
// Structured output
// ============================================================================

function writeOutput(result) {
	console.log("\n--- PUBLISH RESULT ---");
	console.log(JSON.stringify(result, null, 2));
}

// ============================================================================
// Testable orchestration — all dependencies injectable.
// ============================================================================

/**
 * Execute the full publish-orchestration pipeline with injectable dependencies.
 * This is the testable entrypoint; main() delegates to it after wiring real I/O.
 *
 * @param {object} options
 * @param {Array<{dir: string, name: string, version: string}>} options.packages
 * @param {string} options.publishTag
 * @param {(name: string, version: string) => {published: boolean, summary: string}} options.checkVersion
 * @param {(name: string, version: string, opts: object) => Promise<void>} options.waitForVersion
 * @param {(pkg: object, authMode: string, publishTag: string) => void} options.publishFn
 * @param {(packages: Array<object>, releaseVersion: string) => void} [options.promoteTags]
 * @param {(version: string, options: {allowExistingRelease: boolean}) => boolean} options.createTag
 * @param {(result: object) => void} options.writeOutput
 * @param {string} options.packageDirsModule — for topology assertion only
 * @returns {Promise<object>} the result object
 */
export async function orchestratePublish(options) {
	const {
		packages,
		publishTag,
		checkVersion,
		waitForVersion,
		publishFn,
		promoteTags = () => {},
		createTag,
		createGitHubRelease,
		writeOutput: outputFn,
	} = options;

	if (packages.length !== EXPECTED_PACKAGE_COUNT) {
		throw new Error(
			`Expected ${EXPECTED_PACKAGE_COUNT} publishable packages but found ${packages.length}. ` +
			`Aborting: the lockstep invariant is violated.`,
		);
	}
	const packageNames = new Set(packages.map((pkg) => pkg.name));
	for (const expectedName of EXPECTED_PACKAGE_NAMES) {
		if (!packageNames.has(expectedName)) {
			throw new Error(`Expected fixed-group package ${expectedName} was not found. Aborting publication.`);
		}
	}

	// Verify all versions are equal (lockstep invariant)
	const releaseVersion = packages[0].version;
	for (const pkg of packages) {
		if (pkg.version !== releaseVersion) {
			throw new Error(
				`Lockstep version mismatch: ${pkg.name} is at ${pkg.version} but expected ${releaseVersion} ` +
				`(based on ${packages[0].name}). All seven packages must share the same version.`,
			);
		}
	}

	console.log(`Release version: ${releaseVersion}`);
	const tagName = `v${releaseVersion}`;

	// Determine which packages need publishing
	const publishedStatuses = new Map(
		packages.map((pkg) => [`${pkg.name}@${pkg.version}`, checkVersion(pkg.name, pkg.version)]),
	);
	const unpublishedPackages = packages.filter(
		(pkg) => !publishedStatuses.get(`${pkg.name}@${pkg.version}`)?.published,
	);
	const alreadyPublishedPackages = packages.filter(
		(pkg) => publishedStatuses.get(`${pkg.name}@${pkg.version}`)?.published,
	);

	if (unpublishedPackages.length > 0) {
		console.log("Unpublished packages detected:");
		for (const pkg of unpublishedPackages) {
			console.log(`- ${pkg.name}@${pkg.version}`);
		}
	} else {
		console.log("No unpublished package versions detected.");
	}

	const publishedDuringRun = [];

	// Publish unpublished packages in topological order
	for (const pkg of packages) {
		const key = `${pkg.name}@${pkg.version}`;
		const status = publishedStatuses.get(key);

		if (status?.published) {
			console.log(`[skip] ${pkg.name}@${pkg.version} already published`);
			continue;
		}

		publishFn(pkg, "token", publishTag);
		await waitForVersion(pkg.name, pkg.version);
		publishedDuringRun.push(pkg.name);
	}

	// Verify all seven packages are on the registry
	let allVerified = true;
	const verificationResults = {};
	for (const pkg of packages) {
		const result = checkVersion(pkg.name, pkg.version);
		verificationResults[pkg.name] = result.published;
		if (!result.published) {
			allVerified = false;
			console.log(`[verify] FAILED: ${pkg.name}@${pkg.version} is NOT on npm after publish loop`);
		}
	}

	if (!allVerified) {
		const result = {
			releaseVersion,
			releaseTag: null,
			publishedPackages: [...alreadyPublishedPackages.map((p) => p.name), ...publishedDuringRun],
			alreadyPublishedPackages: alreadyPublishedPackages.map((p) => p.name),
			allPackagesVerified: false,
			tagCreated: false,
		};
		outputFn(result);
		throw new Error(
			"Not all seven packages are verified on the npm registry. " +
			`The lockstep tag ${tagName} was NOT created. ` +
			"Re-run the workflow to retry.",
		);
	}

	console.log("[verify] All seven packages confirmed on npm registry");

	// Promote only after the complete fixed group is available and verified.
	// Version verification is authoritative. A stale dist-tag after confirmed
	// publication is PROPAGATION state — it must never abort tag/release
	// creation (that was the recurring 1.4.0 release defect).
	let propagation = { converged: true, staleTags: [] };
	try {
		propagation = promoteTags(packages, releaseVersion) ?? propagation;
	} catch {
		propagation = { converged: false, staleTags: ["dist-tag convergence pending"] };
	}

	// Create the single lockstep tag (idempotent — never moves an existing tag).
	const tagCreated = createTag(releaseVersion, {
		allowExistingRelease: publishedDuringRun.length === 0,
	});
	const tagExists = tagCreated || hasTag(tagName);

	// Create the GitHub Release (idempotent) when a creator is configured.
	const githubReleaseCreated = options.createGitHubRelease ? options.createGitHubRelease(tagName) : false;

	// Classify the typed lifecycle state from independent facts.
	const releaseState = classifyReleaseState({
		anyUnpublished: false,
		tagsConverged: propagation.converged !== false,
		tagExists,
		githubReleaseExists: githubReleaseCreated,
		finalVerified: true,
	});

	const result = {
		releaseVersion,
		releaseTag: tagName,
		publishedPackages: [
			...alreadyPublishedPackages.map((p) => p.name),
			...publishedDuringRun,
		],
		alreadyPublishedPackages: alreadyPublishedPackages.map((p) => p.name),
		allPackagesVerified: true,
		tagCreated,
		githubReleaseCreated,
		releaseState,
		tagsPropagating: propagation.converged === false,
		staleTags: propagation.staleTags ?? [],
	};

	outputFn(result);
	return result;
}

// ============================================================================
// Main publish routine
// ============================================================================

export const TOPOLOGICAL_ORDER = packageDirs;

export async function main(options = {}) {
	const {
		checkVersion = checkPublishedVersion,
		waitForVersion = waitForPublishedVersion,
		publishFn = publishPackage,
	} = options;

	// Load package metadata
	const packages = packageDirs
		.map((dir) => {
			const pkg = readPackage(dir);
			if (!pkg || pkg.private) {
				return null;
			}

			return {
				dir,
				name: pkg.name,
				version: pkg.version,
			};
		})
		.filter((pkg) => pkg !== null);

	// Version regression check (needs registry access — done before orchestration)
	const publishTag = getPublishTag();
	for (const pkg of packages) {
		const highestPublishedVersion = getHighestPublishedVersion(pkg.name);
		if (!highestPublishedVersion) {
			continue;
		}

		if (compareVersions(pkg.version, highestPublishedVersion) < 0 && publishTag === "latest") {
			throw new Error(
				[
					`Version regression detected for ${pkg.name} when publishing with the "latest" dist-tag.`,
					`Local version: ${pkg.version}`,
					`Highest published version: ${highestPublishedVersion}`,
					`Set JENSEN_NPM_DIST_TAG to a fork-specific tag or bump the monorepo version above ${highestPublishedVersion}.`,
				].join("\n"),
			);
		}
	}

	const authMode = getPublishAuthMode();
	const hasToken = Boolean(process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN);

	console.log(`Publish auth mode: ${authMode}`);
	console.log(`Token env present: ${hasToken}`);
	console.log(`Publish dist-tag: ${publishTag}`);

	return orchestratePublish({
		packages,
		publishTag,
		checkVersion,
		waitForVersion,
		publishFn: (pkg, _authMode, tag) => publishFn(pkg, authMode, tag),
		promoteTags: promoteStableDistTags,
		createTag: createLockstepTag,
		writeOutput,
		createGitHubRelease: process.env.JENSEN_CREATE_GH_RELEASE
			? (tagName) => createGitHubReleaseIdempotent(tagName)
			: undefined,
	});
}

const entrypoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;

if (entrypoint && import.meta.url === entrypoint) {
	await main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
