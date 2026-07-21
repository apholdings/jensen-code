import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { orchestratePublish, TOPOLOGICAL_ORDER, EXPECTED_PACKAGE_COUNT } from "./publish-unpublished-packages.mjs";

// ============================================================================
// Test helpers
// ============================================================================

const ALL_SEVEN = [
	{ dir: "packages/tui", name: "@apholdings/jensen-tui", version: "1.1.7" },
	{ dir: "packages/ai", name: "@apholdings/jensen-ai", version: "1.1.7" },
	{ dir: "packages/agent", name: "@apholdings/jensen-agent-core", version: "1.1.7" },
	{ dir: "packages/coding-agent", name: "@apholdings/jensen-code", version: "1.1.7" },
	{ dir: "packages/mom", name: "@apholdings/jensen-mom", version: "1.1.7" },
	{ dir: "packages/pods", name: "@apholdings/jensen-pods", version: "1.1.7" },
	{ dir: "packages/web-ui", name: "@apholdings/jensen-web-ui", version: "1.1.7" },
];

function checkAllPublished() {
	return (_name, _version) => ({ published: true, summary: "confirmed" });
}

function checkNonePublished() {
	return (_name, _version) => ({ published: false, summary: "not found" });
}

function checkInitiallyNoneThenVerified() {
	// Returns false for first 7 calls (pre-publish check), true thereafter (post-publish verify)
	let count = 0;
	return (_name, _version) => {
		count += 1;
		return { published: count > 7, summary: count > 7 ? "confirmed" : "not found" };
	};
}

function checkPartialPublished(firstN) {
	// First N packages are already published, rest are initially not but become verified after publish
	let count = 0;
	let verificationCalled = false;
	return (_name, _version) => {
		count += 1;
		// After the initial check of 7 packages, we're in verification phase
		if (count > 7) {
			verificationCalled = true;
			return { published: true, summary: "confirmed" };
		}
		return { published: count <= firstN, summary: count <= firstN ? "confirmed" : "not found" };
	};
}

function waitImmediate() {
	return async (_name, _version) => {};
}

function publishCollector() {
	const calls = [];
	return {
		calls,
		fn(_pkg, _authMode, _publishTag) {
			calls.push(_pkg.name);
		},
	};
}

function tagCollector() {
	const calls = [];
	return {
		calls,
		fn(version) {
			calls.push(version);
			return true;
		},
	};
}

function outputCollector() {
	const calls = [];
	return {
		calls,
		fn(result) {
			calls.push(result);
		},
	};
}

// ============================================================================
// P01 — All seven unpublished
// ============================================================================

it("P01: all seven unpublished — publish all, verify all, create tag", async () => {
	const publish = publishCollector();
	const tag = tagCollector();
	const output = outputCollector();

	const result = await orchestratePublish({
		packages: ALL_SEVEN,
		publishTag: "latest",
		checkVersion: checkInitiallyNoneThenVerified(),
		waitForVersion: waitImmediate(),
		publishFn: publish.fn,
		createTag: tag.fn,
		writeOutput: output.fn,
	});

	assert.equal(publish.calls.length, 7);
	assert.deepEqual(publish.calls, ALL_SEVEN.map((p) => p.name));
	assert.deepEqual(tag.calls, ["1.1.7"]);
	assert.equal(result.releaseVersion, "1.1.7");
	assert.equal(result.releaseTag, "v1.1.7");
	assert.equal(result.allPackagesVerified, true);
	assert.equal(result.tagCreated, true);
	assert.equal(result.publishedPackages.length, 7);
	assert.equal(result.alreadyPublishedPackages.length, 0);
	// Output was written
	assert.equal(output.calls.length, 1);
	assert.equal(output.calls[0].releaseTag, "v1.1.7");
});

// ============================================================================
// P02 — First three already published
// ============================================================================

it("P02: first three already published — publish remaining four, verify seven, create tag", async () => {
	const publish = publishCollector();
	const tag = tagCollector();
	const output = outputCollector();

	const result = await orchestratePublish({
		packages: ALL_SEVEN,
		publishTag: "latest",
		checkVersion: checkPartialPublished(3),
		waitForVersion: waitImmediate(),
		publishFn: publish.fn,
		createTag: tag.fn,
		writeOutput: output.fn,
	});

	// Only 4 published during run
	assert.equal(publish.calls.length, 4);
	assert.deepEqual(publish.calls, ALL_SEVEN.slice(3).map((p) => p.name));
	assert.deepEqual(tag.calls, ["1.1.7"]);
	assert.equal(result.allPackagesVerified, true);
	assert.equal(result.publishedPackages.length, 7);
	assert.equal(result.alreadyPublishedPackages.length, 3);
});

