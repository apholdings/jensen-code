import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import nodePath from "node:path";

/**
 * Language detection and language-server discovery. Capability-driven: never
 * assumes a server is installed. Candidate precedence is deterministic and
 * documented; the first executable found on PATH wins.
 */

export interface ServerCandidate {
	/** Pragmatic server command (as installed on PATH). */
	executable: string;
	args?: string[];
}

export interface LanguageServerSpec {
	languageId: string;
	candidates: ServerCandidate[];
	extensions: string[];
}

const WINDOWS_EXTS = new Set([".cmd", ".bat", ".exe", ".ps1", ".com"]);

async function resolveOnPath(command: string): Promise<string | null> {
	try {
		const resolved = await new Promise<string>((resolve, reject) => {
			execFile("which", [command], { timeout: 3000 }, (err, stdout) => {
				if (err) reject(err);
				else resolve(stdout.trim().split("\n")[0]);
			});
		});
		if (!resolved) return null;
		await access(resolved);
		return resolved;
	} catch {
		return null;
	}
}

/**
 * Default language-server candidates with documented precedence. Order within
 * `candidates` is the precedence order. These are conventions, not
 * installations — discovery reports which are actually available.
 */
export const DEFAULT_LANGUAGE_SERVERS: LanguageServerSpec[] = [
	{
		languageId: "typescript",
		candidates: [{ executable: "typescript-language-server", args: ["--stdio"] }],
		extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
	},
	{
		languageId: "python",
		candidates: [
			{ executable: "basedpyright-langserver", args: ["--stdio"] },
			{ executable: "pyright-langserver", args: ["--stdio"] },
			{ executable: "pyright", args: ["--stdio"] },
		],
		extensions: [".py", ".pyw"],
	},
	{
		languageId: "csharp",
		candidates: [
			{ executable: "OmniSharp", args: ["-lsp"] },
			{ executable: "csharp-ls", args: [] },
		],
		extensions: [".cs", ".csx"],
	},
	{
		languageId: "java",
		candidates: [{ executable: "jdtls", args: [] }],
		extensions: [".java"],
	},
	{
		languageId: "go",
		candidates: [{ executable: "gopls", args: ["serve"] }],
		extensions: [".go"],
	},
	{
		languageId: "rust",
		candidates: [{ executable: "rust-analyzer", args: [] }],
		extensions: [".rs"],
	},
];

export interface LanguageDetectionResult {
	languageId: string | null;
	matchedExtension: string | null;
}

export function detectLanguage(
	filePath: string,
	specs: LanguageServerSpec[] = DEFAULT_LANGUAGE_SERVERS,
): LanguageDetectionResult {
	const ext = nodePath.extname(filePath).toLowerCase();
	if (!ext) return { languageId: null, matchedExtension: null };
	for (const spec of specs) {
		if (spec.extensions.includes(ext)) {
			return { languageId: spec.languageId, matchedExtension: ext };
		}
	}
	return { languageId: null, matchedExtension: ext };
}

export interface ServerResolution {
	languageId: string;
	executable: string | null;
	resolvedPath: string | null;
	args: string[];
	reason?: string;
}

/**
 * Deterministically resolve the best available server candidate for a
 * language. Returns `executable: null` when none is installed.
 */
export async function resolveServer(
	languageId: string,
	specs: LanguageServerSpec[] = DEFAULT_LANGUAGE_SERVERS,
): Promise<ServerResolution> {
	const spec = specs.find((s) => s.languageId === languageId);
	if (!spec) {
		return {
			languageId,
			executable: null,
			resolvedPath: null,
			args: [],
			reason: `unsupported_language:${languageId}`,
		};
	}
	for (const candidate of spec.candidates) {
		const resolved = await resolveOnPath(candidate.executable);
		if (resolved) {
			return {
				languageId,
				executable: candidate.executable,
				resolvedPath: resolved,
				args: candidate.args ?? [],
			};
		}
	}
	return {
		languageId,
		executable: null,
		resolvedPath: null,
		args: spec.candidates[0]?.args ?? [],
		reason: `server_not_installed:${languageId}`,
	};
}

export interface LanguageServerStatusRow {
	languageId: string;
	candidate: string;
	available: boolean;
	resolvedPath: string | null;
	reason?: string;
}

/** Report availability for all configured languages (diagnostics). */
export async function reportAllServers(
	specs: LanguageServerSpec[] = DEFAULT_LANGUAGE_SERVERS,
): Promise<LanguageServerStatusRow[]> {
	const rows: LanguageServerStatusRow[] = [];
	for (const spec of specs) {
		for (const cand of spec.candidates) {
			const resolved = await resolveOnPath(cand.executable);
			rows.push({
				languageId: spec.languageId,
				candidate: cand.executable,
				available: resolved !== null,
				resolvedPath: resolved,
				reason: resolved ? undefined : "server_not_installed",
			});
		}
	}
	return rows;
}

export async function commandExists(command: string): Promise<boolean> {
	return (await resolveOnPath(command)) !== null;
}

export function isWindowsPathExecutable(): boolean {
	const isWin = process.platform === "win32";
	void WINDOWS_EXTS;
	return isWin;
}
