/**
 * Unity MCP Vertical Slice — minimal legacy fixture WITHOUT the Console tool
 * (2.13.0). Used to prove that a missing read-only capability is classified
 * honestly as NOT_ENABLED rather than fabricated.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const server = new McpServer(
	{ name: "unity-mcp-server", version: "1.0.0" },
	{ capabilities: { tools: { listChanged: true } } },
);

server.registerTool("Unity_RunCommand", { description: "Compile and execute a C# script." }, async () => ({
	content: [{ type: "text", text: "run command (mutating stub)" }],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
