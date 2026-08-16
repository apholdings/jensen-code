/**
 * Unity MCP Vertical Slice — deterministic LEGACY stdio fixture (2.13.0).
 *
 * A real MCP server that mirrors the LOTG Unity Editor's observed MCP surface:
 * legacy `initialize` negotiation (protocol 2025-03-26), server identity
 * `unity-mcp-server@1.0.0`, and the seven tools actually enabled on the real
 * host (4 read-only, 3 mutating). This makes inspection normalization and
 * Evidence provenance testable without the real Editor.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const server = new McpServer(
	{ name: "unity-mcp-server", version: "1.0.0" },
	{ capabilities: { tools: { listChanged: true } } },
);

server.registerTool(
	"Unity_GetConsoleLogs",
	{
		description: "Get Unity Console logs including messages, warnings, and errors with their stack traces.",
		inputSchema: z.object({
			maxEntries: z.number().int().nonnegative().optional(),
			includeStackTrace: z.boolean().optional(),
			logTypes: z.string().optional(),
		}),
		annotations: { readOnlyHint: true },
	},
	async () => {
		const payload = {
			success: true,
			message: "Tool 'GetConsoleLogs' executed successfully",
			data: { logs: [], totalCount: 0, errorCount: 0, warningCount: 0 },
		};
		return { content: [{ type: "text", text: JSON.stringify(payload) }] };
	},
);

server.registerTool(
	"Unity_AssetGeneration_GetModels",
	{ description: "Gets a list of available models for asset generation.", annotations: { readOnlyHint: true } },
	async () => ({
		content: [{ type: "text", text: JSON.stringify({ success: true, data: { models: [] } }) }],
	}),
);

server.registerTool(
	"Unity_Camera_Capture",
	{ description: "Renders an image from a specific camera in the scene.", annotations: { readOnlyHint: true } },
	async () => ({ content: [{ type: "text", text: "camera capture (read-only stub)" }] }),
);

server.registerTool(
	"Unity_SceneView_Capture2DScene",
	{ description: "Captures a rectangular region of a 2D scene.", annotations: { readOnlyHint: true } },
	async () => ({ content: [{ type: "text", text: "2D scene capture (read-only stub)" }] }),
);

server.registerTool(
	"Unity_SceneView_CaptureMultiAngleSceneView",
	{ description: "Captures a multi-angle view of the current Scene View.", annotations: { readOnlyHint: true } },
	async () => ({ content: [{ type: "text", text: "multi-angle capture (read-only stub)" }] }),
);

server.registerTool(
	"Unity_AssetGeneration_GenerateAsset",
	{ description: "Generates or modifies a Unity asset. Mutating.", annotations: { destructiveHint: true } },
	async () => ({ content: [{ type: "text", text: "asset generation (mutating stub)" }] }),
);

server.registerTool(
	"Unity_RunCommand",
	{
		description: "Compile and execute a C# script in the Unity Editor. Mutating.",
		annotations: { destructiveHint: true },
	},
	async () => ({ content: [{ type: "text", text: "run command (mutating stub)" }] }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
