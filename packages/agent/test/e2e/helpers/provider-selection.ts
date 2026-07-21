/**
 * E2E provider selection helpers for Vitest tests.
 *
 * Delegates to the authoritative provider inventory in scripts/.
 * Single source of truth — no diverging provider lists.
 *
 * @module
 */

// @ts-expect-error — .mjs import into vitest context, no TS types
import { PROVIDER_INVENTORY, parseProviderSelection } from "../../../../scripts/e2e-provider-inventory.mjs";

const _providerInventory = PROVIDER_INVENTORY as Array<{
	key: string;
	displayName: string;
	credentialSets: unknown[];
}>;
const _parseProviderSelection = parseProviderSelection as (raw: string | undefined) => {
	selected: string[];
	error?: string;
};

/** Set of selected provider keys (lowercase). Built once at import time. */
const selectedSet = (() => {
	const { selected, error } = _parseProviderSelection(process.env.JENSEN_E2E_PROVIDERS);
	if (error && selected.length === 0) {
		// No selector — no providers selected
		return new Set<string>();
	}
	if (error) {
		// Partial unknown — only valid ones selected
		return new Set<string>(selected);
	}
	return new Set<string>(selected);
})();

/**
 * Returns the list of selected provider keys.
 * Empty array if JENSEN_E2E_PROVIDERS is not set.
 */
export function getSelectedE2EProviders(): string[] {
	return [...selectedSet].sort();
}

/**
 * Check whether a provider is selected for E2E testing.
 * The name parameter is the display name (e.g. "Google", "OpenAI").
 */
export function isProviderSelected(displayName: string): boolean {
	const entry = _providerInventory.find((p: { displayName: string; key: string }) => p.displayName === displayName);
	if (!entry) return false;
	return selectedSet.has(entry.key);
}

/**
 * Check whether ANY provider is selected.
 * Used to decide whether to run auxiliary non-provider tests.
 */
export function hasAnyProviderSelected(): boolean {
	return selectedSet.size > 0;
}
