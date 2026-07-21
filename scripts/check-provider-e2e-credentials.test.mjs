import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { strictEqual, ok, match } from "node:assert";
import { join } from "node:path";
import { test } from "node:test";

const PREFLIGHT = join(import.meta.dirname, "check-provider-e2e-credentials.mjs");

/**
 * Build a clean environment with all known credential variables removed.
 */
function cleanEnv() {
	const env = {};
	// Only copy non-credential variables
	for (const [key, value] of Object.entries(process.env)) {
		if (
			!key.endsWith("_API_KEY") &&
			key !== "AWS_PROFILE" &&
			key !== "AWS_ACCESS_KEY_ID" &&
			key !== "AWS_SECRET_ACCESS_KEY" &&
			key !== "AWS_BEARER_TOKEN_BEDROCK"
		) {
			env[key] = value;
		}
	}
	return env;
}

function runPreflight(extraEnv = {}) {
	const env = { ...cleanEnv(), ...extraEnv };
	try {
		const output = execFileSync(process.execPath, [PREFLIGHT], {
			encoding: "utf8",
			env,
			stdio: "pipe",
		});
		return { exitCode: 0, stdout: output, stderr: "" };
	} catch (err) {
		return {
			exitCode: err.status ?? 1,
			stdout: err.stdout ?? "",
			stderr: err.stderr ?? "",
		};
	}
}

// ============================================================================
// E01 — No credentials at all
// ============================================================================

test("E01: no credentials — exit non-zero, lists every provider", () => {
	const result = runPreflight();

	strictEqual(result.exitCode, 1, "exit code must be 1");
	match(result.stderr, /missing for all providers/);
	match(result.stderr, /GEMINI_API_KEY/);
	match(result.stderr, /OPENAI_API_KEY/);
	match(result.stderr, /ANTHROPIC_API_KEY/);
	match(result.stderr, /XAI_API_KEY/);
	match(result.stderr, /GROQ_API_KEY/);
	match(result.stderr, /CEREBRAS_API_KEY/);
	match(result.stderr, /ZAI_API_KEY/);
	match(result.stderr, /AWS_PROFILE/);
	match(result.stderr, /AWS_ACCESS_KEY_ID/);
	match(result.stderr, /AWS_SECRET_ACCESS_KEY/);
	match(result.stderr, /AWS_BEARER_TOKEN_BEDROCK/);

	// No secret values leaked
	ok(!result.stderr.includes("dummy"), "must not contain dummy values");
	ok(!result.stderr.includes("sk-"), "must not contain key-like patterns");
});

// ============================================================================
// E02 — Partial credentials
// ============================================================================

test("E02: partial credentials — exit 0 with one credential, lists missing without values", () => {
	const result = runPreflight({ GEMINI_API_KEY: "dummy-gemini-key" });

	strictEqual(result.exitCode, 0, "at least one credential present → exit 0");
	match(result.stdout, /present for: Google/);

	// The missing ones are listed in stdout as "without credentials"
	ok(
		result.stdout.includes("OpenAI") ||
			result.stdout.includes("Anthropic") ||
			result.stdout.includes("xAI") ||
			result.stdout.includes("Groq") ||
			result.stdout.includes("Cerebras") ||
			result.stdout.includes("zAI") ||
			result.stdout.includes("Amazon Bedrock"),
		"should list providers without credentials",
	);

	// No secret values leaked — the dummy key must not appear in output
	ok(!result.stdout.includes("dummy-gemini-key"), "must not print dummy key value");
	ok(!result.stderr.includes("dummy-gemini-key"), "must not print dummy key value");
});

// ============================================================================
// E03 — All credentials present (dummy values)
// ============================================================================

test("E03: all credentials present with dummy values — exit 0, no values leaked", () => {
	const result = runPreflight({
		GEMINI_API_KEY: "dummy-gemini",
		OPENAI_API_KEY: "dummy-openai",
		ANTHROPIC_API_KEY: "dummy-anthropic",
		XAI_API_KEY: "dummy-xai",
		GROQ_API_KEY: "dummy-groq",
		CEREBRAS_API_KEY: "dummy-cerebras",
		ZAI_API_KEY: "dummy-zai",
		AWS_PROFILE: "dummy-profile",
	});

	strictEqual(result.exitCode, 0, "all credentials present → exit 0");

	// No dummy values leaked
	ok(!result.stdout.includes("dummy-gemini"), "must not print credential value");
	ok(!result.stdout.includes("dummy-openai"), "must not print credential value");
	ok(!result.stdout.includes("dummy-anthropic"), "must not print credential value");
});

// ============================================================================
// E04 — Empty/whitespace values treated as missing
// ============================================================================

test("E04: empty or whitespace values treated as missing", () => {
	const result = runPreflight({
		GEMINI_API_KEY: "",
		OPENAI_API_KEY: "   ",
		ANTHROPIC_API_KEY: "\t",
	});

	strictEqual(result.exitCode, 1, "whitespace-only creds → exit 1");
	match(result.stderr, /GEMINI_API_KEY/);
	match(result.stderr, /OPENAI_API_KEY/);
	match(result.stderr, /ANTHROPIC_API_KEY/);
});

// ============================================================================
// E05 — No secret leakage in missing-credential diagnostic
// ============================================================================

test("E05: diagnostic never contains secret values", () => {
	const result = runPreflight({ GEMINI_API_KEY: "AIzaSyDummyGoogleKey123456789" });

	strictEqual(result.exitCode, 0, "one present → exit 0");

	// The actual value must never appear in output
	ok(!result.stdout.includes("AIzaSyDummyGoogleKey123456789"), "must not leak google key");
	ok(!result.stderr.includes("AIzaSyDummyGoogleKey123456789"), "must not leak google key");

	// Generic patterns that could match real keys
	ok(!result.stdout.includes("dummy"), "must not contain the dummy marker word in clean pass");

	// Check that a non-secret provider name IS present (the "present" listing)
	ok(result.stdout.includes("Google"), "should list Google as present");
});

// ============================================================================
// E06 — Command short-circuit: preflight before vitest in npm script
// ============================================================================

test("E06: test:e2e:providers script places preflight before vitest with short-circuit", () => {
	const agentPkgPath = join(import.meta.dirname, "..", "packages", "agent", "package.json");
	const agentPkg = JSON.parse(readFileSync(agentPkgPath, "utf8"));
	const script = agentPkg.scripts["test:e2e:providers"];

	ok(typeof script === "string", "test:e2e:providers script must exist");
	ok(script.includes("check-provider-e2e-credentials.mjs"), "script must include preflight");
	ok(script.includes("&&"), "script must use && for short-circuit");

	const preflightIdx = script.indexOf("check-provider-e2e-credentials.mjs");
	const vitestIdx = script.indexOf("vitest");
	ok(preflightIdx < vitestIdx, "preflight must appear before vitest for short-circuit");
});
