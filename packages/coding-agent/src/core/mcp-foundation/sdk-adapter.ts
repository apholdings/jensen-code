/**
 * MCP Client Foundation — official SDK adapter (2.13.0).
 *
 * This is the ONLY module that imports the MCP TypeScript SDK runtime and
 * transports. It owns a single stdio session: spawn, protocol negotiation,
 * tool discovery, tool invocation, cancellation/timeout, stderr isolation, and
 * clean shutdown. Everything crossing out of this file is Jensen-shaped (see
 * mcp-types.ts).
 *
 * Negotiation policy: `versionNegotiation: { mode: "auto" }` — probe with the
 * modern `server/discover` advertisement first, then fall back to the legacy
 * `initialize` handshake for 2025-era servers. The negotiated era/version are
 * captured and surfaced as observable Jensen session metadata; Jensen domains
 * never branch on them.
 */

import { type CallToolResult, Client, type Tool } from "@modelcontextprotocol/client";
import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/client/stdio";
import { APP_NAME, VERSION } from "../../config.js";
import { classifyMcpConnectError, classifyMcpError, McpClientError } from "./mcp-error.js";
import type {
	McpContentItem,
	McpProtocolEra,
	McpServerDefinition,
	McpServerInfo,
	McpServerSession,
	McpSessionState,
	McpToolCall,
	McpToolDescriptor,
	McpToolResult,
} from "./mcp-types.js";
import { DEFAULT_MCP_REQUEST_TIMEOUT_MS, safeServerCommand } from "./server-config.js";

/** Bounded stderr diagnostics: last N lines, each truncated. */
const STDERR_MAX_LINES = 200;
const STDERR_MAX_LINE_CHARS = 2_000;

/**
 * Bound for the `server/discover` probe under `mode: "auto"`. On stdio a silent
 * server is treated as legacy, so this must be much shorter than the standard
 * request timeout or a spawn-per-invocation CLI would stall against a legacy
 * server that never answers unknown pre-`initialize` requests.
 */
const NEGOTIATION_PROBE_TIMEOUT_MS = 5_000;

export interface McpSdkAdapterOptions {
	sessionId: string;
	serverId: string;
	now?: () => number;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function mapIdentity(serverVersion: { name: string; version: string } | undefined): McpServerInfo | undefined {
	if (!serverVersion) return undefined;
	return { name: serverVersion.name, version: serverVersion.version };
}

function mapContent(content: readonly unknown[]): McpContentItem[] {
	return content.map((item) => {
		if (typeof item !== "object" || item === null) {
			return { type: "unknown", value: item } as McpContentItem;
		}
		const record = item as Record<string, unknown>;
		return { ...record } as McpContentItem;
	});
}

function mapTool(tool: Tool, serverId: string): McpToolDescriptor {
	return {
		name: tool.name,
		description: tool.description,
		inputSchema: tool.inputSchema,
		outputSchema: tool.outputSchema,
		annotations: tool.annotations,
		execution: tool.execution,
		title: tool.title,
		meta: tool._meta,
		serverId,
	};
}

/** Normalize the SDK era string into the stable Jensen vocabulary. */
function normalizeEra(era: "modern" | "legacy" | undefined): McpProtocolEra {
	if (era === "modern" || era === "legacy") return era;
	return "unknown";
}

/** Extract a human-facing message from a tool-error result's content. */
function toolErrorMessage(content: McpContentItem[]): string | undefined {
	for (const item of content) {
		if (item.type === "text" && typeof item.text === "string" && item.text.trim().length > 0) {
			return item.text.trim();
		}
	}
	return undefined;
}

export class McpSdkAdapter {
	private readonly sessionId: string;
	private readonly serverId: string;
	private readonly now: () => number;
	private definition?: McpServerDefinition;
	private client?: Client;
	private state: McpSessionState = "DISCONNECTED";
	private failure?: { code: string; message: string };
	private connectedAtMs?: number;
	private disconnectedAtMs?: number;
	private pid?: number;
	private protocolVersion?: string;
	private protocolEra?: McpProtocolEra;
	private identity?: McpServerInfo;
	private capabilities?: Record<string, unknown>;
	private instructions?: string;
	private toolListChanged = false;
	private stderrPending = "";
	private stderrLines: string[] = [];

	constructor(options: McpSdkAdapterOptions) {
		this.sessionId = options.sessionId;
		this.serverId = options.serverId;
		this.now = options.now ?? Date.now;
	}

	get isConnected(): boolean {
		return this.state === "CONNECTED";
	}

