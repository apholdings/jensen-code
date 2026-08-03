import { createHash } from "node:crypto";

export type McpTransport = "stdio" | "sse" | "streamable_http";
export type McpHealth = "configured" | "starting" | "ready" | "degraded" | "reconnecting" | "failed" | "stopped";

export interface McpServerIdentity {
	serverId: string;
	configIdentity: string;
	transport: McpTransport;
	endpointIdentity: string;
	processIdentity?: string;
	connectedAt?: string;
	protocolVersion?: string;
	capabilitiesHash?: string;
}

export interface McpServerConfig {
	serverId: string;
	transport: McpTransport;
	command?: string;
	args?: string[];
	url?: string;
	envRefs?: Record<string, string>;
	headerRefs?: Record<string, string>;
	startupTimeoutMs?: number;
	requestTimeoutMs?: number;
	maxReconnects?: number;
}

export interface McpToolSchema {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
}

export interface McpCapabilitySnapshot {
	serverId: string;
	protocolVersion?: string;
	tools: McpToolSchema[];
	resources: Array<{ uri: string; name?: string; mimeType?: string }>;
	resourceTemplates: Array<{ uriTemplate: string; name?: string }>;
	prompts: Array<{ name: string; description?: string }>;
	capabilities: Record<string, boolean>;
	snapshotHash: string;
	retrievedAt: string;
}

export type McpEffectClass = "read_only" | "writes_workspace" | "mutates_external_state" | "unknown";

export interface McpToolEffects {
	classification: McpEffectClass;
	mutatesExternalState: boolean | "unknown";
	parallelSafe: boolean;
	requiresApproval: boolean;
	source: "configured" | "administrator" | "builtin" | "inferred" | "unknown";
}

export interface McpValidationIssue {
	code: string;
	message: string;
	toolName?: string;
}

export interface McpValidationResult {
	valid: boolean;
	tools: McpToolSchema[];
	rejected: McpValidationIssue[];
}

const MAX_SCHEMA_BYTES = 128 * 1024;
const MAX_SCHEMA_DEPTH = 12;
const MAX_DESCRIPTION_LENGTH = 8 * 1024;
const MAX_TOOLS = 256;
const URI_SCHEMES = new Set(["https:", "http:"]);

