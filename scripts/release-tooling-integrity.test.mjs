import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "..");

function readJson(p) {
	return JSON.parse(readFileSync(join(ROOT, p), "utf-8"));
}

function readText(p) {
	return readFileSync(join(ROOT, p), "utf-8");
}

// ============================================================================
// Release script hygiene
// ============================================================================

test("release.mjs does not exist", () => {
	strictEqual(existsSync(join(ROOT, "scripts/release.mjs")), false);
});

test("JENSEN.md does not reference missing npm scripts", () => {
	const content = readText("JENSEN.md");
	ok(!content.includes("release:patch"), "JENSEN.md references release:patch");
	ok(!content.includes("release:minor"), "JENSEN.md references release:minor");
	ok(!content.includes("release:major"), "JENSEN.md references release:major");
	ok(!content.includes("scripts/release.mjs"), "JENSEN.md references scripts/release.mjs");
	ok(content.includes("changeset"), "JENSEN.md must document changeset usage");
	ok(content.includes("version PR"), "JENSEN.md must document version PR");
});

test("release workflow does not reference missing npm scripts", () => {
	const content = readText(".github/workflows/release.yml");
	ok(!content.includes("release:patch"), "release.yml references release:patch");
	ok(!content.includes("release:minor"), "release.yml references release:minor");
});

test("root package.json has exactly one active versioning path", () => {
	const rootPkg = readJson("package.json");
	const scripts = rootPkg.scripts ?? {};

	strictEqual("version:packages" in scripts, true);
	deepStrictEqual(scripts["version:packages"], "changeset version && npm install --package-lock-only");

	ok(!("version:patch" in scripts), "version:patch must not exist");
	ok(!("version:minor" in scripts), "version:minor must not exist");
	ok(!("version:major" in scripts), "version:major must not exist");
	ok(!("publish" in scripts), "publish script must not exist");
	ok(!("prepublishOnly" in scripts), "prepublishOnly script must not exist");
});

test("changeset script exists for interactive use", () => {
	const rootPkg = readJson("package.json");
	ok("changeset" in (rootPkg.scripts ?? {}), "changeset script must exist");
	strictEqual(rootPkg.scripts.changeset, "changeset");
});

test("version:packages includes lockfile update", () => {
	const rootPkg = readJson("package.json");
	const script = rootPkg.scripts["version:packages"];
	ok(script.includes("npm install --package-lock-only"), "version:packages must update lockfile");
});

// ============================================================================
// Release-tooling test gating
// ============================================================================

test("test:release-tooling script exists in root package.json", () => {
	const rootPkg = readJson("package.json");
	ok("test:release-tooling" in (rootPkg.scripts ?? {}), "test:release-tooling script must exist");
	ok(
		rootPkg.scripts["test:release-tooling"].includes("scripts/release-tooling-integrity.test.mjs"),
		"test:release-tooling must invoke the integrity test",
	);
});

test("npm run check invokes test:release-tooling", () => {
	const rootPkg = readJson("package.json");
	const checkScript = rootPkg.scripts.check;
	ok(checkScript.includes("test:release-tooling"), "check script must invoke test:release-tooling");
});

test("CI workflow runs npm run check", () => {
	const content = readText(".github/workflows/ci.yml");
	ok(content.includes("npm run check"), "ci.yml must run npm run check");
});

test("release workflow runs npm run check before version/publish", () => {
	const content = readText(".github/workflows/release.yml");
	const checkIndex = content.indexOf("npm run check");
	const changesetsIndex = content.indexOf("changesets/action");
	ok(checkIndex >= 0, "release.yml must run npm run check");
	ok(changesetsIndex >= 0, "release.yml must use changesets/action");
	ok(checkIndex < changesetsIndex, "check must run before changesets/action in release.yml");
});

// ============================================================================
// Fixed group and private/exclude
// ============================================================================

