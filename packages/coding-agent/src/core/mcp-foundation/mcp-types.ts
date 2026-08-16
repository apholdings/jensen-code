/**
 * MCP Client Foundation — domain types (2.13.0).
 *
 * These are the stable, SDK-agnostic shapes exposed to the rest of Jensen.
 * Nothing here imports the MCP SDK: the SDK is confined to the adapter layer so
 * a protocol/SDK change can be absorbed at the boundary without touching
 * Missions, Scheduler, Assignment, Verification, or future Worker domains.
 */

// =============================================================================
// Server configuration
// =============================================================================

/**
 * A configured stdio MCP server. This is plain, serializable configuration —
 * never an active connection.
 */
export interface McpServerDefinition {
	/** Stable, Jensen-scoped server identifier (must be path/durable-safe when persisted). */
	id: string;
	/** Optional human-readable display name. */
	name?: string;
	/** Executable to spawn. */
	command: string;
	/** Arguments passed to the executable (argv identity preserved for diagnostics). */
	args?: readonly string[];
	/**
	 * Environment variables for the spawned process. Secrets are never logged or
	 * echoed into evidence; only variable NAMES are used for diagnostics.
	 */
	env?: Readonly<Record<string, string>>;
	/** Working directory for the spawned process, if required. */
	cwd?: string;
	/** Timeout for the initialize handshake. Defaults to DEFAULT_MCP_STARTUP_TIMEOUT_MS. */
	startupTimeoutMs?: number;
	/** Default per-request timeout. Defaults to DEFAULT_MCP_REQUEST_TIMEOUT_MS. */
	requestTimeoutMs?: number;
}

// =============================================================================
// Identity / capabilities / connection state
// =============================================================================

/** Server implementation identity reported during initialize. */
export interface McpServerInfo {
	name: string;
	version: string;
}

/**
 * Raw, faithfully-preserved server capabilities. Deliberately kept structural
 * (rather than flattened) so future capability routing can reason about the
 * real negotiated surface.
 */
export type McpServerCapabilities = Record<string, unknown>;

export type McpSessionState = "CONNECTING" | "CONNECTED" | "DISCONNECTING" | "DISCONNECTED" | "FAILED";

export const MCP_SESSION_STATES: readonly McpSessionState[] = [
	"CONNECTING",
	"CONNECTED",
	"DISCONNECTING",
	"DISCONNECTED",
	"FAILED",
];

export function isMcpSessionState(value: unknown): value is McpSessionState {
	return typeof value === "string" && (MCP_SESSION_STATES as readonly string[]).includes(value);
}

/**
 * Which MCP protocol generation a connection actually negotiated. Jensen domains
 * never branch on this for correctness — it exists so diagnostics, evidence, and QA
 * can prove which era a session used without leaking SDK implementation details.
 */
export type McpProtocolEra = "modern" | "legacy" | "unknown";

export interface McpFailure {
	code: string;
	message: string;
}

// =============================================================================
// Tools
// =============================================================================

/** Tool-level annotations exposed by MCP. Preserved, not collapsed. */
export interface McpToolAnnotations {
	title?: string;
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
}

/**
 * A discovered tool. Schemas are preserved verbatim (unknown JSON Schema) so
 * downstream capability routing and model-context construction keep accurate
 * metadata.
 */
export interface McpToolDescriptor {
	name: string;
	description?: string;
	inputSchema?: unknown;
	outputSchema?: unknown;
	annotations?: McpToolAnnotations;
	/** Era-dependent execution metadata, preserved verbatim (e.g. legacy taskSupport). */
	execution?: Record<string, unknown>;
	title?: string;
	/** Additional MCP metadata, preserved verbatim. */
	meta?: Record<string, unknown>;
	/** Owning server, captured for deterministic multi-server routing. */
	serverId: string;
}

/** Preserved MCP result content item. Typed conveniences, not exhaustive flattening. */
export interface McpContentItem {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
	resource?: unknown;
	uri?: string;
	name?: string;
	[key: string]: unknown;
}

// =============================================================================
// Invocation
// =============================================================================