// ============================================================================
// P03 — Fourth package fails during publish
// ============================================================================

it("P03: fourth package fails — packages five through seven not attempted, no tag", async () => {
	const publishCalls = [];
	const tag = tagCollector();
	const output = outputCollector();

	const failingPublishFn = (pkg, _authMode, _publishTag) => {
		publishCalls.push(pkg.name);
		if (pkg.name === "@apholdings/jensen-code") {
			throw new Error("Simulated publish failure");
		}
	};

	await assert.rejects(
		orchestratePublish({
			packages: ALL_SEVEN,
			publishTag: "latest",
			checkVersion: checkNonePublished(),
			waitForVersion: waitImmediate(),
			publishFn: failingPublishFn,
			createTag: tag.fn,
			writeOutput: output.fn,
		}),
		/Simulated publish failure/,
	);

	// Only first 4 were attempted (tui, ai, agent, coding-agent)
	assert.deepEqual(publishCalls, [
		"@apholdings/jensen-tui",
		"@apholdings/jensen-ai",
		"@apholdings/jensen-agent-core",
		"@apholdings/jensen-code",
	]);
	// No tag
	assert.equal(tag.calls.length, 0);
});

// ============================================================================
// P04 — Publishing loop completes but one package still absent
// ============================================================================

it("P04: one package still absent after publish loop — no tag, exit failure", async () => {
	const publish = publishCollector();
	const tag = tagCollector();
	const output = outputCollector();

	// Check that returns false for web-ui even after "publishing"
	let checkCount = 0;
	const flakyCheck = (_name, _version) => {
		checkCount += 1;
		// Pre-publish check: all unpublished
		if (checkCount <= 7) return { published: false, summary: "not found" };
		// Post-publish verification: web-ui still missing
		if (_name === "@apholdings/jensen-web-ui") return { published: false, summary: "still not found" };
		return { published: true, summary: "confirmed" };
	};

	await assert.rejects(
		orchestratePublish({
			packages: ALL_SEVEN,
			publishTag: "latest",
			checkVersion: flakyCheck,
			waitForVersion: waitImmediate(),
			publishFn: publish.fn,
			createTag: tag.fn,
			writeOutput: output.fn,
		}),
		/Not all seven packages are verified/,
	);

	assert.equal(publish.calls.length, 7);
	assert.equal(tag.calls.length, 0);
	assert.equal(output.calls.length, 1);
	assert.equal(output.calls[0].allPackagesVerified, false);
	assert.equal(output.calls[0].releaseTag, null);
	assert.equal(output.calls[0].tagCreated, false);
});

// ============================================================================
// P05 — Divergent versions
// ============================================================================

it("P05: one package at 1.1.8, six at 1.1.7 — fail before any publish", async () => {
	const divergent = [
		{ dir: "packages/tui", name: "@apholdings/jensen-tui", version: "1.1.7" },
		{ dir: "packages/ai", name: "@apholdings/jensen-ai", version: "1.1.7" },
		{ dir: "packages/agent", name: "@apholdings/jensen-agent-core", version: "1.1.7" },
		{ dir: "packages/coding-agent", name: "@apholdings/jensen-code", version: "1.1.8" },
		{ dir: "packages/mom", name: "@apholdings/jensen-mom", version: "1.1.7" },
		{ dir: "packages/pods", name: "@apholdings/jensen-pods", version: "1.1.7" },
		{ dir: "packages/web-ui", name: "@apholdings/jensen-web-ui", version: "1.1.7" },
	];

	const publish = publishCollector();
	const tag = tagCollector();
	const output = outputCollector();

	await assert.rejects(
		orchestratePublish({
			packages: divergent,
			publishTag: "latest",
			checkVersion: checkNonePublished(),
			waitForVersion: waitImmediate(),
			publishFn: publish.fn,
			createTag: tag.fn,
			writeOutput: output.fn,
		}),
		/Lockstep version mismatch/,
	);

	// No publishes attempted
	assert.equal(publish.calls.length, 0);
	assert.equal(tag.calls.length, 0);
});

// ============================================================================
// P06 — Tag already exists at expected commit
// ============================================================================

