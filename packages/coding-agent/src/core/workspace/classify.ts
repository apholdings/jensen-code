/**
 * File classification and sensitive-file policy.
 */

export type Classification =
	| "source"
	| "test"
	| "documentation"
	| "configuration"
	| "schema"
	| "migration"
	| "build"
	| "generated"
	| "vendor"
	| "binary"
	| "secret-sensitive"
	| "lockfile"
	| "unknown";

const LANGUAGE_BY_EXT: Record<string, string> = {
	".ts": "typescript",
	".tsx": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	".js": "javascript",
	".jsx": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".py": "python",
	".pyi": "python",
	".cs": "csharp",
	".java": "java",
	".go": "go",
	".rs": "rust",
	".json": "json",
	".yaml": "yaml",
	".yml": "yaml",
	".toml": "toml",
	".md": "markdown",
	".mdx": "markdown",
	".sh": "shell",
	".bash": "shell",
	".zsh": "shell",
	".ps1": "powershell",
	".psm1": "powershell",
	".sql": "sql",
	".css": "css",
	".scss": "scss",
	".less": "less",
	".html": "html",
	".xml": "xml",
	".proto": "proto",
	".graphql": "graphql",
	".gql": "graphql",
	".txt": "text",
	".rst": "markdown",
};

const SENSITIVE_FILE_PATTERNS: RegExp[] = [
	/(^|[/\\])\.env([^/\\]*)?$/i,
	/(^|[/\\])\.pem$/i,
	/(^|[/\\])\.key$/i,
	/(^|[/\\])\.p12$/i,
	/(^|[/\\])\.pfx$/i,
	/(^|[/\\])id_rsa($|[.])/i,
	/(^|[/\\])id_ed25519($|[.])/i,
	/(^|[/\\])credentials\.json$/i,
	/(^|[/\\])service-account[^/\\]*\.json$/i,
	/(^|[/\\])\.netrc$/i,
	/(^|[/\\])\.npmrc$/i,
	/(^|[/\\])\.htpasswd$/i,
	/(^|[/\\])secrets\.[^/\\]*$/i,
	/(^|[/\\])\.ssh[/\\]/i,
	/(^|[/\\])awscredentials$/i,
	/(^|[/\\])\.aws[/\\](credentials|config)$/i,
];

const BINARY_EXT: Set<string> = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".ico",
	".svg",
	".pdf",
	".zip",
	".gz",
	".tar",
	".7z",
	".exe",
	".dll",
	".so",
	".dylib",
	".wasm",
	".woff",
	".woff2",
	".ttf",
	".otf",
	".mp3",
	".mp4",
	".avi",
	".mov",
	".pickle",
	".bin",
	".class",
	".o",
	".a",
	".jar",
	".node",
	".map",
]);

export interface ClassificationResult {
	classification: Classification;
	languageId?: string;
	isBinary: boolean;
	isGenerated: boolean;
	isSensitive: boolean;
	ignoredByVendor?: boolean;
	ignoredByCache?: boolean;
}

const GENERATED_PATTERNS: RegExp[] = [
	/(^|[/\\])(dist|build|out|coverage|\.next|\.nuxt|\.svelte-kit|\.turbo)([/\\]|$)/i,
	/(^|[/\\])build[/\\]/i,
	/\.(min|bundle|chunk)\.(js|css)$/i,
	/(^|[/\\])generated[/\\]/i,
	/(^|[/\\])\.cache[/\\]/i,
];

const VENDOR_PATTERNS: RegExp[] = [
	/(^|[/\\])node_modules([/\\]|$)/i,
	/(^|[/\\])vendor([/\\]|$)/i,
	/(^|[/\\])\.venv([/\\]|$)/i,
	/(^|[/\\])venv([/\\]|$)/i,
	/(^|[/\\])site-packages([/\\]|$)/i,
	/(^|[/\\])\.git([/\\]|$)/i,
	/(^|[/\\])Pods([/\\]|$)/i,
	/(^|[/\\])(Cargo|go|pip|pnpm|npm|yarn)\.lock$/i,
];

export function classifyPath(workspaceRelativePath: string): ClassificationResult {
	const rel = workspaceRelativePath.replace(/\\/g, "/");
	const lower = rel.toLowerCase();
	const ext = extOf(rel);

	const isSensitive = SENSITIVE_FILE_PATTERNS.some((re) => re.test(rel));
	const isBinaryExt = BINARY_EXT.has(ext);
	const isGenerated = GENERATED_PATTERNS.some((re) => re.test(rel));
	const isVendor = VENDOR_PATTERNS.some((re) => re.test(rel));
	const isCache = /([/\\])\.?(_|node_modules|__pycache__|\.git)([/\\]|$)/.test(rel);
	const isLockfile =
		/(^|[/\\])(package-lock|pnpm-lock|yarn\.lock|Cargo\.lock|go\.sum|poetry\.lock|Pipfile\.lock)(\.|$)/i.test(rel);

	let classification: Classification = "unknown";
	const segs = rel.split("/");
	const _base = segs[segs.length - 1] ?? "";

	if (isSensitive) {
		classification = "secret-sensitive";
	} else if (/\.(test|spec)\./.test(lower) || /(^|\/)(test|tests|__tests__|spec|specs)(\/|$)/i.test(rel)) {
		classification = "test";
	} else if (isLockfile) {
		classification = "lockfile";
	} else if (isVendor) {
		classification = "vendor";
	} else if (isGenerated) {
		classification = "generated";
	} else if (/(^|\/)(docs|documentation)(\/|$)/i.test(rel) || /\.(md|mdx|rst|txt)$/i.test(lower)) {
		classification = "documentation";
	} else if (/\.(json|ya?ml|toml|ini|conf|cfg|properties)$/i.test(lower)) {
		classification = "configuration";
	} else if (/\.(proto|graphql|gql)$/i.test(lower)) {
		classification = "schema";
	} else if (/(^|[/\\])migrations?([/\\]|$)/i.test(rel)) {
		classification = "migration";
	} else if (/\.(d\.ts)$/i.test(lower)) {
		classification = "source";
	} else if (LANGUAGE_BY_EXT[ext]) {
		classification = /\.(css|scss|less|html|xml|js|jsx|mjs|cjs|ts|tsx|mts|cts)$/i.test(lower)
			? "source"
			: LANGUAGE_BY_EXT[ext] === "markdown"
				? "documentation"
				: "source";
	}

	if (classification === "unknown") {
		if (isBinaryExt) classification = "binary";
		else if (LANGUAGE_BY_EXT[ext]) classification = "source";
		else classification = "unknown";
	}

	const languageId = LANGUAGE_BY_EXT[ext];

	return {
		classification,
		languageId,
		isBinary: isBinaryExt,
		isGenerated,
		isSensitive,
		ignoredByVendor: isVendor,
		ignoredByCache: isCache,
	};
}

function extOf(rel: string): string {
	const base = rel.split("/").pop() ?? "";
	const idx = base.lastIndexOf(".");
	if (idx <= 0) return "";
	const ext = base.slice(idx);
	// handle .d.ts
	if (base.toLowerCase().endsWith(".d.ts")) return ".d.ts";
	return ext.toLowerCase();
}