test("changeset config fixed group includes all 7 published packages", () => {
	const config = JSON.parse(readText(".changeset/config.json"));
	const fixedGroups = config.fixed ?? [];
	ok(fixedGroups.length === 1, "exactly one fixed group");
	const group = fixedGroups[0];
	const expected = [
		"@apholdings/jensen-agent-core",
		"@apholdings/jensen-ai",
		"@apholdings/jensen-code",
		"@apholdings/jensen-mom",
		"@apholdings/jensen-pods",
		"@apholdings/jensen-tui",
		"@apholdings/jensen-web-ui",
	];
	deepStrictEqual([...group].sort(), [...expected].sort(), "all 7 published packages must be in fixed group");
});

test("changeset config does not include private root", () => {
	const config = JSON.parse(readText(".changeset/config.json"));
	const fixedGroups = config.fixed ?? [];
	const group = fixedGroups[0];
	ok(!group.includes("jensen-monorepo"), "private root must not be in fixed group");
});

test("changeset config ignores example workspaces", () => {
	const config = JSON.parse(readText(".changeset/config.json"));
	const ignored = config.ignore ?? [];
	ok(ignored.includes("pi-web-ui-example"), "example workspace must be ignored");
});

test("root package is private", () => {
	const rootPkg = readJson("package.json");
	strictEqual(rootPkg.private, true, "root package must be private");
});

test("all 7 published packages are not private", () => {
	const publishedNames = [
		"@apholdings/jensen-agent-core",
		"@apholdings/jensen-ai",
		"@apholdings/jensen-code",
		"@apholdings/jensen-mom",
		"@apholdings/jensen-pods",
		"@apholdings/jensen-tui",
		"@apholdings/jensen-web-ui",
	];

	const pkgDir = {
		"@apholdings/jensen-agent-core": "packages/agent/package.json",
		"@apholdings/jensen-ai": "packages/ai/package.json",
		"@apholdings/jensen-code": "packages/coding-agent/package.json",
		"@apholdings/jensen-mom": "packages/mom/package.json",
		"@apholdings/jensen-pods": "packages/pods/package.json",
		"@apholdings/jensen-tui": "packages/tui/package.json",
		"@apholdings/jensen-web-ui": "packages/web-ui/package.json",
	};

	for (const name of publishedNames) {
		const pkgPath = pkgDir[name];
		ok(pkgPath, `package directory for ${name}`);
		const pkg = readJson(pkgPath);
		strictEqual(pkg.private ?? false, false, `${name} must not be private`);
		strictEqual(pkg.name, name, `${name} package.json name mismatch`);
	}
});

// ============================================================================
// Tag policy
// ============================================================================

test("publisher does not create per-package tags", () => {
	const content = readText("scripts/publish-unpublished-packages.mjs");
	// The old createTagIfMissing created tags like `${pkg.name}@${pkg.version}`.
	// Must verify it no longer exists.
	ok(!content.includes("function createTagIfMissing"), "createTagIfMissing must not exist");
	ok(!content.includes("createTagIfMissing"), "createTagIfMissing must not be called");
	// Must use lockstep v<version> tag
	ok(content.includes("`v${version}") || content.includes("`v${") || content.includes("v${releaseVersion}"), "publisher must use v<version> tag format");
	// Must have a function that creates the lockstep tag
	ok(content.includes("createLockstepTag"), "publisher must have a createLockstepTag function");
	// Must verify all 7 before creating tag
	ok(content.includes("allPackagesVerified") || content.includes("all seven packages") || content.includes("all 7"), "publisher must verify all packages before tag");
});

test("documented tag policy uses v<version> format", () => {
	const jensen = readText("JENSEN.md");
	// Must document lockstep tags
	ok(jensen.includes("lightweight Git tag") || jensen.includes("v<version>") || jensen.includes("lockstep"), "JENSEN.md must document lockstep tag policy");
	// Must NOT document per-package tags
	ok(!jensen.includes("@apholdings/jensen"), "JENSEN.md must not reference per-package tags");
});

