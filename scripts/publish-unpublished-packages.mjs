#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const packageDirs = [
	"packages/tui",
	"packages/ai",
	"packages/agent",
	"packages/coding-agent",
	"packages/mom",
	"packages/pods",
	"packages/web-ui",
];

function readPackage(dir) {
	const packageJsonPath = path.join(dir, "package.json");
	if (!existsSync(packageJsonPath)) {
		return null;
	}

	return JSON.parse(readFileSync(packageJsonPath, "utf8"));
}

function isPublished(name, version) {
	try {
		execFileSync("npm", ["view", `${name}@${version}`, "version"], {
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
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

function getPublishAuthMode() {
	const requestedMode = process.env.JENSEN_NPM_PUBLISH_AUTH_MODE ?? "auto";
	if (!["auto", "oidc", "token"].includes(requestedMode)) {
		throw new Error(
			`Invalid JENSEN_NPM_PUBLISH_AUTH_MODE: ${requestedMode}. Expected one of: auto, oidc, token.`,
		);
	}

	const hasToken = Boolean(process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN);
	if (requestedMode === "auto") {
		return hasToken ? "token" : "oidc";
	}

	return requestedMode;
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

function publishPackage(pkg, authMode) {
	console.log(`Publishing ${pkg.name}@${pkg.version} from ${pkg.dir}`);
	const result = runWithOutput("npm", ["publish", "--access", "public", "--provenance"], {
		cwd: pkg.dir,
	});

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

for (const pkg of packages) {
	const highestPublishedVersion = getHighestPublishedVersion(pkg.name);
	if (!highestPublishedVersion) {
		continue;
	}

	if (compareVersions(pkg.version, highestPublishedVersion) < 0) {
		throw new Error(
			[
				`Version regression detected for ${pkg.name}.`,
				`Local version: ${pkg.version}`,
				`Highest published version: ${highestPublishedVersion}`,
				"Release versions must keep moving forward. Bump the monorepo lockstep version before publishing.",
			].join("\n"),
		);
	}
}

const unpublishedPackages = packages.filter((pkg) => !isPublished(pkg.name, pkg.version));
const authMode = getPublishAuthMode();
const hasToken = Boolean(process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN);

console.log(`Publish auth mode: ${authMode}`);
console.log(`Token env present: ${hasToken}`);

if (unpublishedPackages.length > 0) {
	console.log("Unpublished packages detected:");
	for (const pkg of unpublishedPackages) {
		console.log(`- ${pkg.name}@${pkg.version}`);
	}
} else {
	console.log("No unpublished package versions detected.");
}

for (const pkg of unpublishedPackages) {
	publishPackage(pkg, authMode);
}

for (const pkg of packages) {
	if (!isPublished(pkg.name, pkg.version)) {
		console.error(`Package ${pkg.name}@${pkg.version} is still not published. Skipping tag creation.`);
		process.exit(1);
	}

	const tagName = `${pkg.name}@${pkg.version}`;
	if (hasTag(tagName)) {
		continue;
	}

	run("git", ["tag", "-a", tagName, "-m", tagName]);
}