it("P06: tag already exists at expected commit — no duplicate, success", async () => {
	const publish = publishCollector();
	const tagCalls = [];

	const existingTagFn = (version) => {
		tagCalls.push(version);
		return false; // not newly created
	};

	const result = await orchestratePublish({
		packages: ALL_SEVEN,
		publishTag: "latest",
		checkVersion: checkAllPublished(),
		waitForVersion: waitImmediate(),
		publishFn: publish.fn,
		createTag: existingTagFn,
		writeOutput: (_result) => {},
	});

	assert.equal(publish.calls.length, 0); // all already published
	assert.deepEqual(tagCalls, ["1.1.7"]);
	assert.equal(result.allPackagesVerified, true);
	assert.equal(result.tagCreated, false); // not newly created
	assert.equal(result.releaseTag, "v1.1.7");
});

// ============================================================================
// P07 — Tag exists at wrong commit
// ============================================================================

it("P07: tag at wrong commit — fail, tag unchanged", async () => {
	const publish = publishCollector();

	const wrongTagFn = (_version) => {
		throw new Error("Tag already exists at different commit");
	};

	await assert.rejects(
		orchestratePublish({
			packages: ALL_SEVEN,
			publishTag: "latest",
			checkVersion: checkAllPublished(),
			waitForVersion: waitImmediate(),
			publishFn: publish.fn,
			createTag: wrongTagFn,
			writeOutput: (_result) => {},
		}),
		/Tag already exists at different commit/,
	);

	assert.equal(publish.calls.length, 0);
});

// ============================================================================
// P08 — All already published, create missing tag
// ============================================================================

it("P08: all already published — publish none, verify seven, create tag", async () => {
	const publish = publishCollector();
	const tag = tagCollector();
	const output = outputCollector();

	const result = await orchestratePublish({
		packages: ALL_SEVEN,
		publishTag: "latest",
		checkVersion: checkAllPublished(),
		waitForVersion: waitImmediate(),
		publishFn: publish.fn,
		createTag: tag.fn,
		writeOutput: output.fn,
	});

	assert.equal(publish.calls.length, 0);
	assert.deepEqual(tag.calls, ["1.1.7"]);
	assert.equal(result.allPackagesVerified, true);
	assert.equal(result.tagCreated, true);
	assert.equal(result.publishedPackages.length, 7);
	assert.equal(result.alreadyPublishedPackages.length, 7);
});

// ============================================================================
// P09 — Topological order
// ============================================================================

it("P09: packages are processed in topological order", () => {
	// The TOPOLOGICAL_ORDER defines the dependency ordering
	assert.equal(TOPOLOGICAL_ORDER.length, EXPECTED_PACKAGE_COUNT);

	const idx = (name) => TOPOLOGICAL_ORDER.indexOf(name);

	// tui and ai before agent
	assert.ok(idx("packages/tui") < idx("packages/agent"), "tui before agent");
	assert.ok(idx("packages/ai") < idx("packages/agent"), "ai before agent");

	// agent before coding-agent
	assert.ok(idx("packages/agent") < idx("packages/coding-agent"), "agent before coding-agent");

	// coding-agent, agent, ai before mom
	assert.ok(idx("packages/coding-agent") < idx("packages/mom"), "coding-agent before mom");
	assert.ok(idx("packages/agent") < idx("packages/mom"), "agent before mom");
	assert.ok(idx("packages/ai") < idx("packages/mom"), "ai before mom");

	// agent before pods
	assert.ok(idx("packages/agent") < idx("packages/pods"), "agent before pods");

	// tui and ai before web-ui
	assert.ok(idx("packages/tui") < idx("packages/web-ui"), "tui before web-ui");
	assert.ok(idx("packages/ai") < idx("packages/web-ui"), "ai before web-ui");

	// Full order is preserved: tui, ai, agent, coding-agent, mom, pods, web-ui
	assert.deepEqual(TOPOLOGICAL_ORDER, [
		"packages/tui",
		"packages/ai",
		"packages/agent",
		"packages/coding-agent",
		"packages/mom",
		"packages/pods",
		"packages/web-ui",
	]);
});

// Verify topological order during publish execution
it("P09b: publish respects topological order during runtime", async () => {
	const publish = publishCollector();

	await orchestratePublish({
		packages: ALL_SEVEN,
		publishTag: "latest",
		checkVersion: checkInitiallyNoneThenVerified(),
		waitForVersion: waitImmediate(),
		publishFn: publish.fn,
		createTag: (_v) => true,
		writeOutput: (_result) => {},
	});

	// Verify order matches TOPOLOGICAL_ORDER
	const namesFromDir = (dir) => ALL_SEVEN.find((p) => p.dir === dir)?.name;
	assert.deepEqual(
		publish.calls,
		TOPOLOGICAL_ORDER.map(namesFromDir),
	);
});