	async connect(definition: McpServerDefinition): Promise<void> {
		if (this.client) throw new McpClientError("MCP_PROTOCOL_ERROR", "adapter already connected");
		this.definition = definition;
		this.state = "CONNECTING";
		this.failure = undefined;

		const serverParams: StdioServerParameters = {
			command: definition.command,
			args: definition.args ? [...definition.args] : [],
			env: definition.env ? { ...definition.env } : undefined,
			cwd: definition.cwd,
			stderr: "pipe",
		};

		const transport = new StdioClientTransport(serverParams);

		// Capture stderr separately BEFORE start() so early diagnostics are not lost.
		const stderrStream = transport.stderr;
		if (stderrStream) {
			stderrStream.on("data", (chunk: Buffer) => this.captureStderr(chunk));
		}

		const client = new Client(
			{ name: APP_NAME, version: VERSION },
			{
				capabilities: {},
				versionNegotiation: {
					mode: "auto",
					probe: { timeoutMs: NEGOTIATION_PROBE_TIMEOUT_MS },
				},
				listChanged: {
					tools: {
						autoRefresh: true,
						debounceMs: 0,
						onChanged: (error) => this.onToolsChanged(error),
					},
				},
			},
		);

		client.onclose = () => this.onTransportClosed();
		client.onerror = (error) => {
			// Non-fatal out-of-band diagnostics are recorded but do not mutate state.
			this.failure = this.failure ?? { code: "MCP_PROTOCOL_ERROR", message: messageOf(error) };
		};

		this.client = client;

		try {
			await client.connect(transport, { timeout: definition.startupTimeoutMs });
		} catch (error) {
			const code = classifyMcpConnectError(error);
			this.state = "FAILED";
			this.failure = { code, message: messageOf(error) };
			await this.forceCleanup();
			throw new McpClientError(code, `failed to connect to MCP server "${definition.id}": ${messageOf(error)}`, {
				serverId: definition.id,
				sessionId: this.sessionId,
				detail: safeServerCommand(definition),
				cause: error,
			});
		}

		this.pid = transport.pid ?? undefined;
		this.connectedAtMs = this.now();
		this.state = "CONNECTED";
		this.protocolVersion = client.getNegotiatedProtocolVersion() ?? undefined;
		this.protocolEra = normalizeEra(client.getProtocolEra());
		this.identity = mapIdentity(client.getServerVersion());
		this.capabilities = client.getServerCapabilities() as Record<string, unknown> | undefined;
		this.instructions = client.getInstructions();
	}

	async disconnect(): Promise<void> {
		if (this.state === "DISCONNECTED" || this.state === "DISCONNECTING") return;
		const client = this.client;
		if (!client) {
			this.state = "DISCONNECTED";
			return;
		}

		this.state = "DISCONNECTING";
		try {
			await client.close();
		} catch (error) {
			this.state = "FAILED";
			this.failure = { code: "MCP_SHUTDOWN_FAILED", message: messageOf(error) };
			throw new McpClientError(
				"MCP_SHUTDOWN_FAILED",
				`failed to disconnect from MCP server "${this.serverId}": ${messageOf(error)}`,
				{
					serverId: this.serverId,
					sessionId: this.sessionId,
					cause: error,
				},
			);
		}

		// The transport close event normally fires synchronously; normalize defensively.
		if (this.state === "DISCONNECTING") {
			this.state = "DISCONNECTED";
			this.disconnectedAtMs = this.now();
		}
	}

	async listTools(): Promise<McpToolDescriptor[]> {
		this.assertConnected("listTools");
		const client = this.client!;

		// v2 auto-aggregates every page when called without a cursor.
		const page = await client.listTools();
		this.toolListChanged = false;

		const descriptors = page.tools.map((tool) => mapTool(tool, this.serverId));
		descriptors.sort((a, b) => a.name.localeCompare(b.name) || a.serverId.localeCompare(b.serverId));
		return descriptors;
	}

	async callTool(call: McpToolCall): Promise<McpToolResult> {
		this.assertConnected("callTool");
		const client = this.client!;
		const definition = this.definition!;
		const invokedAtMs = this.now();
		const timeoutMs = call.timeoutMs ?? definition.requestTimeoutMs ?? DEFAULT_MCP_REQUEST_TIMEOUT_MS;

		try {
			const result = await client.callTool(
				{ name: call.toolName, arguments: { ...call.arguments } },
				{ timeout: timeoutMs, signal: call.signal },
			);
			const completedAtMs = this.now();
			return this.toToolResult(call.toolName, result, invokedAtMs, completedAtMs);
		} catch (error) {
			const completedAtMs = this.now();
			// The SDK wraps an explicit client abort into a RequestTimeout-style error on
			// its shared cancel path, so detect the user's signal directly to keep
			// cancellation distinct from a genuine request timeout.
			const code = call.signal?.aborted
				? "MCP_REQUEST_CANCELLED"
				: classifyMcpError(error, { toolName: call.toolName });
			return {
				sessionId: this.sessionId,
				serverId: this.serverId,
				toolName: call.toolName,
				status: this.resultStatusForCode(code),
				isError: false,
				content: [],
				errorCode: code,
				errorMessage: messageOf(error),
				invokedAtMs,
				completedAtMs,
			};
		}
	}

