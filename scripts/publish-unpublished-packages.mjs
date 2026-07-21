#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

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

export { EXPECTED_PACKAGE_COUNT };

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
 * If the tag exists at a different commit, the function throws.
 */
function createLockstepTag(version) {
	const tagName = `v${version}`;

	if (hasTag(tagName)) {
		const tagCommit = getTagCommit(tagName);
		const headCommit = getHeadCommit();
		if (tagCommit === headCommit) {
			console.log(`[tag] ${tagName} already exists at expected commit ${headCommit.slice(0, 7)}`);
			return false; // not newly created
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
 * @param {(version: string) => boolean} options.createTag
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
		createTag,
		writeOutput: outputFn,
	} = options;

	if (packages.length !== EXPECTED_PACKAGE_COUNT) {
		throw new Error(
			`Expected ${EXPECTED_PACKAGE_COUNT} publishable packages but found ${packages.length}. ` +
			`Aborting: the lockstep invariant is violated.`,
		);
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

	// Create the single lockstep tag
	const tagCreated = createTag(releaseVersion);

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
		createTag: createLockstepTag,
		writeOutput,
	});
}

const entrypoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;

if (entrypoint && import.meta.url === entrypoint) {
	await main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
