/**
 * Minimal, self-contained Language Server Protocol types used by Jensen's
 * native LSP subsystem. Deliberately a local subset — no external LSP
 * dependency — sufficient for initialize handshake, document sync, semantic
 * requests, diagnostics and rename.
 */

export interface LspPosition {
	line: number;
	character: number;
}

export interface LspRange {
	start: LspPosition;
	end: LspPosition;
}

export interface LspLocation {
	uri: string;
	range: LspRange;
}

export interface LspLocationLink {
	targetUri: string;
	targetRange: LspRange;
	targetSelectionRange?: LspRange;
	originSelectionRange?: LspRange;
}

export interface LspTextIdentifier {
	uri: string;
}

export interface LspTextDocumentPositionParams {
	textDocument: LspTextIdentifier;
	position: LspPosition;
}

export interface LspTextEdit {
	range: LspRange;
	newText: string;
}

export interface LspVersionedTextDocumentIdentifier extends LspTextIdentifier {
	version: number | null;
}

export interface LspTextDocumentEdit {
	textDocument: LspVersionedTextDocumentIdentifier;
	edits: LspTextEdit[];
}

/** WorkspaceEdit (subset): document edits, optional resource ops not supported. */
export interface LspWorkspaceEdit {
	changes?: Record<string, LspTextEdit[]>;
	documentChanges?: (LspTextDocumentEdit | { resourceChanges: unknown })[];
}

/** LSP diagnostic severity. */
export enum LspDiagnosticSeverity {
	Error = 1,
	Warning = 2,
	Information = 3,
	Hint = 4,
}

export interface LspDiagnostic {
	range: LspRange;
	severity?: LspDiagnosticSeverity;
	code?: string | number;
	source?: string;
	message: string;
}

export interface LspPublishDiagnosticsParams {
	uri: string;
	version?: number;
	diagnostics: LspDiagnostic[];
}

export interface LspHover {
	contents:
		| string
		| { kind: "markdown" | "plaintext"; value: string }
		| { language: string; value: string }
		| Array<string | { language: string; value: string }>;
	range?: LspRange;
}

export interface LspSymbolInformation {
	name: string;
	kind: number;
	location: LspLocation;
	containerName?: string;
}

export interface LspDocumentSymbol {
	name: string;
	detail?: string;
	kind: number;
	range: LspRange;
	selectionRange: LspRange;
	children?: LspDocumentSymbol[];
}

export interface LspServerCapabilities {
	positionEncoding?: string;
	textDocumentSync?: number | { openClose?: boolean; change?: number; save?: boolean };
	definitionProvider?: boolean | { workDoneProgress?: boolean };
	referencesProvider?: boolean;
	implementationProvider?: boolean | { workDoneProgress?: boolean };
	hoverProvider?: boolean;
	documentSymbolProvider?: boolean | { workDoneProgress?: boolean };
	workspaceSymbolProvider?: boolean;
	renameProvider?: boolean | { prepareProvider?: boolean };
	diagnosticsProvider?: boolean | { interFileDependencies?: boolean; workspaceDiagnostics?: boolean };
}

export interface LspInitializeResult {
	capabilities: LspServerCapabilities;
	serverInfo?: { name?: string; version?: string };
}

export interface LspMessage {
	jsonrpc: "2.0";
}

export interface LspRequestMessage<T = unknown> extends LspMessage {
	id: number | string;
	method: string;
	params?: T;
}

export interface LspNotificationMessage<T = unknown> extends LspMessage {
	method: string;
	params?: T;
}

export interface LspResponseMessage<T = unknown> extends LspMessage {
	id: number | string | null;
	result?: T;
	error?: {
		code: number;
		message: string;
		data?: unknown;
	};
}

/** Jensen's addressable, workspace-relative semantic location result. */
export interface LspLocationResult {
	workspaceRelativePath: string;
	startLine: number;
	startCharacter: number;
	endLine: number;
	endCharacter: number;
	symbol?: string;
	languageId: string;
	serverId: string;
}

export interface LspDiagnosticResult {
	workspaceRelativePath: string;
	range: LspRange;
	severity: LspDiagnosticSeverity | undefined;
	code?: string | number;
	source?: string;
	message: string;
}

export interface LspServerIdentity {
	serverId: string;
	languageId: string;
	executable: string;
	workspaceRoot: string;
	processIdentity: string;
	initializedAt: string;
	capabilitiesHash: string;
}

export interface LspServerHealth {
	serverId: string;
	state: "starting" | "running" | "degraded" | "stopped" | "crash_loop";
	alive: boolean;
	capabilities?: LspServerCapabilities;
	lastError?: string;
}

/** Product-level docs/tools shared error codes. */
export const LSP_ERROR_UNAVAILABLE = "LSP_SERVER_UNAVAILABLE";
export const LSP_ERROR_NOT_CONFIGURED = "LSP_SERVER_NOT_CONFIGURED";
