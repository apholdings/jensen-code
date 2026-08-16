/**
 * MCP Client Foundation — client service (2.13.0).
 *
 * Implements the Jensen-facing `McpClientPort` over the SDK adapter and
 * integrates tool calls with the Evidence Archive. Sessions are process-lifetime
 * objects: no fake cross-process persistence is implied.
 */

import { type EvidenceArchive, InMemoryEvidenceArchive } from "../context-runtime/evidence-archive.js";
import { McpClientError } from "./mcp-error.js";
import { buildMcpEvidence, recordMcpEvidence } from "./mcp-evidence.js";
import type {
	McpServerDefinition,
	McpServerSession,
	McpSessionHealth,
	McpToolCall,
	McpToolDescriptor,
	McpToolResult,
} from "./mcp-types.js";
import { McpSdkAdapter } from "./sdk-adapter.js";
import { safeServerCommand } from "./server-config.js";

let sessionCounter = 0;

export interface McpClientServiceOptions {
	evidenceArchive?: EvidenceArchive;
	now?: () => number;
}

interface SessionEntry {
	adapter: McpSdkAdapter;
	definition: McpServerDefinition;
}

export class McpClientService {
	private readonly evidenceArchive: EvidenceArchive;
	private readonly now: () => number;
	private readonly sessions = new Map<string, SessionEntry>();

	constructor(options: McpClientServiceOptions = {}) {
		this.evidenceArchive = options.evidenceArchive ?? new InMemoryEvidenceArchive();
		this.now = options.now ?? Date.now;
	}

	async connect(server: McpServerDefinition): Promise<McpServerSession> {
		sessionCounter += 1;
		const sessionId = `mcp-${sessionCounter}-${server.id}`;
		const adapter = new McpSdkAdapter({ sessionId, serverId: server.id, now: this.now });

		await adapter.connect(server);

		this.sessions.set(sessionId, { adapter, definition: server });
		return adapter.snapshot();
	}

	async disconnect(sessionId: string): Promise<void> {
		const entry = this.requireSession(sessionId);
		await entry.adapter.disconnect();
		// Keep the (now-disconnected) adapter so disconnect remains idempotent and
		// health() can still report the terminal state of a known session.
	}

	async listTools(sessionId: string): Promise<McpToolDescriptor[]> {
		return this.requireSession(sessionId).adapter.listTools();
	}

	async callTool(sessionId: string, request: McpToolCall): Promise<McpToolResult> {
		const entry = this.requireSession(sessionId);
		if (typeof request.toolName !== "string" || request.toolName.length === 0) {
			throw new McpClientError("MCP_INVALID_TOOL_CALL", "toolName must be a non-empty string", {
				serverId: entry.definition.id,
				sessionId,
			});
		}
		if (request.arguments === null || typeof request.arguments !== "object" || Array.isArray(request.arguments)) {
			throw new McpClientError("MCP_INVALID_TOOL_CALL", "arguments must be a JSON object", {
				serverId: entry.definition.id,
				sessionId,
				toolName: request.toolName,
			});
		}

		const result = await entry.adapter.callTool(request);

		// Evidence is first-class but best-effort: never let archive failure turn a
		// real tool outcome into an error, and never fabricate success evidence.
		try {
			const evidence = buildMcpEvidence({
				result,
				serverCommand: safeServerCommand(entry.definition),
				session: entry.adapter.snapshot(),
				arguments: request.arguments,
			});
			result.evidenceId = await recordMcpEvidence(this.evidenceArchive, evidence);
		} catch {
			result.evidenceId = undefined;
		}

		return result;
	}

	async health(sessionId: string): Promise<McpSessionHealth> {
		const entry = this.requireSession(sessionId);
		const snapshot = entry.adapter.snapshot();
		return {
			sessionId: snapshot.sessionId,
			serverId: snapshot.serverId,
			state: snapshot.state,
			connected: snapshot.state === "CONNECTED",
			processAlive: entry.adapter.processAlive(),
			pid: snapshot.pid,
			connectedAtMs: snapshot.connectedAtMs,
			failed: snapshot.state === "FAILED",
			failure: snapshot.failure,
			capabilitiesKnown: snapshot.capabilities !== undefined,
			protocolVersion: snapshot.protocolVersion,
			protocolEra: snapshot.protocolEra,
		};
	}

	/** Snapshot of a known session (used by CLI inspect). */
	getSession(sessionId: string): McpServerSession {
		return this.requireSession(sessionId).adapter.snapshot();
	}

	private requireSession(sessionId: string): SessionEntry {
		const entry = this.sessions.get(sessionId);
		if (!entry) {
			throw new McpClientError("MCP_SESSION_NOT_FOUND", `no MCP session with id "${sessionId}"`, { sessionId });
		}
		return entry;
	}
}
