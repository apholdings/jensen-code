/**
 * MCP Client Foundation — public surface (2.13.0).
 */

export { McpClientService, type McpClientServiceOptions } from "./mcp-client-service.js";
export {
	classifyMcpConnectError,
	classifyMcpError,
	McpClientError,
	type McpErrorCode,
	type McpErrorContext,
} from "./mcp-error.js";
export { type BuildMcpEvidenceInput, buildMcpEvidence, mcpEvidenceSource, recordMcpEvidence } from "./mcp-evidence.js";
export {
	isMcpSessionState,
	MCP_SESSION_STATES,
	type McpClientPort,
	type McpContentItem,
	type McpEvidence,
	type McpEvidenceStatus,
	type McpFailure,
	type McpServerCapabilities,
	type McpServerDefinition,
	type McpServerInfo,
	type McpServerSession,
	type McpSessionHealth,
	type McpSessionState,
	type McpToolAnnotations,
	type McpToolCall,
	type McpToolDescriptor,
	type McpToolResult,
	type McpToolResultStatus,
} from "./mcp-types.js";
export { McpSdkAdapter, type McpSdkAdapterOptions } from "./sdk-adapter.js";
export {
	DEFAULT_MCP_REQUEST_TIMEOUT_MS,
	DEFAULT_MCP_STARTUP_TIMEOUT_MS,
	isSafeMcpServerId,
	normalizeMcpServerDefinition,
	parseMcpServerConfigJson,
	safeEnvNames,
	safeServerCommand,
} from "./server-config.js";
