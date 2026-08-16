/**
 * MCP Client Foundation — server configuration (2.13.0).
 *
 * Parses/validates a configured stdio server into a normalized
 * `McpServerDefinition`. Secret hygiene is enforced here: environment values are
 * never echoed into diagnostics or evidence; only variable names are surfaced.
 */

import { McpClientError } from "./mcp-error.js";
import type { McpServerDefinition } from "./mcp-types.js";

export const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 30_000;
export const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 60_000;

/** Server ids must be durable/path-safe: short, [A-Za-z0-9._-], no traversal. */
const SAFE_SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isSafeMcpServerId(value: string): boolean {
	return SAFE_SERVER_ID.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) throw invalidConfig(`${field} must be a non-empty string`);
	return value;
}

function invalidConfig(message: string): McpClientError {
	return new McpClientError("MCP_INVALID_SERVER_CONFIG", message);
}

function normalizeTimeout(value: unknown, field: string, fallback: number): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw invalidConfig(`${field} must be a positive integer (milliseconds)`);
	}
	return value;
}

function normalizeStringArray(value: unknown, field: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		throw invalidConfig(`${field} must be an array of strings`);
	}
	return [...(value as string[])];
}

function normalizeEnv(value: unknown): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw invalidConfig("env must be an object of string values");
	const out: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry !== "string") throw invalidConfig(`env.${key} must be a string`);
		out[key] = entry;
	}
	return out;
}

/**
 * Validate a raw JSON-decoded object into a normalized server definition.
 * Throws `McpClientError("MCP_INVALID_SERVER_CONFIG")` on any structural error.
 */
export function normalizeMcpServerDefinition(input: unknown): McpServerDefinition {
	if (!isRecord(input)) throw invalidConfig("server config must be a JSON object");

	const id = requireString(input.id, "id");
	if (!isSafeMcpServerId(id)) {
		throw invalidConfig("id must be durable-safe: 1-64 chars of [A-Za-z0-9._-] starting with a letter/digit");
	}

	const command = requireString(input.command, "command");
	const name = input.name === undefined ? undefined : requireString(input.name, "name");
	const args = normalizeStringArray(input.args, "args");
	const env = normalizeEnv(input.env);
	const cwd = input.cwd === undefined ? undefined : requireString(input.cwd, "cwd");
	const startupTimeoutMs = normalizeTimeout(
		input.startupTimeoutMs,
		"startupTimeoutMs",
		DEFAULT_MCP_STARTUP_TIMEOUT_MS,
	);
	const requestTimeoutMs = normalizeTimeout(
		input.requestTimeoutMs,
		"requestTimeoutMs",
		DEFAULT_MCP_REQUEST_TIMEOUT_MS,
	);

	return Object.freeze({
		id,
		name,
		command,
		args: args ? Object.freeze(args) : undefined,
		env: env ? Object.freeze(env) : undefined,
		cwd,
		startupTimeoutMs,
		requestTimeoutMs,
	});
}

/** Parse a server-config JSON document into a validated definition. */
export function parseMcpServerConfigJson(text: string): McpServerDefinition {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw invalidConfig(`server config is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	return normalizeMcpServerDefinition(parsed);
}

/**
 * argv identity for diagnostics: `command` plus explicit args. Environment
 * contents are deliberately excluded.
 */
export function safeServerCommand(definition: McpServerDefinition): string {
	return [definition.command, ...(definition.args ?? [])].join(" ");
}

/** Sorted environment variable NAMES only — values are never surfaced. */
export function safeEnvNames(definition: McpServerDefinition): string[] {
	return Object.keys(definition.env ?? {}).sort();
}
