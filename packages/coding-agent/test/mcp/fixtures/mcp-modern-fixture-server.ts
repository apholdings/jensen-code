/**
 * MCP Client Foundation — deterministic MODERN stdio fixture server (2.13.0).
 *
 * A real MCP server run as a child process over stdio, wired the 2026-07-28 way:
 * `serveStdio(factory, { legacy: "reject" })` answers the modern `server/discover`
 * advertisement and refuses legacy `initialize` openings. This makes it a
 * genuine modern-only peer — if Jensen's auto-negotiation ever fell back to
 * legacy, `connect()` would fail loudly, which is exactly what MODERN-A/B assert
 * against.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

// Early diagnostic proves stderr is captured before the opening exchange.
process.stderr.write("[fixture] modern boot diagnostic\n");

function buildServer(): McpServer {
	const server = new McpServer(
		{ name: "jensen-mcp-modern-fixture", version: "2.0.0" },
		{
			capabilities: { tools: {} },
			instructions: "Deterministic MODERN MCP test fixture for Jensen (2026-07-28).",
		},
	);

	server.registerTool(
		"echo",
		{
			title: "Echo",
			description: "Echo structured text back over the modern protocol era.",
			inputSchema: z.object({ text: z.string() }),
			outputSchema: z.object({ echoed: z.string() }),
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		async ({ text }) => {
			return {
				content: [{ type: "text", text: `echo: ${text}` }],
				structuredContent: { echoed: text },
			};
		},
	);

	server.registerTool(
		"fail_tool",
		{ title: "Fail", description: "Returns an intentional tool-level error." },
		async () => ({
			content: [{ type: "text", text: "intentional tool failure" }],
			isError: true,
		}),
	);

	return server;
}

serveStdio(buildServer, { legacy: "reject" });
