export type CavemanLevel = "off" | "lite" | "full" | "ultra";
export type CavemanAction = CavemanLevel | "status";

export const CAVEMAN_COMMAND_USAGE = "Usage: /caveman [lite|full|ultra|off|status]";

export interface CavemanCommandTarget {
	cavemanLevel: CavemanLevel;
	setCavemanLevel(level: CavemanLevel): void;
}

const CAVEMAN_COMMAND_NAME = "/caveman";

/**
 * Parse a caveman command from input text.
 * Returns the action or undefined if not a caveman command.
 *
 * Handles:
 * - `/caveman` alone → defaults to "full"
 * - `/caveman <level>` where level is lite|full|ultra|off|status
 * - Natural language phrases via parseCavemanNaturalLanguage
 */
export function parseCavemanCommand(text: string): CavemanAction | undefined {
	const parts = text.trim().split(/\s+/);
	if (parts[0]?.toLowerCase() !== CAVEMAN_COMMAND_NAME) {
		return undefined;
	}

	const action = parts[1]?.toLowerCase();
	if (action === "lite" || action === "full" || action === "ultra" || action === "off" || action === "status") {
		return action;
	}

	// `/caveman` with no argument defaults to "full"
	if (parts.length === 1) {
		return "full";
	}

	return undefined;
}

/**
 * Parse natural language phrases for caveman activation/deactivation.
 * Uses WORD-BOUNDARY matching to avoid false positives.
 *
 * Activation phrases (maps to "full"): "caveman mode", "talk like caveman", "be brief",
 * "less tokens", "me caveman", "caveman style", "make it briefer", "shorter please"
 *
 * Deactivation phrases (maps to "off"): "normal mode", "stop caveman"
 *
 * @returns "full" for activation, "off" for deactivation, undefined if no match
 */
export function parseCavemanNaturalLanguage(text: string): CavemanLevel | undefined {
	const lowerText = text.toLowerCase();

	// Activation phrases - must match full phrase with word boundaries
	const activationPhrases = [
		/\bcaveman mode\b/i,
		/\btalk like caveman\b/i,
		/\bbe brief\b/i,
		/\bless tokens\b/i,
		/\bme caveman\b/i,
		/\bcaveman style\b/i,
		/\bmake it briefer\b/i,
		/\bshorter please\b/i,
	];

	for (const pattern of activationPhrases) {
		if (pattern.test(lowerText)) {
			return "full";
		}
	}

	// Deactivation phrases - must match full phrase with word boundaries
	const deactivationPhrases = [/\bnormal mode\b/i, /\bstop caveman\b/i];

	for (const pattern of deactivationPhrases) {
		if (pattern.test(lowerText)) {
			return "off";
		}
	}

	return undefined;
}

/**
 * Run a caveman command on the target session.
 * Returns a status string describing the result.
 */
export function runCavemanCommand(target: CavemanCommandTarget, action: CavemanAction): string {
	if (action === "status") {
		const level = target.cavemanLevel;
		if (level === "off") {
			return "Caveman compression is disabled for this session only (runtime-only). Normal assistant prose is active.";
		}
		if (level === "lite") {
			return "Caveman Lite compression is active for this session only (runtime-only). Paragraph-level summaries.";
		}
		if (level === "full") {
			return "Caveman Full compression is active for this session only (runtime-only). Sentence-level summaries.";
		}
		if (level === "ultra") {
			return "Caveman Ultra compression is active for this session only (runtime-only). Keyword-level responses.";
		}
		return "Unknown caveman level.";
	}

	if (action === "off") {
		target.setCavemanLevel("off");
		return "Disabled Caveman compression for this session only (runtime-only). Normal assistant prose is active.";
	}

	if (action === "lite") {
		target.setCavemanLevel("lite");
		return "Caveman Lite compression activated for this session only (runtime-only). Paragraph-level summaries.";
	}

	if (action === "full") {
		target.setCavemanLevel("full");
		return "Caveman Full compression activated for this session only (runtime-only). Sentence-level summaries.";
	}

	if (action === "ultra") {
		target.setCavemanLevel("ultra");
		return "Caveman Ultra compression activated for this session only (runtime-only). Keyword-level responses.";
	}

	return CAVEMAN_COMMAND_USAGE;
}
