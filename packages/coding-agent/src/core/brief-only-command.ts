export type BriefOnlyCommandAction = "on" | "off" | "status";

export const BRIEF_ONLY_COMMAND_NAME = "/brief";
export const BRIEF_ONLY_COMMAND_USAGE = "Usage: /brief <on|off|status>";

export interface BriefOnlyCommandTarget {
	briefOnly: boolean;
	setBriefOnly(enabled: boolean): void;
}

export function parseBriefOnlyCommand(text: string): BriefOnlyCommandAction | undefined {
	const parts = text.trim().split(/\s+/);
	if (parts[0]?.toLowerCase() !== BRIEF_ONLY_COMMAND_NAME) {
		return undefined;
	}

	const action = parts[1]?.toLowerCase();
	if (action === "on" || action === "off" || action === "status") {
		return action;
	}

	return undefined;
}

export function runBriefOnlyCommand(target: BriefOnlyCommandTarget, action: BriefOnlyCommandAction): string {
	if (action === "status") {
		return target.briefOnly
			? "Brief-only mode is enabled for this session only (runtime-only). Ordinary assistant prose is suppressed; tool, error, and security-relevant visibility remains visible."
			: "Brief-only mode is disabled for this session only (runtime-only). Normal assistant prose is active.";
	}

	if (action === "on") {
		target.setBriefOnly(true);
		return "Enabled brief-only mode for this session only (runtime-only). Ordinary assistant prose will be suppressed; tool, error, and security-relevant visibility remains visible.";
	}

	target.setBriefOnly(false);
	return "Disabled brief-only mode for this session only (runtime-only). Normal assistant prose is active.";
}