/** Structured invocation request (port input). */
export interface McpToolCall {
	toolName: string;
	arguments: Readonly<Record<string, unknown>>;
	/** Per-request override; defaults to the server's requestTimeoutMs. */
	timeoutMs?: number;
	/** Optional cancellation signal. When aborted, the request converges to CANCELLED. */
	signal?: AbortSignal;
}

export type McpToolResultStatus = "success" | "tool-error" | "timeout" | "cancelled" | "connection-lost" | "failed";

/**
 * The honest terminal outcome of a tool call. Transport failure, protocol
 * failure, server failure, tool execution error, and success are all distinct.
 */
export interface McpToolResult {
	sessionId: string;
	serverId: string;
	toolName: string;
	status: McpToolResultStatus;
	/** True only when the server itself reported an error result. */
	isError: boolean;
	/** Preserved content items (empty when the call failed before a result). */
	content: McpContentItem[];
	/** Preserved structured content, when the server returned it. */
	structuredContent?: unknown;
	/** Machine-readable error code for non-success outcomes. */
	errorCode?: string;
	/** Human-readable failure description for non-success outcomes. */
	errorMessage?: string;
	invokedAtMs: number;
	completedAtMs: number;
	/** Evidence reference, present once recorded into the Evidence Archive. */
	evidenceId?: string;
}

// =============================================================================
// Session / health
// =============================================================================

/** A live session snapshot. */
export interface McpServerSession {
	sessionId: string;
	serverId: string;
	state: McpSessionState;
	identity?: McpServerInfo;
	capabilities?: McpServerCapabilities;
	protocolVersion?: string;
	/** Negotiated protocol generation: "modern" (2026-07-28+) or "legacy" (initialize). */
	protocolEra?: McpProtocolEra;
	instructions?: string;
	connectedAtMs?: number;
	disconnectedAtMs?: number;
	failure?: McpFailure;
	/** Bounded tail of captured stderr diagnostics (secrets never persisted). */
	stderrTail: string[];
	/** Child process pid, retained for liveness diagnostics after close. */
	pid?: number;
	/** True when the server announced a tool-list change since last discovery. */
	toolListChanged: boolean;
}

/** Lightweight, non-mutating health/status query. */
export interface McpSessionHealth {
	sessionId: string;
	serverId: string;
	state: McpSessionState;
	connected: boolean;
	processAlive: boolean;
	pid?: number;
	connectedAtMs?: number;
	failed: boolean;
	failure?: McpFailure;
	capabilitiesKnown: boolean;
	protocolVersion?: string;
	protocolEra?: McpProtocolEra;
}

// =============================================================================
// Evidence
// =============================================================================

export type McpEvidenceStatus = "success" | "tool-error" | "timeout" | "cancelled" | "connection-lost" | "failed";

/**
 * Structured MCP provenance. This is the durable payload stored into the
 * existing Evidence Archive (as kind `tool-result`, source `mcp:<server>:<tool>`)
 * so MCP observations become first-class Jensen evidence — "I queried the real
 * external system and this is what it reported."
 */
export interface McpEvidence {
	kind: "mcp-tool-call";
	version: 1;
	serverId: string;
	/** argv identity for diagnostics (command + args, never env contents). */
	serverCommand?: string;
	sessionId: string;
	toolName: string;
	status: McpEvidenceStatus;
	invokedAtMs: number;
	completedAtMs: number;
	/** Safe argument representation (secret-scrubbed at archive time). */
	arguments?: Readonly<Record<string, unknown>>;
	/** Result summary for success / tool-error (never fabricated on failure). */
	resultSummary?: {
		contentTypes: string[];
		textPreview?: string;
		hasStructuredContent: boolean;
	};
	failure?: McpFailure;
	protocolVersion?: string;
	protocolEra?: McpProtocolEra;
}

// =============================================================================
// Port
// =============================================================================

/**
 * Jensen-facing MCP client port. Implementations wrap the SDK adapter behind
 * these stable operations; consumers never see SDK types.
 */
export interface McpClientPort {
	connect(server: McpServerDefinition): Promise<McpServerSession>;
	disconnect(sessionId: string): Promise<void>;
	listTools(sessionId: string): Promise<McpToolDescriptor[]>;
	callTool(sessionId: string, request: McpToolCall): Promise<McpToolResult>;
	health(sessionId: string): Promise<McpSessionHealth>;
}