// ============================================================================
// P10 — No per-package tags
// ============================================================================

it("P10: tag function receives only bare version, not per-package format", async () => {
	const tagCalls = [];

	await orchestratePublish({
		packages: ALL_SEVEN,
		publishTag: "latest",
		checkVersion: checkAllPublished(),
		waitForVersion: waitImmediate(),
		publishFn: (_pkg, _authMode, _tag) => {},
		createTag: (version) => {
			tagCalls.push(version);
			return false;
		},
		writeOutput: (_result) => {},
	});

	assert.equal(tagCalls.length, 1);
	assert.equal(tagCalls[0], "1.1.7");
	// Never @apholdings/jensen-code@1.1.7 or similar per-package format
	assert.ok(!tagCalls.some((c) => c.includes("@")), "no per-package tags");
});

// ============================================================================
// Publisher output contract
// ============================================================================

it("publisher output: all fields present with correct types", async () => {
	const output = outputCollector();

	const result = await orchestratePublish({
		packages: ALL_SEVEN,
		publishTag: "latest",
		checkVersion: checkAllPublished(),
		waitForVersion: waitImmediate(),
		publishFn: (_pkg, _authMode, _tag) => {},
		createTag: (_v) => true,
		writeOutput: output.fn,
	});

	// releaseVersion: string
	assert.equal(typeof result.releaseVersion, "string");
	assert.equal(result.releaseVersion, "1.1.7");

	// releaseTag: string
	assert.equal(typeof result.releaseTag, "string");
	assert.equal(result.releaseTag, "v1.1.7");

	// publishedPackages: string[]
	assert.ok(Array.isArray(result.publishedPackages));
	assert.equal(result.publishedPackages.length, 7);

	// alreadyPublishedPackages: string[]
	assert.ok(Array.isArray(result.alreadyPublishedPackages));
	assert.equal(result.alreadyPublishedPackages.length, 7);

	// allPackagesVerified: boolean
	assert.equal(typeof result.allPackagesVerified, "boolean");
	assert.equal(result.allPackagesVerified, true);

	// tagCreated: boolean
	assert.equal(typeof result.tagCreated, "boolean");
	assert.equal(result.tagCreated, true);

	// Output is valid JSON
	const jsonStr = JSON.stringify(result);
	const parsed = JSON.parse(jsonStr);
	assert.equal(parsed.releaseVersion, "1.1.7");

	// No credentials in output
	assert.ok(!jsonStr.includes("token"), "no token in output");
	assert.ok(!jsonStr.includes("NPM_TOKEN"), "no NPM_TOKEN in output");
	assert.ok(!jsonStr.includes("NODE_AUTH_TOKEN"), "no NODE_AUTH_TOKEN in output");
});

it("publisher output: releaseTag is null on failure", async () => {
	const output = outputCollector();

	let checkCount = 0;
	const flakyCheck = (_name, _version) => {
		checkCount += 1;
		if (checkCount <= 7) return { published: false, summary: "not found" };
		if (_name === "@apholdings/jensen-web-ui") return { published: false, summary: "still not found" };
		return { published: true, summary: "confirmed" };
	};

	await assert.rejects(
		orchestratePublish({
			packages: ALL_SEVEN,
			publishTag: "latest",
			checkVersion: flakyCheck,
			waitForVersion: waitImmediate(),
			publishFn: (_pkg, _authMode, _tag) => {},
			createTag: (_v) => false,
			writeOutput: output.fn,
		}),
	);

	assert.equal(output.calls.length, 1);
	assert.equal(output.calls[0].releaseTag, null);
	assert.equal(output.calls[0].allPackagesVerified, false);
	assert.equal(output.calls[0].tagCreated, false);
});

it("publisher output: arrays are stable (publishedPackages does not contain duplicates)", async () => {
	const publish = publishCollector();

	const result = await orchestratePublish({
		packages: ALL_SEVEN,
		publishTag: "latest",
		checkVersion: checkInitiallyNoneThenVerified(),
		waitForVersion: waitImmediate(),
		publishFn: publish.fn,
		createTag: (_v) => true,
		writeOutput: (_result) => {},
	});

	const unique = new Set(result.publishedPackages);
	assert.equal(unique.size, result.publishedPackages.length);
});
