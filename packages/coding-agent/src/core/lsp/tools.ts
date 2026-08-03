import { readFile } from "node:fs/promises";
import type { AgentTool, AgentToolResult, ToolEffects } from "@apholdings/jensen-agent-core";
import { Type } from "@sinclair/typebox";
import { uriToPath } from "./client.js";
import { getDiagnosticRows } from "./diagnostics.js";
import { reportAllServers } from "./discovery.js";
import { applyTextEdits, extractEditsByPath, sha256Content } from "./rename.js";
import type { LspRuntime } from "./runtime.js";
import type { LspLocationResult } from "./types.js";

const readEffects: ToolEffects = {
	readsWorkspace: true,
	writesWorkspace: false,
	createsFiles: false,
	deletesFiles: false,
	executesProcesses: false,
	startsPersistentProcesses: false,
	accessesNetwork: false,
	mutatesGit: false,
	mutatesExternalState: false,
	handlesSecrets: false,
	potentiallyDestructive: false,
	requiresExclusiveWorkspaceLease: false,
	parallelSafe: true,
	scopes: [{ kind: "workspace" }],
};

const renamePreviewEffects: ToolEffects = { ...readEffects, parallelSafe: true };

const fileParams = Type.Object(
	{
		file: Type.String({ description: "Workspace-relative file path" }),
		line: Type.Optional(Type.Integer({ default: 0, description: "0-based line" })),
		character: Type.Optional(Type.Integer({ default: 0, description: "0-based UTF-16 character" })),
		symbol: Type.Optional(Type.String({ description: "Symbol query (for workspace symbols)" })),
		language: Type.Optional(Type.String({ description: "Language override" })),
		limit: Type.Optional(Type.Integer({ default: 50, description: "Max results (bounded)" })),
	},
	{ additionalProperties: false },
);

/** Permissive tool input (superset of every LSP tool's schema fields). */
export interface LspToolInput {
	file: string;
	line?: number;
	character?: number;
	symbol?: string;
	language?: string;
	limit?: number;
	newName?: string;
}

function capLimit(limit: number | undefined): number {
	const n = limit ?? 50;
	return Math.max(1, Math.min(n, 500));
}

function locationResults(
	locations: Array<{
		uri: string;
		startLine: number;
		startCharacter: number;
		endLine: number;
		endCharacter: number;
		symbol?: string;
	}>,
	serverId: string,
	languageId: string,
	workspaceRoot: string,
	limit: number,
): { results: LspLocationResult[]; truncated: boolean } {
	const seen = new Set<string>();
	const results: LspLocationResult[] = [];
	for (const loc of locations) {
		const rel = toWorkspaceRel(loc.uri, workspaceRoot);
		const key = `${rel}:${loc.startLine}:${loc.startCharacter}`;
		if (seen.has(key)) continue;
		seen.add(key);
		results.push({
			workspaceRelativePath: rel,
			startLine: loc.startLine,
			startCharacter: loc.startCharacter,
			endLine: loc.endLine,
			endCharacter: loc.endCharacter,
			symbol: loc.symbol,
			languageId,
			serverId,
		});
		if (results.length >= limit) break;
	}
	return { results, truncated: results.length >= limit };
}

function toWorkspaceRel(uri: string, workspaceRoot: string): string {
	const raw = uriToPath(uri);
	if (!raw) return uri;
	const rel = raw.replace(workspaceRoot.replace(/[\\/]+/g, "/"), "").replace(/^[/\\]/, "");
	return rel || raw;
}

function toLoc(l: {
	uri: string;
	range: { start: { line: number; character: number }; end: { line: number; character: number } };
}): {
	uri: string;
	startLine: number;
	startCharacter: number;
	endLine: number;
	endCharacter: number;
} {
	return {
		uri: l.uri,
		startLine: l.range.start.line,
		startCharacter: l.range.start.character,
		endLine: l.range.end.line,
		endCharacter: l.range.end.character,
	};
}