// ============================================================================
// Entrypoint validation
// ============================================================================

const PUBLISHED_PACKAGES = [
	{ dir: "packages/tui", name: "@apholdings/jensen-tui" },
	{ dir: "packages/ai", name: "@apholdings/jensen-ai" },
	{ dir: "packages/agent", name: "@apholdings/jensen-agent-core" },
	{ dir: "packages/coding-agent", name: "@apholdings/jensen-code" },
	{ dir: "packages/mom", name: "@apholdings/jensen-mom" },
	{ dir: "packages/pods", name: "@apholdings/jensen-pods" },
	{ dir: "packages/web-ui", name: "@apholdings/jensen-web-ui" },
];

function resolveEntrypoint(pkgDir, entrypoint) {
	if (typeof entrypoint !== "string") {
		return null;
	}
	return join(ROOT, pkgDir, entrypoint.replace(/^\.\//, ""));
}

function entrypointExists(pkgDir, entrypoint) {
	const resolved = resolveEntrypoint(pkgDir, entrypoint);
	if (resolved === null) return false;
	try {
		const s = statSync(resolved);
		return s.isFile();
	} catch {
		return false;
	}
}

test("all declared entrypoints exist in dist after build", () => {
	const missing = [];

	for (const pkg of PUBLISHED_PACKAGES) {
		const pkgJson = readJson(`${pkg.dir}/package.json`);

		const entrypoints = [];

		// main
		if (typeof pkgJson.main === "string") {
			entrypoints.push({ type: "main", path: pkgJson.main });
		}

		// module
		if (typeof pkgJson.module === "string") {
			entrypoints.push({ type: "module", path: pkgJson.module });
		}

		// types
		if (typeof pkgJson.types === "string") {
			entrypoints.push({ type: "types", path: pkgJson.types });
		}

		// bin targets
		if (pkgJson.bin && typeof pkgJson.bin === "object") {
			for (const [binName, binPath] of Object.entries(pkgJson.bin)) {
				entrypoints.push({ type: `bin.${binName}`, path: binPath });
			}
		}

		// exports subpaths (only string values and import/types conditions)
		if (pkgJson.exports && typeof pkgJson.exports === "object") {
			for (const [subpath, target] of Object.entries(pkgJson.exports)) {
				if (typeof target === "string") {
					entrypoints.push({ type: `exports${subpath}`, path: target });
				} else if (target && typeof target === "object") {
					for (const [cond, path] of Object.entries(target)) {
						if (typeof path === "string" && (cond === "import" || cond === "types" || cond === "default")) {
							entrypoints.push({ type: `exports${subpath}[${cond}]`, path });
						}
					}
				}
			}
		}

		for (const ep of entrypoints) {
			if (!entrypointExists(pkg.dir, ep.path)) {
				missing.push(`${pkg.name}:${ep.type}=${ep.path}`);
			}
		}
	}

	if (missing.length > 0) {
		console.log("Missing entrypoints:");
		for (const m of missing) console.log(`  ${m}`);
	}
	strictEqual(missing.length, 0, `found ${missing.length} missing entrypoints`);
});

// ============================================================================
// No alternative publish paths
// ============================================================================

test("no alternative publish script exists", () => {
	ok(!existsSync(join(ROOT, "scripts/release.mjs")), "release.mjs must not exist");
	const rootPkg = readJson("package.json");
	const scripts = rootPkg.scripts ?? {};
	ok(!("publish" in scripts), "no manual publish script");
	ok(!("prepublishOnly" in scripts), "no manual prepublishOnly script");
});

test("release workflow does not contain git push --follow-tags", () => {
	const content = readText(".github/workflows/release.yml");
	ok(!content.includes("--follow-tags"), "release.yml must not use git push --follow-tags");
});
