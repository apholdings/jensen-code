/**
 * Authoritative provider inventory for E2E tests.
 *
 * Shared by the credential preflight and Vitest E2E tests.
 * Single source of truth for provider names, credential requirements,
 * and selection parsing — prevents diverging inventories.
 *
 * Provider keys (lowercase): used in JENSEN_E2E_PROVIDERS env var.
 * Display names: used in diagnostic output and test describe blocks.
 */

/**
 * @typedef {Object} ProviderEntry
 * @property {string} key — lowercase canonical key (e.g. "openai")
 * @property {string} displayName — human-readable name (e.g. "OpenAI")
 * @property {Array<Array<{name: string, optional?: boolean, requiresCompanion?: string}>>} credentialSets — AND'd sets where each set is OR'd internally
 */

/** @type {ProviderEntry[]} */
export const PROVIDER_INVENTORY = [
	{
		key: "google",
		displayName: "Google",
		credentialSets: [[{ name: "GEMINI_API_KEY" }]],
	},
	{
		key: "openai",
		displayName: "OpenAI",
		credentialSets: [[{ name: "OPENAI_API_KEY" }]],
	},
	{
		key: "anthropic",
		displayName: "Anthropic",
		credentialSets: [[{ name: "ANTHROPIC_API_KEY" }]],
	},
	{
		key: "xai",
		displayName: "xAI",
		credentialSets: [[{ name: "XAI_API_KEY" }]],
	},
	{
		key: "groq",
		displayName: "Groq",
		credentialSets: [[{ name: "GROQ_API_KEY" }]],
	},
	{
		key: "cerebras",
		displayName: "Cerebras",
		credentialSets: [[{ name: "CEREBRAS_API_KEY" }]],
	},
	{
		key: "zai",
		displayName: "zAI",
		credentialSets: [[{ name: "ZAI_API_KEY" }]],
	},
	{
		key: "bedrock",
		displayName: "Amazon Bedrock",
		credentialSets: [
			[{ name: "AWS_PROFILE" }],
			[
				{ name: "AWS_ACCESS_KEY_ID", optional: false },
				{ name: "AWS_SECRET_ACCESS_KEY", optional: false },
			],
			[{ name: "AWS_BEARER_TOKEN_BEDROCK" }],
		],
	},
];

/** Map from provider key to ProviderEntry for fast lookup. */
export const PROVIDER_MAP = Object.fromEntries(
	PROVIDER_INVENTORY.map((p) => [p.key, p]),
);

/** Set of all valid provider keys. */
export const VALID_PROVIDER_KEYS = new Set(PROVIDER_INVENTORY.map((p) => p.key));

/**
 * Parse and normalize JENSEN_E2E_PROVIDERS.
 *
 * Accepts:
 *   "all"       → all 8 providers
 *   "openai"    → single provider
 *   "openai,anthropic" → multiple providers
 *   " OpenAI,anthropic,OPENAI " → normalized, deduplicated, sorted
 *
 * Returns { selected: string[], error?: string }
 *   selected — sorted lowercase array of provider keys
 *   error    — set when input is empty or contains unknown providers
 */
export function parseProviderSelection(raw) {
	if (!raw || raw.trim().length === 0) {
		return {
			selected: [],
			error: 'Set JENSEN_E2E_PROVIDERS to a comma-separated provider list or "all".',
		};
	}

	const trimmed = raw.trim().toLowerCase();
	if (trimmed === "all") {
		return { selected: [...VALID_PROVIDER_KEYS].sort() };
	}

	const parts = trimmed.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
	const seen = new Set();
	const selected = [];
	const unknown = [];

	for (const part of parts) {
		if (VALID_PROVIDER_KEYS.has(part)) {
			if (!seen.has(part)) {
				seen.add(part);
				selected.push(part);
			}
		} else {
			unknown.push(part);
		}
	}

	if (unknown.length > 0) {
		const supported = [...VALID_PROVIDER_KEYS].sort().join(", ");
		return {
			selected: selected.sort(),
			error: `Unknown provider(s): ${unknown.join(", ")}. Supported: ${supported}`,
		};
	}

	return { selected: selected.sort() };
}