/** Create the nine LSP tools bound to a runtime. */
export function createLspTools(runtime: LspRuntime): AgentTool<any>[] {
	const mk = <TSchema>(
		name: string,
		description: string,
		parameters: TSchema,
		effects: ToolEffects,
		execute: (c: string, p: LspToolInput, signal?: AbortSignal) => Promise<AgentToolResult<any> | string>,
	): AgentTool<any> => ({
		name,
		label: name,
		description,
		parameters,
		effects,
		execute: async (toolCallId, params, signal) => {
			if (typeof execute === "function") {
				const r = await execute(toolCallId, params as never as LspToolInput, signal);
				if (typeof r === "string") return { content: [{ type: "text", text: r }], details: {} };
				return r;
			}
			return { content: [{ type: "text", text: "noop" }], details: {} };
		},
	});

	const unavailable = (lang: string | undefined, reason: string): string =>
		`LSP server unavailable for ${lang ?? "file"}: ${reason}`;

	const definition = mk(
		"lsp_definition",
		"Resolve the definition locations for a symbol at a file position. Read-only.",
		fileParams,
		readEffects,
		async (_c, p) => {
			const limit = capLimit(p.limit);
			const sd = await runtime.serverForFile(p.file, p.language ?? null);
			if (!sd.client || !sd.uri) return unavailable(p.language, sd.unavailableReason ?? "no server");
			const locations = await sd.client.definition({ uri: sd.uri, line: p.line ?? 0, character: p.character ?? 0 });
			const { results, truncated } = locationResults(
				locations.map((l) => toLoc(l)),
				sd.serverId ?? "?",
				sd.languageId ?? "?",
				runtime.workspaceRoot,
				limit,
			);
			return {
				content: [{ type: "text", text: formatLocations(results, truncated) }],
				details: { locations: results, truncated },
			};
		},
	);

	const references = mk(
		"lsp_references",
		"Resolve reference locations for a symbol at a file position. Read-only.",
		fileParams,
		readEffects,
		async (_c, p) => {
			const limit = capLimit(p.limit);
			const sd = await runtime.serverForFile(p.file, p.language ?? null);
			if (!sd.client || !sd.uri) return unavailable(p.language, sd.unavailableReason ?? "no server");
			const locations = await sd.client.references({ uri: sd.uri, line: p.line ?? 0, character: p.character ?? 0 });
			const { results, truncated } = locationResults(
				locations.map((l) => toLoc(l)),
				sd.serverId ?? "?",
				sd.languageId ?? "?",
				runtime.workspaceRoot,
				limit,
			);
			return {
				content: [{ type: "text", text: formatLocations(results, truncated) }],
				details: { locations: results, truncated },
			};
		},
	);

	const implementations = mk(
		"lsp_implementations",
		"Resolve implementation locations for a symbol at a file position. Read-only.",
		fileParams,
		readEffects,
		async (_c, p) => {
			const limit = capLimit(p.limit);
			const sd = await runtime.serverForFile(p.file, p.language ?? null);
			if (!sd.client || !sd.uri) return unavailable(p.language, sd.unavailableReason ?? "no server");
			const locations = await sd.client.implementations({
				uri: sd.uri,
				line: p.line ?? 0,
				character: p.character ?? 0,
			});
			const { results, truncated } = locationResults(
				locations.map((l) => toLoc(l)),
				sd.serverId ?? "?",
				sd.languageId ?? "?",
				runtime.workspaceRoot,
				limit,
			);
			return {
				content: [{ type: "text", text: formatLocations(results, truncated) }],
				details: { locations: results, truncated },
			};
		},
	);

	const hover = mk(
		"lsp_hover",
		"Return hover documentation for a symbol at a file position. Read-only.",
		fileParams,
		readEffects,
		async (_c, p) => {
			const sd = await runtime.serverForFile(p.file, p.language ?? null);
			if (!sd.client || !sd.uri) return unavailable(p.language, sd.unavailableReason ?? "no server");
			const h = await sd.client.hover({ uri: sd.uri, line: p.line ?? 0, character: p.character ?? 0 });
			if (!h) return { content: [{ type: "text", text: "No hover content." }], details: { hover: null } };
			return { content: [{ type: "text", text: hoverText(h.contents) }], details: { hover: h } };
		},
	);

	const diagnosticsTool = mk(
		"lsp_diagnostics",
		"Return current LSP diagnostics for a file. Read-only; never authortive for execution.",
		fileParams,
		readEffects,
		async (_c, p) => {
			const limit = capLimit(p.limit);
			const sd = await runtime.serverForFile(p.file, p.language ?? null);
			if (!sd.client || !sd.uri) return unavailable(p.language, sd.unavailableReason ?? "no server");
			const paramsList = runtime.manager.diagnosticsForUri(sd.uri);
			const rows = paramsList
				.flatMap((params) => getDiagnosticRows(params, runtime.workspaceRoot, sd.serverId ?? "?", limit))
				.slice(0, limit);
			const text =
				rows.length === 0
					? "No diagnostics."
					: rows
							.map(
								(d) =>
									`${d.workspaceRelativePath}:${d.range.start.line}:${d.range.start.character} [${severityName(d.severity)}] ${d.message}`,
							)
							.join("\n");
			return { content: [{ type: "text", text }], details: { diagnostics: rows, truncated: rows.length >= limit } };
		},
	);

	const documentSymbols = mk(
		"lsp_document_symbols",
		"List symbols declared in a document. Read-only.",
		Type.Object({ file: Type.String(), limit: Type.Optional(Type.Integer({ default: 200 })) }),
		readEffects,
		async (_c, p) => {
			const limit = capLimit((p as unknown as { limit?: number }).limit);
			const sd = await runtime.serverForFile(p.file, p.language ?? null);
			if (!sd.client || !sd.uri) return unavailable(p.language, sd.unavailableReason ?? "no server");
			const symbols = await sd.client.documentSymbols(sd.uri);
			const names = symbolNames(symbols, limit);
			return {
				content: [{ type: "text", text: names.join("\n") || "No symbols." }],
				details: { symbols: symbols.slice(0, limit) },
			};
		},
	);

	const workspaceSymbols = mk(
		"lsp_workspace_symbols",
		"Query workspace symbols by name. Read-only.",
		Type.Object({ symbol: Type.String(), limit: Type.Optional(Type.Integer({ default: 100 })) }),
		readEffects,
		async (_c, p) => {
			const limit = capLimit((p as unknown as { limit?: number }).limit);
			const sd = await runtime.serverForFile(p.file ?? "", p.language ?? null);
			const query = (p as unknown as { symbol?: string }).symbol ?? "";
			if (!sd.client) return unavailable(undefined, sd.unavailableReason ?? "no server");
			const symbols = await sd.client.workspaceSymbols(query);
			const names = symbols
				.slice(0, limit)
				.map((s) => `${s.name} @ ${toWorkspaceRel(s.location.uri, runtime.workspaceRoot)}`);
			return {
				content: [{ type: "text", text: names.join("\n") || "No matching symbols." }],
				details: { symbols: symbols.slice(0, limit) },
			};
		},
	);

	const renamePreview = mk(
		"lsp_rename_preview",
		"Produce a read-only preview of a rename. Zero physical mutation; applying uses a transaction.",
		Type.Object({
			file: Type.String(),
			line: Type.Optional(Type.Integer({ default: 0 })),
			character: Type.Optional(Type.Integer({ default: 0 })),
			newName: Type.String(),
		}),
		renamePreviewEffects,
		async (_c, p) => {
			const sd = await runtime.serverForFile(p.file, p.language ?? null);
			if (!sd.client || !sd.uri) return unavailable(p.language, sd.unavailableReason ?? "no server");
			const prepare = await sd.client.prepareRename({ uri: sd.uri, line: p.line ?? 0, character: p.character ?? 0 });
			if (!prepare) return "Rename not applicable at this position.";
			const newName = p.newName ?? "";
			if (!newName) return "newName is required.";
			const edit = await sd.client.rename({ uri: sd.uri, line: p.line ?? 0, character: p.character ?? 0, newName });
			if (!edit) return "Rename produced no edits.";
			const { byPath, conflicts, unsupported } = extractEditsByPath(edit, runtime.workspaceRoot);
			if (conflicts.length) return `Rename preview rejected: ${conflicts.join("; ")}`;
			const affected: Array<{ file: string; edits: number; preview: string }> = [];
			for (const [abs, edits] of byPath) {
				const content = await readFile(abs, "utf-8");
				const applied = applyTextEdits(content, edits);
				affected.push({
					file: abs.replace(runtime.workspaceRoot, "").replace(/^[/\\]/, ""),
					edits: edits.length,
					preview: applied.newContent.slice(0, 400),
				});
			}
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								symbol: p.newName,
								affectedFiles: affected,
								totalEditCount: affected.reduce((n, f) => n + f.edits, 0),
								conflicts,
								unsupportedResourceOperations: unsupported,
								zeroMutation: true,
							},
							null,
							2,
						),
					},
				],
				details: { affected, conflicts, unsupported, zeroMutation: true },
			};
		},
	);

	const status = mk(
		"lsp_status",
		"Report LSP server discovery and health status. Read-only.",
		Type.Object({ filter: Type.Optional(Type.String()) }),
		readEffects,
		async () => {
			const rows: string[] = [];
			rows.push("language server discovery:");
			for (const r of await reportAllServers()) {
				rows.push(`  ${r.languageId}: ${r.candidate} ${r.available ? "available" : "unavailable"}`);
			}
			rows.push("active LSP servers:");
			for (const s of runtime.manager.listServers()) {
				const h = runtime.manager.health(s.languageId);
				rows.push(`  ${s.serverId}: ${s.state} (${h?.lastError ?? "ok"})`);
			}
			return rows.join("\n");
		},
	);

	return [
		definition,
		references,
		implementations,
		hover,
		diagnosticsTool,
		documentSymbols,
		workspaceSymbols,
		renamePreview,
		status,
	];
}

