#!/usr/bin/env node

/**
 * Provider E2E credential preflight.
 *
 * Requires JENSEN_E2E_PROVIDERS to be set to a comma-separated list of
 * provider keys or "all". Validates credentials only for selected providers.
 *
 * Exit codes:
 *   0 — JENSEN_E2E_PROVIDERS set, all selected providers have credentials
 *   1 — JENSEN_E2E_PROVIDERS missing/empty, unknown provider, or
 *        selected provider lacks credentials
 *
 * Usage:
 *   JENSEN_E2E_PROVIDERS=openai,anthropic \
 *   OPENAI_API_KEY="<key>" \
 *   ANTHROPIC_API_KEY="<key>" \
 *   node scripts/check-provider-e2e-credentials.mjs
 */

import process from "node:process";
import {
	parseProviderSelection,
	PROVIDER_MAP,
	VALID_PROVIDER_KEYS,
} from "./e2e-provider-inventory.mjs";

/**
 * Check whether a single variable is present and non-empty.
 */
function hasVar(name) {
	const value = process.env[name];
	return typeof value === "string" && value.trim().length > 0;
}

/**
 * Check whether a provider's credential sets are satisfied.
 */
function providerHasCredentials(entry) {
	for (const set of entry.credentialSets) {
		const allPresent = set.every((v) => {
			if (!hasVar(v.name)) return false;
			if (v.requiresCompanion && !hasVar(v.requiresCompanion)) return false;
			return true;
		});
		if (allPresent) return true;
	}
	return false;
}

/**
 * Return a human-readable description of the credential variables
 * required for a provider.
 */
function credentialDescription(entry) {
	return entry.credentialSets
		.map((set) => {
			if (set.length === 1) return set[0].name;
			return set.map((v) => v.name).join(" + ");
		})
		.join(" or ");
}

function main() {
	const raw = process.env.JENSEN_E2E_PROVIDERS;
	const { selected, error } = parseProviderSelection(raw);

	if (error) {
		// Unknown providers or empty selector
		if (selected.length > 0) {
			// Partial unknown: still fail
			console.error(error);
			process.exit(1);
		}
		// Empty selector
		console.error(error);
		console.error("");
		console.error("Supported providers: " + [...VALID_PROVIDER_KEYS].sort().join(", "));
		process.exit(1);
	}

	if (selected.length === 0) {
		console.error('Set JENSEN_E2E_PROVIDERS to a comma-separated provider list or "all".');
		console.error("");
		console.error("Supported providers: " + [...VALID_PROVIDER_KEYS].sort().join(", "));
		process.exit(1);
	}

	// Validate credentials for selected providers only
	const missing = [];
	for (const key of selected) {
		const entry = PROVIDER_MAP[key];
		if (!providerHasCredentials(entry)) {
			missing.push({ displayName: entry.displayName, vars: credentialDescription(entry) });
		}
	}

	const selectedDisplay = selected.map((k) => PROVIDER_MAP[k].displayName).sort().join(", ");
	console.log(`Selected provider E2E: ${selectedDisplay}`);

	if (missing.length > 0) {
		console.error("");
		console.error("Missing credentials for selected provider(s):");
		for (const { displayName, vars } of missing) {
			console.error(`  ${displayName}: ${vars}`);
		}
		console.error("");
		console.error("Set the required environment variables and retry.");
		console.error("Variables that are present will NOT be printed for security.");
		process.exit(1);
	}

	process.exit(0);
}

main();
