/**
 * MCP Client Foundation — evidence integration (2.13.0).
 *
 * MCP tool invocations become first-class Jensen evidence through the existing
 * L3 Evidence Archive (`EvidenceArchive`). The durable payload is an
 * `McpEvidence` JSON document stored under kind `tool-result` with a
 * deterministic, content-addressed id — so `retrieve_evidence` can rehydrate
 * "I queried the real external system and this is what it reported."
 *
 * Secret hygiene: environment contents are never embedded; the archive's
 * conservative redaction additionally scrubs credential-shaped values before
 * persistence.
 */

import type { EvidenceArchive } from "../context-runtime/evidence-archive.js";
import type { McpEvidence, McpServerSession, McpToolResult } from "./mcp-types.js";

/** Deterministic evidence source identity for a (server, tool) pair. */
export function mcpEvidenceSource(serverId: string, toolName: string): string {
	return `mcp:${serverId}:${toolName}`;
}

const TEXT_PREVIEW_MAX_CHARS = 2_000;

function firstText(result: McpToolResult): string | undefined {
	for (const item of result.content) {
		if (item.type === "text" && typeof item.text === "string") return item.text;
	}
	return undefined;
}

export interface BuildMcpEvidenceInput {
	result: McpToolResult;
	/** argv identity for diagnostics; env contents are never included. */
	serverCommand: string;
	session: McpServerSession;
	/** Safe argument representation (redacted at archive time if needed). */
	arguments?: Readonly<Record<string, unknown>>;
}

/**
 * Build the durable MCP evidence payload. On failure paths this deliberately
 * carries failure metadata (never a success claim); on success it carries a
 * bounded result summary rather than unbounded raw content.
 */
export function buildMcpEvidence(input: BuildMcpEvidenceInput): McpEvidence {
	const { result, serverCommand, session, arguments: args } = input;
	const successLike = result.status === "success" || result.status === "tool-error";

	const evidence: McpEvidence = {
		kind: "mcp-tool-call",
		version: 1,
		serverId: result.serverId,
		serverCommand,
		sessionId: result.sessionId,
		toolName: result.toolName,
		status: result.status,
		invokedAtMs: result.invokedAtMs,
		completedAtMs: result.completedAtMs,
		arguments: args,
		protocolVersion: session.protocolVersion,
	};

	if (successLike) {
		const text = firstText(result);
		evidence.resultSummary = {
			contentTypes: result.content.map((item) => item.type),
			textPreview: text ? text.slice(0, TEXT_PREVIEW_MAX_CHARS) : undefined,
			hasStructuredContent: result.structuredContent !== undefined,
		};
	}

	if (result.status !== "success") {
		evidence.failure = {
			code: result.errorCode ?? "MCP_TOOL_CALL_FAILED",
			message: result.errorMessage ?? result.status,
		};
	}

	return evidence;
}

/**
 * Persist MCP evidence into the existing Evidence Archive and return its
 * deterministic evidence id. The archive redacts and hashes the payload, so the
 * same invocation always resolves to the same reference.
 */
export async function recordMcpEvidence(archive: EvidenceArchive, evidence: McpEvidence): Promise<string> {
	return archive.store({
		kind: "tool-result",
		source: mcpEvidenceSource(evidence.serverId, evidence.toolName),
		content: JSON.stringify(evidence),
	});
}