function formatLocations(results: LspLocationResult[], truncated: boolean): string {
	const lines = results.map(
		(r) =>
			`${r.workspaceRelativePath}:${r.startLine}:${r.startCharacter}-${r.endLine}:${r.endCharacter}${r.symbol ? ` (${r.symbol})` : ""}`,
	);
	if (truncated) lines.push("...(truncated)");
	return lines.join("\n") || "No results.";
}

function severityName(s: number | undefined): string {
	return s === 1 ? "ERROR" : s === 2 ? "WARNING" : s === 3 ? "INFO" : s === 4 ? "HINT" : "?";
}

function hoverText(contents: unknown): string {
	if (typeof contents === "string") return contents;
	if (Array.isArray(contents)) return contents.map((c) => (typeof c === "string" ? c : (c.value ?? ""))).join("\n\n");
	if (contents && typeof contents === "object") {
		const v = (contents as { value?: string }).value ?? "";
		return v;
	}
	return "";
}

function symbolNames(symbols: unknown, limit: number): string[] {
	const out: string[] = [];
	const walk = (s: unknown) => {
		if (out.length >= limit) return;
		if (Array.isArray(s)) {
			for (const item of s) walk(item);
			return;
		}
		if (s && typeof s === "object") {
			const name = (s as { name?: string }).name;
			if (name) out.push(name);
			const children = (s as { children?: unknown }).children;
			if (children) walk(children);
		}
	};
	walk(symbols);
	return out;
}

export { toWorkspaceRel, sha256Content };
