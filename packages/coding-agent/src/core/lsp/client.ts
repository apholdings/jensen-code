import type { JsonRpcClient } from "./jsonrpc.js";
import type {
	LspDiagnostic,
	LspDocumentSymbol,
	LspHover,
	LspLocation,
	LspLocationLink,
	LspPublishDiagnosticsParams,
	LspServerCapabilities,
	LspSymbolInformation,
	LspWorkspaceEdit,
} from "./types.js";

/**
 * A single managed LSP server connection: initialize handshake, document
 * synchronization (full-document sync), semantic requests, rename and
 * diagnostics delivery.
 *
 * Health/authority: this client issues requests but NEVER treats server
 * responses as trusted instructions. All request results are read-only
 * semantic data.
 */

export interface LspClientOptions {
	rpc: JsonRpcClient;
	rootUri: string;
	workspaceRoot: string;
	onDiagnostics?: (params: LspPublishDiagnosticsParams) => void;
}

export function toFileUri(absPath: string): string {
	const normalized = absPath.replace(/\\/g, "/");
	if (normalized.startsWith("/")) return `file://${encodeURI(normalized)}`;
	// Windows drive path
	return `file:///${normalized}`;
}

export function uriToPath(uri: string): string | null {
	if (!uri.startsWith("file://")) return null;
	const rest = uri.slice("file://".length);
	const raw = decodeURIComponent(rest);
	if (raw.startsWith("/")) return raw;
	return raw.replace(/^\//, "").replace(/\//g, "\\");
}

export class LspClient {
	private rpc: JsonRpcClient;
	readonly rootUri: string;
	readonly workspaceRoot: string;
	private onDiagnostics?: (p: LspPublishDiagnosticsParams) => void;
	private capabilities: LspServerCapabilities | null = null;
	private initialized = false;
	private version = 0;
	private openUris = new Set<string>();

	constructor(opts: LspClientOptions) {
		this.rpc = opts.rpc;
		this.rootUri = opts.rootUri;
		this.workspaceRoot = opts.workspaceRoot;
		this.onDiagnostics = opts.onDiagnostics;
		this.rpc.setNotificationHandler((n) => {
			if (n.method === "textDocument/publishDiagnostics") {
				this.onDiagnostics?.(n.params as LspPublishDiagnosticsParams);
			}
		});
	}

	async initialize(): Promise<LspServerCapabilities> {
		const result = (await this.rpc.request("initialize", {
			processId: process.pid,
			rootUri: this.rootUri,
			capabilities: {},
			clientInfo: { name: "jensen", version: "1.4.0" },
		})) as { capabilities: LspServerCapabilities };
		this.capabilities = result.capabilities;
		this.rpc.notify("initialized", {});
		this.initialized = true;
		return this.capabilities;
	}

	getCapabilities(): LspServerCapabilities | null {
		return this.capabilities;
	}

	/** Open a document with full-document sync. */
	async openDocument(uri: string, text: string): Promise<void> {
		if (!this.openUris.has(uri)) {
			const v = ++this.version;
			this.rpc.notify("textDocument/didOpen", {
				textDocument: { uri, languageId: inferLanguageId(uri), version: v, text },
			});
			this.openUris.add(uri);
			return;
		}
		await this.changeDocument(uri, text);
	}

	/** Full-document change (sync mode 1 = Full). */
	async changeDocument(uri: string, text: string): Promise<void> {
		const v = ++this.version;
		this.rpc.notify("textDocument/didChange", {
			textDocument: { uri, version: v },
			contentChanges: [{ text }],
		});
	}

	async closeDocument(uri: string): Promise<void> {
		if (this.openUris.has(uri)) {
			this.rpc.notify("textDocument/didClose", { textDocument: { uri } });
			this.openUris.delete(uri);
		}
	}

	async definition(params: { uri: string; line: number; character: number }): Promise<LspLocation[]> {
		return normalizeLocations(await this.rpc.request("textDocument/definition", toPositionParams(params)));
	}

	async references(params: { uri: string; line: number; character: number }): Promise<LspLocation[]> {
		return normalizeLocations(
			await this.rpc.request("textDocument/references", {
				...toPositionParams(params),
				context: { includeDeclaration: true },
			}),
		);
	}

	async implementations(params: { uri: string; line: number; character: number }): Promise<LspLocation[]> {
		return normalizeLocations(await this.rpc.request("textDocument/implementation", toPositionParams(params)));
	}

	async hover(params: { uri: string; line: number; character: number }): Promise<LspHover | null> {
		return (await this.rpc.request("textDocument/hover", toPositionParams(params))) as LspHover | null;
	}

	async documentSymbols(uri: string): Promise<LspDocumentSymbol[] | LspSymbolInformation[]> {
		return (await this.rpc.request("textDocument/documentSymbol", { textDocument: { uri } })) as
			| LspDocumentSymbol[]
			| LspSymbolInformation[];
	}

	async workspaceSymbols(query: string): Promise<LspSymbolInformation[]> {
		return normalizeSymbols(await this.rpc.request("workspace/symbol", { query }));
	}

	async prepareRename(params: { uri: string; line: number; character: number }): Promise<{ range: unknown } | null> {
		return (await this.rpc.request("textDocument/prepareRename", toPositionParams(params))) as {
			range: unknown;
		} | null;
	}

	async rename(params: {
		uri: string;
		line: number;
		character: number;
		newName: string;
	}): Promise<LspWorkspaceEdit | null> {
		return (await this.rpc.request("textDocument/rename", {
			...toPositionParams(params),
			newName: params.newName,
		})) as LspWorkspaceEdit | null;
	}

	async shutdown(): Promise<void> {
		if (!this.initialized) return;
		try {
			await this.rpc.request("shutdown", null, 5000);
		} catch {
			// best-effort
		}
		this.rpc.notify("exit", null);
	}

	dispose(): void {
		this.rpc.dispose();
	}

	rejectAllPending(reason: string): void {
		this.rpc.rejectAllPending(reason);
	}

	diagnosticStderr(): string {
		return this.rpc.getDiagnosticStderr();
	}
}

function toPositionParams(params: { uri: string; line: number; character: number }): {
	textDocument: { uri: string };
	position: { line: number; character: number };
} {
	return { textDocument: { uri: params.uri }, position: { line: params.line, character: params.character } };
}

function normalizeLocations(value: unknown): LspLocation[] {
	if (!value) return [];
	if (Array.isArray(value)) {
		const out: LspLocation[] = [];
		for (const item of value) {
			if (isLocationLink(item)) out.push({ uri: item.targetUri, range: item.targetRange });
			else if (isLocation(item)) out.push(item);
		}
		return out;
	}
	if (isLocation(value)) return [value];
	return [];
}

function normalizeSymbols(value: unknown): LspSymbolInformation[] {
	if (!Array.isArray(value)) return [];
	return value.filter((v) => v && typeof v === "object" && "name" in v && "location" in v) as LspSymbolInformation[];
}

function isLocationLink(v: unknown): v is LspLocationLink {
	return !!v && typeof v === "object" && typeof (v as { targetUri?: unknown }).targetUri === "string";
}

function isLocation(v: unknown): v is LspLocation {
	return !!v && typeof v === "object" && typeof (v as { uri?: unknown }).uri === "string" && "range" in (v as object);
}

function inferLanguageId(uri: string): string {
	const path = uri.endsWith(".ts")
		? "typescript"
		: uri.endsWith(".py")
			? "python"
			: uri.endsWith(".cs")
				? "csharp"
				: uri.endsWith(".java")
					? "java"
					: uri.endsWith(".go")
						? "go"
						: uri.endsWith(".rs")
							? "rust"
							: uri.endsWith(".js")
								? "javascript"
								: uri.endsWith(".jsx")
									? "javascriptreact"
									: uri.endsWith(".tsx")
										? "typescriptreact"
										: "plaintext";
	return path;
}

export type { LspDiagnostic };
