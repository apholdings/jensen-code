import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "..");

function readJson(path) {
	return JSON.parse(readFileSync(join(ROOT, path), "utf-8"));
}

test("release.mjs does not exist", () => {
	strictEqual(existsSync(join(ROOT, "scripts/release.mjs")), false);
});

test("JENSEN.md does not reference missing npm scripts", () => {
	const content = readFileSync(join(ROOT, "JENSEN.md"), "utf-8");
	// Must NOT reference the old manual release scripts
	ok(!content.includes("release:patch"), "JENSEN.md references release:patch");
	ok(!content.includes("release:minor"), "JENSEN.md references release:minor");
	ok(!content.includes("release:major"), "JENSEN.md references release:major");
	ok(!content.includes("scripts/release.mjs"), "JENSEN.md references scripts/release.mjs");
	// Must document the Changesets CI path
	ok(content.includes("changeset"), "JENSEN.md must document changeset usage");
	ok(content.includes("version PR"), "JENSEN.md must document version PR");
});

test("release workflow does not reference missing npm scripts", () => {
	const content = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf-8");
	ok(!content.includes("release:patch"), "release.yml references release:patch");
	ok(!content.includes("release:minor"), "release.yml references release:minor");
});

test("root package.json has exactly one active versioning path", () => {
	const rootPkg = readJson("package.json");
	const scripts = rootPkg.scripts ?? {};

	// Single versioning path: version:packages
	strictEqual("version:packages" in scripts, true);
	deepStrictEqual(scripts["version:packages"], "changeset version && npm install --package-lock-only");

	// Must NOT have any old manual versioning scripts
	ok(!("version:patch" in scripts), "version:patch must not exist");
	ok(!("version:minor" in scripts), "version:minor must not exist");
	ok(!("version:major" in scripts), "version:major must not exist");

	// Must NOT have manual publish scripts
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

test("changeset config fixed group includes all 7 published packages", () => {
	const config = JSON.parse(
		readFileSync(join(ROOT, ".changeset/config.json"), "utf-8"),
	);
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
	const config = JSON.parse(
		readFileSync(join(ROOT, ".changeset/config.json"), "utf-8"),
	);
	const fixedGroups = config.fixed ?? [];
	const group = fixedGroups[0];
	ok(!group.includes("jensen-monorepo"), "private root must not be in fixed group");
});

test("changeset config ignores example workspaces", () => {
	const config = JSON.parse(
		readFileSync(join(ROOT, ".changeset/config.json"), "utf-8"),
	);
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

test("changeset directory has exactly one changeset file", () => {
	const changesetsDir = join(ROOT, ".changeset");
	const files = readdirSync(changesetsDir);
	const changesetFiles = files.filter(
		(f) => f.endsWith(".md") && f !== "README.md",
	);
	strictEqual(changesetFiles.length, 1, "exactly one changeset file");
	strictEqual(changesetFiles[0], "robust-bash-execution.md");
});

test("changeset file targets only coding-agent", () => {
	const content = readFileSync(
		join(ROOT, ".changeset/robust-bash-execution.md"),
		"utf-8",
	);
	ok(content.includes('"@apholdings/jensen-code": patch'), "changeset targets coding-agent with patch bump");
	// Should NOT target other packages
	ok(!content.includes('"@apholdings/jensen-ai":'), "changeset must not target ai");
	ok(!content.includes('"@apholdings/jensen-agent-core":'), "changeset must not target agent-core");
	ok(!content.includes('"@apholdings/jensen-tui":'), "changeset must not target tui");
	ok(!content.includes('"@apholdings/jensen-mom":'), "changeset must not target mom");
	ok(!content.includes('"@apholdings/jensen-pods":'), "changeset must not target pods");
	ok(!content.includes('"@apholdings/jensen-web-ui":'), "changeset must not target web-ui");
});
