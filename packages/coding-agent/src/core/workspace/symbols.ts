/**
 * Symbol extraction via a deterministic heuristic line-based parser, plus LSP
 * document-symbol integration. The heuristic parser provides lexical symbol
 * boundaries for common languages without requiring a language server; when an
 * LSP server is present, its document symbols are the preferred evidence source.
 */

export interface ExtractedSymbol {
	name: string;
	kind: string;
	languageId: string;
	startLine: number;
	startCharacter: number;
	endLine: number;
	endCharacter: number;
	qualifiedName?: string;
	containerSymbolId?: string;
	signatureHash?: string;
}

export interface LspSymbolInput {
	name: string;
	kind: string;
	startLine: number;
	startCharacter: number;
	endLine: number;
	endCharacter: number;
	containerName?: string;
	languageId: string;
}

const KIND_BY_KEYWORD: Record<string, string> = {
	function: "function",
	fn: "function",
	func: "function",
	def: "function",
	class: "class",
	struct: "class",
	interface: "interface",
	trait: "interface",
	enum: "enum",
	constructor: "constructor",
	"public class": "class",
	"private class": "class",
	"internal class": "class",
	"public interface": "interface",
	"public enum": "enum",
	"record struct": "class",
	record: "class",
	macro: "macro",
	module: "module",
	namespace: "namespace",
	package: "package",
	type: "type",
	protocol: "interface",
	extension: "extension",
};

function extractNameFromDef(line: string): string {
	// Strip leading decorators/annotations and visibility.
	const cleaned = line
		.replace(/^[@#].*/, "")
		.replace(/^[ \t]+/, "")
		.replace(
			/^(async |public |private |protected |internal |static |final |abstract |export |default |virtual |override )+/g,
			"",
		);
	const m = cleaned.match(
		/(?:function|func|fn|def|class|struct|interface|trait|enum|record|type|protocol|extension|namespace|module|package)\s+([A-Za-z_$][\w$]*)/,
	);
	if (m) return m[1];
	const m2 = cleaned.match(/^([A-Za-z_$][\w$]*)\s*\(/);
	if (m2) return m2[1];
	return "";
}

/**
 * Heuristic symbol extraction for a supported language. Returns symbols ordered
 * by start line. Non-authoritative; used to bound chunking and to provide
 * parser-only symbols when no LSP server is present.
 */
export function extractSymbolsHeuristic(languageId: string, content: string): ExtractedSymbol[] {
	const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
	const symbols: ExtractedSymbol[] = [];
	const indentStack: Array<{ indent: number; name: string; kind: string; startLine: number }> = [];

	const keywordRe =
		/\b(function|func|fn|def|class|struct|interface|trait|enum|record|type|protocol|extension|namespace|module|package)\b/;
	// Only treat as a definition if the line declares a top-level-ish symbol.
	const defRe =
		/^\s*(?:async\s+|public\s+|private\s+|protected\s+|internal\s+|static\s+|final\s+|abstract\s+|export\s+|default\s+|virtual\s+|override\s+)*\s*(function|func|fn|def|class|struct|interface|trait|enum|record|type|protocol|extension|namespace|module|package)\b/;

	const braceLanguages = new Set(["typescript", "javascript", "csharp", "java", "go", "rust", "css"]);

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const indent = raw.length - raw.trimStart().length;
		if (defRe.test(raw)) {
			const name = extractNameFromDef(raw);
			if (name) {
				const kind =
					KIND_BY_KEYWORD[
						raw
							.trim()
							.match(
								/\b(function|func|fn|def|class|struct|interface|trait|enum|record|type|protocol|extension|namespace|module|package)\b/,
							)?.[1] ?? ""
					] ?? "other";
				// Pop stack entries deeper than current indent.
				while (indentStack.length && indentStack[indentStack.length - 1].indent >= indent) {
					const top = indentStack.pop() as { indent: number; name: string; kind: string; startLine: number };
					const existing = symbols.find((s) => s.name === top.name && s.startLine === top.startLine);
					if (existing) existing.endLine = Math.max(existing.endLine, i);
				}
				indentStack.push({ indent, name, kind, startLine: i });
				symbols.push({
					name,
					kind,
					languageId,
					startLine: i,
					startCharacter: raw.indexOf(name),
					endLine: i + 1,
					endCharacter: 0,
					qualifiedName: name,
				});
			}
		} else if (braceLanguages.has(languageId) && indentStack.length && /\{\s*$/.test(raw)) {
			// Extend the current top symbol's end to the closing brace later.
			void indent;
			void keywordRe;
		}
	}

	// Close brace matching: extend symbol endLine to matching closing brace.
	if (braceLanguages.has(languageId)) {
		for (const sym of symbols) {
			let depth = 0;
			let end = sym.endLine;
			for (let j = sym.startLine; j < lines.length; j++) {
				const line = lines[j];
				const opens = (line.match(/{/g) || []).length;
				const closes = (line.match(/}/g) || []).length;
				depth += opens - closes;
				if (depth <= 0 && closes > 0) {
					end = j + 1;
					break;
				}
				if (depth > 0) end = j + 1;
			}
			sym.endLine = Math.max(sym.endLine, end);
		}
	}

	return symbols;
}

/** Map string symbols for markdown (headers) and structured config. */
export function markdownSections(content: string): ExtractedSymbol[] {
	const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
	const out: ExtractedSymbol[] = [];
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(/^(#{1,6})\s+(.+)/);
		if (m) {
			out.push({
				name: m[2].trim(),
				kind: "heading",
				languageId: "markdown",
				startLine: i,
				startCharacter: lines[i].indexOf(m[2].trim()),
				endLine: Math.min(i + 40, lines.length - 1),
				endCharacter: 0,
				qualifiedName: m[2].trim(),
			});
		}
	}
	return out;
}

/** Merge heuristic symbols with LSP symbols, preferring LSP when present. */
export function mergeSymbols(heuristic: ExtractedSymbol[], lsp: LspSymbolInput[] | undefined): ExtractedSymbol[] {
	if (!lsp || lsp.length === 0) return heuristic;
	const mapped: ExtractedSymbol[] = lsp.map((s) => ({
		name: s.name,
		kind: s.kind,
		languageId: s.languageId,
		startLine: s.startLine,
		startCharacter: s.startCharacter,
		endLine: s.endLine,
		endCharacter: s.endCharacter,
		qualifiedName: s.containerName ? `${s.containerName}.${s.name}` : s.name,
	}));
	return mapped.length > 0 ? mapped : heuristic;
}