	snapshot(): McpServerSession {
		return {
			sessionId: this.sessionId,
			serverId: this.serverId,
			state: this.state,
			identity: this.identity,
			capabilities: this.capabilities,
			protocolVersion: this.protocolVersion,
			protocolEra: this.protocolEra,
			instructions: this.instructions,
			connectedAtMs: this.connectedAtMs,
			disconnectedAtMs: this.disconnectedAtMs,
			failure: this.failure,
			stderrTail: this.stderrLines.slice(-STDERR_MAX_LINES),
			pid: this.pid,
			toolListChanged: this.toolListChanged,
		};
	}

	processAlive(): boolean {
		if (this.pid === undefined) return false;
		try {
			process.kill(this.pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	private toToolResult(
		toolName: string,
		raw: CallToolResult | { toolResult: unknown },
		invokedAtMs: number,
		completedAtMs: number,
	): McpToolResult {
		const content = "content" in raw && Array.isArray(raw.content) ? mapContent(raw.content) : [];
		const structuredContent = "structuredContent" in raw ? raw.structuredContent : undefined;
		const isError = "isError" in raw ? raw.isError === true : false;
		const status = isError ? "tool-error" : "success";
		const errorMessage = isError ? (toolErrorMessage(content) ?? "tool reported an error") : undefined;

		return {
			sessionId: this.sessionId,
			serverId: this.serverId,
			toolName,
			status,
			isError,
			content,
			structuredContent,
			errorCode: isError ? "MCP_TOOL_CALL_FAILED" : undefined,
			errorMessage,
			invokedAtMs,
			completedAtMs,
		};
	}

	private resultStatusForCode(code: string): McpToolResult["status"] {
		switch (code) {
			case "MCP_REQUEST_TIMEOUT":
				return "timeout";
			case "MCP_REQUEST_CANCELLED":
				return "cancelled";
			case "MCP_CONNECTION_LOST":
				return "connection-lost";
			case "MCP_TOOL_NOT_FOUND":
				return "failed";
			default:
				return "failed";
		}
	}

	private assertConnected(operation: string): void {
		if (this.state !== "CONNECTED" || !this.client) {
			const code: "MCP_SESSION_INVALID" | "MCP_SESSION_NOT_FOUND" =
				this.state === "DISCONNECTED" ? "MCP_SESSION_NOT_FOUND" : "MCP_SESSION_INVALID";
			throw new McpClientError(
				code,
				`cannot ${operation}: MCP session "${this.sessionId}" is not connected (${this.state})`,
				{
					serverId: this.serverId,
					sessionId: this.sessionId,
				},
			);
		}
	}

	private onToolsChanged(error: Error | null): void {
		this.toolListChanged = true;
		if (error) {
			this.failure = this.failure ?? {
				code: "MCP_PROTOCOL_ERROR",
				message: `tool list change failed: ${messageOf(error)}`,
			};
		}
	}

	private onTransportClosed(): void {
		if (this.state === "DISCONNECTING") {
			this.state = "DISCONNECTED";
			this.disconnectedAtMs = this.now();
			return;
		}
		this.state = "FAILED";
		this.failure = this.failure ?? { code: "MCP_CONNECTION_LOST", message: "MCP connection closed" };
		this.disconnectedAtMs = this.now();
	}

	private async forceCleanup(): Promise<void> {
		try {
			await this.client?.close();
		} catch {
			// Best-effort during failure paths; the failure is already authoritative.
		}
	}

	private captureStderr(chunk: Buffer): void {
		const text = chunk.toString("utf8");
		this.stderrPending += text;
		const parts = this.stderrPending.split("\n");
		this.stderrPending = parts.pop() ?? "";
		for (const line of parts) {
			this.stderrLines.push(line.slice(0, STDERR_MAX_LINE_CHARS));
		}
		if (this.stderrLines.length > STDERR_MAX_LINES) {
			this.stderrLines = this.stderrLines.slice(-STDERR_MAX_LINES);
		}
	}
}
