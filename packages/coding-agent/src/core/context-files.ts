import { existsSync } from "node:fs";
import { join } from "node:path";

export const PRIMARY_CONTEXT_FILE = "JENSEN.md";
export const LEGACY_CONTEXT_FILE = "AGENTS.md";
export const CLAUDE_CONTEXT_FILE = "CLAUDE.md";

export const CONTEXT_FILE_CANDIDATES = [PRIMARY_CONTEXT_FILE, LEGACY_CONTEXT_FILE, CLAUDE_CONTEXT_FILE] as const;

export type ContextFileName = (typeof CONTEXT_FILE_CANDIDATES)[number];

export interface LocatedContextFile {
	filename: ContextFileName;
	path: string;
}

export function findContextFileInDir(dir: string): LocatedContextFile | undefined {
	for (const filename of CONTEXT_FILE_CANDIDATES) {
		const filePath = join(dir, filename);
		if (existsSync(filePath)) {
			return { filename, path: filePath };
		}
	}

	return undefined;
}

export function describeContextFiles(): string {
	return `${PRIMARY_CONTEXT_FILE} (preferred), ${LEGACY_CONTEXT_FILE} (legacy fallback), or ${CLAUDE_CONTEXT_FILE}`;
}

export function isLegacyAgentsContextFile(filename: string): filename is typeof LEGACY_CONTEXT_FILE {
	return filename === LEGACY_CONTEXT_FILE;
}

export function getLegacyAgentsDeprecationWarning(filePath: string): string {
	return `${LEGACY_CONTEXT_FILE} is deprecated. Rename ${filePath} to ${PRIMARY_CONTEXT_FILE}; ${LEGACY_CONTEXT_FILE} remains supported for now as a fallback.`;
}
