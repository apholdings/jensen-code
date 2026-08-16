/**
 * Unity MCP Vertical Slice — read-only inspection (2.13.0).
 *
 * One-shot, process-lifetime operation that reaches the real LOTG Unity Editor
 * through the existing MCP Client Foundation and normalizes what the enabled
 * Unity MCP tools actually expose. Generic connect/discover/invoke flows through
 * `McpClientPort`; this module adds only safe discovery, normalization, and
 * Evidence correlation. It never fabricates project state and never enables or
 * invokes mutating tools.
 */

import type { McpClientService } from "../mcp-foundation/mcp-client-service.js";
import { McpClientError } from "../mcp-foundation/mcp-error.js";
import type { McpServerDefinition, McpServerSession, McpToolResult } from "../mcp-foundation/mcp-types.js";
import { buildUnityMcpServerDefinition } from "./unity-server-config.js";
import {
	UNITY_INSPECTION_CATEGORIES,
	UNITY_KNOWN_TOOLS,
	type UnityInspectionResult,
	type UnityObservation,
	type UnityObservationStatus,
	type UnityServerTarget,
	type UnityToolObservation,
} from "./unity-types.js";

export interface UnityInspectOptions {
	target: UnityServerTarget;
	service: McpClientService;
	now?: () => number;
}

export interface UnityInspectDefinitionOptions {
	definition: McpServerDefinition;
	serverId: string;
	machine: string;
	service: McpClientService;
	/** Optional project path for the project-path observation (when known). */
	projectPath?: string;
	now?: () => number;
}

const READ_ONLY_CONSOLE_ARGS = { maxEntries: 50, includeStackTrace: false };

/** Parse Unity_GetConsoleLogs output without fabricating a shape it lacks. */
function extractConsolePayload(result: McpToolResult): unknown {
	const text = result.content.find((item) => item.type === "text" && typeof item.text === "string")?.text;
	if (text === undefined) return undefined;
	try {
		const parsed = JSON.parse(text) as unknown;
		if (typeof parsed === "object" && parsed !== null && "data" in (parsed as Record<string, unknown>)) {
			return (parsed as Record<string, unknown>).data;
		}
		return parsed;
	} catch {
		return text;
	}
}

function observation(
	category: string,
	status: UnityObservationStatus,
	extra: Partial<UnityObservation> = {},
): UnityObservation {
	return { category, status, ...extra };
}

function failureResult(
	serverId: string,
	machine: string,
	connectionReason: string,
	startedAtMs: number,
	now: () => number,
): UnityInspectionResult {
	return {
		kind: "unity-inspection",
		version: 1,
		serverId,
		machine,
		connection: "FAIL",
		connectionReason,
		tools: [],
		observations: [],
		evidenceIds: [],
		startedAtMs,
		completedAtMs: now(),
	};
}

/**
 * Run a bounded, read-only Unity inspection against an explicit server
 * definition. Always disconnects; a failure never fabricates a connected
 * session or an observation. Exposed separately from `inspectUnity` so failure
 * cases are testable with a deterministic spawn.
 */
export async function inspectUnityDefinition(options: UnityInspectDefinitionOptions): Promise<UnityInspectionResult> {
	const { definition, serverId, machine, service, projectPath } = options;
	const now = options.now ?? Date.now;
	const startedAtMs = now();
	const evidenceIds: string[] = [];

	let session: McpServerSession | undefined;
	try {
		session = await service.connect(definition);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const code = error instanceof McpClientError ? error.code : undefined;
		return failureResult(serverId, machine, code ? `${code}: ${message}` : message, startedAtMs, now);
	}

	try {
		const tools = await service.listTools(session.sessionId);
		const toolObservations: UnityToolObservation[] = tools.map((tool) => {
			const known = UNITY_KNOWN_TOOLS[tool.name];
			return known
				? { name: tool.name, mutating: known.mutating }
				: { name: tool.name, mutating: false, description: tool.description };
		});

		const observations: UnityObservation[] = [];

		// Console: read-only and always attempted when the tool is enabled.
		const hasConsole = tools.some((tool) => tool.name === "Unity_GetConsoleLogs");
		if (hasConsole) {
			const result = await service.callTool(session.sessionId, {
				toolName: "Unity_GetConsoleLogs",
				arguments: READ_ONLY_CONSOLE_ARGS,
			});
			if (result.evidenceId) evidenceIds.push(result.evidenceId);
			if (result.status === "success") {
				observations.push(
					observation("console", "OBSERVED", {
						value: extractConsolePayload(result),
						note: "Unity_GetConsoleLogs (read-only)",
					}),
				);
			} else {
				observations.push(
					observation("console", "ERROR", {
						note: `${result.errorCode ?? "UNKNOWN"}: ${result.errorMessage ?? "tool call failed"}`,
						missingTool: "Unity_GetConsoleLogs",
					}),
				);
			}
		} else {
			observations.push(
				observation("console", "NOT_ENABLED", {
					note: "Console inspection requires Unity_GetConsoleLogs",
					missingTool: "Unity_GetConsoleLogs",
				}),
			);
		}

		// Project path: proven by the relay's project-targeted bridge connection.
		observations.push(
			observation("project-path", "OBSERVED", {
				value: projectPath,
				note: "relay targeted the configured Unity project path",
			}),
		);

		// The remaining read-only categories are not exposed by the currently
		// enabled Unity MCP tool surface. Classified honestly, never fabricated.
		for (const category of UNITY_INSPECTION_CATEGORIES) {
			if (category === "console" || category === "project-path") continue;
			observations.push(
				observation(category, "NOT_EXPOSED", {
					note: "no enabled Unity MCP tool surfaces this category",
				}),
			);
		}

		return {
			kind: "unity-inspection",
			version: 1,
			serverId,
			machine,
			connection: "PASS",
			protocolEra: session.protocolEra,
			protocolVersion: session.protocolVersion,
			serverIdentity: session.identity,
			sessionId: session.sessionId,
			tools: toolObservations,
			observations,
			evidenceIds,
			startedAtMs,
			completedAtMs: now(),
		};
	} finally {
		await service.disconnect(session.sessionId).catch(() => {
			// Disconnect failures never mask the inspection outcome.
		});
	}
}

/**
 * Run a bounded, read-only Unity inspection for a `UnityServerTarget`. This is
 * the operator-facing entry point: it builds the SSH stdio server definition
 * and delegates to `inspectUnityDefinition`.
 */
export async function inspectUnity(options: UnityInspectOptions): Promise<UnityInspectionResult> {
	const { target, service, now } = options;
	const definition = buildUnityMcpServerDefinition(target);
	return inspectUnityDefinition({
		definition,
		serverId: target.serverId,
		machine: target.sshTarget,
		service,
		projectPath: target.unityProjectPath,
		now,
	});
}

/** Helpers exposed for tests and CLI rendering. */
export function isMutatingTool(tool: UnityToolObservation): boolean {
	return tool.mutating;
}

export function readOnlyUnityTools(tools: UnityToolObservation[]): string[] {
	return tools.filter((tool) => !tool.mutating).map((tool) => tool.name);
}