function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
		.join(",")}}`;
}

export function canonicalizeMcp(value: unknown): string {
	return canonical(value);
}

export function mcpSha256(value: unknown): string {
	return createHash("sha256").update(canonical(value)).digest("hex");
}

function depth(value: unknown): number {
	if (!value || typeof value !== "object") return 0;
	let maximum = 0;
	const pending: Array<{ value: unknown; level: number }> = [{ value, level: 0 }];
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current || !current.value || typeof current.value !== "object") continue;
		maximum = Math.max(maximum, current.level);
		if (maximum > MAX_SCHEMA_DEPTH) return maximum;
		const children = Array.isArray(current.value)
			? current.value
			: Object.values(current.value as Record<string, unknown>);
		for (const child of children) pending.push({ value: child, level: current.level + 1 });
	}
	return maximum;
}

function isJsonSchema(schema: unknown): schema is Record<string, unknown> {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
	const type = (schema as Record<string, unknown>).type;
	return type === undefined || typeof type === "string" || Array.isArray(type);
}

export function validateMcpToolSchemas(tools: McpToolSchema[]): McpValidationResult {
	const rejected: McpValidationIssue[] = [];
	const valid: McpToolSchema[] = [];
	const names = new Set<string>();
	if (tools.length > MAX_TOOLS)
		rejected.push({ code: "tool_count_limit", message: `maximum ${MAX_TOOLS} tools exceeded` });
	for (const tool of tools.slice(0, MAX_TOOLS)) {
		if (!tool || typeof tool.name !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(tool.name)) {
			rejected.push({ code: "invalid_tool_name", message: "tool name is invalid", toolName: tool?.name });
			continue;
		}
		if (names.has(tool.name)) {
			rejected.push({ code: "tool_name_collision", message: "duplicate tool name", toolName: tool.name });
			continue;
		}
		names.add(tool.name);
		if (!isJsonSchema(tool.inputSchema) || (tool.outputSchema !== undefined && !isJsonSchema(tool.outputSchema))) {
			rejected.push({
				code: "invalid_json_schema",
				message: "input/output schema is not a JSON object schema",
				toolName: tool.name,
			});
			continue;
		}
		const schemaDepth = depth(tool.inputSchema);
		if (schemaDepth > MAX_SCHEMA_DEPTH) {
			rejected.push({
				code: "schema_depth_limit",
				message: "schema exceeds safety limits",
				toolName: tool.name,
			});
			continue;
		}
		const schemaBytes = Buffer.byteLength(canonical(tool.inputSchema));
		if (schemaBytes > MAX_SCHEMA_BYTES) {
			rejected.push({
				code: schemaBytes > MAX_SCHEMA_BYTES ? "schema_size_limit" : "schema_depth_limit",
				message: "schema exceeds safety limits",
				toolName: tool.name,
			});
			continue;
		}
		if (
			tool.description !== undefined &&
			(typeof tool.description !== "string" || tool.description.length > MAX_DESCRIPTION_LENGTH)
		) {
			rejected.push({
				code: "description_limit",
				message: "tool description exceeds safety limits",
				toolName: tool.name,
			});
			continue;
		}
		valid.push({ ...tool, description: tool.description?.slice(0, MAX_DESCRIPTION_LENGTH) });
	}
	return { valid: rejected.length === 0, tools: valid, rejected };
}

export function classifyMcpToolEffects(tool: McpToolSchema, configured?: McpToolEffects): McpToolEffects {
	if (configured?.classification === "unknown" || configured?.mutatesExternalState === true)
		return { ...configured, requiresApproval: true, parallelSafe: false };
	if (configured) return configured;
	const text = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
	if (/(delete|remove|write|edit|update|send|publish|execute|deploy|create)/.test(text))
		return {
			classification: "unknown",
			mutatesExternalState: "unknown",
			parallelSafe: false,
			requiresApproval: true,
			source: "inferred",
		};
	if (/\b(read|list|search|fetch|get|inspect|status)\b/.test(text))
		return {
			classification: "read_only",
			mutatesExternalState: false,
			parallelSafe: true,
			requiresApproval: false,
			source: "inferred",
		};
	return {
		classification: "unknown",
		mutatesExternalState: "unknown",
		parallelSafe: false,
		requiresApproval: true,
		source: "unknown",
	};
}

export function validateMcpConfig(config: McpServerConfig): McpValidationIssue[] {
	const issues: McpValidationIssue[] = [];
	if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(config.serverId))
		issues.push({ code: "invalid_server_id", message: "server ID is invalid" });
	if (config.transport === "stdio" && (!config.command || config.url))
		issues.push({ code: "stdio_command_required", message: "stdio requires command and no URL" });
	if (config.transport !== "stdio" && (!config.url || !/^https?:\/\//i.test(config.url)))
		issues.push({ code: "remote_url_required", message: "remote transport requires an HTTP(S) URL" });
	if (config.url) {
		try {
			const parsed = new URL(config.url);
			if (parsed.protocol === "http:" && process.env.JENSEN_ALLOW_INSECURE_MCP !== "1")
				issues.push({
					code: "https_required",
					message: "HTTPS is required unless explicitly enabled for local fixtures",
				});
			if (parsed.username || parsed.password || parsed.search || parsed.hash)
				issues.push({
					code: "secret_or_volatile_url",
					message: "credentials, query strings and fragments are not accepted in MCP identity",
				});
		} catch {
			issues.push({ code: "invalid_url", message: "MCP URL is invalid" });
		}
	}
	if (config.startupTimeoutMs !== undefined && (config.startupTimeoutMs < 100 || config.startupTimeoutMs > 120_000))
		issues.push({ code: "startup_timeout_limit", message: "startup timeout is outside bounds" });
	if (config.requestTimeoutMs !== undefined && (config.requestTimeoutMs < 100 || config.requestTimeoutMs > 600_000))
		issues.push({ code: "request_timeout_limit", message: "request timeout is outside bounds" });
	if (config.maxReconnects !== undefined && (config.maxReconnects < 0 || config.maxReconnects > 10))
		issues.push({ code: "reconnect_limit", message: "reconnect attempts are outside bounds" });
	return issues;
}

export function createMcpIdentity(config: McpServerConfig): McpServerIdentity {
	const endpointIdentity = config.transport === "stdio" ? (config.command ?? "") : new URL(config.url ?? "").origin;
	return {
		serverId: config.serverId,
		configIdentity: mcpSha256(config),
		transport: config.transport,
		endpointIdentity,
	};
}

export function createMcpCapabilitySnapshot(
	input: Omit<McpCapabilitySnapshot, "snapshotHash" | "retrievedAt">,
): McpCapabilitySnapshot {
	const snapshot = { ...input, snapshotHash: "", retrievedAt: new Date().toISOString() };
	return { ...snapshot, snapshotHash: mcpSha256(snapshot) };
}

export function detectCapabilityDrift(previous: McpCapabilitySnapshot, next: McpCapabilitySnapshot): string[] {
	const changes: string[] = [];
	if (previous.protocolVersion !== next.protocolVersion) changes.push("protocol_version_changed");
	const before = new Map(previous.tools.map((tool) => [tool.name, mcpSha256(tool)]));
	const after = new Map(next.tools.map((tool) => [tool.name, mcpSha256(tool)]));
	for (const name of new Set([...before.keys(), ...after.keys()])) {
		if (!before.has(name)) changes.push(`tool_added:${name}`);
		else if (!after.has(name)) changes.push(`tool_removed:${name}`);
		else if (before.get(name) !== after.get(name)) changes.push(`tool_changed:${name}`);
	}
	return changes.sort();
}

export function validateMcpResourceUri(uri: string): boolean {
	try {
		const parsed = new URL(uri);
		return URI_SCHEMES.has(parsed.protocol) && !parsed.username && !parsed.password;
	} catch {
		return false;
	}
}

const MCP_SECRET_VALUE =
	/(?:bearer\s+|sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|-----BEGIN [A-Z ]+-----|eyJ[A-Za-z0-9_-]{8,}\.)/i;
export function redactMcpDiagnostics(value: unknown): unknown {
	if (typeof value === "string") return MCP_SECRET_VALUE.test(value) ? "[REDACTED]" : value;
	if (Array.isArray(value)) return value.map(redactMcpDiagnostics);
	if (!value || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value as Record<string, unknown>))
		out[key] = /(authorization|token|secret|password|cookie|api[-_]?key|private[-_]?key)/i.test(key)
			? "[REDACTED]"
			: redactMcpDiagnostics(child);
	return out;
}
