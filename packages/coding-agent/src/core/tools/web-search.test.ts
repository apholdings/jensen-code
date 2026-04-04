import { describe, expect, it } from "vitest";
import { parseArgs } from "../../cli/args.js";
import { allTools } from "./index.js";
import { createWebSearchTool, type WebSearchToolDetails } from "./web-search.js";

const SEARCH_RESULTS_HTML = `<!DOCTYPE html>
<html>
  <body>
    <table>
      <tr>
        <td>1.&nbsp;</td>
        <td>
          <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fapholdings%2Fjensen-code" class='result-link'>Jensen Code &amp; GitHub</a>
        </td>
      </tr>
      <tr>
        <td>&nbsp;&nbsp;&nbsp;</td>
        <td class='result-snippet'>Official <b>Jensen Code</b> repository with releases &amp; docs.</td>
      </tr>
      <tr>
        <td>&nbsp;&nbsp;&nbsp;</td>
        <td><span class='link-text'>github.com/apholdings/jensen-code</span></td>
      </tr>
      <tr><td>&nbsp;</td><td>&nbsp;</td></tr>
      <tr>
        <td>2.&nbsp;</td>
        <td>
          <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fjensen.dev%2Fdocs" class='result-link'>Jensen Docs</a>
        </td>
      </tr>
      <tr>
        <td>&nbsp;&nbsp;&nbsp;</td>
        <td class='result-snippet'>Browse the latest Jensen documentation.</td>
      </tr>
      <tr>
        <td>&nbsp;&nbsp;&nbsp;</td>
        <td><span class='link-text'>jensen.dev/docs</span></td>
      </tr>
    </table>
  </body>
</html>`;

const EMPTY_RESULTS_HTML = `<!DOCTYPE html><html><body><table></table></body></html>`;

describe("web_search tool", () => {
	it("registers through the built-in tool path and CLI tool parsing", () => {
		expect(allTools.web_search.name).toBe("web_search");
		expect(parseArgs(["--tools", "web_search"]).tools).toEqual(["web_search"]);
	});

	it("returns bounded structured DuckDuckGo Lite results", async () => {
		const tool = createWebSearchTool({
			fetch: async () => new Response(SEARCH_RESULTS_HTML, { status: 200 }),
		});

		const result = await tool.execute("call-1", { query: "jensen code", limit: 2 });
		const details = result.details as WebSearchToolDetails;

		expect(details).toEqual({
			provider: "duckduckgo-lite",
			query: "jensen code",
			resultCount: 2,
			results: [
				{
					title: "Jensen Code & GitHub",
					url: "https://github.com/apholdings/jensen-code",
					snippet: "Official Jensen Code repository with releases & docs.",
					source: "github.com",
				},
				{
					title: "Jensen Docs",
					url: "https://jensen.dev/docs",
					snippet: "Browse the latest Jensen documentation.",
					source: "jensen.dev",
				},
			],
		});
		expect(result.content).toEqual([
			{
				type: "text",
				text: expect.stringContaining('Web search results for "jensen code" via DuckDuckGo Lite:'),
			},
		]);
	});

	it("rejects empty queries honestly", async () => {
		const tool = createWebSearchTool({
			fetch: async () => new Response(SEARCH_RESULTS_HTML, { status: 200 }),
		});

		await expect(tool.execute("call-2", { query: "   " })).rejects.toThrow("Query must not be empty");
	});

	it("returns no-results output without inventing content", async () => {
		const tool = createWebSearchTool({
			fetch: async () => new Response(EMPTY_RESULTS_HTML, { status: 200 }),
		});

		const result = await tool.execute("call-3", { query: "no matches here" });
		const details = result.details as WebSearchToolDetails;

		expect(details.resultCount).toBe(0);
		expect(details.results).toEqual([]);
		expect(result.content).toEqual([{ type: "text", text: 'No web results found for "no matches here".' }]);
	});

	it("surfaces provider failures honestly", async () => {
		const tool = createWebSearchTool({
			fetch: async () => new Response("temporarily unavailable", { status: 503 }),
		});

		await expect(tool.execute("call-4", { query: "jensen code" })).rejects.toThrow(
			"DuckDuckGo Lite search failed: 503",
		);
	});
});
