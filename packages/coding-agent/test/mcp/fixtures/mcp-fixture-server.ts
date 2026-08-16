/**
 * MCP Client Foundation — deterministic LEGACY stdio fixture server (2.13.0).
 *
 * A real MCP server run as a child process over stdio, wired the 2025-era way:
 * `server.connect(new StdioServerTransport())` performs the `initialize`
 * handshake only — it does NOT implement the modern `server/discover`
 * advertisement. This makes it a genuine legacy peer for the automatic-fallback
 * acceptance tests (LEGACY-A/B) and for the existing MCP Foundation regression.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

// Early diagnostic proves stderr is captured before the handshake completes.
process.stderr.write("[fixture] boot diagnostic\n");

const server = new McpServer(
	{ name: "jensen-mcp-fixture", version: "1.0.0" },
	{
		capabilities: { tools: { listChanged: true } },
		instructions: "Deterministic MCP test fixture for Jensen.",
	},
);

server.registerTool(
	"echo",
	{
		title: "Echo",
		description: "Echo structured text back with an optional count.",
		inputSchema: z.object({ text: z.string(), n: z.number().int().positive().optional() }),
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

server.registerTool(
	"delay",
	{
		title: "Delay",
		description: "Wait the requested number of milliseconds, then succeed.",
		inputSchema: z.object({ ms: z.number().int().nonnegative() }),
	},
	async ({ ms }) => {
		await new Promise((resolve) => setTimeout(resolve, ms));
		return { content: [{ type: "text", text: `delayed: ${ms}ms` }] };
	},
);

server.registerTool(
	"hang",
	{ title: "Hang", description: "Accept the request but never reply (timeout fixture)." },
	async () => {
		await new Promise(() => {
			// Intentionally never resolves; the client must time out honestly.
		});
		return { content: [] };
	},
);

server.registerTool(
	"stderr_noise",
	{ title: "Stderr Noise", description: "Emit stderr diagnostics while still succeeding." },
	async () => {
		process.stderr.write("[fixture] diagnostic line one\n");
		process.stderr.write("[fixture] diagnostic line two\n");
		return { content: [{ type: "text", text: "stderr emitted but result valid" }] };
	},
);

server.registerTool(
	"crash",
	{ title: "Crash", description: "Exit the process unexpectedly (connection-lost fixture)." },
	async () => {
		process.exit(7);
	},
);

server.registerTool(
	"register_late_tool",
	{ title: "Register Late Tool", description: "Register a new tool and announce the tool-list change." },
	async () => {
		server.registerTool(
			"late_tool",
			{
				title: "Late Tool",
				description: "Registered after the initial discovery.",
				inputSchema: z.object({ value: z.string() }),
			},
			async ({ value }) => ({
				content: [{ type: "text", text: `late: ${value}` }],
			}),
		);
		return { content: [{ type: "text", text: "registered late_tool" }] };
	},
);

const transport = new StdioServerTransport();
await server.connect(transport);
