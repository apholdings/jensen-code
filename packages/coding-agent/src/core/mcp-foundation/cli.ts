/**
 * MCP Client Foundation — CLI (2.13.0).
 *
 * `jensen mcp inspect|tools|call|health <server-config.json>`
 *
 * One-shot, process-lifetime honest operations: connect, perform the requested
 * operation, record evidence (for calls), and disconnect. There is no fake
 * cross-process persistent session; the Worker daemon is a later layer.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { getAgentDir } from "../../config.js";
import { EvidenceFileStore } from "../context-runtime/evidence-archive.js";
import { McpClientService } from "./mcp-client-service.js";
import { McpClientError } from "./mcp-error.js";
import type { McpServerDefinition, McpServerSession, McpSessionHealth, McpToolResult } from "./mcp-types.js";
import { parseMcpServerConfigJson } from "./server-config.js";

const SUBCOMMANDS = new Set(["inspect", "tools", "call", "health"]);

function buildService(): McpClientService {
	const archive = new EvidenceFileStore(join(getAgentDir(), "context-evidence"));
	return new McpClientService({ evidenceArchive: archive });
}

function loadServerConfig(configPath: string): McpServerDefinition {
	let text: string;
	try {
		text = readFileSync(configPath, "utf8");
	} catch (error) {
		throw new McpClientError(
			"MCP_SERVER_NOT_FOUND",
			`cannot read server config "${configPath}": ${error instanceof Error ? error.message : String(error)}`,
			{ detail: configPath },
		);
	}
	return parseMcpServerConfigJson(text);
}

function valueArgs(args: string[]): string[] {
	return args.filter((a) => !a.startsWith("--"));
}

function flag(args: string[], name: string): boolean {
	return args.includes(name);
}

function printJson(payload: unknown): void {
	process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function codeOf(error: unknown): string | undefined {
	if (typeof error === "object" && error !== null && "code" in error) {
		return String((error as { code: unknown }).code);
	}
	return undefined;
}

function renderError(error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	const code = codeOf(error);
	process.stderr.write(`${chalk.red(code ? `${code}: ${message}` : message)}\n`);
}

interface ParsedArgs {
	args: Record<string, unknown>;
	timeoutMs?: number;
}

function parseCallArgs(raw: string[]): ParsedArgs {
	const args: Record<string, unknown> = {};
	let timeoutMs: number | undefined;

	for (let i = 0; i < raw.length; i++) {
		const token = raw[i];
		if (token === "--arg" || token === "--arg-json") {
			const pair = raw[i + 1];
			if (pair === undefined || pair.startsWith("--")) {
				throw new McpClientError("MCP_INVALID_TOOL_CALL", `${token} requires a key=value argument`);
			}
			const eq = pair.indexOf("=");
			if (eq <= 0) throw new McpClientError("MCP_INVALID_TOOL_CALL", `${token} requires key=value`);
			const key = pair.slice(0, eq);
			const valueText = pair.slice(eq + 1);
			if (token === "--arg") {
				args[key] = valueText;
			} else {
				try {
					args[key] = JSON.parse(valueText) as unknown;
				} catch (error) {
					throw new McpClientError(
						"MCP_INVALID_TOOL_CALL",
						`--arg-json ${key} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			i += 1;
			continue;
		}
		if (token === "--timeout-ms") {
			const value = raw[i + 1];
			if (value === undefined) throw new McpClientError("MCP_INVALID_TOOL_CALL", "--timeout-ms requires a number");
			const parsed = Number(value);
			if (!Number.isSafeInteger(parsed) || parsed <= 0) {
				throw new McpClientError("MCP_INVALID_TOOL_CALL", "--timeout-ms must be a positive integer");
			}
			timeoutMs = parsed;
			i += 1;
		}
	}

	return { args, timeoutMs };
}

function renderCapabilityKeys(capabilities: Record<string, unknown> | undefined): string {
	if (!capabilities) return "(unknown)";
	const keys = Object.keys(capabilities).sort();
	return keys.length > 0 ? keys.join(", ") : "(none)";
}

function renderSession(session: McpServerSession): void {
	process.stdout.write(`MCP SERVER\n`);
	process.stdout.write(`  server: ${session.serverId}\n`);
	process.stdout.write(`  session: ${session.sessionId}\n`);
	process.stdout.write(`  state: ${session.state}\n`);
	if (session.identity) process.stdout.write(`  identity: ${session.identity.name}@${session.identity.version}\n`);
	if (session.protocolVersion) process.stdout.write(`  protocol: ${session.protocolVersion}\n`);
	process.stdout.write(`  capabilities: ${renderCapabilityKeys(session.capabilities)}\n`);
	if (session.pid !== undefined) process.stdout.write(`  pid: ${session.pid}\n`);
	if (session.failure) process.stdout.write(`  failure: ${session.failure.code}: ${session.failure.message}\n`);
}

function renderHealth(health: McpSessionHealth): void {
	process.stdout.write(`MCP HEALTH\n`);
	process.stdout.write(`  server: ${health.serverId}\n`);
	process.stdout.write(`  session: ${health.sessionId}\n`);
	process.stdout.write(`  state: ${health.state}\n`);
	process.stdout.write(`  connected: ${health.connected}\n`);
	process.stdout.write(`  processAlive: ${health.processAlive}\n`);
	if (health.protocolVersion) process.stdout.write(`  protocol: ${health.protocolVersion}\n`);
	if (health.failed && health.failure)
		process.stdout.write(`  failure: ${health.failure.code}: ${health.failure.message}\n`);
}

function renderToolResult(result: McpToolResult): void {
	process.stdout.write(`MCP TOOL CALL\n`);
	process.stdout.write(`  server: ${result.serverId}\n`);
	process.stdout.write(`  tool: ${result.toolName}\n`);
	process.stdout.write(`  status: ${result.status}\n`);
	if (result.errorCode)
		process.stdout.write(`  error: ${result.errorCode}${result.errorMessage ? `: ${result.errorMessage}` : ""}\n`);
	if (result.evidenceId) process.stdout.write(`  evidence: ${result.evidenceId}\n`);
	for (const item of result.content) {
		if (item.type === "text" && typeof item.text === "string") {
			process.stdout.write(`  text: ${item.text}\n`);
		} else {
			process.stdout.write(`  content: ${item.type}\n`);
		}
	}
}

// =============================================================================
// Handler
// =============================================================================

export function printMcpUsage(): string {
	return [
		"  mcp inspect <server-config.json> [--json]",
		"  mcp tools <server-config.json> [--json]",
		"  mcp call <server-config.json> <tool> [--arg key=value]... [--arg-json key=json]... [--timeout-ms N] [--json]",
		"  mcp health <server-config.json> [--json]",
	].join("\n");
}

export async function handleMcpCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "mcp") return false;
	const sub = args[1];
	if (!sub || !SUBCOMMANDS.has(sub)) return false;

	const json = flag(args, "--json");
	const configPath = valueArgs(args)[2];
	if (!configPath) {
		process.stderr.write("missing server config path\n");
		process.exitCode = 1;
		return true;
	}

	const service = buildService();

	try {
		const definition = loadServerConfig(configPath);
		const session = await service.connect(definition);

		try {
			switch (sub) {
				case "inspect": {
					if (json) printJson(session);
					else renderSession(session);
					return true;
				}

				case "tools": {
					const tools = await service.listTools(session.sessionId);
					if (json) printJson({ serverId: session.serverId, sessionId: session.sessionId, tools });
					else {
						if (tools.length === 0) process.stdout.write("(no tools)\n");
						for (const tool of tools) {
							process.stdout.write(`${tool.name}${tool.description ? `  ${tool.description}` : ""}\n`);
						}
					}
					return true;
				}

				case "call": {
					const toolName = valueArgs(args)[3];
					if (!toolName) {
						process.stderr.write("missing tool name\n");
						process.exitCode = 1;
						return true;
					}
					const parsed = parseCallArgs(args);
					const result = await service.callTool(session.sessionId, {
						toolName,
						arguments: parsed.args,
						timeoutMs: parsed.timeoutMs,
					});
					if (json) printJson(result);
					else renderToolResult(result);
					if (result.status !== "success") process.exitCode = 1;
					return true;
				}

				case "health": {
					const health = await service.health(session.sessionId);
					if (json) printJson(health);
					else renderHealth(health);
					return true;
				}

				default:
					return false;
			}
		} finally {
			await service.disconnect(session.sessionId).catch(() => {
				// Disconnect failures must not mask the primary operation result.
			});
		}
	} catch (error) {
		renderError(error);
		process.exitCode = 1;
		return true;
	}
}
