import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { deepStrictEqual, strictEqual, ok, match } from "node:assert";
import { join } from "node:path";
import { test } from "node:test";

const PREFLIGHT = join(import.meta.dirname, "check-provider-e2e-credentials.mjs");

/**
 * Build a clean environment with all known credential variables removed,
 * and JENSEN_E2E_PROVIDERS removed.
 */
function cleanEnv() {
	const env = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (
			key === "JENSEN_E2E_PROVIDERS" ||
			key.endsWith("_API_KEY") ||
			key === "AWS_PROFILE" ||
			key === "AWS_ACCESS_KEY_ID" ||
			key === "AWS_SECRET_ACCESS_KEY" ||
			key === "AWS_BEARER_TOKEN_BEDROCK"
		) {
			continue;
		}
		env[key] = value;
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
// E01 — No credentials at all, no selector
// ============================================================================

test("E01: no selector, no credentials — exit non-zero, usage diagnostic", () => {
	const result = runPreflight();

	strictEqual(result.exitCode, 1, "exit code must be 1");
	match(result.stderr, /JENSEN_E2E_PROVIDERS/);
	match(result.stderr, /comma-separated/);
});

// ============================================================================
// S01 — Without selector
// ============================================================================

test("S01: selector absent — exit non-zero, usage diagnostic", () => {
	const result = runPreflight();

	strictEqual(result.exitCode, 1, "selector absent → exit 1");
	match(result.stderr, /Set JENSEN_E2E_PROVIDERS/);
	match(result.stderr, /comma-separated/);
	match(result.stderr, /Supported providers/);
});

test("S01b: selector absent even with credentials present — exit non-zero", () => {
	const result = runPreflight({ GEMINI_API_KEY: "dummy-gemini-key" });

	strictEqual(result.exitCode, 1, "credentials present but no selector → exit 1");
	match(result.stderr, /Set JENSEN_E2E_PROVIDERS/);

	// Secret value must NOT be printed
	ok(!result.stdout.includes("dummy-gemini-key"), "must not leak credential value");
	ok(!result.stderr.includes("dummy-gemini-key"), "must not leak credential value");
});

// ============================================================================
// S02 — Unknown provider selector
// ============================================================================

test("S02: unknown provider — exit non-zero, lists unknown and supported", () => {
	const result = runPreflight({
		JENSEN_E2E_PROVIDERS: "openai,unknown",
	});

	strictEqual(result.exitCode, 1, "unknown provider → exit 1");
	match(result.stderr, /Unknown provider/);
	match(result.stderr, /unknown/);
	match(result.stderr, /Supported:/);
	match(result.stderr, /openai/);
});

// ============================================================================
// S03 — Selected provider without credentials
// ============================================================================

test("S03: selected provider missing credentials — exit non-zero", () => {
	const result = runPreflight({
		JENSEN_E2E_PROVIDERS: "openai",
	});

	strictEqual(result.exitCode, 1, "openai selected without creds → exit 1");
	match(result.stdout, /Selected provider E2E: OpenAI/);
	match(result.stderr, /Missing credentials for selected provider/);
	match(result.stderr, /OpenAI/);
	match(result.stderr, /OPENAI_API_KEY/);
});

// ============================================================================
// S04 — Selected provider with credentials
// ============================================================================

test("S04: selected provider with credentials — preflight exit 0, secret not printed", () => {
	const result = runPreflight({
		JENSEN_E2E_PROVIDERS: "openai",
		OPENAI_API_KEY: "dummy-openai-key",
	});

	strictEqual(result.exitCode, 0, "openai selected + cred → exit 0");
	match(result.stdout, /Selected provider E2E: OpenAI/);

	// Secret value must NOT appear in output
	ok(!result.stdout.includes("dummy-openai-key"), "must not leak credential value");
	ok(!result.stderr.includes("dummy-openai-key"), "must not leak credential value");

	// Only OpenAI is mentioned (no unrelated providers)
	ok(!result.stdout.includes("Google"), "unrelated provider not listed");
	ok(!result.stderr.includes("ANTHROPIC_API_KEY"), "unrelated env var not listed");
});

// ============================================================================
// S05 — Multiple providers, one missing credentials
// ============================================================================

test("S05: multiple providers, one missing — exit non-zero, only missing listed", () => {
	const result = runPreflight({
		JENSEN_E2E_PROVIDERS: "openai,anthropic",
		OPENAI_API_KEY: "dummy-openai-key",
	});

	strictEqual(result.exitCode, 1, "one missing → exit 1");
	match(result.stdout, /Selected provider E2E: Anthropic, OpenAI/);
	match(result.stderr, /Missing credentials for selected provider/);
	match(result.stderr, /Anthropic/);
	match(result.stderr, /ANTHROPIC_API_KEY/);

	// Only missing is listed
	ok(!result.stderr.includes("OpenAI"), "present provider not in missing list");
	// Unrelated providers not listed
	ok(!result.stderr.includes("GEMINI_API_KEY"), "unrelated env var not listed");
	ok(!result.stderr.includes("XAI_API_KEY"), "unrelated env var not listed");
});

// ============================================================================
// S06 — Multiple providers, all with credentials
// ============================================================================

test("S06: multiple providers all with credentials — exit 0", () => {
	const result = runPreflight({
		JENSEN_E2E_PROVIDERS: "openai,anthropic",
		OPENAI_API_KEY: "dummy-openai",
		ANTHROPIC_API_KEY: "dummy-anthropic",
	});

	strictEqual(result.exitCode, 0, "both present → exit 0");
	match(result.stdout, /Selected provider E2E: Anthropic, OpenAI/);

	ok(!result.stdout.includes("dummy-openai"), "must not leak secret");
	ok(!result.stdout.includes("dummy-anthropic"), "must not leak secret");
});

// ============================================================================
// S07 — `all` incomplete
// ============================================================================

test("S07: all with one provider missing — exit non-zero, missing listed", () => {
	const result = runPreflight({
		JENSEN_E2E_PROVIDERS: "all",
		OPENAI_API_KEY: "dummy-openai",
		ANTHROPIC_API_KEY: "dummy-anthropic",
		XAI_API_KEY: "dummy-xai",
		GROQ_API_KEY: "dummy-groq",
		CEREBRAS_API_KEY: "dummy-cerebras",
		ZAI_API_KEY: "dummy-zai",
		AWS_PROFILE: "dummy-profile",
		// GEMINI_API_KEY intentionally missing
	});

	strictEqual(result.exitCode, 1, "all but one missing → exit 1");
	match(result.stderr, /Missing credentials for selected provider/);
	match(result.stderr, /Google/);
	match(result.stderr, /GEMINI_API_KEY/);

	// Present providers NOT listed as missing
	ok(!result.stderr.includes("OpenAI"), "present provider not in missing list");
});

test("S07b: all complete — exit 0", () => {
	const result = runPreflight({
		JENSEN_E2E_PROVIDERS: "all",
		GEMINI_API_KEY: "dummy-gemini",
		OPENAI_API_KEY: "dummy-openai",
		ANTHROPIC_API_KEY: "dummy-anthropic",
		XAI_API_KEY: "dummy-xai",
		GROQ_API_KEY: "dummy-groq",
		CEREBRAS_API_KEY: "dummy-cerebras",
		ZAI_API_KEY: "dummy-zai",
		AWS_PROFILE: "dummy-profile",
	});

	strictEqual(result.exitCode, 0, "all present → exit 0");
	// All 8 display names appear
	match(result.stdout, /Google/);
	match(result.stdout, /OpenAI/);
	match(result.stdout, /Anthropic/);
	match(result.stdout, /xAI/);
	match(result.stdout, /Groq/);
	match(result.stdout, /Cerebras/);
	match(result.stdout, /zAI/);
	match(result.stdout, /Amazon Bedrock/);
});

// ============================================================================
// S08 — Bedrock credential alternatives
// ============================================================================

test("S08a: bedrock with AWS_PROFILE alone — ok", () => {
	const result = runPreflight({
		JENSEN_E2E_PROVIDERS: "bedrock",
		AWS_PROFILE: "my-profile",
	});

	strictEqual(result.exitCode, 0, "AWS_PROFILE → exit 0");
});

test("S08b: bedrock with AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY — ok", () => {
	const result = runPreflight({
		JENSEN_E2E_PROVIDERS: "bedrock",
		AWS_ACCESS_KEY_ID: "AKIADUMMY",
		AWS_SECRET_ACCESS_KEY: "dummy-secret",
	});

	strictEqual(result.exitCode, 0, "key pair → exit 0");
});

test("S08c: bedrock with AWS_BEARER_TOKEN_BEDROCK alone — ok", () => {
	const result = runPreflight({
		JENSEN_E2E_PROVIDERS: "bedrock",
		AWS_BEARER_TOKEN_BEDROCK: "dummy-token",
	});

	strictEqual(result.exitCode, 0, "bearer token → exit 0");
});

test("S08d: bedrock with partial pair (key only) — fail", () => {
	const result = runPreflight({
		JENSEN_E2E_PROVIDERS: "bedrock",
		AWS_ACCESS_KEY_ID: "AKIADUMMY",
	});

	strictEqual(result.exitCode, 1, "partial pair → exit 1");
	match(result.stderr, /Amazon Bedrock/);
});

// ============================================================================
// S09 — Normalization
// ============================================================================

test("S09a: whitespace stripped, case normalized", () => {
	const result = runPreflight({
		JENSEN_E2E_PROVIDERS: " OpenAI,anthropic,OPENAI ",
		OPENAI_API_KEY: "dummy-openai",
		ANTHROPIC_API_KEY: "dummy-anthropic",
	});

	strictEqual(result.exitCode, 0, "normalized selection → exit 0");
	match(result.stdout, /Selected provider E2E: Anthropic, OpenAI/);
});

test("S09b: duplicates removed", () => {
	const result = runPreflight({
		JENSEN_E2E_PROVIDERS: "openai,openai,openai",
		OPENAI_API_KEY: "dummy-openai",
	});

	strictEqual(result.exitCode, 0, "deduped → exit 0");
	match(result.stdout, /Selected provider E2E: OpenAI/);
	// Should only appear once
	const matches = (result.stdout.match(/OpenAI/g) || []).length;
	strictEqual(matches, 1, "OpenAI should appear exactly once in selected list");
});

// ============================================================================
// S10 — Filter in tests (vitest helper unit test)
// ============================================================================

// S10 is a Vitest-level concern — the helper lives in
// packages/agent/test/e2e/helpers/provider-selection.ts.
// We verify the parse logic used by the helper here.

test("S10: parseProviderSelection handles all edge cases", async () => {
	// Dynamic ESM import to test the shared inventory parser
	const { parseProviderSelection } = await import("./e2e-provider-inventory.mjs");

	// "all" selects all 8
	const all = parseProviderSelection("all");
	strictEqual(all.error, undefined);
	strictEqual(all.selected.length, 8);

	// Empty string → error
	const empty = parseProviderSelection("");
	ok(empty.error !== undefined);
	strictEqual(empty.selected.length, 0);

	// Undefined → error
	const undef = parseProviderSelection(undefined);
	ok(undef.error !== undefined);

	// Unknown only → error, empty selected
	const unknown = parseProviderSelection("unknown");
	ok(unknown.error !== undefined);
	strictEqual(unknown.selected.length, 0);

	// Mixed known + unknown → error, selected has known
	const mixed = parseProviderSelection("openai,unknown");
	ok(mixed.error !== undefined);
	deepStrictEqual(mixed.selected, ["openai"]);
});
