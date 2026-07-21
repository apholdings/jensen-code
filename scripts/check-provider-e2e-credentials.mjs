#!/usr/bin/env node

/**
 * Provider E2E credential preflight.
 *
 * Checks that the environment has credentials for at least one provider.
 * If no provider can run, prints the missing variable names and exits non-zero.
 *
 * This prevents accidental runs of `npm run test:e2e:providers` that
 * silently skip all provider tests without any diagnosis.
 *
 * Usage:
 *   node scripts/check-provider-e2e-credentials.mjs
 *
 * Exit codes:
 *   0 — at least one provider has credentials
 *   1 — no provider credentials found
 */

import process from "node:process";

// Provider → required variable set (each set is OR'd internally, sets are AND'd for the provider)
const PROVIDER_CREDENTIAL_SETS = {
	Google: [{ name: "GEMINI_API_KEY" }],
	OpenAI: [{ name: "OPENAI_API_KEY" }],
	Anthropic: [{ name: "ANTHROPIC_API_KEY" }],
	xAI: [{ name: "XAI_API_KEY" }],
	Groq: [{ name: "GROQ_API_KEY" }],
	Cerebras: [{ name: "CEREBRAS_API_KEY" }],
	zAI: [{ name: "ZAI_API_KEY" }],
	"Amazon Bedrock": [
		{ name: "AWS_PROFILE", optional: false },
		{ name: "AWS_ACCESS_KEY_ID", optional: true, requiresCompanion: "AWS_SECRET_ACCESS_KEY" },
		{ name: "AWS_BEARER_TOKEN_BEDROCK", optional: false },
	],
};

/**
 * Check whether a single variable is present and non-empty.
 */
function hasVar(name) {
	const value = process.env[name];
	return typeof value === "string" && value.trim().length > 0;
}

/**
 * Check whether a provider has at least one valid credential set.
 * For simple providers (single key), checks the key is present.
 * For Bedrock, checks alternative auth methods.
 */
function providerHasCredentials(name, sets) {
	if (name === "Amazon Bedrock") {
		// AWS_PROFILE alone
		if (hasVar("AWS_PROFILE")) return true;
		// AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY pair
		if (hasVar("AWS_ACCESS_KEY_ID") && hasVar("AWS_SECRET_ACCESS_KEY")) return true;
		// AWS_BEARER_TOKEN_BEDROCK
		if (hasVar("AWS_BEARER_TOKEN_BEDROCK")) return true;
		return false;
	}

	// Simple providers: one key
	for (const set of sets) {
		if (hasVar(set.name)) return true;
	}
	return false;
}

/**
 * Return the canonical variable name for each provider (for diagnostics).
 */
function providerMissingVars(name) {
	if (name === "Amazon Bedrock") {
		return [
			"AWS_PROFILE",
			"AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY",
			"AWS_BEARER_TOKEN_BEDROCK",
		].join(" or ");
	}

	const set = PROVIDER_CREDENTIAL_SETS[name];
	if (!set || set.length === 0) return "(unknown)";
	if (set.length === 1) return set[0].name;
	return set.map((s) => s.name).join(" or ");
}

function main() {
	const present = [];
	const missing = [];

	for (const [name, sets] of Object.entries(PROVIDER_CREDENTIAL_SETS)) {
		if (providerHasCredentials(name, sets)) {
			present.push(name);
		} else {
			missing.push({ name, vars: providerMissingVars(name) });
		}
	}

	if (present.length > 0) {
		console.log(
			`Provider E2E credentials present for: ${present.join(", ")}`,
		);
		if (missing.length > 0) {
			console.log(
				`Providers without credentials (will be skipped): ${missing.map((m) => m.name).join(", ")}`,
			);
		}
		process.exit(0);
	}

	// No provider has credentials — fail before Vitest starts
	console.error("Provider E2E credentials are missing for all providers.");
	console.error("");
	console.error("Required environment variables (at least one provider needed):");
	for (const { name, vars } of missing) {
		console.error(`  ${name}: ${vars}`);
	}
	console.error("");
	console.error("To run provider E2E tests:");
	console.error("  npm run test:e2e:providers");
	console.error("");
	console.error("Set the required environment variables and retry.");
	console.error("Variables that are present will NOT be printed for security.");
	process.exit(1);
}

main();
