#!/usr/bin/env node

import { execFileSync } from "node:child_process";
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

function run(command, args, options = {}) {
	console.log(`$ ${command} ${args.join(" ")}`);
	execFileSync(command, args, {
		stdio: "inherit",
		...options,
	});
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

const unpublishedPackages = packages.filter((pkg) => !isPublished(pkg.name, pkg.version));

if (unpublishedPackages.length > 0) {
	console.log("Unpublished packages detected:");
	for (const pkg of unpublishedPackages) {
		console.log(`- ${pkg.name}@${pkg.version}`);
	}
} else {
	console.log("No unpublished package versions detected.");
}

for (const pkg of unpublishedPackages) {
	console.log(`Publishing ${pkg.name}@${pkg.version} from ${pkg.dir}`);
	run("npm", ["publish", "--access", "public", "--provenance"], {
		cwd: pkg.dir,
	});
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
